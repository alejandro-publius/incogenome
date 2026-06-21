# DoseDNA — 5-minute demo script

Judging Sunday 4–6pm. Demos are 5 min max. Rehearse twice before going up.

## One-line pitch (memorize)

> DoseDNA is a privacy-first pharmacogenomics app. You drop in your 23andMe file, see how your DNA affects every drug in your medicine cabinet, and your genome never leaves your laptop. The pharmacogenomics is the wedge — the venture is private analysis for any sensitive health data.

## The 5 minutes (90s problem, 3m product, 30s ask)

**0:00 – 0:30 — Hook**
"Your DNA decides whether a drug works, fails, or hurts you. 90% of people carry at least one variant that changes how they metabolize a common medication. Today, finding out means either a $1,000 clinical test, or uploading your genome to a website you'll never get it back from. We built a third option."

**0:30 – 1:00 — Privacy claim, made falsifiable**
"Our entire pitch is that your DNA never leaves your device. Most demos would just tell you that. Instead — open the Privacy Console." *(Click the corner panel.)* "Every network call this page makes is logged here in real time. Watch this counter labelled 'DNA bytes that left your device.' It says zero. It will stay zero, no matter what I do next. If it ever ticks up, our entire product is a lie."

**1:00 – 2:30 — Core flow**
1. "Here's a 23andMe file I downloaded this morning." *(Click "Load sample file".)*
2. "It's reading on-device — you can watch it in your network tab too." *(Show parsed SNP count.)*
3. "Now we see the per-gene results. Green means standard dose, amber means caution, red means avoid." *(Tap a card.)*
4. "But genes alone aren't the story. The real risk is when your meds interact with your DNA. Watch." *(Type `clopidogrel, omeprazole` into the meds box.)*
5. "Phenoconversion: omeprazole inhibits the same enzyme that processes clopidogrel. Even if your DNA says you metabolize clopidogrel normally, this combination might mean it won't work for you. That's the kind of reasoning your pharmacist would do — we're putting it in your pocket."
6. "And here's a button you press before your next appointment." *(Click 'Generate questions for my clinician.')* "Six specific questions, generated in plain language, that turn this report into a productive conversation."

**2:30 – 3:30 — The privacy moment (the closer)**
"Throughout that whole demo, look at the Privacy Console. The only thing that left this laptop was three words: gene, phenotype, drug. No DNA. No genotype. No ID. Open the panel — read the actual payloads. Verify it yourself. We didn't claim privacy; we made it auditable."

**3:30 – 4:30 — Why it's a venture, not a feature**
"Pharmacogenomics is just our first wedge. The architecture — parse locally, reason with anonymized summaries, never upload — works for any sensitive health data. Bloodwork, hormone panels, cycle tracking, prescription history. We're building the privacy-first interpretation layer for the data people most want to understand and least want to upload."

**4:30 – 5:00 — Close + ask**
"This was built in 24 hours by four undergrads. We'd love your feedback, and if you're a SkyDeck partner we'd love to talk after. Thank you."

## Q&A prep (drill these)

| Question | One-sentence answer |
|---|---|
| "Isn't this just PharmCAT?" | PharmCAT is a Java pipeline for clinicians; ours runs on a patient's laptop, in the browser, with a privacy guarantee no server-side tool can offer. |
| "What's stopping someone from uploading the result anyway?" | Nothing — but the difference is the user is in control. We never had it. |
| "How is the AI load-bearing?" | The variant→phenotype chain is deterministic. The AI does the cross-data reasoning — drug-drug, phenoconversion, doctor-question generation — where rules don't scale. |
| "What about GINA / insurance?" | GINA protects health insurance and employment, but not life, disability, or long-term care. Our architecture means there's nothing to subpoena. |
| "Can a consumer chip really do this safely?" | We mark CYP2D6 as "coverage limited" because consumer arrays can't reliably call its structural variants. We're honest about what we can and can't see. |
| "What's next?" | Bloodwork interpretation, then prescription history, then any sensitive health data the user wants to understand without uploading. |

## Demo hygiene

- Pre-charge laptop to 100% and bring power adapter.
- Open dev tools network tab BEFORE judges arrive — it strengthens the privacy claim.
- Have `sample_23andme.txt` already in Downloads.
- Practice the Privacy Console opening line — it's the moment that wins.
- If proxy errors during demo: keep going. The bundled static text still renders. Say "and notice — the core works without AI too."
- Backup demo: a 60-second screen recording of the full flow, in case Wi-Fi or proxy dies.

## Who presents

Decide by Sunday 1pm. Whoever pitches must rehearse 2+ times. The other 3 stand behind, ready to answer technical Q&A.
