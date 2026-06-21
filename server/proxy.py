"""
DoseDNA explanation + reasoning proxy.

Holds the Anthropic API key. Browser calls into here. The proxy NEVER sees
DNA, rsIDs, or any identifier. Only sees {gene, phenotype, drug, meds[]}.

Run:
    cd server
    pip install -r requirements.txt
    cp .env.example .env  # put your key in
    uvicorn proxy:app --reload --port 8001
"""

import json
import os
import re
import sys
import time
from collections import defaultdict, deque
from pathlib import Path
from typing import Literal, Optional

from anthropic import Anthropic, APIError
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, ValidationError, field_validator


# BUILD_SPEC §12b: validate fields against an allowlist built from the bundled
# genes.json + drugs.json, so the proxy can never be abused as an open Claude
# endpoint. The only strings that reach the prompt are ones we authored.
_REPO_ROOT = Path(__file__).resolve().parent.parent
_GENES_PATH = _REPO_ROOT / "src" / "data" / "genes.json"
_DRUGS_PATH = _REPO_ROOT / "src" / "data" / "drugs.json"

# Universal phenotypes the deterministic engine can emit even when a gene
# isn't in the table (incomplete coverage). Always permitted.
_UNIVERSAL_PHENOTYPES = {"Not determined", "Coverage limited"}


def _build_allowlist() -> tuple[set[str], set[str], set[str], set[tuple[str, str, str]]]:
    if not _GENES_PATH.exists() or not _DRUGS_PATH.exists():
        # Hackathon-friendly: refuse to start so the failure mode is loud, not
        # a silent open proxy.
        sys.exit(
            f"Bundled data missing — expected {_GENES_PATH} and {_DRUGS_PATH}. "
            "Allowlist cannot be built; refusing to start."
        )
    with _GENES_PATH.open() as fh:
        genes_data = json.load(fh)
    with _DRUGS_PATH.open() as fh:
        drugs_data = json.load(fh)

    genes: set[str] = set(genes_data.get("genes", {}).keys())
    phenotypes: set[str] = set(_UNIVERSAL_PHENOTYPES)
    for spec in genes_data.get("genes", {}).values():
        for key in (
            "diplotype_to_phenotype",
            "activity_score_to_phenotype",
            "single_snp_to_phenotype",
            "variant_count_to_phenotype",
        ):
            for p in spec.get(key, {}).values():
                phenotypes.add(p)
        if "fixed_phenotype" in spec:
            phenotypes.add(spec["fixed_phenotype"])

    drugs: set[str] = set()
    tuples: set[tuple[str, str, str]] = set()
    for gene, by_drug in drugs_data.get("drugs", {}).items():
        for drug, by_phenotype in by_drug.items():
            drugs.add(drug)
            for phenotype in by_phenotype:
                tuples.add((gene, phenotype, drug))
            # Allow Not determined / Coverage limited for any (gene, drug) pair
            # so partial-coverage results still get an explanation.
            for universal in _UNIVERSAL_PHENOTYPES:
                tuples.add((gene, universal, drug))

    return genes, phenotypes, drugs, tuples


_ALLOWED_GENES, _ALLOWED_PHENOTYPES, _ALLOWED_DRUGS, _ALLOWED_TUPLES = _build_allowlist()


def _check_in(value: str, allowed: set[str], field: str) -> str:
    if value not in allowed:
        raise ValueError(f"{field} '{value[:40]}' is not in the bundled allowlist")
    return value

# Defense-in-depth: reject any payload field that looks like DNA. The schema
# already caps lengths, but a future client bug could still try to send an
# rsID or a long ACGT run. Match either an rsID (rs + 3+ digits) or a long
# uninterrupted ACGT run. Caller passes the string through _reject_dna_shaped.
DNA_SHAPED_RE = re.compile(r"\brs\d{3,}\b|[ACGT]{20,}")


def _reject_dna_shaped(s: str) -> str:
    if DNA_SHAPED_RE.search(s):
        raise ValueError("payload contains DNA-shaped data, rejecting")
    return s

load_dotenv()

MODEL = "claude-haiku-4-5"

if not os.environ.get("ANTHROPIC_API_KEY"):
    sys.exit("ANTHROPIC_API_KEY not set. Copy .env.example to .env and add a key.")

EXPLAIN_SYSTEM = (
    "You explain pharmacogenomic results in plain language for patients. "
    "Be clear and calm, always recommend confirming with a clinician, and do not "
    "invent clinical claims beyond the provided result. Keep responses under "
    "120 words. Do not use medical jargon without immediately defining it. "
    "End every response with one concrete question the patient could ask "
    "their doctor or pharmacist."
)

QUESTIONS_SYSTEM = (
    "You generate a short bulleted list of questions a patient could bring to "
    "their doctor or pharmacist, based on a summary of their pharmacogenomic "
    "results and current medications. Questions should be specific, actionable, "
    "and answerable in a clinical visit. Output 4-6 bullets, nothing else. "
    "Do not give medical advice or make clinical claims."
)

INTERACTIONS_SYSTEM = (
    "You analyze potential pharmacogenomic interactions for a patient. "
    "You are given: their metabolizer phenotypes for a handful of pharmacogenes "
    "and a list of medications they currently take. "
    "Flag three categories: "
    "(1) DRUG-GENE conflicts where a current med is affected by a phenotype; "
    "(2) DRUG-DRUG interactions between current meds that are well-documented; "
    "(3) PHENOCONVERSION where one of the meds inhibits or induces a metabolizing "
    "enzyme, effectively changing the patient's phenotype for other drugs they take "
    "(e.g. a strong CYP2C19 inhibitor making a normal metabolizer behave as poor). "
    "Format output as JSON with keys: drug_gene, drug_drug, phenoconversion. "
    "Each value is an array of {flag, severity, explanation, ask_clinician}. "
    "severity is one of: info, caution, avoid. "
    "Be conservative. Only flag things with documented evidence. If nothing to "
    "flag in a category, return an empty array for it. Output ONLY the JSON object "
    "with no surrounding text or markdown fences. If you cannot answer, return "
    '{"drug_gene":[], "drug_drug":[], "phenoconversion":[]}.'
)

app = FastAPI(title="DoseDNA proxy")

# Any localhost / 127.0.0.1 origin works. Any external origin is blocked.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$",
    allow_methods=["POST", "GET", "OPTIONS"],
    allow_headers=["*"],
)

client = Anthropic(api_key=os.environ["ANTHROPIC_API_KEY"])


# Lightweight per-IP rate limiter. 30 requests per 60s window. No external dep.
RATE_LIMIT_WINDOW_S = 60.0
RATE_LIMIT_MAX = 30
_rate_buckets: dict[str, deque] = defaultdict(deque)


def rate_limit(request: Request) -> None:
    ip = request.client.host if request.client else "unknown"
    now = time.time()
    bucket = _rate_buckets[ip]
    cutoff = now - RATE_LIMIT_WINDOW_S
    while bucket and bucket[0] < cutoff:
        bucket.popleft()
    if len(bucket) >= RATE_LIMIT_MAX:
        raise HTTPException(status_code=429, detail="rate limit exceeded")
    bucket.append(now)


class ExplainRequest(BaseModel):
    gene: str = Field(..., max_length=20)
    phenotype: str = Field(..., max_length=40)
    drug: str = Field(..., max_length=60)

    @field_validator("gene")
    @classmethod
    def gene_in_allowlist(cls, v: str) -> str:
        return _check_in(_reject_dna_shaped(v), _ALLOWED_GENES, "gene")

    @field_validator("phenotype")
    @classmethod
    def phenotype_in_allowlist(cls, v: str) -> str:
        return _check_in(_reject_dna_shaped(v), _ALLOWED_PHENOTYPES, "phenotype")

    @field_validator("drug")
    @classmethod
    def drug_in_allowlist(cls, v: str) -> str:
        return _check_in(_reject_dna_shaped(v), _ALLOWED_DRUGS, "drug")

    def assert_tuple_known(self) -> None:
        if (self.gene, self.phenotype, self.drug) not in _ALLOWED_TUPLES:
            raise HTTPException(
                status_code=400,
                detail="(gene, phenotype, drug) tuple is not in the bundled guidance set",
            )


class ExplainResponse(BaseModel):
    explanation: str
    source: Literal["claude", "fallback"]


class PhenotypeSummary(BaseModel):
    gene: str = Field(..., max_length=20)
    phenotype: str = Field(..., max_length=40)

    @field_validator("gene")
    @classmethod
    def gene_in_allowlist(cls, v: str) -> str:
        return _check_in(_reject_dna_shaped(v), _ALLOWED_GENES, "gene")

    @field_validator("phenotype")
    @classmethod
    def phenotype_in_allowlist(cls, v: str) -> str:
        return _check_in(_reject_dna_shaped(v), _ALLOWED_PHENOTYPES, "phenotype")


class QuestionsRequest(BaseModel):
    phenotypes: list[PhenotypeSummary] = Field(..., max_length=20)
    medications: list[str] = Field(default_factory=list, max_length=30)


class QuestionsResponse(BaseModel):
    questions: list[str]


class InteractionsRequest(BaseModel):
    phenotypes: list[PhenotypeSummary] = Field(..., max_length=20)
    medications: list[str] = Field(..., min_length=1, max_length=30)

    @field_validator("medications")
    @classmethod
    def reject_dna_meds(cls, v: list[str]) -> list[str]:
        for med in v:
            _reject_dna_shaped(med)
        return v


SEVERITY_MAP = {
    "warning": "caution",
    "warn": "caution",
    "moderate": "caution",
    "high": "avoid",
    "severe": "avoid",
    "low": "info",
    "minor": "info",
}


class Flag(BaseModel):
    flag: str
    severity: Literal["info", "caution", "avoid"]
    explanation: str
    ask_clinician: str = ""

    @field_validator("severity", mode="before")
    @classmethod
    def coerce_severity(cls, v):
        if not isinstance(v, str):
            return "caution"
        v = v.lower().strip()
        if v in {"info", "caution", "avoid"}:
            return v
        return SEVERITY_MAP.get(v, "caution")


class InteractionsResponse(BaseModel):
    drug_gene: list[Flag] = Field(default_factory=list)
    drug_drug: list[Flag] = Field(default_factory=list)
    phenoconversion: list[Flag] = Field(default_factory=list)


JSON_FENCE = re.compile(r"```(?:json)?\s*(\{.*?\})\s*```", re.DOTALL)
JSON_OBJECT = re.compile(r"\{[\s\S]*\}")


def _extract_json(text: str) -> Optional[str]:
    fence = JSON_FENCE.search(text)
    if fence:
        return fence.group(1)
    brace = JSON_OBJECT.search(text)
    return brace.group(0) if brace else None


def _call_claude(system_text: str, user_message: str, max_tokens: int = 500) -> str:
    try:
        response = client.messages.create(
            model=MODEL,
            max_tokens=max_tokens,
            system=system_text,
            messages=[{"role": "user", "content": user_message}],
        )
    except APIError as exc:
        raise HTTPException(status_code=503, detail="upstream model error") from exc
    return "".join(b.text for b in response.content if b.type == "text").strip()


@app.get("/")
def health() -> dict:
    return {"ok": True, "model": MODEL}


@app.post(
    "/api/explain",
    response_model=ExplainResponse,
    dependencies=[Depends(rate_limit)],
)
def explain(req: ExplainRequest) -> ExplainResponse:
    # Spec §12b: also assert the tuple is one we actually have guidance for.
    # Individual fields can be valid in isolation but the combination might
    # be one we never authored (e.g. CYP2C19 + simvastatin).
    req.assert_tuple_known()
    user_message = (
        f"Explain in simple terms what it means to be a {req.gene} "
        f"{req.phenotype} taking {req.drug}, and what to ask the doctor."
    )
    try:
        text = _call_claude(EXPLAIN_SYSTEM, user_message)
    except APIError:
        # README §3 fallback: still show the user something useful when
        # Claude is unreachable. UI keys on source="fallback".
        fallback = (
            f"Based on your {req.gene} {req.phenotype} result, ask your clinician "
            f"how to safely take {req.drug}."
        )
        return ExplainResponse(explanation=fallback, source="fallback")
    return ExplainResponse(explanation=text, source="claude")


@app.post(
    "/api/questions",
    response_model=QuestionsResponse,
    dependencies=[Depends(rate_limit)],
)
def questions(req: QuestionsRequest) -> QuestionsResponse:
    pheno_lines = "\n".join(f"- {p.gene}: {p.phenotype}" for p in req.phenotypes)
    meds = ", ".join(req.medications) if req.medications else "(none provided)"
    user_message = (
        "Pharmacogenomic phenotypes:\n"
        f"{pheno_lines}\n\n"
        f"Current medications: {meds}\n\n"
        "Generate 4-6 specific questions this patient should bring to their "
        "doctor or pharmacist. Format as bullet points."
    )
    try:
        text = _call_claude(QUESTIONS_SYSTEM, user_message, max_tokens=500)
    except APIError:
        # README §3 fallback: a single generic bullet beats a 503.
        return QuestionsResponse(
            questions=[
                "Ask your clinician how your pharmacogenomic results should "
                "shape your current medications."
            ]
        )
    bullets = []
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if stripped[0] in "-*•":
            bullets.append(stripped.lstrip("-*• ").strip())
        elif re.match(r"^\d+[.)]\s+", stripped):
            bullets.append(re.sub(r"^\d+[.)]\s+", "", stripped))
    if not bullets:
        # Last resort: split on sentence-ish boundaries.
        bullets = [s.strip() for s in re.split(r"(?<=[.?])\s+", text) if s.strip()]
    return QuestionsResponse(questions=bullets[:6])


@app.post(
    "/api/check-meds",
    response_model=InteractionsResponse,
    dependencies=[Depends(rate_limit)],
)
def check_meds(req: InteractionsRequest) -> InteractionsResponse:
    pheno_lines = "\n".join(f"- {p.gene}: {p.phenotype}" for p in req.phenotypes)
    user_message = (
        "Pharmacogenomic phenotypes:\n"
        f"{pheno_lines}\n\n"
        f"Current medications: {', '.join(req.medications)}\n\n"
        "Return the JSON object as specified."
    )
    # 900 tokens is enough for 3 short JSON arrays per §9 ("handful of high-
    # confidence examples"). Keeps demo latency tight; 2000 was overkill.
    try:
        text = _call_claude(INTERACTIONS_SYSTEM, user_message, max_tokens=900)
    except APIError:
        # README §3 fallback: empty interactions render as "no flags" client-side.
        return InteractionsResponse()
    extracted = _extract_json(text)
    if not extracted:
        # Refusal or unparseable — return empty result; client renders "no flags".
        return InteractionsResponse()
    try:
        return InteractionsResponse(**json.loads(extracted))
    except (ValueError, ValidationError):
        return InteractionsResponse()
