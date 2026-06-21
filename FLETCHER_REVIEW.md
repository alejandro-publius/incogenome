# FLETCHER REVIEW — DoseDNA, alex/pgx-pipeline

**Verdict:** Not quite my tempo. The engine plays in time now. The rest of this band is dragging.

---

## 1. What's unforgivable

The bar for a medical product is "this thing does not lie to a patient." You missed it in five places. Three are still missed.

- **The Privacy Console is theater.** It hooks `fetch`, `XHR`, `sendBeacon`, `WebSocket`. Four channels. There are at least ten. `new Image().src` exfiltrates. Injected `<script>`/`<iframe>` tags exfiltrate. `EventSource`, WebRTC, `window.open` with a query string, a hidden form `submit()` — all walk past your "auditable" badge. Your regex is `/[ACGT]{20,}/`. No `/i` flag. Lowercase the genotype, break it into 19-character chunks, or base64-encode it — straight through. A falsifiable claim any sophomore can falsify. **Make it catch everything, or take it off the slide.**

- **The proxy "allowlist" is a leaky regex.** `proxy.py` validates `gene`, `phenotype`, `drug` with `max_length` and a DNA-shape reject. That is not an allowlist. Spec §12b says the tuple must map to a real `guidance_id`. You don't check it. Anyone with the URL has a free Claude proxy. Replace the regex with a Python `set` of `(gene, phenotype, drug)` tuples from the bundle. Not in the set, 400. That is the job.

- **No precompute pipeline. "Core works offline" is a lie.** Spec §13 is the architecture. Every Explain click hits `claude-sonnet-4-6` live — wrong model, wrong path, wrong budget. Spec says `claude-haiku-4-5`, batched, into `data/explanations.json`. You skipped the script and swapped the model. Wi-Fi drops Sunday at 4:47 PM and the card spins forever while you explain that the offline product needs the internet.

---

## 2. What's mediocre

- **Three endpoints where the spec says one.** `/api/explain`, `/api/questions`, `/api/check-meds`. Sprawl on a 24-hour project. Collapse it.
- **44 tests passing on 2 of ~60 phenotype × drug combinations.** A green badge for a suite that doesn't test the product. Enumerate every tuple in the bundle and assert each one.
- **The lie in the UI.** `index.html` line 626: "Typically 15–25 MB." Your sample file is 8.5 KB. The first judge who opens the file inspector reads you the line.
- **README on `main`** mentions none of the demo features: no Privacy Console, no Check Meds, no Doctor Questions. Lindsay read it and didn't know what's built. Not her failure. Yours.
- **`.env` missing, venv shebangs pointed at a deleted `/incogenome/`.** The project did not run when audit started. That it runs now is a precondition, not a feature.

---

## 3. Fixed in this commit (don't get smug)

I'm noting the work. I am not congratulating you. *There are no two words in the English language more harmful than 'good job.'*

- **`pgx.js` rewritten.** Missing positions no longer default to `*1`/normal. The old code would have told a CYP2C19 Poor metabolizer "Intermediate — take the clopidogrel." A medical product that lies is not a product. Engine now enumerates every assignment over unknowns and only emits a phenotype when invariant. CYP2C9 sums activity only when every position is observed. TPMT flags `hetCount >= 2 && homCount === 0` as ambiguous instead of silently calling Deficient. Verify `tests/pgx.test.mjs` shows 52 passing.
- **Sentry killed.** `traces_sample_rate=1.0` + zero scrubbing + FastAPI integration was shipping every `gene + phenotype + drug` body to a third party. The pitch was "DNA never leaves" and you were shipping the next-best thing. Removing it doesn't make the pitch true. It makes it possible.
- **Sample file drop path wired into `index.html`.** Without it, the demo dies on the first click.
- **Doctor button label stabilized.** A button that renames itself mid-click is a child's bug in a five-minute pitch.
- **venv shebangs repaired.** The project runs.

---

## 4. What you do next (punch list — in order)

1. **Write the precompute script.** `scripts/precompute_explanations.py`. Enumerate every valid `(gene, phenotype, drug, coverage_state)` tuple from the bundle. Push them through the **Anthropic Message Batches API** on `claude-haiku-4-5`. Run the §13.3 denylist pass. Write `data/explanations.json`. Frontend does a dict lookup. Live call becomes the rare fallback the spec promised.
2. **Replace the regex in `proxy.py`** with a tuple allowlist loaded from the bundle at startup. Not in the set, 400. The only strings reaching Claude are ones *you* authored.
3. **Collapse three endpoints to one.** `/api/explain` with a `kind` field. One validator. One cache.
4. **Privacy Console: expand or remove.** Patch `Image`, `EventSource`, `RTCPeerConnection`, `window.open`, dynamic `<script>`/`<iframe>` via a `MutationObserver`, and `HTMLFormElement.submit`. Add `/i` to the ACGT regex. Or take it off the slide. Half a privacy console is a liability with a green dot on it.
5. **Test every tuple.** Generate the assertion matrix from the bundle. Missing guidance is a finding, not a green test.
6. **Fix the "15–25 MB" line in `index.html`.** Truth is cheap.
7. **README pass on `main`.** Privacy Console, Check Meds, Doctor Questions — named and described.

---

## 5. On coordination

Lindsay just pushed a 404-line build spec naming the exact files you already built. On a side branch. No DM, no PR, no signal. She is about to spend her Saturday writing `pgx.js` and `proxy.py` from scratch because you didn't tell her they exist. That is not her problem. That is yours.

*If you're not on time, you're not on tempo, you're not on the team.* You are off-tempo with your own band. Open Slack. Send her the branch link, the diff, the file paths, the punch list above. Do it before the next commit. A 24-hour project survives one merge conflict. It does not survive two people building the same module in parallel because nobody opened their mouth.

---

You fixed the bug that would have hurt a patient. Good. The job is not finished. The privacy claim is still a lie, the proxy is still an open relay, the offline core still requires the internet, and your teammate is still in the dark.

*Not quite my tempo.* Pick it up.
