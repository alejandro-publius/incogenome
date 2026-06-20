// Known-answer tests for the deterministic PGx engine.
//
// Run with: node tests/pgx.test.mjs   (or: make test)
//
// These tests pin the phenotype output for the bundled sample DNA file and a
// handful of synthetic edge cases. They catch the silent-bug class the README
// flags: strand mistakes that pass the {ref, alt} check but flip a call.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { buildEngine } from "../src/pgx.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));

const GENES = readJson("src/data/genes.json");
const DRUGS = readJson("src/data/drugs.json");
const EXPECTED = readJson("sample/expected_phenotypes.json");

const engine = buildEngine(GENES, DRUGS);

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

function section(title) {
  process.stdout.write(`\n${title}\n`);
}

// ─── 1. Known-answer test on the bundled sample ──────────────────────────────
section("Bundled sample (sample_23andme.txt)");

{
  const results = engine.genotypesToResults(EXPECTED.genotypes_at_targets);
  const byGene = Object.fromEntries(results.map((r) => [r.gene, r]));

  for (const [gene, expected] of Object.entries(EXPECTED.phenotypes)) {
    const r = byGene[gene];
    assert(
      `${gene} phenotype is "${expected.phenotype}"`,
      r && r.phenotype === expected.phenotype,
      r ? `got "${r.phenotype}"` : "gene missing from results",
    );
    assert(
      `${gene} coverage_state is "${expected.coverage_state}"`,
      r && r.coverage_state === expected.coverage_state,
      r ? `got "${r.coverage_state}"` : "gene missing from results",
    );
  }
}

// ─── 2. Strand handling: same call regardless of plus/minus orientation ──────
section("Strand handling (minus strand should not flip the call)");

{
  // CYP2C19 *2: plus-strand ref=G, alt=A. Minus-strand of "GA" is "CT".
  const plusResults = engine.genotypesToResults({ rs4244285: "GA" });
  const minusResults = engine.genotypesToResults({ rs4244285: "CT" });
  const plus = plusResults.find((r) => r.gene === "CYP2C19");
  const minus = minusResults.find((r) => r.gene === "CYP2C19");
  assert(
    "rs4244285 GA (plus) → Intermediate metabolizer",
    plus.phenotype === "Intermediate metabolizer",
    `got ${plus.phenotype}`,
  );
  assert(
    "rs4244285 CT (minus, complement of GA) → same Intermediate call",
    minus.phenotype === "Intermediate metabolizer",
    `got ${minus.phenotype}`,
  );
  assert(
    "minus-strand homozygous TT → Poor metabolizer (same as plus AA)",
    engine
      .genotypesToResults({ rs4244285: "TT" })
      .find((r) => r.gene === "CYP2C19").phenotype === "Poor metabolizer",
  );
}

// ─── 3. Missing variants must NOT default to Normal ──────────────────────────
section("Honesty rule: missing → Not determined, never Normal");

{
  // Empty genotypes for everything.
  const results = engine.genotypesToResults({});
  for (const r of results) {
    if (r.gene === "CYP2D6") continue; // structural-only is "Coverage limited"
    assert(
      `${r.gene} with no data → Not determined`,
      r.phenotype === "Not determined",
      `got "${r.phenotype}"`,
    );
    assert(
      `${r.gene} with no data → coverage_state = not-callable`,
      r.coverage_state === "not-callable",
      `got "${r.coverage_state}"`,
    );
  }
}

{
  // Partial coverage with no variant alleles seen → still Not determined.
  // CYP2C19 with only one of three required SNPs, and it's reference.
  const results = engine.genotypesToResults({ rs4244285: "GG" });
  const cyp2c19 = results.find((r) => r.gene === "CYP2C19");
  assert(
    "CYP2C19 with only 1/3 variants seen (all reference) → Not determined",
    cyp2c19.phenotype === "Not determined",
    `got "${cyp2c19.phenotype}"`,
  );
  assert(
    "...and coverage_state = partial",
    cyp2c19.coverage_state === "partial",
    `got "${cyp2c19.coverage_state}"`,
  );
}

// ─── 4. CYP2D6 is always Coverage limited ────────────────────────────────────
section("CYP2D6 is always 'Coverage limited'");

{
  // Even if random rsIDs are present, CYP2D6 ignores them.
  const results = engine.genotypesToResults({ rs4244285: "AA" });
  const cyp2d6 = results.find((r) => r.gene === "CYP2D6");
  assert(
    "CYP2D6 phenotype = Coverage limited",
    cyp2d6.phenotype === "Coverage limited",
    `got "${cyp2d6.phenotype}"`,
  );
  assert(
    "CYP2D6 coverage_state = not-callable",
    cyp2d6.coverage_state === "not-callable",
  );
  assert(
    "CYP2D6 returns drug rows for codeine/tramadol/tamoxifen",
    cyp2d6.drugs.length >= 3,
    `got ${cyp2d6.drugs.length} drugs`,
  );
}

// ─── 5. Diplotype edge cases per current CPIC ────────────────────────────────
section("CYP2C19 diplotype edge cases (CPIC)");

{
  const cases = [
    // [rs4244285 (*2), rs4986893 (*3), rs12248560 (*17), expected phenotype]
    ["AA", "GG", "CC", "Poor metabolizer"],                  // *2/*2
    ["GG", "GG", "TT", "Ultrarapid metabolizer"],            // *17/*17
    ["GG", "GG", "CT", "Rapid metabolizer"],                 // *1/*17
    ["GA", "GG", "CT", "Intermediate metabolizer"],          // *2/*17 (NOT averaged)
    ["GA", "GA", "CC", "Poor metabolizer"],                  // *2/*3
    ["GG", "GG", "CC", "Normal metabolizer"],                // *1/*1
  ];
  for (const [v2, v3, v17, expected] of cases) {
    const r = engine
      .genotypesToResults({
        rs4244285: v2,
        rs4986893: v3,
        rs12248560: v17,
      })
      .find((g) => g.gene === "CYP2C19");
    assert(
      `CYP2C19 ${v2}/${v3}/${v17} → ${expected}`,
      r.phenotype === expected,
      `got "${r.phenotype}"`,
    );
  }
}

// ─── 6. CYP2C9 activity score boundaries ─────────────────────────────────────
section("CYP2C9 activity score boundaries");

{
  const cases = [
    // [rs1799853 (*2), rs1057910 (*3), expected]
    ["CC", "AA", "Normal metabolizer"],         // 2.0
    ["CT", "AA", "Intermediate metabolizer"],   // 1.5
    ["TT", "AA", "Intermediate metabolizer"],   // 1.0
    ["CC", "AC", "Intermediate metabolizer"],   // 1.0
    ["TT", "AC", "Poor metabolizer"],           // 0.5
    ["CC", "CC", "Poor metabolizer"],           // 0.0
  ];
  for (const [v2, v3, expected] of cases) {
    const r = engine
      .genotypesToResults({ rs1799853: v2, rs1057910: v3 })
      .find((g) => g.gene === "CYP2C9");
    assert(
      `CYP2C9 ${v2}/${v3} → ${expected}`,
      r.phenotype === expected,
      `got "${r.phenotype}"`,
    );
  }
}

// ─── 7. Drug lookups produce the right flag colors ───────────────────────────
section("Drug recommendation lookups");

{
  const results = engine.genotypesToResults(EXPECTED.genotypes_at_targets);
  const cyp2c19 = results.find((r) => r.gene === "CYP2C19");
  const clopi = cyp2c19.drugs.find((d) => d.drug === "clopidogrel");
  assert(
    "CYP2C19 IM + clopidogrel → amber flag",
    clopi && clopi.flag === "amber",
    clopi ? `got "${clopi.flag}"` : "missing",
  );

  const slco = results.find((r) => r.gene === "SLCO1B1");
  const simva = slco.drugs.find((d) => d.drug === "simvastatin");
  assert(
    "SLCO1B1 Decreased + simvastatin → amber flag",
    simva && simva.flag === "amber",
  );
}

// ─── Summary ─────────────────────────────────────────────────────────────────
process.stdout.write(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) {
  process.stdout.write("\nFailures:\n" + failures.join("\n") + "\n");
  process.exit(1);
}
