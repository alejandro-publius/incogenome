# DoseDNA — Complete Build Spec (for Claude Code)

A privacy-first pharmacogenomics web app. The user loads a consumer DNA file (23andMe / AncestryDNA); the app reads it **entirely in the browser**, extracts a small set of drug-related variants, maps them to drug-metabolism status, and shows plain-language guidance on how specific medications may affect them. The raw DNA never leaves the device. Only an anonymized, non-identifying question (gene + phenotype + drug) is sent to the Claude API for a friendly explanation — and even that is optional, because the explanations are precomputed and bundled (Section 13).

> **Pitch:** "Before you take a new medication, see how your body may handle it — based on your DNA, without your genome ever leaving your device."

**How to read this doc:** Verified facts are stated plainly with their source. `[CONFIRM AT BUILD]` marks something that must be checked against a primary download or a real file before trusting it (these are the silent-bug risks). `[DECIDE]` marks a product choice. Build in the order of Section 3.

**Decisions already made (don't re-litigate):**
- **AI layer:** Precompute every explanation offline and ship as static JSON. The live proxy is a near-no-op fallback. The core works fully offline. (Section 13.)
- **Test data:** Sourced from openSNP (real consumer files) for coverage, and CDC GeT-RM consensus genotypes for known-answer validation. (Section 14.)
- **Explanation model:** `claude-haiku-4-5` — this is a fixed-result "explain in plain language" task with canonical text already in hand; it does not need a frontier model. (Section 12.)

---

## 1. Core principles (do NOT violate)

1. **Local-first.** All DNA reading, parsing, and variant→result logic runs in the browser, in a Web Worker. The genome is never uploaded. Selecting a file is not uploading it.
2. **One personal network call, anonymized — and optional.** The only outbound call carrying anything derived from the user is `gene + phenotype + drug` → Claude, for plain-language wording. **Never** send DNA, genotypes, rsIDs, diplotypes, or identifiers. Because explanations are precomputed (Section 13), the happy path makes no live call at all.
3. **Core works offline.** All medication guidance *and* the friendly explanations are bundled locally and rendered with zero network calls. Claude only ever adds wording; if the live call fails or is skipped, the app still shows the bundled text.
4. **Never silently assume "normal."** When the file lacks the variants needed to determine a status, the result is **"not determined,"** never a default normal/`*1` call. This rule is the entire product. (See Section 8.)
5. **Deterministic medicine, generative language.** The variant→allele→phenotype→guidance chain is hard-coded and verifiable. Claude never computes a phenotype or invents clinical claims — it only explains the verified result. (See Section 12.)
6. **Honest framing in the UI.** Results are informational; confirm with a clinician. Consumer arrays cannot reliably call CYP2D6 — it is always shown as "coverage limited," never as a clean status.
7. **Validated boundary, not a trusted client.** The browser sends structured, allowlisted fields to the backend — never free text. The backend reconstructs every prompt server-side from validated fields, so the only strings that reach Claude are ones we authored. (See Section 12.)

---

## 2. Architecture & data flow

**Stack**
- Frontend: plain HTML / CSS / JavaScript, no framework. All sensitive logic lives here.
- DNA parsing: in-browser JS in a Web Worker so the UI never freezes.
- Bundled data: JSON files (genes, variants, phenotype rules, drug recommendations, interactions, **precomputed explanations**) shipped with the app, loaded once.
- AI layer: a tiny backend proxy (Python FastAPI) that holds the Anthropic API key, validates an allowlist, serves the precomputed bundle, and only calls Claude live for a tuple genuinely missing from the bundle. The browser never holds the key.
- Runs on localhost for the demo.

**The deterministic spine vs. Claude (make this split explicit in code):**

| Layer | Owner | Never does |
|---|---|---|
| Parse file → genotypes at target rsIDs | Worker (JS) | — |
| Genotypes → diplotype (star alleles) | `pgx.js` (deterministic) | guess/impute missing data |
| Diplotype → phenotype | bundled JSON (deterministic) | default missing to normal |
| Phenotype + drug → guidance | bundled JSON (deterministic) | — |
| Coverage state assignment | `pgx.js` (deterministic) | — |
| Plain-language explanation + doctor questions | Claude, **precomputed** (via proxy fallback) | compute phenotype, invent dosing |

**Data flow**
1. User selects DNA file → browser reads it with `FileReader` / `file.stream()`. Contents stay in memory.
2. Web Worker scans the file for the target rsIDs and reads the genotype at each.
3. JS maps genotypes → diplotype → phenotype using bundled JSON, and assigns a **coverage state** (Section 8).
4. JS looks up phenotype + drug → recommendation in bundled JSON; renders the results UI and the bundled static guidance immediately.
5. For a chosen result, the frontend looks up the **precomputed explanation** in the bundled `explanations.json` by tuple key and renders it. If (and only if) the tuple is missing, it POSTs the anonymized, allowlisted fields to the proxy, which calls Claude and returns wording. On any error, keep the bundled static text.

```
Browser worker:  file → genotypes → diplotype → phenotype → coverage_state   (deterministic, local)
        │
        ▼  look up bundled guidance JSON → render static guidance immediately
        │
        ▼  look up explanations.json[tuple] → render friendlier wording (no network)
        │
        ▼  (rare) tuple missing → POST {gene, phenotype, drug, coverage_state, direction, guidance_id}
Proxy:  allowlist-validate → cache lookup → (rarer) Claude call → return wording
        │
        ▼  swap wording over static text; on any error keep static
```

---

## 3. MVP build order

Build a thin vertical slice on **one gene (CYP2C19)** end-to-end before scaling. That surfaces every real obstacle (strand, missing rsIDs, no-call encoding, phasing) while it's cheap.

1. Upload a DNA file, read it locally, print the parsed target SNPs for CYP2C19.
2. Implement the **diplotype caller** for CYP2C19 (Section 7) and map → phenotype using bundled JSON; assign coverage state.
3. **Validate against a known-answer sample** (Section 14) before trusting the pipeline.
4. Look up phenotype + drug → recommendation; render results with bundled static guidance.
5. Scale to the rest of the gene set (Section 6).
6. Curate the drug-guidance rows (Section 10) and run the **precompute pipeline** (Section 13) to generate `explanations.json`.
7. Wire the explanation layer: bundle lookup first, proxy fallback second.
8. Add the medications-list input + interaction/phenoconversion flags (the novelty — Section 11).
9. Add the legal disclaimer + safety guardrails (Section 15).
10. Polish + the "nothing leaves the device" demo + public repo + screenshots.

---

## 4. Out of scope for MVP (do NOT build)

- Full-genome / VCF parsing. Consumer 23andMe/Ancestry TSV only.
- PharmCAT or any Java dependency. Reimplement the small star-allele logic in JS.
- Statistical imputation of missing genotypes. (Absence → "not determined," not a guess.)
- **Runtime web scraping of any kind.** There is no scraping in this product (Section 5).
- Confidential-computing enclaves / hardware versions.
- Any account system or server-side storage of genetic data.

---

## 5. Data sources & curation (there is no "scraping")

This product does **not** scrape the web at runtime, and you should not build a crawler. The pharmacogenomic knowledge base is small (~11 variants, ~10 drugs) and comes from curated, downloadable, structured datasets. You curate them **once, by hand, at build time** into the bundled JSON, with a source citation per row, and a clinician/pharmacist eyeballs it before freezing.

| Data type | Source | Form |
|---|---|---|
| Star-allele → defining variant (rsID), build-37/38 coordinates | **PharmVar** (pharmvar.org) | REST API + bulk per-gene downloads |
| Allele function, diplotype→phenotype, activity scores, drug recs | **CPIC** (cpicpgx.org) | Downloadable tables + API |
| Clinical annotations (drug–gene) | **PharmGKB** (pharmgkb.org) | Downloadable TSVs (license-gated — check terms) `[CONFIRM AT BUILD]` |
| Regulatory biomarker labels | **FDA Table of Pharmacogenomic Biomarkers / Pharmacogenetic Associations** | Published tables |
| dbSNP plus-strand ref/alt per rsID (for strand handling) | **dbSNP** (build 37) | API / download |

**If you ever automate refreshing the bundle**, that is a periodic *offline* script that hits the PharmVar/CPIC **APIs** and diffs against the current bundle — it runs at build time, never in the request path, and still isn't scraping. Treat any instinct to fetch from these sources at runtime as a bug.

---

## 6. Genomics knowledge base (bundled JSON) — the specific part

Source of truth, by data type: see Section 5. Genome build: consumer files are GRCh37/build 37. PharmVar provides both builds — use the build-37 coordinates. `[CONFIRM AT BUILD]`

### 6a. Verified variant table

These rsIDs and variant alleles are verified against the literature/CPIC. The "no-function / variant allele" column is the allele that *moves* the phenotype; the other allele is reference.

| Gene | Star allele | rsID | Change | Reference → variant allele | Effect |
|---|---|---|---|---|---|
| CYP2C19 | *2 | rs4244285 | c.681G>A | G → **A** | no function (splicing defect) |
| CYP2C19 | *3 | rs4986893 | c.636G>A | G → **A** | no function (stop gain) |
| CYP2C19 | *17 | rs12248560 | c.-806C>T | C → **T** | increased function |
| CYP2C9 | *2 | rs1799853 | c.430C>T (R144C) | C → **T** | decreased function (AS 0.5) |
| CYP2C9 | *3 | rs1057910 | c.1075A>C (I359L) | A → **C** | no/▼▼ function (AS 0) |
| VKORC1 | (−1639) | rs9923231 | c.-1639G>A | G → **A** | ↑ warfarin sensitivity (lower dose) |
| SLCO1B1 | (521 C) | rs4149056 | c.521T>C (V174A) | T → **C** | decreased function |
| TPMT | *2 | rs1800462 | c.238G>C | G → **C** | no function |
| TPMT | *3B | rs1800460 | c.460G>A | G → **A** | (combines into *3A) |
| TPMT | *3C | rs1142345 | c.719A>G | A → **G** | no function; with *3B = *3A |
| CYP2D6 | — | — | structural | **not array-callable** | always "coverage limited" |

> These are coding/plus-strand changes from CPIC/PharmVar. The **strand the consumer file reports on can differ** — see 6b. Always confirm each rsID's defining allele against PharmVar's build-37 table at build time. `[CONFIRM AT BUILD]`

### 6b. Strand handling — the actual method

23andMe/Ancestry report two-letter genotypes, and some rsIDs are reported on the minus strand relative to the star-allele definition, so the letters can be complemented (A↔T, C↔G). Do **not** hand-eyeball this. Implement:

1. For each rsID, store the plus-strand `ref`/`alt` alleles from **dbSNP** (build 37) alongside the PharmVar definition.
2. When reading a file genotype, accept it if its alleles are a subset of `{ref, alt}`. If not, try the **complement**; if that matches, the file is minus-strand for that SNP — record the orientation in the JSON so it's explicit, not inferred at runtime.
3. If neither matches → flag as an unparseable/no-call for that SNP (contributes to "not determined," never to "normal").
4. **Validate the whole mapping against a known-answer sample** (Section 14) before trusting any result. This catches strand mistakes that pass step 2 but still flip a call.

### 6c. rsID matching robustness

Match target variants by rsID **and** sanity-check the chromosomal position. dbSNP merges and deprecates rsIDs over time, and some chips report merged IDs. If an rsID is absent but the position matches a known target, **flag it** rather than silently treating the variant as missing. Cheap insurance against silent coverage holes.

### 6d. Phenotype rules — verified pieces + the gotchas

Pull the full diplotype→phenotype tables from CPIC; do not hand-roll the edge cases. Verified anchors and the specific traps:

- **CYP2C19** (no-function: *2, *3; increased: *17): `*1/*1` = Normal; `*1/*17` = Rapid; `*17/*17` = Ultrarapid; `*1/*2`/`*1/*3` = Intermediate; `*2/*2`, `*2/*3`, `*3/*3` = Poor. **Gotcha:** `*2/*17` and other no-function + `*17` combinations are *not* "averaged" — use the current CPIC table verbatim (CPIC classifies `*2/*17` as Intermediate). `[CONFIRM AT BUILD]`
- **CYP2C9** uses an **activity score**: *1 = 1.0, *2 = 0.5, *3 = 0.0; sum the two alleles → Normal (2.0) / Intermediate / Poor. Don't use simple "normal/decreased/poor by genotype" labels. **Missing-data guard:** if any defining position is a no-call, you cannot sum — the result is "partially determined," never "assume 1.0 for the missing allele." (Section 7.)
- **VKORC1 rs9923231** is a warfarin **dose-sensitivity** flag, not a metabolizer phenotype: GG = normal sensitivity; GA = increased; AA = high sensitivity (lower dose). It is interpreted *together with* CYP2C9 for warfarin.
- **SLCO1B1 rs4149056** (function-based, per CPIC 2022): TT ≈ normal function, TC ≈ decreased function, CC ≈ poor function — **but** this single SNP can't distinguish `*5` from `*15` (that needs rs2306283, c.388A>G). For MVP, report it as "carries the decreased-function variant (consistent with *5/*15)," not a specific star allele. `[CONFIRM AT BUILD]`
- **TPMT phasing gotcha:** the common no-function allele `*3A` = `*3B` (rs1800460) **+** `*3C` (rs1142345) **on the same chromosome**. An unphased array can't always tell `*3A/*1` from `*3B/*3C`. The *phenotype* is often the same either way, but state the assumption explicitly and treat the ambiguous case as "consistent with TPMT deficiency, confirm clinically," not a precise diplotype. (Section 7.)

### 6e. Bundled JSON schema (suggested)

```json
{
  "genes": {
    "CYP2C19": {
      "build": "GRCh37",
      "variants": [
        { "rsid": "rs4244285", "allele": "*2", "ref": "G", "alt": "A",
          "file_strand": "plus", "function": "no_function", "position": 94781859 }
      ],
      "diplotype_to_phenotype": { "*1/*1": "Normal", "*1/*2": "Intermediate" },
      "method": "diplotype",
      "array_callable": "partial",
      "coverage_note": "Common no-function + *17 alleles covered; rare alleles not on array."
    },
    "CYP2D6": { "array_callable": "none", "coverage_note": "Structural variants undetectable on arrays." }
  }
}
```

(For CYP2C9 add `"method": "activity_score"` and an `activity_value` per allele instead of a diplotype map.)

---

## 7. Diplotype-calling algorithm (the hard part — write this explicitly)

"Genotypes → diplotype" is one row in the architecture table but it is where the silent bugs live. The core problem: **consumer arrays are unphased**, so when a person is heterozygous at two positions you often cannot know which variant sits on which chromosome. Write this out per gene; do not leave it as a vague mapping.

### 7a. Two states for every position — keep them distinct from the first parse step

- **Present + reference** — the line exists and the genotype is the reference allele.
- **Present + variant** — the line exists and carries the variant allele (het or hom).
- **Absent / no-call** — the line is missing, or is `--`/`00`/`DD`/`II`.

A diplotype can be called `*1` on a chromosome only when that chromosome carries **none** of the variant alleles — which you can only assert for a position that was **present + reference**. You can only call the diplotype `*1/*1` when **every** variant-defining position on your panel for that gene was present + reference. An absent line never contributes to a `*1` call.

### 7b. Diplotype-method genes (CYP2C19, TPMT) — explicit logic

1. For each defining position, classify as present+ref / het / hom-variant / no-call.
2. If any decisive position is a no-call → the call is incomplete → **Partially tested** or **Not callable** per Section 8; do not proceed to a confident diplotype.
3. Count variant alleles per star allele and resolve to a diplotype using the gene's CPIC table.
4. **Detect unphasable cases and report phenotype, not a guessed diplotype:**
   - **CYP2C19:** het at a no-function position (`*2` or `*3`) **and** het at `*17` (e.g. `*2`+`*17` both het) is phase-ambiguous (`*2/*17` vs `*1/*` combinations). Resolve by the rule: if the phenotype is invariant across the possible diplotypes, report it; if not, report "ambiguous — confirm clinically."
   - **TPMT:** het at rs1800460 (`*3B`) **and** het at rs1142345 (`*3C`) cannot distinguish `*3A/*1` from `*3B/*3C`. Phenotype is usually the same (one deficient allele) → report "consistent with TPMT intermediate/deficiency, confirm clinically," not a precise diplotype.

> Conceptual rule borrowed from PharmCAT (do **not** port PharmCAT): when phase is ambiguous, report the **phenotype** if it is invariant across the possible diplotypes; report "ambiguous" only when the phenotype itself would change.

### 7c. Activity-score genes (CYP2C9) — explicit logic

1. Classify each defining position (rs1799853 `*2`, rs1057910 `*3`) as above.
2. If any is a no-call → **partially determined**; do not sum. Never substitute 1.0 for a missing allele.
3. Otherwise assign per-allele activity values (*1 = 1.0, *2 = 0.5, *3 = 0.0), sum both alleles, and map the total → Normal (2.0) / Intermediate (1.0–1.5) / Poor (0–0.5) per the current CPIC table. `[CONFIRM AT BUILD]`

### 7d. Single-SNP flags (VKORC1, SLCO1B1)

No phasing needed — these are interpreted per genotype directly (Section 6d). Still subject to the present/absent/no-call states: an absent line → "not determined."

---

## 8. Coverage / honesty logic (the differentiator — spend the most time here)

Two halves: *what can this file see* and *what are we allowed to conclude*.

### 8a. Empirical coverage step (do this, don't assume)

Chips differ by version (23andMe v3/v4/v5, AncestryDNA versions) — the rsIDs present change. **Measure it:** intersect each gene's required rsIDs (6a) against the rsID list of a real/synthetic file for each chip version you support (Section 14). That intersection *is* your coverage map; bundle it. `[CONFIRM AT BUILD]`

### 8b. The three coverage states

1. **Tested & confident** — every variant needed for a confident call is present, and no structural variant could change the answer.
2. **Partially tested** — some informative variants present, call incomplete (one allele known, second unknown; or rare alleles off-chip; or a no-call on a decisive position). Report as a directional flag, not a verdict.
3. **Not callable from this file** — the decisive variation is structural or absent (CYP2D6 always lands here). No status assigned.

### 8c. Decision rules (write as explicit logic)

- Never default a missing variant to `*1`/normal. Absence → "unknown."
- If any structural variant could change the phenotype and the file can't detect it → **Not callable**, regardless of which SNPs are present.
- If exactly one allele is determinable, or a decisive position is a no-call → **Partially tested**; surface the known allele/direction as a flag.
- Map states to UI consequence: Confident → show guidance; Partial → guidance **+** "confirm with clinical test"; Not callable → "we can't determine this; here's why + what to ask."
- Trigger a clinical-PGx-panel recommendation whenever a Not-callable or Partial gene governs a drug the user is starting.

---

## 9. Input handling & file format

- **23andMe:** tab-separated, one variant per line: `rsid<TAB>chromosome<TAB>position<TAB>genotype` (genotype is two letters, e.g. `AA`, `AG`). Lines starting with `#` are comments/headers (the header often names the chip version — use it for coverage).
- **AncestryDNA:** tab-separated, but the genotype is split across **two allele columns**: `rsid<TAB>chromosome<TAB>position<TAB>allele1<TAB>allele2`. Header lines start with `#`. Detect the provider from the header/column layout and handle both. `[CONFIRM AT BUILD against a real Ancestry file]`
- Parse with a simple line scan or PapaParse, in the Worker.
- **Edge cases to handle explicitly:** no-calls (`--`, `00`, `DD`, `II`), missing rsIDs (absent line), indels, strand complementation (6b), and chip-version detection. Each unparseable/absent target contributes to "not determined," never to "normal."
- On upload, validate it's actually a consumer DNA file (expected columns + known rsIDs present) and identify the provider/version; reject gracefully otherwise.

---

## 10. Drug guidance layer (phenotype → what to tell the user)

For each drug–gene pair: a short guidance summary (your words, not pasted) + recommendation strength + source. Priority of sources: CPIC guideline → PharmGKB clinical annotations → FDA Table of Pharmacogenomic Biomarkers / FDA Table of Pharmacogenetic Associations → DPWG where CPIC is silent.

MVP drug set (from the gene table): clopidogrel, citalopram/escitalopram, PPIs, voriconazole (CYP2C19); warfarin (CYP2C9 + VKORC1), NSAIDs, phenytoin (CYP2C9); simvastatin/statins (SLCO1B1); azathioprine, mercaptopurine, thioguanine (TPMT).

**This section must be filled out as bundled JSON** — one row per `(gene, phenotype, drug, direction)`, each with: a `guidance_id`, your own-words summary, recommendation strength, direction-of-risk, and a source citation. `[FILL one guidance row per phenotype per drug from CPIC.]`

**Direction-of-risk matters and flips by drug type** — encode it, because the same status is opposite advice:
- *Prodrugs* (need activation): e.g. clopidogrel via CYP2C19 — poor metabolizer → drug doesn't work.
- *Active drugs* (need clearance): e.g. citalopram via CYP2C19 — poor metabolizer → builds up, toxicity risk.

Surface hard regulatory warnings prominently (e.g. the codeine/CYP2D6 ultrarapid pediatric restriction) — though codeine sits under the CYP2D6 "coverage limited" path here.

---

## 11. Medications layer (the novelty — add after core works)

A text input for the user's current medications. Cross-check three things and frame all output as "flags to discuss with your pharmacist," not a complete engine:

1. **Drug–gene** (Section 10).
2. **Drug–drug interactions** — a small bundled table of well-documented pairs.
3. **Phenoconversion** — a drug the user already takes that inhibits a metabolizing enzyme and *flips their effective phenotype*. This is where Claude does real cross-data reasoning, not paraphrase.

Concrete, defensible phenoconversion examples to bundle `[CONFIRM exact pairs against a clinical reference at build]`:
- A strong **CYP2C19 inhibitor** (e.g. fluvoxamine, fluconazole) taken alongside a CYP2C19 substrate → a genotype-normal metabolizer behaves as intermediate/poor.
- A strong **CYP2D6 inhibitor** (e.g. bupropion, paroxetine, fluoxetine) → converts a CYP2D6 normal metabolizer toward poor — relevant precisely because the *genetic* CYP2D6 status is unknown here, so a drug-induced flip is the part you *can* flag.

Keep the table to a handful of high-confidence examples. Quality and honest framing beat coverage.

---

## 12. Backend & Claude integration (the AI layer)

### 12a. The proxy

- **Proxy only.** FastAPI holds the key in an env var (`ANTHROPIC_API_KEY`); the browser POSTs structured, allowlisted fields; the proxy reconstructs the prompt and calls the Anthropic Messages API. One endpoint.
- **Anonymized, structured payload — never free text.** The browser sends fields, not a prompt. No DNA, genotype, rsIDs, diplotype, or identifiers ever leave the device.

Request from browser:
```json
{
  "gene": "CYP2C19",
  "phenotype": "Poor Metabolizer",
  "drug": "clopidogrel",
  "coverage_state": "tested_confident",
  "direction": "prodrug",
  "guidance_id": "cyp2c19_clopidogrel_pm"
}
```

### 12b. Server logic (in order)

1. **Validate against an allowlist.** `gene`, `phenotype`, `drug`, `coverage_state` must each be members of the known bundled set, and the tuple must correspond to a real `guidance_id`. Reject anything else with a 400. This means the only strings that ever reach the prompt are ones we authored — the browser cannot inject arbitrary prompt text, and the endpoint can't be abused as an open Claude proxy.
2. **Check the precomputed cache** (Section 13), keyed by the tuple → return it if present (the normal case).
3. On cache miss, **build the prompt server-side** from the validated fields + the bundled canonical guidance text, call Claude, cache, return. (A live call should essentially never fire if enumeration is complete — treat it as a signal a combination was missed.)
4. On any API error, return a flag telling the browser to fall back to bundled static text.

### 12c. The Claude call (model: `claude-haiku-4-5`)

```python
resp = client.messages.create(
    model="claude-haiku-4-5",
    max_tokens=1024,
    system=(
        "You explain pharmacogenomic results in plain language for patients. "
        "Be clear and calm. Always recommend confirming with a clinician. "
        "Explain ONLY the verified result provided. Never state a specific dose, "
        "never invent clinical claims, never contradict the provided guidance."
    ),
    messages=[{"role": "user", "content": built_from_validated_fields}],
)
```

### 12d. Logging

Even though the payload is anonymized, `gene + phenotype + drug` per request is health-adjacent. **Do not log request bodies** — log only aggregate counts. Make this a deliberate decision, not an accident.

---

## 13. Precompute pipeline (build-time batch → static JSON)

The input space is tiny and enumerable, so generate every explanation once, offline, and ship it. This makes the live call optional, keeps the core fully offline, and costs the API once instead of per user.

**1. Enumerate the combination space** from the bundled data:
```
for gene in genes:
  for phenotype in gene.phenotypes:          # PM / IM / NM / RM / UM, etc.
    for drug in drugs_for(gene):
      for coverage_state in [tested_confident, partial, not_callable]:
        key = f"{gene}|{phenotype}|{drug}|{coverage_state}"
```
Filter to **valid** tuples only (a drug only pairs with genes that affect it; `not_callable` collapses to a generic "couldn't determine" explanation that doesn't vary by phenotype). Realistically a few hundred keys.

**2. Batch them through the Message Batches API** (50% cheaper; latency is irrelevant for a one-time job). Each request: the same cached system prompt + the validated fields + the canonical bundled guidance text for that tuple. Model: `claude-haiku-4-5`.

**3. Post-validation pass** over every generated explanation before it ships: regex/deny-check for specific mg doses, "you should take/stop," and any drug name not in the input tuple. Flag failures for human review. Because it's a one-time batch, you can afford to actually read the flagged ones.

**4. Write results to `data/explanations.json`**, keyed by the tuple string, bundled next to `pgx_genes.json`. At runtime the browser does a pure dictionary lookup — no network call in the happy path.

**5. Add a `version`/checksum field** tied to the guidance + prompt. When you edit either, bump the version and rerun the batch. (This is data, not code — keep prior versions explicitly per the document-versioning habit.)

This is a build-time script, not part of the running app. Re-run only when guidance or the prompt changes.

---

## 14. Test data & validation

Two distinct needs — do not conflate them.

### 14a. Coverage map — which rsIDs each chip actually carries (input to Section 8)

- **openSNP** (opensnp.org) — real 23andMe and AncestryDNA files released into the public domain, tagged by chip version. Pull 2–3 of each: 23andMe v3/v4/v5, AncestryDNA v1/v2. Extract the rsID column and intersect with the ~11 targets. That intersection **is** the coverage map; it cannot be derived from the literature.
- Cross-check against vendors' published chip manifests where available, but trust the real files — manifests and shipped content drift.
- **Put this on the critical path before finalizing Section 8 coverage logic.**

### 14b. Known-answer validation — does the caller produce the right diplotype (correctness test)

- **CDC GeT-RM** (Genetic Testing Reference Materials program) — publishes **consensus star-allele genotypes** for Coriell cell-line samples across exactly these genes (CYP2C19, CYP2C9, CYP2D6, TPMT, SLCO1B1, VKORC1), determined by multiple labs. This is the ground truth.
- **Coriell / 1000 Genomes** — obtain genotype data for GeT-RM samples and build synthetic input files at the target positions with a known expected diplotype.
- Build a fixture: `(input_genotypes) → expected_diplotype → expected_phenotype` for a handful of GeT-RM samples per gene; assert the pipeline reproduces the CDC consensus. **Include at least one phase-ambiguous case** (e.g. TPMT `*3A` vs `*3B`+`*3C`) and assert the app emits "ambiguous," not a confident wrong call.
- **Put this on the critical path before calling the diplotype caller done.**

Neither set is large — a dozen files total — but both are blocking for clinical credibility.

---

## 15. Legal, disclaimer & safety guardrails

- **Not medical advice.** Prominent, persistent framing: informational only, not a diagnostic device, confirm with a clinician/pharmacist. Decide consciously where this sits relative to FDA's stance on consumer PGx reports (23andMe's own PGx reports carry heavy FDA-mandated caveats). This is a gating requirement for a public repo with this pitch, not polish. `[DECIDE]`
- **Hallucination defense in depth:** (1) the bundled static guidance is canonical and always rendered; (2) Claude only adds wording on top; (3) post-validate Claude output against a denylist — no specific mg doses, no "you should take X," no drug not in the tuple (Section 13 step 3 applies at runtime too for any live call).
- **No genetic data at rest, anywhere on the server.** The proxy is stateless w.r.t. user data.

---

## 16. How to drive Claude Code to build this

Build in the Section 3 order, one vertical slice first. Suggested prompts to Claude Code, in sequence:

1. "Parse a 23andMe/AncestryDNA TSV in a Web Worker; detect provider + chip version from the header; emit genotypes at the CYP2C19 target rsIDs with each position classified as present-ref / het / hom-variant / no-call. Handle strand complement per Section 6b."
2. "Implement `pgx.js`: the CYP2C19 diplotype caller per Section 7, including the unphasable `*2`+`*17` case → phenotype-if-invariant rule; then diplotype→phenotype from `pgx_genes.json`; then assign coverage state per Section 8."
3. "Add a known-answer test (Section 14b) using a GeT-RM consensus genotype for CYP2C19; assert the caller reproduces the consensus diplotype and flags the ambiguous case."
4. "Render results: static bundled guidance for phenotype+drug, with coverage-state-driven UI consequences (Section 8c)."
5. "Scale `pgx_genes.json` and `pgx.js` to CYP2C9 (activity-score method + missing-data guard), TPMT (phasing gotcha), VKORC1, SLCO1B1 per Sections 6–7."
6. "Write the precompute script (Section 13): enumerate valid tuples, batch through the Message Batches API with `claude-haiku-4-5`, post-validate against the denylist, write `data/explanations.json` with a version field."
7. "Build the FastAPI proxy (Section 12): one endpoint, allowlist validation, cache lookup against `explanations.json`, live `claude-haiku-4-5` fallback, no request-body logging."
8. "Wire the frontend explanation layer: bundle lookup first, proxy fallback second, static text on any error."
9. "Add the medications input + phenoconversion flags (Section 11) and the disclaimer + runtime denylist (Section 15)."

Give Claude Code this file as context for every step, and tell it which section the current task maps to.
