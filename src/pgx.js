// pgx.js — deterministic variant → diplotype → phenotype → drug guidance.
//
// PRIVACY: This module receives genotype values from the parser worker and
// produces gene/phenotype/drug strings ONLY. No genotype value, rsID, or
// diplotype is ever returned, logged, or shared outside this module.
//
// HONESTY: Missing required variants never default to *1/normal. They produce
// "Not determined" with a coverage_state that the UI surfaces honestly.
//
// EXPORTS:
//   buildEngine(genesData, drugsData) → { genotypesToResults }   (sync, testable)
//   genotypesToResults(genotypes) → Promise<Result[]>            (browser default)

import { fetchBundledData } from "./data/_loader.js";

const COVERAGE = {
  CONFIDENT: "confident",
  PARTIAL: "partial",
  NOT_CALLABLE: "not-callable",
};

const NOT_DETERMINED = "Not determined";

const COMPLEMENT = { A: "T", T: "A", C: "G", G: "C" };

function complementGenotype(genotype) {
  let out = "";
  for (const b of genotype) out += COMPLEMENT[b] || b;
  return out;
}

// Try plus-strand match first, then minus. Returns { strand, altCount } or null.
function decodeGenotype(genotype, ref, alt) {
  const a = genotype[0];
  const b = genotype[1];
  if ((a === ref || a === alt) && (b === ref || b === alt)) {
    return {
      strand: "plus",
      altCount: (a === alt) + (b === alt),
      plusGenotype: genotype,
    };
  }
  const refC = COMPLEMENT[ref];
  const altC = COMPLEMENT[alt];
  if ((a === refC || a === altC) && (b === refC || b === altC)) {
    return {
      strand: "minus",
      altCount: (a === altC) + (b === altC),
      plusGenotype: complementGenotype(genotype),
    };
  }
  return null;
}

function coverageFor(missing, detected) {
  if (missing === 0) return COVERAGE.CONFIDENT;
  if (detected === 0) return COVERAGE.NOT_CALLABLE;
  return COVERAGE.PARTIAL;
}

// ─── diplotype engine (CYP2C19) ──────────────────────────────────────────────
function evalDiplotype(spec, genotypes) {
  const def = spec.default_allele || "*1";
  const slots = [def, def];
  let missing = 0;
  let detected = 0;

  for (const v of spec.variants) {
    const g = genotypes[v.rsid];
    if (!g) { missing++; continue; }
    const d = decodeGenotype(g, v.ref, v.alt);
    if (!d) { missing++; continue; }
    detected++;
    for (let i = 0; i < d.altCount; i++) {
      const slot = slots.indexOf(def);
      if (slot === -1) {
        // Three+ variant alleles across the gene → biologically inconsistent
        // (we only have 2 chromosomes). Don't guess.
        return { phenotype: NOT_DETERMINED, coverage_state: COVERAGE.PARTIAL };
      }
      slots[slot] = v.allele;
    }
  }

  const cov = coverageFor(missing, detected);
  if (cov === COVERAGE.NOT_CALLABLE) {
    return { phenotype: NOT_DETERMINED, coverage_state: cov };
  }
  // Partial coverage AND zero variant alleles seen → can't rule out an unseen
  // no-function allele. Surface as Not determined rather than defaulting to *1/*1.
  if (cov === COVERAGE.PARTIAL && slots[0] === def && slots[1] === def) {
    return { phenotype: NOT_DETERMINED, coverage_state: cov };
  }

  const key = `${slots[0]}/${slots[1]}`;
  const phenotype = spec.diplotype_to_phenotype[key];
  if (!phenotype) return { phenotype: NOT_DETERMINED, coverage_state: cov };
  return { phenotype, coverage_state: cov };
}

// ─── activity-score engine (CYP2C9) ──────────────────────────────────────────
function evalActivityScore(spec, genotypes) {
  const defAct = spec.default_activity_value ?? 1.0;
  let activity = 2 * defAct;
  let missing = 0;
  let detected = 0;
  let altsSeen = 0;

  for (const v of spec.variants) {
    const g = genotypes[v.rsid];
    if (!g) { missing++; continue; }
    const d = decodeGenotype(g, v.ref, v.alt);
    if (!d) { missing++; continue; }
    detected++;
    altsSeen += d.altCount;
    activity += d.altCount * ((v.activity_value ?? 0) - defAct);
  }

  const cov = coverageFor(missing, detected);
  if (cov === COVERAGE.NOT_CALLABLE) {
    return { phenotype: NOT_DETERMINED, coverage_state: cov };
  }
  if (cov === COVERAGE.PARTIAL && altsSeen === 0) {
    return { phenotype: NOT_DETERMINED, coverage_state: cov };
  }

  const key = activity.toFixed(1);
  const phenotype = spec.activity_score_to_phenotype[key];
  if (!phenotype) return { phenotype: NOT_DETERMINED, coverage_state: cov };
  return { phenotype, coverage_state: cov };
}

// ─── single-SNP engine (VKORC1, SLCO1B1) ─────────────────────────────────────
function evalSingleSnp(spec, genotypes) {
  const v = spec.variants[0];
  const g = genotypes[v.rsid];
  if (!g) {
    return { phenotype: NOT_DETERMINED, coverage_state: COVERAGE.NOT_CALLABLE };
  }
  const d = decodeGenotype(g, v.ref, v.alt);
  if (!d) {
    return { phenotype: NOT_DETERMINED, coverage_state: COVERAGE.PARTIAL };
  }
  const phenotype = spec.single_snp_to_phenotype[d.plusGenotype];
  if (!phenotype) {
    return { phenotype: NOT_DETERMINED, coverage_state: COVERAGE.PARTIAL };
  }
  return { phenotype, coverage_state: COVERAGE.CONFIDENT };
}

// ─── variant-count engine (TPMT) ─────────────────────────────────────────────
function evalVariantCount(spec, genotypes) {
  let alts = 0;
  let missing = 0;
  let detected = 0;

  for (const v of spec.variants) {
    const g = genotypes[v.rsid];
    if (!g) { missing++; continue; }
    const d = decodeGenotype(g, v.ref, v.alt);
    if (!d) { missing++; continue; }
    detected++;
    alts += d.altCount;
  }

  const cov = coverageFor(missing, detected);
  if (cov === COVERAGE.NOT_CALLABLE) {
    return { phenotype: NOT_DETERMINED, coverage_state: cov };
  }
  if (cov === COVERAGE.PARTIAL && alts === 0) {
    return { phenotype: NOT_DETERMINED, coverage_state: cov };
  }

  const phenotype = spec.variant_count_to_phenotype[String(alts)];
  if (!phenotype) return { phenotype: NOT_DETERMINED, coverage_state: cov };
  return { phenotype, coverage_state: cov };
}

// ─── structural-only engine (CYP2D6) ─────────────────────────────────────────
function evalStructuralOnly(spec) {
  return {
    phenotype: spec.fixed_phenotype || "Coverage limited",
    coverage_state: COVERAGE.NOT_CALLABLE,
  };
}

function evaluateGene(spec, genotypes) {
  switch (spec.method) {
    case "diplotype":           return evalDiplotype(spec, genotypes);
    case "activity_score":      return evalActivityScore(spec, genotypes);
    case "single_snp_function": return evalSingleSnp(spec, genotypes);
    case "variant_count":       return evalVariantCount(spec, genotypes);
    case "structural_only":     return evalStructuralOnly(spec);
    default:
      return { phenotype: NOT_DETERMINED, coverage_state: COVERAGE.NOT_CALLABLE };
  }
}

function lookupDrugs(gene, phenotype, drugsData) {
  const geneDrugs = drugsData.drugs[gene];
  if (!geneDrugs) return [];
  const out = [];
  for (const [drug, byPhenotype] of Object.entries(geneDrugs)) {
    const row = byPhenotype[phenotype];
    if (row) out.push({ drug, flag: row.flag, recommendation: row.recommendation });
  }
  return out;
}

export function buildEngine(genesData, drugsData) {
  return {
    genotypesToResults(genotypes) {
      const g = genotypes || {};
      const out = [];
      for (const [gene, spec] of Object.entries(genesData.genes)) {
        const { phenotype, coverage_state } = evaluateGene(spec, g);
        out.push({
          gene,
          phenotype,
          coverage_state,
          drugs: lookupDrugs(gene, phenotype, drugsData),
        });
      }
      return out;
    },
  };
}

// Browser default: lazy-load bundled JSON once, then delegate.
let _defaultEnginePromise = null;
async function getDefaultEngine() {
  if (!_defaultEnginePromise) {
    _defaultEnginePromise = fetchBundledData().then(({ genes, drugs }) =>
      buildEngine(genes, drugs),
    );
  }
  return _defaultEnginePromise;
}

export async function genotypesToResults(genotypes) {
  const engine = await getDefaultEngine();
  return engine.genotypesToResults(genotypes);
}
