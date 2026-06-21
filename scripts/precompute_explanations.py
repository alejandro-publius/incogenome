"""
DoseDNA build-time precompute script for explanations.json.

Implements BUILD_SPEC sections:
  - Section 13 (precompute pipeline: enumerate -> batch -> validate -> static JSON)
  - Section 12 (mirrors the server-side EXPLAIN_SYSTEM prompt from server/proxy.py)
  - Section 15 (post-validation denylist: no specific doses, no imperative dosing,
                no drug names other than the input drug, no clinical claims)

What it does
------------
1. Enumerates every valid (gene, phenotype, drug, coverage_state) tuple from
   src/data/genes.json and src/data/drugs.json.
2. Builds one Claude request per tuple using a system prompt re-read at runtime
   from server/proxy.py (the EXPLAIN_SYSTEM constant), so the wording stays in
   sync with the live proxy.
3. Submits ALL requests as a single Anthropic Message Batch
   (https://docs.anthropic.com/en/api/creating-message-batches), polls until
   processing_status == "ended".
4. Post-validates every result against a denylist; passing entries go to
   src/data/explanations.json, failures go to /tmp/dosedna_review.jsonl.

Usage
-----
  # Cost estimate / sanity check (no API call):
  python scripts/precompute_explanations.py --dry-run

  # Real run (writes src/data/explanations.json):
  python scripts/precompute_explanations.py

  # Resume an in-flight batch by id (skips submission):
  python scripts/precompute_explanations.py --resume msgbatch_01abc...

Env: ANTHROPIC_API_KEY must be set for real / resume runs.

Constraints
-----------
- Python 3.9+. No `match` statements; uses typing.Optional, not the X | Y syntax.
- Only deps are `anthropic` (already in server/requirements.txt) and stdlib.
- Re-reads EXPLAIN_SYSTEM from server/proxy.py at runtime so it never drifts
  from the live proxy.
"""

import argparse
import ast
import datetime
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple


# --- Repo layout --------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent
GENES_PATH = REPO_ROOT / "src" / "data" / "genes.json"
DRUGS_PATH = REPO_ROOT / "src" / "data" / "drugs.json"
PROXY_PATH = REPO_ROOT / "server" / "proxy.py"
OUTPUT_PATH = REPO_ROOT / "src" / "data" / "explanations.json"
REVIEW_PATH = Path("/tmp/dosedna_review.jsonl")

MODEL = "claude-haiku-4-5"

# Coverage states per BUILD_SPEC Section 8b. The bundle key uses these literal
# strings; the server's Pydantic schema constrains the same set.
COVERAGE_STATES = ["confident", "partial", "not-callable"]

# Per-tuple budget for the explanation. EXPLAIN_SYSTEM caps the response at
# <120 words; 400 tokens is comfortably enough headroom.
MAX_TOKENS_PER_REQUEST = 400

# Token-budget guesses for cost estimation in --dry-run. These are rough — the
# real call will return exact usage. ~250 input tokens covers the system prompt
# + the canonical guidance block we paste in; ~180 output tokens is the upper
# bound for a <120-word explanation.
EST_INPUT_TOKENS_PER_REQUEST = 250
EST_OUTPUT_TOKENS_PER_REQUEST = 180

# Batch pricing for claude-haiku-4-5, confirmed against
# https://docs.anthropic.com/en/docs/about-claude/pricing on 2026-06-20:
# input $0.50/MTok, output $2.50/MTok with the 50% Batch API discount.
# Standard (non-batch) is $1 / $5 per MTok. The user asked for the standard
# numbers in the --dry-run printout, so estimate both and print both.
PRICE_INPUT_PER_MTOK_STD = 1.00
PRICE_OUTPUT_PER_MTOK_STD = 5.00
PRICE_INPUT_PER_MTOK_BATCH = 0.50
PRICE_OUTPUT_PER_MTOK_BATCH = 2.50


# --- Pull EXPLAIN_SYSTEM out of server/proxy.py at runtime --------------------
# We re-read the proxy file and pluck the constant via AST. This keeps the
# precompute and the live fallback path using identical wording without an
# import dependency on FastAPI / pydantic / dotenv (which would force the user
# to install the whole server requirements just to run the script).

def load_explain_system(proxy_path: Path) -> str:
    src = proxy_path.read_text(encoding="utf-8")
    tree = ast.parse(src)
    for node in tree.body:
        if isinstance(node, ast.Assign):
            for target in node.targets:
                if isinstance(target, ast.Name) and target.id == "EXPLAIN_SYSTEM":
                    try:
                        return ast.literal_eval(node.value)
                    except (ValueError, SyntaxError) as exc:
                        raise SystemExit(
                            "Could not literal_eval EXPLAIN_SYSTEM from "
                            "server/proxy.py: " + str(exc)
                        )
    raise SystemExit(
        "EXPLAIN_SYSTEM constant not found in " + str(proxy_path) +
        ". Did the proxy refactor it away?"
    )


# --- Enumeration --------------------------------------------------------------

def phenotypes_for_gene(gene_def: Dict[str, Any]) -> List[str]:
    """Collect the set of possible phenotype labels for a gene.

    Reads diplotype_to_phenotype, activity_score_to_phenotype,
    single_snp_to_phenotype, variant_count_to_phenotype, or fixed_phenotype.
    De-dupes while preserving first-seen order (deterministic for batch keys).
    """
    seen: List[str] = []

    def add(label: str) -> None:
        if label and label not in seen:
            seen.append(label)

    if "fixed_phenotype" in gene_def:
        add(gene_def["fixed_phenotype"])

    for map_key in (
        "diplotype_to_phenotype",
        "activity_score_to_phenotype",
        "single_snp_to_phenotype",
        "variant_count_to_phenotype",
    ):
        m = gene_def.get(map_key)
        if isinstance(m, dict):
            for label in m.values():
                add(label)

    return seen


def enumerate_tuples(
    genes_data: Dict[str, Any], drugs_data: Dict[str, Any]
) -> List[Tuple[str, str, str, str]]:
    """Build the full list of (gene, phenotype, drug, coverage_state) tuples.

    Rules (BUILD_SPEC §13 step 1):
      - For each gene, gather possible phenotypes from its rule map.
      - Emit a (gene, phenotype, drug, coverage_state) only when drugs.json
        contains a guidance row for that gene+drug+phenotype. This is the
        filter that keeps the combinatorics from blowing up — drugs.json
        controls relevance.
      - Additionally emit a (gene, 'Not determined', drug, coverage_state) row
        for every gene+drug pair, since 'Not determined' is the partial /
        not-callable phenotype that collapses to a generic message.
      - All three coverage states are emitted for every (gene, phenotype, drug)
        we keep. The runtime lookup keys on coverage_state, so we need entries
        at all three.
    """
    genes_section = genes_data["genes"]
    drugs_section = drugs_data["drugs"]

    out: List[Tuple[str, str, str, str]] = []
    for gene, gene_def in genes_section.items():
        gene_drugs = drugs_section.get(gene, {})
        if not gene_drugs:
            continue

        gene_phenotypes = phenotypes_for_gene(gene_def)

        for drug, drug_pheno_map in gene_drugs.items():
            # Real phenotypes: only emit if drugs.json has a row for that
            # exact (gene, phenotype, drug). drugs.json is the canonical
            # relevance filter.
            for phenotype in gene_phenotypes:
                if phenotype == "Not determined":
                    continue
                if phenotype in drug_pheno_map:
                    for coverage in COVERAGE_STATES:
                        out.append((gene, phenotype, drug, coverage))

            # Not-determined entry, one per (gene, drug) per coverage state.
            # Covers partial / not-callable / confident-but-genuinely-undet.
            for coverage in COVERAGE_STATES:
                out.append((gene, "Not determined", drug, coverage))

    return out


# --- Request body construction ------------------------------------------------

def tuple_key(gene: str, phenotype: str, drug: str, coverage: str) -> str:
    return "|".join([gene, phenotype, drug, coverage])


def canonical_guidance(
    drugs_data: Dict[str, Any], gene: str, drug: str, phenotype: str
) -> Optional[Dict[str, Any]]:
    """Look up the canonical drug guidance row, or None if not present."""
    return (
        drugs_data["drugs"]
        .get(gene, {})
        .get(drug, {})
        .get(phenotype)
    )


COVERAGE_PHRASING = {
    "confident": (
        "Coverage: every variant needed to call this gene was readable in the "
        "user's file."
    ),
    "partial": (
        "Coverage: some defining positions were missing or no-call in the "
        "user's file, so the result is directional rather than definitive."
    ),
    "not-callable": (
        "Coverage: this gene could not be reliably called from the user's "
        "consumer DNA file (structural variation or missing positions)."
    ),
}


def build_user_message(
    gene: str,
    phenotype: str,
    drug: str,
    coverage: str,
    drugs_data: Dict[str, Any],
) -> str:
    """Compose the user message from validated fields plus canonical guidance.

    Mirrors the server's "structured fields wrapped in canonical text" rule
    (§12a) — never echoes raw user input.
    """
    if phenotype == "Not determined":
        # Not-determined collapses across drugs to a generic message about
        # incomplete coverage. We still mention the gene and drug so the
        # explanation can reference what couldn't be assessed.
        return (
            "A user uploaded a consumer DNA file and asked about " + drug + ".\n"
            "Their " + gene + " status could not be determined from this file.\n"
            + COVERAGE_PHRASING[coverage] + "\n\n"
            "Explain in plain language (<120 words) that we could not fully "
            "read this gene from their file, why that matters for " + drug +
            ", and one concrete question they could ask their clinician. Do "
            "NOT speculate about what their phenotype might be. Do NOT name "
            "any medication other than " + drug + "."
        )

    guidance = canonical_guidance(drugs_data, gene, drug, phenotype) or {}
    canonical_text = guidance.get("recommendation", "")
    source = guidance.get("source", "CPIC")

    return (
        "A user uploaded a consumer DNA file. The deterministic pipeline "
        "produced the following verified result:\n"
        "Gene: " + gene + "\n"
        "Phenotype: " + phenotype + "\n"
        "Drug: " + drug + "\n"
        + COVERAGE_PHRASING[coverage] + "\n\n"
        "Canonical guidance (source: " + source + "):\n"
        '"' + canonical_text + '"\n\n'
        "Explain the verified result above in plain language (<120 words). "
        "Do not contradict the canonical guidance. Do not state any specific "
        "dose in mg/mcg/ml/units/tablets. Do not give imperative instructions "
        "to take, stop, start, increase, or decrease a medication. Do not "
        "name any medication other than " + drug + ". End with one concrete "
        "question the patient could ask their doctor or pharmacist."
    )


def build_batch_request(
    custom_id: str,
    system_prompt: str,
    user_message: str,
) -> Dict[str, Any]:
    """Shape one entry of the Message Batches `requests` array.

    Reference: https://docs.anthropic.com/en/api/creating-message-batches
    """
    return {
        "custom_id": custom_id,
        "params": {
            "model": MODEL,
            "max_tokens": MAX_TOKENS_PER_REQUEST,
            "system": system_prompt,
            "messages": [{"role": "user", "content": user_message}],
        },
    }


# --- Post-validation (denylist) -----------------------------------------------

# Per BUILD_SPEC §13 step 3 + §15. Hardened in response to red-team escapes:
# * Greek mu (U+03BC) vs micro-sign (U+00B5) — both must match.
# * Bare imperatives ("Stop taking warfarin immediately.") had no `you` anchor.
# * Decimal doses ("0.5 ml", "2.5 mg") were missed because the old regex
#   stopped after the leading integer.
# * Brand-name leakage (Prilosec/Plavix/Coumadin/...) was invisible because
#   drugs.json only carries generics.
# * Drug-class tokens (PPI/SSRI/statin/NSAID/...) leaked phenotype-level
#   prescribing guidance the model isn't supposed to give.

DENY_DOSE_RE = re.compile(
    r"\b(\d+(?:[.,]\d+)?|one|two|three|four|five|six|seven|eight|nine|ten|"
    r"twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)"
    r"[\s\-  ]*"
    r"(mg|mcg|[µμ]g|ml|mL|g|grams?|kg|iu|units?|tabs?|tablets?|caps?|"
    r"capsules?|drops?|puffs?|lozenges?|patch(?:es)?|"
    r"milligrams?|micrograms?|milliliters?)\b",
    re.IGNORECASE,
)

DENY_IMPERATIVE_RE = re.compile(
    # Form 1: sentence-initial bare imperative (with optional politeness prefix).
    r"(?:^|(?<=[.!?]\s))(?:please\s+|kindly\s+)?"
    r"(take|stop|start|increase|decrease|reduce|lower|raise|"
    r"double|halve|skip|switch|avoid|discontinue|hold|cut\s+back)\b"
    r"|"
    # Form 2: modal-anchored imperative ("you should/must/...", also "we",
    # "your doctor/clinician/pharmacist"). The 'd-better contraction is
    # matched both as "you'd better" (no space before 'd) and "you had better".
    r"\b(?:you|we|your\s+(?:doctor|clinician|pharmacist))"
    r"(?:\s+|'d\s+)"
    r"(should|must|need\s+to|have\s+to|ought\s+to|may\s+want\s+to|"
    r"better|had\s+better|are\s+supposed\s+to)\s+\w+"
    r"|"
    # Form 3: recommend-verb wrappers.
    r"\b(I|we|your\s+(?:doctor|clinician|pharmacist))\s+"
    r"(recommend|advise|suggest|urge)\b",
    re.IGNORECASE | re.MULTILINE,
)

DENY_CLINICAL_CLAIM_RE = re.compile(
    r"\b(diagnose[sd]?|cure[sd]?|prevent[sd]?|alleviate[sd]?|heal[sd]?|"
    r"reverse[sd]?|fix(?:es|ed)?|manage[sd]?|cause[sd]?|"
    r"protect[sd]?\s+(?:against|from)|treat(?:s|ed|ing)?)\b",
    re.IGNORECASE,
)

# Brand-name -> generic alias map. Keys are regex patterns (case-insensitive),
# values are the generic name. If a brand appears in text and its generic is
# not the input drug, the text fails. drugs.json carries only generics, so
# without this the model could substitute "Prilosec" for "omeprazole" and
# slip through.
BRAND_TO_GENERIC = {
    "prilosec": "omeprazole",
    "plavix": "clopidogrel",
    "coumadin": "warfarin",
    "jantoven": "warfarin",
    "zocor": "simvastatin",
    "lipitor": "atorvastatin",
    "crestor": "rosuvastatin",
    "celexa": "citalopram",
    "lexapro": "escitalopram",
    "vfend": "voriconazole",
    "ultram": "tramadol",
    "imuran": "azathioprine",
    "purinethol": "mercaptopurine",
    "tabloid": "thioguanine",
    "advil": "ibuprofen",
    "motrin": "ibuprofen",
    "dilantin": "phenytoin",
    "tylenol\\s+with\\s+codeine": "codeine",
    "nolvadex": "tamoxifen",
}

# Drug-class tokens. Flagged unconditionally — explanations should describe
# the patient's phenotype, not name a class. False positives flow to
# REVIEW_PATH (human review), not the production bundle.
DRUG_CLASS_TOKENS = [
    "ppi", "ppis", "ssri", "ssris", "snri", "snris", "nsaid", "nsaids",
    "statin", "statins", "anticoagulant", "anticoagulants", "thienopyridine",
    "thienopyridines", "thiopurine", "thiopurines", "opioid", "opioids",
]

# Precompiled for speed; each brand pattern bracketed with word boundaries.
_BRAND_PATTERNS = [
    (re.compile(r"\b" + pat + r"\b", re.IGNORECASE), generic)
    for pat, generic in BRAND_TO_GENERIC.items()
]
_CLASS_PATTERN = re.compile(
    r"\b(" + "|".join(re.escape(t) for t in DRUG_CLASS_TOKENS) + r")\b",
    re.IGNORECASE,
)


# Known drug names from drugs.json. We treat each drug as forbidden in any
# explanation whose input drug is something else. Built once at module load.

def collect_known_drugs(drugs_data: Dict[str, Any]) -> List[str]:
    out: List[str] = []
    seen = set()
    for gene_drugs in drugs_data["drugs"].values():
        for drug in gene_drugs.keys():
            d = drug.lower()
            if d not in seen:
                seen.add(d)
                out.append(d)
    return out


def validate_explanation(
    text: str,
    gene: str,
    phenotype: str,
    drug: str,
    coverage: str,
    known_drugs: List[str],
) -> Optional[str]:
    """Return None if the text passes; otherwise return a failure reason."""
    if not text or not text.strip():
        return "empty response"

    m = DENY_DOSE_RE.search(text)
    if m:
        return "contains specific dose: " + m.group(0)

    m = DENY_IMPERATIVE_RE.search(text)
    if m:
        return "contains imperative dosing: " + m.group(0).strip()

    m = DENY_CLINICAL_CLAIM_RE.search(text)
    if m:
        return "contains clinical claim: " + m.group(0)

    # Drug-name leakage: any known generic other than the input drug.
    lowered = text.lower()
    input_drug_lc = drug.lower()
    for other in known_drugs:
        if other == input_drug_lc:
            continue
        # Word-boundary match so "atorvastatin" doesn't trip on "statin".
        pattern = r"\b" + re.escape(other) + r"\b"
        if re.search(pattern, lowered):
            return "mentions other drug: " + other

    # Brand-name leakage: any brand whose generic is not the input drug.
    for brand_re, generic in _BRAND_PATTERNS:
        bm = brand_re.search(text)
        if bm and generic != input_drug_lc:
            return "mentions brand name: " + bm.group(0)

    # Drug-class leakage: flagged unconditionally.
    cm = _CLASS_PATTERN.search(text)
    if cm:
        return "mentions drug class: " + cm.group(0)

    return None


# --- Anthropic API plumbing ---------------------------------------------------

def make_client():
    """Lazy-import anthropic so --dry-run works without the SDK installed."""
    try:
        from anthropic import Anthropic
    except ImportError:
        raise SystemExit(
            "anthropic SDK not installed. Run "
            "`pip install -r server/requirements.txt`."
        )
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise SystemExit("ANTHROPIC_API_KEY env var not set.")
    return Anthropic(api_key=api_key)


def submit_batch(client, batch_requests: List[Dict[str, Any]]) -> str:
    """Create the batch and return its id."""
    print("Submitting batch of " + str(len(batch_requests)) + " requests...")
    batch = client.messages.batches.create(requests=batch_requests)
    print("Submitted " + batch.id)
    return batch.id


def poll_batch(client, batch_id: str, total: int) -> Any:
    """Poll until processing_status == 'ended'. Returns the final batch object.

    Prints progress as a fraction of total tuples whenever the count changes.
    """
    last_done = -1
    while True:
        batch = client.messages.batches.retrieve(batch_id)
        counts = batch.request_counts
        # counts has: processing, succeeded, errored, canceled, expired
        done = (
            getattr(counts, "succeeded", 0)
            + getattr(counts, "errored", 0)
            + getattr(counts, "canceled", 0)
            + getattr(counts, "expired", 0)
        )
        if done != last_done:
            pct = int(round(100 * done / total)) if total else 0
            print(
                "Polling: " + str(done) + "/" + str(total)
                + " complete (" + str(pct) + "%) status="
                + str(batch.processing_status)
            )
            last_done = done
        if batch.processing_status == "ended":
            return batch
        time.sleep(5)


def collect_results(client, batch_id: str) -> Dict[str, Dict[str, Any]]:
    """Stream the batch results and key them by custom_id."""
    results: Dict[str, Dict[str, Any]] = {}
    for entry in client.messages.batches.results(batch_id):
        # entry has: custom_id, result (with type: succeeded/errored/...)
        results[entry.custom_id] = entry  # store the raw entry object
    return results


def extract_text(message_obj: Any) -> str:
    """Pull the text out of a succeeded Message result."""
    chunks = []
    for block in getattr(message_obj, "content", []) or []:
        if getattr(block, "type", None) == "text":
            chunks.append(getattr(block, "text", ""))
    return "".join(chunks).strip()


# --- Cost estimation ----------------------------------------------------------

def estimate_cost(n_tuples: int) -> Tuple[float, float, float, float]:
    """Return (input_cost_std, output_cost_std, input_cost_batch, output_cost_batch)."""
    total_input = n_tuples * EST_INPUT_TOKENS_PER_REQUEST
    total_output = n_tuples * EST_OUTPUT_TOKENS_PER_REQUEST
    in_std = total_input * PRICE_INPUT_PER_MTOK_STD / 1_000_000
    out_std = total_output * PRICE_OUTPUT_PER_MTOK_STD / 1_000_000
    in_batch = total_input * PRICE_INPUT_PER_MTOK_BATCH / 1_000_000
    out_batch = total_output * PRICE_OUTPUT_PER_MTOK_BATCH / 1_000_000
    return in_std, out_std, in_batch, out_batch


# --- Main pipeline ------------------------------------------------------------

def run(args: argparse.Namespace) -> int:
    genes_data = json.loads(GENES_PATH.read_text(encoding="utf-8"))
    drugs_data = json.loads(DRUGS_PATH.read_text(encoding="utf-8"))
    system_prompt = load_explain_system(PROXY_PATH)
    known_drugs = collect_known_drugs(drugs_data)

    tuples = enumerate_tuples(genes_data, drugs_data)
    print("Enumerated " + str(len(tuples)) + " tuples")

    if args.dry_run:
        in_std, out_std, in_batch, out_batch = estimate_cost(len(tuples))
        print("--- Cost estimate (claude-haiku-4-5) ---")
        print(
            "Assumes ~" + str(EST_INPUT_TOKENS_PER_REQUEST)
            + " input + ~" + str(EST_OUTPUT_TOKENS_PER_REQUEST)
            + " output tokens per request."
        )
        print(
            "Standard API: input ${:.4f}".format(in_std)
            + " + output ${:.4f}".format(out_std)
            + " = ${:.4f}".format(in_std + out_std)
        )
        print(
            "Batch API   : input ${:.4f}".format(in_batch)
            + " + output ${:.4f}".format(out_batch)
            + " = ${:.4f}".format(in_batch + out_batch)
        )
        print(
            "Pricing confirmed against "
            "https://docs.anthropic.com/en/docs/about-claude/pricing"
        )
        # Show a sample request so the user can eyeball wording.
        if tuples:
            g, p, d, c = tuples[0]
            print("--- Sample request (tuple 0) ---")
            print("custom_id: " + tuple_key(g, p, d, c))
            print(build_user_message(g, p, d, c, drugs_data))
        return 0

    # Real or resume run.
    client = make_client()

    if args.resume:
        batch_id = args.resume
        print("Resuming batch " + batch_id)
    else:
        batch_requests = []
        for (g, p, d, c) in tuples:
            user_message = build_user_message(g, p, d, c, drugs_data)
            batch_requests.append(
                build_batch_request(
                    custom_id=tuple_key(g, p, d, c),
                    system_prompt=system_prompt,
                    user_message=user_message,
                )
            )
        batch_id = submit_batch(client, batch_requests)

    poll_batch(client, batch_id, total=len(tuples))
    print("Collecting results for " + batch_id + "...")
    results = collect_results(client, batch_id)

    # Validate + split.
    explanations: Dict[str, str] = {}
    review: List[Dict[str, Any]] = []
    ok = 0
    flagged = 0
    api_errors = 0

    for (g, p, d, c) in tuples:
        key = tuple_key(g, p, d, c)
        entry = results.get(key)
        if entry is None:
            review.append({
                "custom_id": key, "reason": "no result returned",
                "gene": g, "phenotype": p, "drug": d, "coverage_state": c,
            })
            api_errors += 1
            continue

        result_obj = getattr(entry, "result", None)
        result_type = getattr(result_obj, "type", None)
        if result_type != "succeeded":
            review.append({
                "custom_id": key,
                "reason": "batch result type: " + str(result_type),
                "gene": g, "phenotype": p, "drug": d, "coverage_state": c,
            })
            api_errors += 1
            continue

        message_obj = getattr(result_obj, "message", None)
        text = extract_text(message_obj) if message_obj is not None else ""
        failure = validate_explanation(text, g, p, d, c, known_drugs)
        if failure is None:
            explanations[key] = text
            ok += 1
        else:
            review.append({
                "custom_id": key,
                "reason": failure,
                "text": text,
                "gene": g, "phenotype": p, "drug": d, "coverage_state": c,
            })
            flagged += 1

    print(
        "Validation: " + str(ok) + " ok, "
        + str(flagged) + " review_required, "
        + str(api_errors) + " api_errors"
    )

    # Write outputs.
    payload = {
        "version": "1",
        "model": MODEL,
        "generated_at": datetime.datetime.utcnow().isoformat() + "Z",
        "explanations": explanations,
    }
    OUTPUT_PATH.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    print(
        "Wrote " + str(OUTPUT_PATH) + " (" + str(len(explanations)) + " entries)"
    )

    if review:
        with REVIEW_PATH.open("w", encoding="utf-8") as f:
            for row in review:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
        print(
            "Wrote " + str(REVIEW_PATH) + " (" + str(len(review)) + " entries)"
        )

    return 0


def parse_args(argv: List[str]) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="precompute_explanations",
        description=(
            "Precompute DoseDNA per-tuple explanations into "
            "src/data/explanations.json (BUILD_SPEC §13)."
        ),
    )
    p.add_argument(
        "--dry-run",
        action="store_true",
        help="Enumerate + estimate cost only; do not submit a batch.",
    )
    p.add_argument(
        "--resume",
        metavar="BATCH_ID",
        default=None,
        help="Skip submission; poll the given batch id and process its results.",
    )
    return p.parse_args(argv)


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv if argv is not None else sys.argv[1:])
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
