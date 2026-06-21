// CDC GeT-RM known-answer fixtures for the PGx engine.
//
// Run with: node tests/getrm.test.mjs   (or: make getrm)
//
// PURPOSE (BUILD_SPEC §14b)
// -------------------------
// The CDC Genetic Testing Reference Materials (GeT-RM) program publishes
// CONSENSUS star-allele diplotypes for Coriell cell-line samples, determined
// by multiple labs across multiple platforms. These are the gold standard for
// validating a pharmacogenomics caller: if our deterministic engine reproduces
// the GeT-RM consensus on a sample's genotypes-at-target, the caller is
// correct on that sample. If it doesn't, we have a bug worth fixing before
// any clinical claim.
//
// HARD RULE (per project instructions): GENOTYPES MUST NOT BE FABRICATED.
// Every fixture entered into FIXTURES below MUST cite a real, primary CDC
// GeT-RM consensus genotype (paper + table). Inventing data here defeats the
// entire point of this file.
//
// CURRENT STATE: EMPTY SCAFFOLD ───────────────────────────────────────────────
// As of this commit, FIXTURES is empty. The author attempted to fetch per-
// sample consensus diplotypes from the canonical GeT-RM PMC papers via the
// agent's WebFetch tool, but WebFetch was permission-denied for
// pmc.ncbi.nlm.nih.gov in this environment. WebSearch snippets confirmed the
// papers exist and named NA12878 as a reference sample, but did NOT surface
// per-sample diplotype values — only meta-commentary. That is not a citable
// primary source for a genotype call, so per project policy nothing was
// imported.
//
// TO POPULATE (TODO):
// Mine the following primary sources for per-sample (Coriell NA-ID) consensus
// diplotypes covering CYP2C19, CYP2C9, VKORC1, SLCO1B1, TPMT, then translate
// each diplotype to expected genotypes at the rsIDs in src/data/genes.json:
//
//   [1] Pratt VM, Zehnbauer B, Wilson JA, et al. "Characterization of 107
//       genomic DNA reference materials for CYP2D6, CYP2C19, CYP2C9, VKORC1,
//       and UGT1A1: a GeT-RM and Association for Molecular Pathology
//       collaborative project." J Mol Diagn. 2010 Nov;12(6):835-46.
//       PMID: 20889555. PMC: PMC2933072.
//       https://pmc.ncbi.nlm.nih.gov/articles/PMC2933072/
//       → Tables 2-3: per-sample CYP2C19, CYP2C9, VKORC1 consensus.
//
//   [2] Pratt VM, Everts RE, Aggarwal P, et al. "Characterization of 137
//       Genomic DNA Reference Materials for 28 Pharmacogenetic Genes: A GeT-RM
//       Collaborative Project." J Mol Diagn. 2016 Jan;18(1):109-23.
//       PMC: PMC4695224.
//       https://pmc.ncbi.nlm.nih.gov/articles/PMC4695224/
//       → Supplemental tables: SLCO1B1, TPMT, plus expanded CYP coverage.
//
//   [3] Pratt VM, Cavallari LH, Del Tredici AL, et al. "Recommendations for
//       Clinical CYP2C19 Genotyping Allele Selection" (AMP Tier 2 update).
//       J Mol Diagn. Updated CYP2C9/CYP2C19/VKORC1 consensus.
//       PMID: 34020041.
//
//   [4] TPMT/NUDT15 GeT-RM characterization paper (J Mol Diagn 2022,
//       https://www.sciencedirect.com/science/article/pii/S1525157822001957).
//       → Needed specifically for the *3A vs *3B+*3C phasing-ambiguous case.
//
//   [5] CDC GeT-RM living consensus tables:
//       https://www.cdc.gov/lab-quality/php/get-rm/reference-materials.html
//
// PHASING-AMBIGUOUS FIXTURE REQUIRED:
// Per BUILD_SPEC §14b and §7b's TPMT gotcha, AT LEAST ONE fixture must be a
// TPMT sample where rs1800460 and rs1142345 are both heterozygous and
// rs1800462 is reference. Unphased data cannot distinguish *3A/*1 (single
// star allele, Intermediate activity) from *3B/*3C (two star alleles,
// Deficient activity). The engine's variant-count path (src/pgx.js
// evalVariantCount, "hetCount >= 2 && homCount === 0" branch) is designed to
// emit phenotype = "Not determined" / coverage_state = "partial" in this
// case. The test asserts the engine refuses to make a confident wrong call,
// NOT that it produces either Intermediate or Deficient.
//
// FIXTURE SHAPE
// -------------
// Each fixture object describes one Coriell sample, and per gene gives:
//   - diplotype:        the published GeT-RM consensus star-allele call
//   - genotypes:        expected raw genotype at each rsID our pipeline reads
//                       (plus-strand, per src/data/genes.json file_strand)
//   - expect_phenotype: the phenotype OR the literal "Not determined" if the
//                       call is intentionally ambiguous (phase-ambiguous TPMT,
//                       out-of-scope allele, etc.)
//   - cite:             "Author Year, PMID, table/row" — load-bearing; without
//                       this the row should NOT be added.
//
// Example fixture (KEEP COMMENTED until verified against the cited table):
//
//   // {
//   //   sample: "NA12878",
//   //   notes: "1000 Genomes CEU; widely used reference",
//   //   genes: {
//   //     CYP2C19: {
//   //       diplotype: "*1/*17",          // TODO verify against Pratt 2010 Table 2
//   //       genotypes: { rs4244285: "GG", rs4986893: "GG", rs12248560: "CT" },
//   //       expect_phenotype: "Rapid metabolizer",
//   //       cite: "Pratt 2010, PMID 20889555, Table 2",
//   //     },
//   //     // ...other genes...
//   //   },
//   // },
//
// PRE-COMMIT CHECKLIST FOR ANY NEW FIXTURE:
//   1. Open the cited table directly. Do not trust secondary sources or
//      LLM-generated tables that purport to reproduce GeT-RM data.
//   2. Confirm the consensus diplotype uses only alleles our engine models
//      (genes.json). If not, mark expect_phenotype: "Not determined" and add
//      a note explaining the out-of-scope allele.
//   3. Cross-check ref/alt and file_strand in src/data/genes.json before
//      translating a star allele to per-rsID genotype. A strand flip will
//      silently invert the call.
//   4. Run `make getrm` and confirm pass. If it fails, the engine and the
//      consensus disagree — investigate, do not "fix" the fixture.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { buildEngine } from "../src/pgx.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), "utf8"));

const GENES = readJson("src/data/genes.json");
const DRUGS = readJson("src/data/drugs.json");

const engine = buildEngine(GENES, DRUGS);

// ─── FIXTURES ────────────────────────────────────────────────────────────────
// HARD RULE: Every entry here MUST cite a primary CDC GeT-RM source. See the
// header comment for the canonical paper list and the pre-commit checklist.
// EMPTY is the correct, honest state until rows are imported from real tables.
const FIXTURES = [
  // TODO(getrm): import from Pratt 2010 (PMC2933072), Pratt 2016 (PMC4695224),
  //              Pratt 2021 (PMID 34020041), and the TPMT GeT-RM paper.
  //              See header comment for required phase-ambiguous TPMT case.
];

// ─── TEST DRIVER ─────────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
let skipped = 0;
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

function runFixture(fix) {
  process.stdout.write(`\nSample ${fix.sample}${fix.notes ? ` (${fix.notes})` : ""}\n`);
  for (const [gene, expected] of Object.entries(fix.genes || {})) {
    if (expected.skip) {
      skipped++;
      process.stdout.write(`  - ${gene}: SKIPPED (${expected.skip})\n`);
      continue;
    }
    const r = engine
      .genotypesToResults(expected.genotypes || {})
      .find((g) => g.gene === gene);

    const label = `${fix.sample} ${gene} ${expected.diplotype} → ${expected.expect_phenotype}`;
    const got = r ? r.phenotype : "<no result>";
    assert(label, r && r.phenotype === expected.expect_phenotype,
      `got "${got}" (cite: ${expected.cite || "MISSING CITATION"})`);
  }
}

process.stdout.write("CDC GeT-RM known-answer fixtures (BUILD_SPEC §14b)\n");

if (FIXTURES.length === 0) {
  process.stdout.write(
    "\n  0 fixtures — see TODO at the top of this file.\n" +
    "  No GeT-RM consensus diplotypes have been imported yet. The scaffold is\n" +
    "  ready; populate FIXTURES from the cited primary sources, then re-run.\n",
  );
} else {
  for (const fix of FIXTURES) runFixture(fix);
}

process.stdout.write(
  `\n${pass} passed, ${fail} failed, ${skipped} skipped, ${FIXTURES.length} fixtures.\n`,
);
if (failures.length) {
  process.stdout.write("\nFailures:\n" + failures.join("\n") + "\n");
}
process.exit(fail ? 1 : 0);
