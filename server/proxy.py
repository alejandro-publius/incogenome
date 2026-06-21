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
import urllib.parse
import urllib.request
from collections import defaultdict, deque
from pathlib import Path
from typing import Annotated, Literal, Optional, Union

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
_EXPLANATIONS_PATH = _REPO_ROOT / "src" / "data" / "explanations.json"
_INTERACTIONS_PATH = _REPO_ROOT / "src" / "data" / "interactions.json"

# Per BUILD_SPEC §12b step 2: check the precomputed bundle before calling Claude
# live. Bundle is optional — if scripts/precompute_explanations.py hasn't been
# run yet, we silently fall through to the live path.
_COVERAGE_STATES = {"confident", "partial", "not-callable"}


def _load_explanations() -> dict[str, str]:
    if not _EXPLANATIONS_PATH.exists():
        return {}
    try:
        with _EXPLANATIONS_PATH.open() as fh:
            data = json.load(fh)
    except (json.JSONDecodeError, OSError):
        return {}
    entries = data.get("explanations", {})
    return {k: v for k, v in entries.items() if isinstance(v, str)}


_EXPLANATIONS = _load_explanations()


def _load_interactions() -> dict:
    """Load the bundled phenoconversion + drug-drug table (BUILD_SPEC §11).

    Returns a dict with `phenoconversion`, `drug_drug`, and `drug_gene_extras`
    keys. Missing or unparseable file degrades to empty lists, so the proxy
    still starts and the interactions endpoint returns no flags rather than
    crashing.
    """
    empty = {"phenoconversion": [], "drug_drug": [], "drug_gene_extras": []}
    if not _INTERACTIONS_PATH.exists():
        return empty
    try:
        with _INTERACTIONS_PATH.open() as fh:
            data = json.load(fh)
    except (json.JSONDecodeError, OSError):
        return empty
    return {
        "phenoconversion": list(data.get("phenoconversion", []) or []),
        "drug_drug": list(data.get("drug_drug", []) or []),
        "drug_gene_extras": list(data.get("drug_gene_extras", []) or []),
    }


_INTERACTIONS = _load_interactions()


def _load_drugs_guidance() -> dict:
    """Load the bundled (gene, drug, phenotype) guidance table.

    Used by `_handle_interactions` for the deterministic drug-gene lookup —
    the same data `_build_allowlist` reads, but kept in its nested form
    instead of flattened to a tuple set.
    """
    if not _DRUGS_PATH.exists():
        return {}
    try:
        with _DRUGS_PATH.open() as fh:
            return json.load(fh).get("drugs", {})
    except (json.JSONDecodeError, OSError):
        return {}


_DRUGS_GUIDANCE = _load_drugs_guidance()

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

# Lindsay's framing (4-agent-chat.html): one agent that knows what it isn't.
# Tools are the four cards on her landing page — read status, map drug, catch
# interactions, build list. The model decides which to call; we execute them
# against the deterministic spine and feed results back. The model never sees
# rsIDs or genotypes — only verified phenotype strings the engine produced.
CHAT_SYSTEM = (
    "You are DoseDNA, a pharmacogenomics agent grounded in CPIC "
    "(Clinical Pharmacogenetics Implementation Consortium) guidelines. CPIC "
    "is the authoritative source for clinical gene-drug guidance; you exist "
    "to translate it into plain language for the user.\n\n"
    "You operate under hard rules:\n"
    "- Use tools to look up facts. Every drug-gene recommendation must come "
    "from a tool call — never invent a phenotype, drug guidance, or "
    "interaction. If a tool returns 'not loaded' or 'no bundled guidance,' "
    "say so plainly; do not fill the gap with reasoning of your own.\n"
    "- When you cite a recommendation, name the source field the tool "
    "returned (CPIC, FDA, DPWG, etc.). If the source was CPIC, say so "
    "explicitly: e.g. 'CPIC guidance for this combination is…'. This "
    "signals to the user that the underlying clinical statement is "
    "authoritative, not your paraphrase.\n"
    "- The user's CPIC-aligned phenotype was called locally from their DNA "
    "by a deterministic engine (PharmVar variants, CPIC diplotype tables). "
    "Trust it; never second-guess it.\n"
    "- Never state a specific dose (mg, mcg, units, tablets) or imperative "
    "dosing instructions ('you should stop', 'take 20mg'). CPIC guidelines "
    "include doses; you summarize *direction* (works less well, builds up, "
    "use an alternative) and leave the numbers to the prescriber.\n"
    "- Always recommend confirming with a clinician or pharmacist.\n"
    "- Refuse to overstep: if asked about a drug or gene that isn't in our "
    "bundled CPIC set, or about a non-pharmacogenomics topic, say so "
    "plainly and don't speculate.\n"
    "- The user's raw DNA never leaves their device. You only ever see "
    "verified CPIC-style phenotype labels (e.g. 'CYP2C19 Intermediate "
    "metabolizer') and medication names.\n\n"
    "Workflow for any drug-specific question:\n"
    "1. Call `get_gene_status` to confirm the user's phenotype for the "
    "relevant gene (if you don't already know it from the context).\n"
    "2. Call `lookup_cpic_recommendation` with that exact phenotype to "
    "fetch CPIC's verbatim text from api.cpicpgx.org — this is the "
    "authoritative source.\n"
    "3. Paraphrase the CPIC implications and recommendation into plain "
    "language. Don't quote whole sentences — translate them. Preserve the "
    "*direction* of the recommendation (use, avoid, alternative) and "
    "name the alternative drugs CPIC suggests if any.\n"
    "4. Mention the evidence classification CPIC returned (Strong, "
    "Moderate, Optional) so the user understands how firm the guidance is.\n"
    "Fall back to `get_drug_guidance` only if the live CPIC lookup misses.\n\n"
    "Style guide (load-bearing — the user is a patient, not a clinician):\n"
    "- Translate enzyme jargon literally. Say 'enzyme that processes the "
    "drug' instead of 'metabolizes'; 'turns into the form that works' "
    "instead of 'activates' or 'metabolite formation'; 'slows down' "
    "instead of 'inhibits'; 'reduced speed' instead of 'reduced function'; "
    "'speeds up' instead of 'induces'; 'builds up' instead of 'increased "
    "exposure'.\n"
    "- Do NOT use metaphors or analogies. Stay literal — describe what "
    "the biology actually does. No 'kitchen,' no 'switch,' no 'gas pedal.'\n"
    "- Keep these exact: drug names, gene names (CYP2C19, CYP2D6, "
    "VKORC1, SLCO1B1, TPMT), and CPIC phenotype labels (intermediate "
    "metabolizer, poor metabolizer, etc.). Don't reword these.\n"
    "- Target an 8th-grade reading level. If a sentence would need a "
    "glossary, rewrite it.\n"
    "- Prefer short paragraphs and numbered lists for multi-step "
    "reasoning, not dense prose.\n\n"
    "Keep replies under 150 words. End each reply with one concrete question "
    "the user could ask their clinician or pharmacist."
)

# ── Live CPIC API ─────────────────────────────────────────────────────────────
# Run-time lookup against api.cpicpgx.org. CPIC publishes the authoritative
# clinical recommendation for every (gene, drug, phenotype) tuple they cover;
# we let the chat agent fetch the verbatim text and then paraphrase it. The
# bundled drugs.json stays as the fast / offline fallback.
CPIC_API_BASE = "https://api.cpicpgx.org/v1"
CPIC_TIMEOUT_S = 6.0

# Drugid (RxNorm) lookups are stable; cache forever in-memory. Bool False
# sentinel means "we looked and CPIC has no entry for this drug name."
_CPIC_DRUGID_CACHE: dict[str, Optional[str]] = {}
_CPIC_RECS_CACHE: dict[str, list[dict]] = {}


def _cpic_get_json(url: str) -> Optional[object]:
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=CPIC_TIMEOUT_S) as resp:
            return json.loads(resp.read())
    except Exception:
        return None


def _cpic_drugid(drug_name: str) -> Optional[str]:
    key = drug_name.lower().strip()
    if key in _CPIC_DRUGID_CACHE:
        return _CPIC_DRUGID_CACHE[key]
    url = (
        f"{CPIC_API_BASE}/drug?name=eq.{urllib.parse.quote(key)}"
        "&select=drugid&limit=1"
    )
    data = _cpic_get_json(url)
    drugid: Optional[str] = None
    if isinstance(data, list) and data:
        drugid = data[0].get("drugid") if isinstance(data[0], dict) else None
    _CPIC_DRUGID_CACHE[key] = drugid
    return drugid


def _cpic_lookup(gene: str, drug: str, phenotype: str) -> Optional[dict]:
    """Fetch (and cache) CPIC's recommendation for (gene, drug, phenotype).

    Returns a dict with the verbatim CPIC text fields, or None on miss /
    network failure. Case-insensitive match on the phenotype string against
    CPIC's own labels (CPIC's casing differs slightly from ours; matching
    case-insensitively avoids a fragile mapping table).
    """
    drugid = _cpic_drugid(drug)
    if not drugid:
        return None
    cache_key = f"{drugid}"
    recs = _CPIC_RECS_CACHE.get(cache_key)
    if recs is None:
        url = (
            f"{CPIC_API_BASE}/recommendation"
            f"?drugid=eq.{urllib.parse.quote(drugid)}"
            "&select=phenotypes,implications,drugrecommendation,classification,population"
            "&limit=200"
        )
        data = _cpic_get_json(url)
        if not isinstance(data, list):
            return None
        recs = data
        _CPIC_RECS_CACHE[cache_key] = recs
    pheno_lc = phenotype.lower().strip()
    gene_uc = gene.upper().strip()
    for rec in recs:
        if not isinstance(rec, dict):
            continue
        phenos = rec.get("phenotypes") or {}
        gene_pheno = phenos.get(gene_uc)
        if not gene_pheno:
            continue
        if gene_pheno.lower().strip() != pheno_lc:
            continue
        return {
            "cpic_phenotype": gene_pheno,
            "implications": (rec.get("implications") or {}).get(gene_uc, ""),
            "drugrecommendation": rec.get("drugrecommendation", ""),
            "classification": rec.get("classification", ""),
            "population": rec.get("population", "general"),
            "source_url": (
                f"{CPIC_API_BASE}/recommendation?drugid=eq.{drugid}"
            ),
        }
    return None


CHAT_TOOLS = [
    {
        "name": "get_gene_status",
        "description": (
            "Read the user's metabolizer phenotype for a specific pharmacogene "
            "(CYP2C19, CYP2C9, VKORC1, SLCO1B1, TPMT, CYP2D6). Returns the "
            "phenotype the deterministic engine called from the user's DNA "
            "file, or 'not loaded' if the user hasn't loaded a file yet."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "gene": {
                    "type": "string",
                    "description": "Gene symbol, uppercase.",
                },
            },
            "required": ["gene"],
        },
    },
    {
        "name": "get_drug_guidance",
        "description": (
            "Look up the bundled CPIC/FDA guidance for a specific drug at the "
            "user's current phenotype for the relevant gene. Returns the "
            "flag color (green/amber/red/gray), the bundled recommendation "
            "text, and its source. Fast path. Use this before commenting on "
            "any specific drug; never paraphrase guidance you haven't "
            "looked up. Prefer `lookup_cpic_recommendation` when you want "
            "the authoritative CPIC text verbatim."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "gene": {"type": "string"},
                "drug": {"type": "string"},
            },
            "required": ["gene", "drug"],
        },
    },
    {
        "name": "lookup_cpic_recommendation",
        "description": (
            "Fetch the LIVE CPIC recommendation from api.cpicpgx.org for a "
            "specific (gene, drug, phenotype) combination. Returns CPIC's "
            "verbatim clinical implications text, CPIC's actual drug "
            "recommendation, and CPIC's evidence-strength classification "
            "(Strong / Moderate / Optional / No Recommendation). Use this "
            "as the primary tool whenever the user asks about a specific "
            "medication — paraphrase the verbatim CPIC text into plain "
            "language without changing the medical meaning. Falls back to "
            "the bundled guidance if the CPIC API is unreachable."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "gene": {"type": "string"},
                "drug": {"type": "string"},
                "phenotype": {
                    "type": "string",
                    "description": (
                        "The user's phenotype for this gene exactly as "
                        "returned by get_gene_status — e.g. 'Intermediate "
                        "metabolizer', 'Poor metabolizer'."
                    ),
                },
            },
            "required": ["gene", "drug", "phenotype"],
        },
    },
    {
        "name": "check_drug_interactions",
        "description": (
            "Run the deterministic interaction engine against the user's "
            "current medication list. Returns flagged drug-drug interactions, "
            "phenoconversion (an inhibitor/inducer changing the user's "
            "effective phenotype), and drug-gene conflicts. All flags come "
            "from bundled FDA/CPIC tables — nothing is invented."
        ),
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
    {
        "name": "suggest_clinician_questions",
        "description": (
            "Generate 4-6 specific questions the user should bring to their "
            "doctor or pharmacist, based on their phenotypes and current "
            "medications. Use when the user wants a takeaway list, not "
            "drug-specific guidance."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "focus_topic": {
                    "type": "string",
                    "description": "Optional topic to focus the questions on.",
                },
            },
            "required": [],
        },
    },
]

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


# BUILD_SPEC §12a + FLETCHER_REVIEW.md §2: one endpoint, one validator, one
# cache. The three legacy paths (/api/explain, /api/questions, /api/check-meds)
# collapse into POST /api/explain with a `kind` discriminator. The request body
# is a Pydantic discriminated union — each kind brings only the fields it needs,
# and field validators stay load-bearing for the security boundary.
class ExplainKindRequest(BaseModel):
    kind: Literal["explain"]
    gene: str = Field(..., max_length=20)
    phenotype: str = Field(..., max_length=40)
    drug: str = Field(..., max_length=60)
    coverage_state: str = Field(default="confident", max_length=20)

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

    @field_validator("coverage_state")
    @classmethod
    def coverage_in_allowlist(cls, v: str) -> str:
        if v not in _COVERAGE_STATES:
            raise ValueError(f"coverage_state '{v[:20]}' is not a known state")
        return v

    def assert_tuple_known(self) -> None:
        if (self.gene, self.phenotype, self.drug) not in _ALLOWED_TUPLES:
            raise HTTPException(
                status_code=400,
                detail="(gene, phenotype, drug) tuple is not in the bundled guidance set",
            )


class QuestionsKindRequest(BaseModel):
    kind: Literal["questions"]
    phenotypes: list[PhenotypeSummary] = Field(..., max_length=20)
    medications: list[str] = Field(default_factory=list, max_length=30)


class InteractionsKindRequest(BaseModel):
    kind: Literal["interactions"]
    phenotypes: list[PhenotypeSummary] = Field(..., max_length=20)
    medications: list[str] = Field(..., min_length=1, max_length=30)

    @field_validator("medications")
    @classmethod
    def reject_dna_meds(cls, v: list[str]) -> list[str]:
        for med in v:
            _reject_dna_shaped(med)
        return v


class ChatTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(..., max_length=4000)

    @field_validator("content")
    @classmethod
    def reject_dna_content(cls, v: str) -> str:
        return _reject_dna_shaped(v)


class ChatKindRequest(BaseModel):
    kind: Literal["chat"]
    message: str = Field(..., max_length=2000)
    conversation: list[ChatTurn] = Field(default_factory=list, max_length=20)
    phenotypes: list[PhenotypeSummary] = Field(default_factory=list, max_length=20)
    medications: list[str] = Field(default_factory=list, max_length=30)

    @field_validator("message")
    @classmethod
    def reject_dna_message(cls, v: str) -> str:
        return _reject_dna_shaped(v)

    @field_validator("medications")
    @classmethod
    def reject_dna_meds(cls, v: list[str]) -> list[str]:
        for med in v:
            _reject_dna_shaped(med)
        return v


ExplainEndpointRequest = Annotated[
    Union[
        ExplainKindRequest,
        QuestionsKindRequest,
        InteractionsKindRequest,
        ChatKindRequest,
    ],
    Field(discriminator="kind"),
]


class ExplainResponse(BaseModel):
    explanation: str
    source: Literal["bundle", "claude", "fallback"]


class QuestionsResponse(BaseModel):
    questions: list[str]


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


class ChatToolCall(BaseModel):
    tool: str
    input: dict


class ChatResponse(BaseModel):
    reply: str
    tool_trace: list[ChatToolCall] = Field(default_factory=list)
    source: Literal["claude", "fallback"]


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


def _handle_explain(req: ExplainKindRequest) -> ExplainResponse:
    # Spec §12b: also assert the tuple is one we actually have guidance for.
    # Individual fields can be valid in isolation but the combination might
    # be one we never authored (e.g. CYP2C19 + simvastatin).
    req.assert_tuple_known()

    # Spec §12b step 2: bundle lookup first. A precomputed hit is the happy
    # path; a live Claude call is the rare fallback. Key shape matches
    # scripts/precompute_explanations.py.
    bundle_key = f"{req.gene}|{req.phenotype}|{req.drug}|{req.coverage_state}"
    cached = _EXPLANATIONS.get(bundle_key)
    if cached:
        return ExplainResponse(explanation=cached, source="bundle")

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


def _handle_questions(req: QuestionsKindRequest) -> QuestionsResponse:
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


# Map drugs.json color flags onto Flag.severity. Green is skipped entirely —
# the interactions panel surfaces concerns, not confirmations. Gray ("we
# couldn't determine your status") is worth surfacing as info so the user
# knows to raise it with a clinician.
_COLOR_TO_SEVERITY = {
    "red": "avoid",
    "amber": "caution",
    "gray": "info",
}


def _normalize_drug(name: str) -> str:
    """Match medications case-insensitively against the bundled tables."""
    return name.strip().lower()


def _handle_interactions(req: InteractionsKindRequest) -> InteractionsResponse:
    """Deterministic interactions engine (BUILD_SPEC §1.5, §11).

    No Claude call. The three categories are looked up against bundled
    tables (`drugs.json` for drug-gene, `interactions.json` for drug-drug
    and phenoconversion) so the clinical content is auditable. Claude's
    only role in this product is paraphrasing canonical text — and that
    happens in `_handle_explain`, not here.
    """
    meds_normalized = [_normalize_drug(m) for m in req.medications]
    meds_set = set(meds_normalized)

    drug_gene_flags: list[Flag] = []
    drug_drug_flags: list[Flag] = []
    phenoconv_flags: list[Flag] = []

    # --- (1) Drug-gene: every (phenotype, med) where we have canonical
    # guidance in drugs.json. Skip green; surface amber/red/gray.
    seen_drug_gene: set[tuple[str, str, str]] = set()
    for pheno in req.phenotypes:
        by_drug = _DRUGS_GUIDANCE.get(pheno.gene, {})
        for med_norm, med_display in zip(meds_normalized, req.medications):
            row = by_drug.get(med_norm)
            if not row:
                continue
            guidance = row.get(pheno.phenotype)
            if not guidance:
                continue
            color = (guidance.get("flag") or "").lower()
            severity = _COLOR_TO_SEVERITY.get(color)
            if not severity:
                continue  # green or unknown — nothing to flag
            key = (pheno.gene, pheno.phenotype, med_norm)
            if key in seen_drug_gene:
                continue
            seen_drug_gene.add(key)
            drug_gene_flags.append(
                Flag(
                    flag=f"{pheno.gene} {pheno.phenotype} + {med_display}",
                    severity=severity,
                    explanation=guidance.get("recommendation", ""),
                    ask_clinician=(
                        f"How should my {pheno.gene} {pheno.phenotype} result "
                        f"shape how I take {med_display}?"
                    ),
                )
            )

    # --- (2) Drug-drug: both drugs of the pair must be in the user's list.
    for entry in _INTERACTIONS.get("drug_drug", []):
        pair = entry.get("drugs") or []
        if len(pair) < 2:
            continue
        pair_norm = [_normalize_drug(d) for d in pair]
        if not all(d in meds_set for d in pair_norm):
            continue
        drug_drug_flags.append(
            Flag(
                flag=" + ".join(pair),
                severity=entry.get("severity", "caution"),
                explanation=entry.get("summary", ""),
                ask_clinician=(
                    f"Is the {' + '.join(pair)} combination safe for me, or "
                    "should one of them be changed?"
                ),
            )
        )

    # --- (3) Phenoconversion: the user takes an inhibitor/inducer drug, and
    # their phenotype for the affected gene is one the shift applies to. The
    # CYP2D6 case is the load-bearing one — coverage is limited, so a
    # drug-induced flip is the part we *can* honestly flag.
    pheno_by_gene = {p.gene: p.phenotype for p in req.phenotypes}
    for entry in _INTERACTIONS.get("phenoconversion", []):
        drug_norm = _normalize_drug(entry.get("drug", ""))
        if drug_norm not in meds_set:
            continue
        gene = entry.get("affects_gene")
        if not gene:
            continue
        current_pheno = pheno_by_gene.get(gene)
        applicable = set(entry.get("applicable_from_phenotypes") or [])
        # If we have no phenotype for this gene at all (gene wasn't called or
        # user didn't submit it), still flag — phenoconversion matters most
        # when the genetic status is unknown (BUILD_SPEC §11, CYP2D6 case).
        if current_pheno is not None and applicable and current_pheno not in applicable:
            continue
        effect = entry.get("effect", "modulates")
        magnitude = entry.get("magnitude", "")
        magnitude_label = f"{magnitude} " if magnitude else ""
        flag_label = (
            f"{entry.get('drug', drug_norm)} is a {magnitude_label}{gene} {effect}"
        )
        phenoconv_flags.append(
            Flag(
                flag=flag_label,
                severity="caution",
                explanation=entry.get("summary", ""),
                ask_clinician=(
                    f"Could {entry.get('drug', drug_norm)} be changing how my "
                    f"body handles {gene} drugs while I'm on it?"
                ),
            )
        )

    return InteractionsResponse(
        drug_gene=drug_gene_flags,
        drug_drug=drug_drug_flags,
        phenoconversion=phenoconv_flags,
    )


# Lookup the drugs.json drug key by case-insensitive match (the bundle uses
# lowercase canonical names; the user / model may type any casing).
_ALLOWED_DRUGS_LC = {d.lower(): d for d in _ALLOWED_DRUGS}


def _execute_chat_tool(
    name: str,
    tool_input: dict,
    req: "ChatKindRequest",
    pheno_by_gene: dict[str, str],
) -> str:
    """Run one chat tool. Returns a plain-text result string for the model.

    Tools are deliberately *strict*: unknown gene/drug arguments don't crash —
    they return a polite error that the model can recover from. Tool inputs
    cannot bypass the security boundary (allowlists, DNA-shape reject), since
    every gene/drug is validated against the bundled set before it's used.
    """
    if name == "get_gene_status":
        gene = (tool_input.get("gene") or "").strip()
        if gene not in _ALLOWED_GENES:
            return (
                f"Unknown gene '{gene}'. Known genes: "
                f"{', '.join(sorted(_ALLOWED_GENES))}."
            )
        phenotype = pheno_by_gene.get(gene)
        if not phenotype:
            return (
                f"{gene} status not loaded. The user needs to load their DNA "
                "file before this gene can be read."
            )
        return f"{gene}: {phenotype}"

    if name == "get_drug_guidance":
        gene = (tool_input.get("gene") or "").strip()
        raw_drug = (tool_input.get("drug") or "").strip()
        drug = _ALLOWED_DRUGS_LC.get(raw_drug.lower())
        if gene not in _ALLOWED_GENES:
            return f"Unknown gene '{gene}'."
        if not drug:
            return (
                f"Unknown drug '{raw_drug}'. Known drugs: "
                f"{', '.join(sorted(_ALLOWED_DRUGS))}."
            )
        phenotype = pheno_by_gene.get(gene)
        if not phenotype:
            return (
                f"{gene} status not loaded — cannot fetch {drug} guidance "
                "specific to this user."
            )
        if (gene, phenotype, drug) not in _ALLOWED_TUPLES:
            return (
                f"No bundled guidance for {gene} + {phenotype} + {drug}. "
                "This combination isn't in our authored set."
            )
        row = _DRUGS_GUIDANCE.get(gene, {}).get(drug, {}).get(phenotype)
        if not row:
            return f"No bundled guidance row for ({gene}, {phenotype}, {drug})."
        return (
            f"{gene} {phenotype} taking {drug}:\n"
            f"Flag: {row.get('flag', 'unknown')}\n"
            f"Recommendation: {row.get('recommendation', '')}\n"
            f"Source: {row.get('source', 'CPIC')}"
        )

    if name == "lookup_cpic_recommendation":
        gene = (tool_input.get("gene") or "").strip()
        raw_drug = (tool_input.get("drug") or "").strip()
        drug = _ALLOWED_DRUGS_LC.get(raw_drug.lower(), raw_drug)
        raw_phenotype = (tool_input.get("phenotype") or "").strip()
        if gene not in _ALLOWED_GENES:
            return f"Unknown gene '{gene}'."
        if raw_phenotype not in _ALLOWED_PHENOTYPES:
            return f"Unknown phenotype '{raw_phenotype}'."
        cpic = _cpic_lookup(gene, drug, raw_phenotype)
        if cpic:
            return (
                f"CPIC live lookup (source: api.cpicpgx.org/v1/recommendation):\n"
                f"Gene: {gene}\n"
                f"CPIC phenotype: {cpic['cpic_phenotype']}\n"
                f"Drug: {drug}\n"
                f"Population: {cpic['population']}\n"
                f"Implications (CPIC verbatim): {cpic['implications']}\n"
                f"Recommendation (CPIC verbatim): {cpic['drugrecommendation']}\n"
                f"Evidence classification: {cpic['classification']}"
            )
        row = _DRUGS_GUIDANCE.get(gene, {}).get(drug, {}).get(raw_phenotype)
        if not row:
            return (
                f"CPIC API returned no match for {gene} + {drug} + "
                f"{raw_phenotype}, and no bundled fallback exists for this "
                "combination. Tell the user this specific combination isn't "
                "in CPIC's authored set."
            )
        return (
            f"CPIC API miss or unreachable; falling back to bundled "
            f"guidance for {gene} {raw_phenotype} + {drug}:\n"
            f"Flag: {row.get('flag', 'unknown')}\n"
            f"Recommendation: {row.get('recommendation', '')}\n"
            f"Source: {row.get('source', 'CPIC (bundled)')}"
        )

    if name == "check_drug_interactions":
        if not req.medications:
            return (
                "The user hasn't entered any medications yet. Ask them which "
                "medications they're taking before calling this tool."
            )
        try:
            int_req = InteractionsKindRequest(
                kind="interactions",
                phenotypes=req.phenotypes,
                medications=req.medications,
            )
        except (ValidationError, ValueError) as exc:
            return f"Interaction check rejected input: {exc}"
        result = _handle_interactions(int_req)
        if not (result.drug_gene or result.drug_drug or result.phenoconversion):
            return "No flagged interactions for this medication list."
        lines: list[str] = []
        if result.drug_gene:
            lines.append("Drug-gene flags:")
            for f in result.drug_gene:
                lines.append(f"- [{f.severity}] {f.flag}: {f.explanation}")
        if result.drug_drug:
            lines.append("Drug-drug interactions:")
            for f in result.drug_drug:
                lines.append(f"- [{f.severity}] {f.flag}: {f.explanation}")
        if result.phenoconversion:
            lines.append("Phenoconversion (inhibitor / inducer shifts):")
            for f in result.phenoconversion:
                lines.append(f"- [{f.severity}] {f.flag}: {f.explanation}")
        return "\n".join(lines)

    if name == "suggest_clinician_questions":
        if not req.phenotypes and not req.medications:
            return (
                "No phenotypes or medications loaded yet. Ask the user to "
                "load a DNA file and / or enter their medications first."
            )
        try:
            q_req = QuestionsKindRequest(
                kind="questions",
                phenotypes=req.phenotypes,
                medications=req.medications,
            )
        except (ValidationError, ValueError) as exc:
            return f"Questions tool rejected input: {exc}"
        result = _handle_questions(q_req)
        if not result.questions:
            return "No questions were generated."
        focus = (tool_input.get("focus_topic") or "").strip()
        prefix = (
            f"Clinician questions (focus: {focus}):\n" if focus
            else "Clinician questions:\n"
        )
        return prefix + "\n".join(f"- {q}" for q in result.questions)

    return f"Unknown tool: {name}"


def _handle_chat(req: ChatKindRequest) -> ChatResponse:
    """Chat loop with tool-use against the deterministic spine.

    Architecture (Lindsay's framing): the model receives the user's prior
    conversation plus a context block listing the verified phenotypes and
    medication names. It chooses which of four tools to call; the tools run
    against the bundled data; results are fed back. After a final non-tool-use
    turn (or after a step cap), the assistant text is returned along with a
    trace of which tools fired — the trace lets the UI render Lindsay's
    "underneath, it's a calculator" demo moment.
    """
    pheno_by_gene = {p.gene: p.phenotype for p in req.phenotypes}

    context_lines: list[str] = []
    if req.phenotypes:
        context_lines.append("Verified phenotypes (read deterministically from the user's DNA file):")
        for p in req.phenotypes:
            context_lines.append(f"- {p.gene}: {p.phenotype}")
    else:
        context_lines.append("No DNA file has been loaded yet — phenotype tools will return 'not loaded'.")
    if req.medications:
        context_lines.append(
            "Current medications the user reported: " + ", ".join(req.medications)
        )
    else:
        context_lines.append("No medications reported yet.")
    context_block = "\n".join(context_lines)

    messages: list[dict] = []
    for turn in req.conversation:
        messages.append({"role": turn.role, "content": turn.content})
    augmented_user_message = (
        f"[Context]\n{context_block}\n\n[User question]\n{req.message}"
    )
    messages.append({"role": "user", "content": augmented_user_message})

    tool_trace: list[ChatToolCall] = []
    MAX_ITERATIONS = 6

    for _ in range(MAX_ITERATIONS):
        try:
            response = client.messages.create(
                model=MODEL,
                max_tokens=1024,
                system=CHAT_SYSTEM,
                tools=CHAT_TOOLS,
                messages=messages,
            )
        except APIError:
            return ChatResponse(
                reply=(
                    "I couldn't reach the language model right now. The "
                    "deterministic results from your DNA are still available "
                    "in the main app — please try again in a moment."
                ),
                tool_trace=tool_trace,
                source="fallback",
            )

        if response.stop_reason != "tool_use":
            text = "".join(
                b.text for b in response.content if getattr(b, "type", None) == "text"
            ).strip()
            return ChatResponse(
                reply=text or "I don't have a response for that.",
                tool_trace=tool_trace,
                source="claude",
            )

        # Re-append assistant turn verbatim so the next call sees the tool_use.
        messages.append(
            {
                "role": "assistant",
                "content": [b.model_dump() for b in response.content],
            }
        )
        tool_result_blocks: list[dict] = []
        for block in response.content:
            if getattr(block, "type", None) != "tool_use":
                continue
            block_input = dict(block.input) if hasattr(block, "input") else {}
            tool_trace.append(ChatToolCall(tool=block.name, input=block_input))
            result_text = _execute_chat_tool(
                block.name, block_input, req, pheno_by_gene
            )
            tool_result_blocks.append(
                {
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": result_text,
                }
            )
        messages.append({"role": "user", "content": tool_result_blocks})

    return ChatResponse(
        reply=(
            "I ran out of steps trying to answer that. Try asking something "
            "narrower, like 'what does my CYP2C19 status mean for clopidogrel?'"
        ),
        tool_trace=tool_trace,
        source="claude",
    )


# BUILD_SPEC §12a says one endpoint. /api/questions and /api/check-meds are
# gone; both behaviors live here under kind="questions" / kind="interactions".
# response_model is None because the response shape is per-kind — FastAPI still
# serializes the returned Pydantic model correctly.
@app.post(
    "/api/explain",
    response_model=None,
    dependencies=[Depends(rate_limit)],
)
def explain(req: ExplainEndpointRequest):
    if isinstance(req, ExplainKindRequest):
        return _handle_explain(req)
    if isinstance(req, QuestionsKindRequest):
        return _handle_questions(req)
    if isinstance(req, InteractionsKindRequest):
        return _handle_interactions(req)
    if isinstance(req, ChatKindRequest):
        return _handle_chat(req)
    # Discriminated union should make this unreachable, but be loud if not.
    raise HTTPException(status_code=400, detail="unknown kind")
