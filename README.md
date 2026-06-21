# DoseDNA

> Before you take a new medication, see how your body may handle it —
> based on your DNA, without your genome ever leaving your device.

Privacy-first pharmacogenomics in the browser. Drop in a 23andMe file, see
per-gene phenotypes and drug guidance, and watch in real time that nothing
DNA-shaped ever leaves your laptop.

The pharmacogenomics is the wedge. The architecture — parse locally, reason
only over anonymized summaries — is the venture.

## Status

Pre-spec implementation just landed on branch `alex/pgx-pipeline`. The core
deterministic pipeline (parse → diplotype → phenotype → guidance) is wired
end-to-end and tested. There are real, known gaps against
[`BUILD_SPEC`](./BUILD_SPEC) — see "Not built yet" below.

Hackathon demo target: **Sunday 4–6pm**. See [`DEMO.md`](./DEMO.md) for the
script.

## What's built right now

**Local PGx engine** (`src/pgx.js`)
- 5 genes called deterministically: CYP2C19, CYP2C9, VKORC1, SLCO1B1, TPMT.
- CYP2D6 is always returned as "Coverage limited" — consumer arrays can't
  call its structural variants and we refuse to guess.
- Strand-aware genotype decoding (plus / minus complement, per spec §6b).
- Phenotype-if-invariant rule: when phase or missing positions are ambiguous,
  we enumerate every assignment and only report a phenotype if all branches
  agree. Otherwise: "Not determined", `coverage_state: partial`.
- 52/52 deterministic tests passing in `tests/pgx.test.mjs`
  (synthetic genotypes + the bundled sample file).

**In-browser parser** (`src/parser.worker.js`)
- 23andMe TSV, parsed in a Web Worker so the UI never freezes.
- File bytes stay in worker scope; only `{rsid: "AG", ...}` for target SNPs
  is handed back to the page.
- AncestryDNA branch is in [`BUILD_SPEC`](./BUILD_SPEC) §9 but not yet
  implemented.

**Privacy Console** (`src/privacyConsole.js`)
- Live overlay logging every outbound `fetch` / `XHR`: URL, method, byte
  count, payload preview.
- This is the demo's load-bearing claim — see DEMO 0:30–1:00 and 2:30–3:30.
  If the counter ever ticks up on anything DNA-shaped, the product is a lie.

**FastAPI proxy** (`server/proxy.py`)
- Holds `ANTHROPIC_API_KEY`. Browser never sees it.
- Three endpoints today: `POST /api/explain`, `POST /api/questions`,
  `POST /api/check-meds`.
- Defense-in-depth: rejects any payload containing rsID-shaped strings or
  long ACGT runs before it ever reaches Claude.
- Spec §12 calls for **one** endpoint backed by the precomputed bundle.
  Three live endpoints is a known gap (see below).

**Bundled data**
- `src/data/genes.json` — variants, function tables, diplotype/phenotype rules.
- `src/data/drugs.json` — phenotype → drug guidance rows for the MVP drug set.
- `sample/sample_23andme.txt` — demo file for "Load sample".
- `sample/expected_phenotypes.json` — known-answer fixture (synthetic, not
  yet GeT-RM consensus).

## Not built yet vs BUILD_SPEC

Be honest with judges and teammates about these:

- **AncestryDNA parser** — spec §9, parser currently 23andMe only.
- **`explanations.json` precompute pipeline** (spec §13) — the offline script
  to batch-generate every `(gene, phenotype, drug, coverage_state)`
  explanation isn't wired up. Today the proxy calls Claude live on every
  `/api/explain`.
- **GeT-RM known-answer fixtures** (spec §14b) — current tests are synthetic
  + sample-based. Coriell / CDC GeT-RM consensus genotypes are not in the
  repo yet.
- **Phenoconversion table** (spec §11) — `/api/check-meds` currently relies
  on live Claude reasoning to flag enzyme inhibitors. The spec wants a
  bundled, deterministic table; relying on the model here violates the
  "deterministic medicine, generative language" rule (§1).
- **Full Section 10 drug guidance set** — `drugs.json` covers the core
  examples (clopidogrel, statins, warfarin/VKORC1, TPMT thiopurines, a few
  SSRIs/PPIs). The complete CPIC-anchored matrix isn't there yet.

## How to run

Requires Python 3.10+ and Node 18+.

```bash
make install                          # pip install proxy deps
cd server && cp .env.example .env     # then put ANTHROPIC_API_KEY in .env
```

Then in two terminals:

```bash
make proxy   # FastAPI on http://localhost:8001
make web     # static server on http://localhost:8000/
```

Open `http://localhost:8000/` — that serves `index.html`, the real app.
Don't point judges at `dev/test.html`; that's a scratch page.

Run the deterministic test suite:

```bash
make test    # node tests/pgx.test.mjs — 52 cases
```

There's also `make smoketest` (`scripts/smoketest.sh`), which exercises the
live proxy. Run it in a third terminal while `make proxy` is up.

## Architecture (30 seconds)

```
  file picker / sample button
            │
            ▼
  parser.worker.js  ─── 23andMe TSV → { rsid: genotype } ───┐
  (Web Worker, off-main-thread)                             │
                                                            ▼
                                                       src/pgx.js
                                       (strand decode, diplotype, phenotype,
                                        coverage state — fully deterministic)
                                                            │
                          ┌─────────────────────────────────┤
                          ▼                                 ▼
              src/data/genes.json              src/data/drugs.json
              (variants + rules)               (phenotype → guidance)
                                                            │
                                                            ▼
                                            render result cards in index.html
                                                            │
                                          (optional)  POST { gene, phenotype, drug }
                                                            ▼
                                          server/proxy.py → Anthropic API
                                                            │
                                          plain-language wording over static text
```

Every box left of the proxy runs locally. The proxy never sees DNA, rsIDs,
genotypes, or diplotypes — only `gene + phenotype + drug` tuples and the
user's typed medication list.

## Privacy guarantee

DNA never leaves the device. The Privacy Console makes that auditable —
every network call this page makes is logged in the corner panel in real
time, and you can read the actual payloads. We didn't claim privacy; we
made it falsifiable.

## Not medical advice

Informational only. Confirm any medication decision with a clinician or
pharmacist. We mark CYP2D6 as "coverage limited" because consumer arrays
can't reliably call its structural variants — we'd rather show nothing than
show a wrong status.

## Contributing

Built by Alex ([@alejandro-publius](https://github.com/alejandro-publius)),
Lindsay ([@lindsayy-l](https://github.com/lindsayy-l)), and
Varsha ([@varsha106-pixel](https://github.com/varsha106-pixel)) at the
SkyDeck hackathon.

Active branch is `alex/pgx-pipeline`. The deterministic spine
(`src/pgx.js`, `src/data/*.json`, `tests/pgx.test.mjs`) is the highest-bar
part of the codebase — changes there should keep `make test` green and add
a new case for any new branch of logic.

## License

TBD.
