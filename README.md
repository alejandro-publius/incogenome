# DoseDNA

> **Ask your genome a straight question.** A chat agent that reads your
> 23andMe / AncestryDNA file in your browser, calls your phenotypes with a
> deterministic engine, fetches CPIC's verbatim clinical recommendation
> live, and answers in plain language — with provider-side anonymity via
> cover traffic.

The conversation is on top. Underneath, it's a deterministic engine that
calls your phenotypes from PharmVar variant tables and CPIC diplotype
rules, fetches the actual CPIC drug recommendation from
`api.cpicpgx.org`, and grounds every clinical claim in a click-through
citation. The LLM only paraphrases verified output.

## Status

Built for [AI Hackathon 2026 at Berkeley](https://hackberkeley.org),
**Best Beginner Hack** track. Science-fair judging Sunday June 21,
1–3pm.

Live preview (landing page only, chat requires the local proxy):
[alejandro-publius.github.io/dosedna](https://alejandro-publius.github.io/dosedna/)

---

## What's built

### Chat agent UI (`4-agent-chat.html` / `index.html`)
Lindsay's landing page is the demo entry point. Load a DNA file, ask a
question in natural English. Replies render with:
- **CPIC evidence-strength chips** (green Strong / amber Moderate / gray
  Optional) that link to the published guideline on `cpicpgx.org`.
- **Tool-call cards** under each reply showing which tools the agent
  invoked and with what arguments.
- **Cover-traffic chip** indicating how many decoy queries were fired
  in parallel to the same provider.

### Deterministic PGx engine (`src/pgx.js`)
- 6 genes called locally in the browser: CYP2C19, CYP2C9, VKORC1,
  SLCO1B1, TPMT, CYP2D6.
- CYP2D6 is always "Coverage limited" — consumer arrays cannot reliably
  call its structural variants, and the engine refuses to guess.
- Phenotype-if-invariant rule (BUILD_SPEC §7): when phase or coverage is
  ambiguous, enumerate every possible assignment; only report a phenotype
  if every branch agrees. Otherwise "Not determined."
- **79/79 unit tests** in `tests/pgx.test.mjs`, against PharmVar's
  variant definitions and CPIC's published diplotype tables.

### In-browser parser (`src/parser.worker.js`)
- 23andMe **and** AncestryDNA TSV formats — auto-detected from header +
  column count.
- Runs in a Web Worker; UI never freezes.
- File bytes stay in worker scope; only `{rsid: "AG", ...}` for the 10
  target SNPs is handed back to the page.
- **33 parser tests** in `tests/parser.test.mjs`.

### Hardened proxy (`server/proxy.py`)
- **One** endpoint, `POST /api/explain`, discriminated by a `kind` field
  (`explain` | `questions` | `interactions` | `chat`).
- Holds `ANTHROPIC_API_KEY`. Browser never sees it.
- Allowlist built from `genes.json` + `drugs.json` at startup — every
  `(gene, phenotype, drug)` tuple validated before any string reaches
  Claude.
- Defense-in-depth: rejects payloads containing rsID-shaped strings or
  long ACGT runs.
- Per-IP rate limit, CORS locked to localhost.
- No request body logging.
- Model: `claude-opus-4-8`.

### Four agent tools (Anthropic tool-use)
1. **`get_gene_status(gene)`** — reads the user's phenotype for one gene
   from the deterministic engine's output.
2. **`lookup_cpic_recommendation(gene, drug, phenotype)`** — fetches CPIC's
   verbatim implications + recommendation + evidence classification from
   `api.cpicpgx.org/v1/recommendation`.
3. **`check_drug_interactions()`** — runs the deterministic engine
   over the user's medications: drug-drug pairs + phenoconversion shifts.
4. **`suggest_clinician_questions(focus_topic)`** — generates 4–6
   concrete questions for a clinician visit.

### CPIC integration
- **Live**: `api.cpicpgx.org/v1/recommendation` queried in real time.
- **Disk-cached**: `src/data/cpic_recommendations.json` — pre-pulled CPIC
  recommendations for all 17 bundled drugs (built by
  `scripts/cache_cpic.py`). The proxy pre-seeds its in-memory caches at
  startup, so the demo works even if `api.cpicpgx.org` is down.

### Deterministic interactions (`src/data/interactions.json`)
- 8 phenoconversion entries (inhibitor / inducer pairs) with FDA / CPIC /
  DPWG citations.
- 6 drug-drug interactions (clopidogrel + omeprazole, warfarin +
  amiodarone, simvastatin + clarithromycin, etc.) with FDA / CPIC
  citations.
- No live LLM reasoning — every clinical claim is grounded in a bundled,
  citable source.

### Privacy Console (`src/privacyConsole.js`)
- Patches every outbound-network primitive in the browser: fetch, XHR,
  beacon, WebSocket, Image, Script, Iframe, Link, EventSource,
  RTCPeerConnection, window.open, form submit, Web Workers.
- Case-insensitive DNA-shape detection across URL, body, base64-decoded
  payloads, and a rolling buffer for chunked-leak detection.
- Collapsed by default behind a single "● See where my data goes" pill.

### Cover-traffic / decoy queries (`server/proxy.py`)
- Every real chat turn spawns **5 decoy Anthropic calls** on daemon
  threads — same model, same system prompt, random `(gene, phenotype,
  drug)` from the allowlist. Their responses are read and discarded.
- The provider's API log therefore contains 6 indistinguishable requests
  per real user turn; they cannot identify which call was the user's
  real question.
- Zero added user-perceived latency (decoys fire in the background after
  the real reply is computed).

### Bundled data
- `src/data/genes.json` — variants, function tables, diplotype rules.
- `src/data/drugs.json` — 17 drugs × phenotypes with CPIC-derived guidance.
- `src/data/interactions.json` — phenoconversion + drug-drug pairs.
- `src/data/cpic_recommendations.json` — disk cache of CPIC API responses.
- `sample/sample_23andme.txt` — bundled demo file.
- `sample/patients/` — 5 synthetic patient files curated by our
  bio collaborator, with documented ground-truth seeded variants in
  `sample/patients/expected/patient_0X.json`.

---

## Privacy posture

We do NOT claim "perfect privacy." We claim **architectural minimization
plus provider-side anonymity**:

1. **Raw DNA never leaves the browser.** The parser worker and the PGx
   engine run in-page; file bytes stay in worker scope. The Privacy
   Console makes this falsifiable in real time — open it, watch the
   "0 raw DNA bytes uploaded" counter.

2. **Only de-identified labels reach the LLM.** Every payload to
   Anthropic contains `{gene, phenotype, drug name}`. No rsIDs, no
   genotypes, no age, sex, name, location, or file content. The proxy's
   allowlist + DNA-shape regex enforce this at the boundary.

3. **Provider-side anonymity via cover traffic.** Even those minimal
   labels are mixed with 5 decoy queries per real chat turn. Anthropic's
   API log shows 6 indistinguishable requests; they cannot link any of
   them to a user.

4. **We log nothing on the proxy.** Request bodies are never written to
   disk; no analytics, no telemetry.

What we do NOT do today: ship a local LLM. That's a real future
direction (WebLLM in the browser, or per-user BYOK keys) — see
[ROADMAP.md](#roadmap) below. Honest about what's prototype vs.
production.

---

## Validation

Honest about what's external and what's internal — full audit in
`tests/`.

### External validation
- **79 PGx engine unit tests** (`tests/pgx.test.mjs`): synthetic
  genotypes → expected phenotypes against PharmVar + CPIC reference
  tables. This part is externally validated against the field's
  authoritative sources.
- **33 parser tests** (`tests/parser.test.mjs`): 23andMe + AncestryDNA
  format coverage.
- **Literature-grounded test, 7/7 passing** (`tests/literature-grounded.test.mjs`):
  each case anchored to a specific peer-reviewed paper or landmark RCT.
  Sources: TAILOR-PCI (JAMA 2020), SEARCH (NEJM 2008), EU-PACT (NEJM
  2013), Colombel et al. (Gastroenterology 2000), Smith et al.
  (Genetics in Medicine 2019), Hicks et al. (Clin Pharmacol Ther 2017),
  Bishop et al. (Frontiers Pharmacology 2019).
- **PGxQA benchmark** (`tests/pgxqa.test.mjs`, Keat et al., PSB 2025):
  expert-review tier — 5/6 partial matches on in-scope cases, 4/4
  clean refusal on out-of-scope.

### Internal-only (regression, not validation)
- 14-case agent regression suite (`tests/agent.test.mjs`): questions and
  expected answers were written by the development team using CPIC
  patterns, not externally curated. Useful as a smoke test; **not
  external validation** — labeled as such in the file header.

### Not done (honest gaps)
- No clinician sign-off on agent paraphrases.
- No patient outcome data, no prospective study.
- No FDA / regulatory clearance — we're a research prototype.

---

## Architecture

```
  4-agent-chat.html / index.html  (Lindsay's chat UI)
            │
            ▼
  Load DNA → parser.worker.js → src/pgx.js → phenotypes
  (in-browser; raw DNA never leaves this tab)
            │
            ▼
  Type a question
            │
            ▼
  src/explain.js → POST /api/explain {kind: "chat", phenotypes, message}
            │
            ▼
  server/proxy.py → Anthropic tool-use loop
            │     +
            │  5 decoy queries fired in parallel (provider anonymity)
            │
            ├──→  get_gene_status                  (in-memory)
            ├──→  lookup_cpic_recommendation       (CPIC API or disk cache)
            ├──→  check_drug_interactions          (interactions.json)
            └──→  suggest_clinician_questions      (LLM paraphrase)
            │
            ▼
  Reply with CPIC evidence chips + tool trace + decoy indicator
```

---

## How to run

Requires Python 3.10+ and Node 18+.

```bash
make install                        # pip install proxy deps
cp server/.env.example server/.env  # paste your Anthropic key inside
```

Two terminals:

```bash
make proxy   # FastAPI on http://localhost:8001
make web     # static server on http://localhost:8000/
```

Open **http://localhost:8000/** — chat agent landing page.

Run the tests:

```bash
make test          # 79 PGx engine cases
make parser-test   # 33 parser cases
make lit-test      # 7 literature-grounded cases (requires proxy + API key)
make pgxqa-test    # PGxQA expert-review benchmark (requires proxy + API key)
```

Rebuild the CPIC cache:

```bash
server/.venv/bin/python3 scripts/cache_cpic.py
```

---

## Roadmap

Current architecture is correct for a hackathon prototype, not a
shipped product. Honest path beyond Phase 1:

1. **Phase 1 — today (demo).** Centralized proxy with shared key,
   allowlist + decoys for privacy. Single-laptop install.
2. **Phase 2 — bring-your-own-key.** User pastes their own Anthropic
   key into the UI, stored in `localStorage`. Allowlist and decoys
   still enforced by the client. Removes shared-key scaling concern.
3. **Phase 3 — clinical content review.** Pharmacist / clinician
   reviews the agent's paraphrases against CPIC source text for
   N=50+ cases.
4. **Phase 4 — broader sources.** Add PharmGKB clinical annotations
   and FDA Table of Pharmacogenomic Biomarkers as additional
   authoritative tools the agent can query.

LLM dependency lives entirely behind a single tool boundary
(`lookup_cpic_recommendation`'s paraphrase step), so swapping it
(BYOK, different model, eventual local fallback) is a single-file
change rather than a rewrite.

---

## Not medical advice

DoseDNA is a research prototype. Informational only. Confirm any
medication decision with a clinician or pharmacist. The agent never
gives a specific dose, never tells the user to start or stop a
medication, and refuses out-of-scope drugs cleanly. When a metabolizer
status cannot be determined from the file, it is reported as "not
determined," never as normal.

---

## Contributing

Built at AI Hackathon 2026 (Berkeley) by:

- Alex ([@alejandro-publius](https://github.com/alejandro-publius)) — engine, proxy, validation suites, system integration
- Lindsay ([@lindsayy-l](https://github.com/lindsayy-l)) — chat UI / landing page design, CPIC data integration
- Varsha ([@varsha106-pixel](https://github.com/varsha106-pixel)) — frontend prototype + UI direction
- Rachel ([@rachelselbrede](https://github.com/rachelselbrede)) — bio collaborator: synthetic patient curation, ground-truth seeding

The deterministic spine (`src/pgx.js`, `src/data/*.json`,
`tests/pgx.test.mjs`) is the highest-bar part of the codebase —
changes there should keep `make test` green.

## License

TBD.
