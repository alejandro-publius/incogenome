# DoseDNA — demo script

**Event:** AI Hackathon 2026 at Berkeley · **Track:** Best Beginner Hack
**Judging:** Sunday June 21, 1–3pm · science fair format
**Slot:** 5 minutes total per judge — **3 min pitch + 2 min Q&A.** Rehearse twice.

---

## One-line pitch (memorize)

> *DoseDNA is a chat agent that reads your DNA file in your browser and answers, in plain language, how your DNA affects medications — grounded in CPIC's live clinical guidelines, anchored to peer-reviewed RCTs, and built so that even what does leave your laptop is statistically anonymous to the LLM provider.*

---

## The 3 minutes

**0:00 – 0:20 — Hook**

> *"Your DNA decides whether a drug works, fails, or hurts you. Today, finding out means a $1,000 clinical test or uploading your genome to a website you can't get back. We built a third option — a chat agent that does the interpretation in your browser, with the privacy guarantees made checkable."*

**0:20 – 0:50 — Load DNA + show local parsing**

*(Click **Load sample DNA**.)*

> *"This 23andMe file is being read in this tab. The deterministic engine — 79 unit tests against PharmVar's variant catalog and CPIC's diplotype tables — just called six phenotypes."*

*(Point at the phenotype chips that appear.)*

> *"Zero raw DNA bytes left this laptop. The Privacy Console in the corner is logging every outbound network call live — you can open it and read each one."*

**0:50 – 1:40 — Ask a real question + show CPIC grounding**

*(Type: "Should I be worried about clopidogrel and omeprazole?")*

*(Reply appears.)*

> *"Two things happened. First, look at the chips below the reply — green 'CPIC Strong' for clopidogrel, amber 'CPIC Moderate' for omeprazole. These pull CPIC's actual evidence classification from the live CPIC API — click any of them and you land on the published guideline with the peer-reviewed studies CPIC used to assign the rating."*

*(Click a chip — `cpicpgx.org` opens in a new tab.)*

> *"Second — the agent itself caught the phenoconversion: omeprazole inhibits the enzyme that activates clopidogrel. That's not the LLM hallucinating; it's a deterministic lookup against our bundled FDA-cited interactions table."*

**1:40 – 2:10 — The privacy moment (this is the closer)**

*(Point at the blue shield chip below the reply.)*

> *"Here's where we go further than 'parsed locally.' The phenotype-and-drug summary did go to Claude, because that's what the chat needs. But every time you hit send, your real query is mixed with five decoy queries drawn at random from our allowlist — same model, same system prompt, fired in parallel. Anthropic logs six requests per turn. They can't tell which one was you. Your real question is statistically anonymous from the provider's view."*

**2:10 – 2:40 — How we know it works**

> *"We didn't validate by saying 'CPIC says so' — that's circular. We built a literature-grounded test suite where each case is anchored to a specific peer-reviewed RCT: TAILOR-PCI for clopidogrel, SEARCH for simvastatin, EU-PACT for warfarin, plus four others. The agent passes 7 of 7. We also ran the published PGxQA expert-review benchmark — Keat et al., PSB 2025 — and the agent matched the expert reference on 5 of 6 in-scope cases and correctly refused 4 of 4 out-of-scope cases."*

**2:40 – 3:00 — Close**

> *"DoseDNA is the patient-facing version of an architecture other PGx tools haven't combined: browser-local parsing, deterministic phenotype calling, CPIC-grounded chat with provider-side anonymity. We built it in 24 hours, it's open-source on GitHub, and we'd love your feedback. Thank you."*

---

## Q&A drills (rehearse out loud)

| Question a judge might ask | Answer |
|---|---|
| **"Isn't this just a ChatGPT wrapper?"** | "Vanilla LLMs handle textbook questions OK when you already know your phenotype. But they can't read a 23andMe file, can't fetch CPIC's live recommendation, can't show you their work, and can't refuse cleanly. We benchmarked head-to-head against vanilla Claude on the same RCT-anchored cases. Our value is the architecture — privacy, deterministic spine, click-through provenance — not 'better at clinical content.'" |
| **"How is this different from 23andMe Health?"** | "23andMe uploads your genome to their servers (10M+ accounts were breached in 2023). We parse in the browser; nothing leaves. They're FDA-restricted to a handful of variants; we surface CPIC's full live guidance. They give static PDFs; we give a chat you can ask follow-up questions in." |
| **"How did you validate?"** | "Three independent tests. 79 unit tests on the deterministic engine against PharmVar + CPIC reference tables — that part is externally validated. Seven literature-grounded cases anchored to specific RCTs (TAILOR-PCI, SEARCH, EU-PACT, etc.) — passed all 7. PGxQA expert-review benchmark from Keat et al. PSB 2025 — passed 5 of 6 in-scope partial matches and 4 of 4 out-of-scope refusal. We're honest about what's external vs. internal — there's a methodology audit in the repo." |
| **"So data still goes to Anthropic — what's the privacy story?"** | "Three independent layers. One: raw DNA never leaves the browser, period — the engine calls phenotypes locally. Two: only de-identified labels (gene, phenotype, drug name) ever go out, never rsIDs or genotypes. Three: every real query is mixed with 5 decoy queries to the same provider — same model, same prompt — so even at the provider's log, your real question is statistically anonymous. We don't claim perfect privacy. We claim minimization plus cover traffic." |
| **"You're shipping your own API key — that won't scale."** | "Correct, and we don't pretend otherwise. Phase 1, what you're seeing today, is a centralized proxy — fine for a research prototype, not for a product. Phase 2 is bring-your-own-key — user pastes their Anthropic key, our allowlist and decoys still run. We deliberately segregated the LLM call behind a single tool boundary so swapping it is a one-line change, not a rewrite." |
| **"Can the chat hallucinate?"** | "Every clinical claim has to come from a tool call against our bundle or CPIC's live API. If a tool returns 'not in our authored set,' the agent says so — we tested 4 out-of-scope drugs and got a clean refusal every time. Ask about amitriptyline — it's not in our 17-drug allowlist — and watch it decline." |
| **"Why CPIC specifically, and isn't that just one source?"** | "CPIC is the clinical-grade consortium that synthesizes peer-reviewed RCTs and assigns evidence strength using a documented methodology. The chips link straight to their guideline page so you can read the studies they used. We also bundle PharmVar variant definitions and FDA/CPIC-cited drug interactions — same chain of sources PGxQA's benchmark draws from." |
| **"What does 'research prototype' mean on the banner?"** | "It means we have not run a prospective clinical trial. Our deterministic engine is validated against published reference tables and our agent matches CPIC's published text. We have NOT had a clinician sign off on every paraphrase; we have NO patient outcome data. That's why the banner is there and the agent never gives a dose or tells you to stop a medication." |
| **"What's next?"** | "Three things. One: clinician review pass on the agent's paraphrases. Two: bring-your-own-key UI so the proxy isn't a bottleneck. Three: expand from 17 CPIC drugs to the full CPIC catalog and add PharmGKB clinical annotations as a second authoritative source." |

---

## Demo hygiene

- Laptop charged. Power adapter at the table.
- `make proxy` running in one terminal. `make web` in another. **Browser pre-loaded at `http://localhost:8000/`** before judges arrive.
- Sample DNA file **already loaded** in the chat — phenotype chips visible — so judges don't watch you click through setup.
- Privacy Console **collapsed by default** (the small "● See where my data goes" pill in the corner) — only open it when you want to make the privacy point.
- If the proxy errors mid-demo: the page still renders, you can still show phenotypes and the architecture. Say *"the deterministic engine works regardless of whether the LLM is reachable."*

---

## Backup options

- **GitHub Pages deploy** (`https://alejandro-publius.github.io/dosedna/`): polished landing page works, but chat will fail there because the proxy is on localhost. Use this URL for the GitHub link in your Devpost, NOT for the demo.
- **Local demo URL: `http://localhost:8000/`** — this is what you point your laptop screen at.

---

## Who presents

Decide by Sunday 11am. Presenter rehearses twice with the script above. The other teammates stand behind, ready for Q&A.
