// End-to-end benchmark: synthetic patient files → parser → engine → phenotype.
//
// Run with: node tests/patient-benchmark.test.mjs   (or: make benchmark)
//
// PURPOSE
// -------
// Proves the full deterministic pipeline reproduces the intended clinical call
// for every synthetic patient in sample/patients/, using the SAME parser and
// engine the live app runs — no shortcuts, no injected phenotypes.
//
// For each patient this test:
//   1. Reads the raw 23andMe file from sample/patients/.
//   2. Runs it through src/parser.worker.js in a vm sandbox (browser-Worker
//      contract preserved exactly as src/main.js drives it).
//   3. Confirms the parser extracted every variant the file deliberately seeds
//      (sample/patients/expected/patient_NN.json → seeded_targets).
//   4. Feeds the parsed genotypes to the real engine (src/pgx.js).
//   5. Asserts the engine produced the expected phenotype AND coverage_state
//      for each seeded gene.
//
// WHAT THIS VALIDATES (and what it does not)
// ------------------------------------------
// The genotype→phenotype mapping is the engine's OWN logic (driven by
// src/data/genes.json, which encodes published CPIC diplotype→phenotype
// tables). The patient files only specify GENOTYPES; the EXPECTATIONS below
// are the independently-known CPIC phenotype for that diplotype. So a pass
// means "engine agrees with the CPIC standard for this diplotype," not merely
// "engine agrees with itself."
//
// It does NOT validate that the chosen genotypes are realistic — these are
// hand-built synthetic samples. External validation against real reference
// samples lives in tests/getrm.test.mjs (CDC GeT-RM consensus).
//
// Patient 05 is the honesty case: incomplete CYP2C19 coverage MUST yield
// "Not determined" / "partial", proving the engine refuses to guess.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

import { buildEngine } from "../src/pgx.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));

const WORKER_SRC = readFileSync(join(ROOT, "src/parser.worker.js"), "utf8");
const GENES = readJson("src/data/genes.json");
const DRUGS = readJson("src/data/drugs.json");
const engine = buildEngine(GENES, DRUGS);

// ─── Worker harness ──────────────────────────────────────────────────────────
// Fresh sandbox per parse so onmessage state can't leak between patients.
// Mirrors tests/parser.test.mjs exactly.
function runWorker(fileText) {
  let onmessage = null;
  const posted = [];
  const fakeSelf = {
    set onmessage(fn) { onmessage = fn; },
    get onmessage() { return onmessage; },
    postMessage: (msg) => posted.push(msg),
  };
  const context = { self: fakeSelf };
  vm.createContext(context);
  vm.runInContext(WORKER_SRC, context, { filename: "parser.worker.js" });
  if (typeof onmessage !== "function") {
    throw new Error("worker did not register self.onmessage");
  }
  onmessage({ data: { type: "parse", fileText } });
  if (posted.length !== 1) {
    throw new Error(`expected 1 postMessage, got ${posted.length}`);
  }
  return posted[0];
}

// ─── Expected clinical calls ─────────────────────────────────────────────────
// Ground-truth CPIC phenotype per seeded gene. These live in the TEST, not in
// the data files, so the data files stay pure inputs. Each entry cites the
// diplotype the seeded genotypes encode.
const EXPECTATIONS = {
  "01": {
    CYP2C19: { phenotype: "Intermediate metabolizer", coverage_state: "confident",
               diplotype: "*2/*17" },
  },
  "02": {
    SLCO1B1: { phenotype: "Poor function", coverage_state: "confident",
               diplotype: "*5/*5 (rs4149056 C/C)" },
  },
  "03": {
    CYP2C9: { phenotype: "Poor metabolizer", coverage_state: "confident",
              diplotype: "*2/*3" },
    VKORC1: { phenotype: "High sensitivity", coverage_state: "confident",
              diplotype: "-1639 A/A" },
  },
  "04": {
    TPMT: { phenotype: "Deficient activity", coverage_state: "confident",
            diplotype: "*3B/*3B" },
  },
  "05": {
    // Honesty case: only rs4244285 (reference) present, *3 position missing →
    // engine must refuse to call CYP2C19.
    CYP2C19: { phenotype: "Not determined", coverage_state: "partial",
               diplotype: "incomplete coverage" },
    SLCO1B1: { phenotype: "Normal function", coverage_state: "confident",
               diplotype: "*1/*1 (rs4149056 T/T)" },
  },
};

// ─── Test runner ─────────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
const failures = [];

function assert(name, condition, detail = "") {
  if (condition) {
    pass++;
    process.stdout.write(`  ✓ ${name}\n`);
  } else {
    fail++;
    failures.push(`✗ ${name}${detail ? `\n    ${detail}` : ""}`);
    process.stdout.write(`  ✗ ${name}\n`);
  }
}

process.stdout.write("Patient benchmark: file → parser → engine → phenotype\n");

for (const id of Object.keys(EXPECTATIONS)) {
  process.stdout.write(`\nPatient ${id}\n`);

  const fileText = readFileSync(
    join(ROOT, `sample/patients/patient_${id}_23andme.txt`), "utf8");
  const seeded = readJson(`sample/patients/expected/patient_${id}.json`)
    .seeded_targets || {};

  const reply = runWorker(fileText);
  const genotypes = reply.genotypes || {};

  // 1. Parser found every seeded variant.
  for (const [rsid, target] of Object.entries(seeded)) {
    assert(
      `parsed ${rsid} (${target.gene} ${target.star}) = ${target.genotype}`,
      genotypes[rsid] === target.genotype,
      `got ${genotypes[rsid] ?? "<absent>"}`,
    );
  }

  // 2. Engine produces the expected phenotype + coverage for each seeded gene.
  const results = engine.genotypesToResults(genotypes);
  for (const [gene, exp] of Object.entries(EXPECTATIONS[id])) {
    const r = results.find((g) => g.gene === gene);
    assert(
      `${gene} ${exp.diplotype} → "${exp.phenotype}" [${exp.coverage_state}]`,
      r && r.phenotype === exp.phenotype && r.coverage_state === exp.coverage_state,
      `got "${r ? r.phenotype : "<no result>"}" [${r ? r.coverage_state : "-"}]`,
    );
  }
}

// ─── Summary ─────────────────────────────────────────────────────────────────
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) {
  process.stdout.write("\n" + failures.join("\n") + "\n");
  process.exit(1);
}
