// End-to-end validation suite for the DoseDNA chat agent.
//
// Run with: node tests/agent.test.mjs   (or: make agent-test)
//
// Each case sends a real chat request to the proxy at localhost:8001 and
// checks whether the reply contains at least one of the expected CPIC-aligned
// key phrases for that (phenotype, drug) combination. This is the bare-minimum
// version of the PGxQA-style validation pattern: instead of trusting the
// chatbot because it "cites CPIC," we measure whether its plain-English reply
// actually matches what CPIC's published recommendation says to do.
//
// HARD RULE: the expected key phrases below are derived from CPIC's *actual*
// published guidance for each pair — not invented to make the agent look good.
// If the agent fails a case, that's signal, not noise.

const PROXY = "http://localhost:8001";
const TIMEOUT_MS = 60_000;

// Each case:
//   prompt:       the user's question to the chat agent
//   phenotypes:   verified phenotype context for the relevant gene(s)
//   expect_any:   reply must contain AT LEAST ONE of these (case-insensitive)
//                 — chosen to match CPIC's actual guidance for the case
//   forbid:       reply must NOT contain any of these (catch failure modes
//                 like recommending the drug at standard dose when it shouldn't)
const CASES = [
  {
    name: "CYP2C19 Poor Metabolizer + clopidogrel → must steer away from clopidogrel",
    prompt: "Should I be worried about taking clopidogrel?",
    phenotypes: [{ gene: "CYP2C19", phenotype: "Poor metabolizer" }],
    expect_any: ["ticagrelor", "prasugrel", "alternative", "avoid"],
    forbid: ["safe to take at standard dose"],
  },
  {
    name: "CYP2C19 Normal Metabolizer + clopidogrel → standard dose OK",
    prompt: "Is clopidogrel fine for me?",
    phenotypes: [{ gene: "CYP2C19", phenotype: "Normal metabolizer" }],
    expect_any: ["standard", "normal", "as prescribed", "no adjustment"],
    forbid: ["avoid clopidogrel", "don't take"],
  },
  {
    name: "SLCO1B1 Poor function + simvastatin → red flag, lower dose / alternative",
    prompt: "What about simvastatin?",
    phenotypes: [{ gene: "SLCO1B1", phenotype: "Poor function" }],
    expect_any: ["alternative", "lower", "different statin", "myopathy", "muscle"],
    forbid: ["safe at standard dose"],
  },
  {
    name: "SLCO1B1 Decreased function + simvastatin → caution, often alternative",
    prompt: "Is simvastatin OK for me?",
    phenotypes: [{ gene: "SLCO1B1", phenotype: "Decreased function" }],
    expect_any: ["alternative", "lower", "different statin", "myopathy", "muscle"],
    forbid: [],
  },
  {
    name: "TPMT Deficient activity + azathioprine → severe risk, alternative / drastic reduction",
    prompt: "Anything I should know about azathioprine?",
    phenotypes: [{ gene: "TPMT", phenotype: "Deficient activity" }],
    expect_any: ["alternative", "avoid", "drastically", "severely", "bone marrow", "toxicity"],
    forbid: ["safe at standard dose"],
  },
  {
    name: "TPMT Normal activity + azathioprine → standard dose OK",
    prompt: "Should I be cautious with azathioprine?",
    phenotypes: [{ gene: "TPMT", phenotype: "Normal activity" }],
    expect_any: ["standard", "normal", "as prescribed", "no adjustment"],
    forbid: ["avoid azathioprine"],
  },
  {
    name: "CYP2D6 Coverage limited + codeine → must acknowledge undeterminable status",
    prompt: "Can I take codeine?",
    phenotypes: [{ gene: "CYP2D6", phenotype: "Coverage limited" }],
    expect_any: [
      "coverage limited",
      "not determined",
      "couldn't determine",
      "can't determine",
      "cannot determine",
      "uncertain",
      "consumer",
    ],
    forbid: [],
  },
];

async function callChat({ prompt, phenotypes }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${PROXY}/api/explain`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "chat",
        message: prompt,
        phenotypes,
        medications: [],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function containsAny(haystack, needles) {
  const lc = haystack.toLowerCase();
  return needles.find((n) => lc.includes(n.toLowerCase())) ?? null;
}

const results = [];

for (const c of CASES) {
  process.stdout.write(`\n• ${c.name}\n`);
  try {
    const data = await callChat({ prompt: c.prompt, phenotypes: c.phenotypes });
    const reply = data.reply || "";
    const matched = containsAny(reply, c.expect_any);
    const violated = c.forbid.length ? containsAny(reply, c.forbid) : null;
    const tools = (data.tool_trace || []).map((t) => t.tool).join(", ") || "(none)";
    if (matched && !violated) {
      console.log(`  ✓ PASS — matched "${matched}"`);
      console.log(`    tools: ${tools}`);
      results.push({ name: c.name, pass: true, matched, reply });
    } else {
      console.log(`  ✗ FAIL`);
      if (!matched) console.log(`    expected any of: ${c.expect_any.join(", ")}`);
      if (violated) console.log(`    forbidden phrase appeared: "${violated}"`);
      console.log(`    tools fired: ${tools}`);
      console.log(`    reply (first 280 chars): ${reply.slice(0, 280).replace(/\n/g, " ")}`);
      results.push({ name: c.name, pass: false, reply, violated });
    }
  } catch (err) {
    console.log(`  ✗ ERROR — ${err.message}`);
    results.push({ name: c.name, pass: false, error: err.message });
  }
}

const pass = results.filter((r) => r.pass).length;
const total = results.length;
console.log(`\n=====================================`);
console.log(`DoseDNA agent validation: ${pass}/${total} cases passed`);
console.log(`=====================================`);

if (pass < total) {
  console.log(`\nFailures:`);
  for (const r of results.filter((r) => !r.pass)) {
    console.log(`  - ${r.name}${r.error ? ` (error: ${r.error})` : ""}`);
  }
}

process.exit(pass === total ? 0 : 1);
