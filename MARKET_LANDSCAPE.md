# Market landscape — where DoseDNA fits

This is the *"here is the current system… and here are the flaws / here
is our system that does not have those issues"* slide the mentor asked
for. Every number is cited; no estimates.

## The map

| Product | Who it's for | Cost | Privacy posture | Output format | Documented failure mode |
|---|---|---|---|---|---|
| **23andMe Health Service** (TTAM-owned, 2025–) | Consumer | $99–199 + Health subscription | Whole genome uploaded to vendor servers, 10-year+ retention | Static PDF reports | **2023 breach exposed PGx data + ancestry for ~7M people; £2.31M ICO fine; $30M class-action settlement (final Jan 2026); company went bankrupt and the 15M-customer genetic database was sold to TTAM in July 2025** |
| **Genomind PGx** | Mental-health patient (clinician-ordered) | $300–500 out-of-pocket | Saliva → CLIA lab, vendor retains data | Clinician report | Requires physician order; uneven insurance coverage; weeks to result; no patient-facing Q&A |
| **OneOme RightMed** | Multi-specialty patient (clinician-ordered) | $300–600 | Saliva → CLIA lab | Clinician report | **Company went out of business in 2025; assets acquired by Tempus AI** — long-tail support unclear |
| **PharmCAT** (PharmGKB) | Clinician / bioinformatician | Free (MPL 2.0, open source) | Local (if user can run the Java CLI on a VCF) | JSON / HTML report | **CLI-only, no patient UI, requires VCF (not consumer 23andMe/Ancestry format), Java dependency, limited real-world validation** |
| **Vanilla LLMs** (ChatGPT, Claude.ai, etc.) | Consumer | $0–$20/mo | Genome data → provider logs | Free-form chat | **Cannot read a DNA file. No source of truth → hallucinates clinical claims. No refusal behavior. No phenotype calling.** |
| **DoseDNA** *(this project)* | Consumer | Free (open source) | Parse in browser + decoy cover traffic + de-identified labels only | Chat with click-through CPIC citations + tool trace | 17 CPIC drugs (not full catalog), research prototype, no clinician sign-off |

## The hole DoseDNA fills

Plot each product on (free vs paid) × (patient vs clinician) × (uploads
genome vs local):

- **Patient-facing + free + does NOT upload your genome:** that quadrant is empty in the existing market. Every patient-facing PGx tool either charges $99–600 OR uploads your genome OR both. The one free local tool (PharmCAT) is a Java CLI for clinicians.

DoseDNA is the first patient-facing free option that doesn't require uploading.

## Per-flaw mapping

Mentor's framework — current system flaws → DoseDNA's answer:

| Flaw in existing system | DoseDNA's mitigation | Mechanism |
|---|---|---|
| 23andMe's 7M-account 2023 breach exposed PGx data | Raw DNA never leaves the browser | Parser worker runs in-page; only de-identified labels (gene, phenotype, drug name) are ever sent to the proxy; the proxy's DNA-shape regex rejects any payload that looks like raw genotypes |
| 23andMe genome database was sold to a new owner (TTAM) under bankruptcy | Architecturally impossible — we never hold the data | We have no servers, no database, no account |
| Clinical PGx panels cost $300–2000 and require clinician order | $0, no clinician gatekeeping, runs on the user's laptop | Browser-local engine + free CPIC API |
| PharmCAT is a Java CLI with no patient UI | Chat interface in plain English | Anthropic tool-use loop grounding every claim in CPIC's live API |
| Vanilla LLMs hallucinate clinical facts | Every clinical claim must come from a tool call against CPIC or our bundled FDA/CPIC tables; out-of-scope drugs refuse cleanly | PGxQA benchmark: 5/6 partial matches in-scope + **4/4 clean refusals out-of-scope** |
| Vanilla LLMs can't read a DNA file | Deterministic engine + parser pre-processes the file before the LLM ever sees a label | 79 unit tests against PharmVar + CPIC reference tables |
| Even minimal data sent to an LLM provider can be linked to a user | Cover-traffic decoys: every real query mixed with 5 random allowlist queries | Provider's log shows 6 indistinguishable requests per turn; cannot identify the real user |

## What we are NOT trying to be

- A diagnostic device (we're a research prototype; the banner says so).
- A replacement for clinical PGx panels (those are CLIA-certified labs).
- A genome storage service (we never hold the data).
- A clinician decision-support tool (PharmCAT covers that).

## Roadmap (mentor's "next step is hospital collaboration")

Phase 2 of DoseDNA is the academic-collaboration tier:
- Partner with a CPIC-affiliated academic medical center (St. Jude, Stanford, Mayo Clinic — all of which contribute to CPIC) for **prospective validation against their own clinical PGx panel results**.
- Add PharmGKB clinical annotations and the FDA Table of Pharmacogenomic Biomarkers as additional authoritative tool sources (the same chain PGxQA's benchmark draws from).
- Replace the centralized Anthropic call with BYOK (user-supplied key) so the architecture stops sharing one API key across users.

## Sources

- [23andMe Data Breach: What Was Exposed, Who Was Affected — Security.org](https://www.security.org/identity-theft/breach/23andme/)
- [23andMe bankruptcy + 15M customers, FierceHealthcare](https://www.fiercehealthcare.com/regulatory/23andme-bankruptcy-sparks-genetic-data-privacy-concerns-its-15m-customers)
- [PIPEDA Findings #2025-001 — joint UK/Canada privacy investigation](https://www.priv.gc.ca/en/opc-actions-and-decisions/investigations/investigations-into-businesses/2025/pipeda-2025-001/)
- [23andMe £2.31M UK fine, Pharmaphorum](https://pharmaphorum.com/news/23andme-fined-ps231m-over-uk-users-genetic-data-breach)
- [Pharmacogenomic Testing Cost — DecodeMyBio](https://decodemybio.com/learn/pharmacogenomic-testing-cost)
- [Genomind PGx Express pricing](https://genomind.com/cost-and-coverage/)
- [Tempus acquires OneOme assets, Precision Medicine Online](https://www.precisionmedicineonline.com/precision-oncology/tempus-acquiring-pharmacogenetics-assets-recently-defunct-oneome)
- [PharmCAT overview, Oxford Briefings in Bioinformatics 2024](https://academic.oup.com/bib/article/25/1/bbad452/7458913)
- [PharmCAT GitHub](https://github.com/PharmGKB/PharmCAT)
- [PGxQA benchmark (Keat et al., PSB 2025)](https://github.com/KarlKeat/PGxQA)
