// pgx.js — deterministic variant → diplotype → phenotype → drug guidance.
//
// PRIVACY: This module receives genotype values from the parser worker and
// produces gene/phenotype/drug strings ONLY. No genotype value, rsID, or
// diplotype is ever returned, logged, or shared outside this module.
//
// HONESTY (BUILD_SPEC §7-§8, the load-bearing rule): missing or no-called
// positions are NEVER silently treated as reference. Instead, we enumerate
// every possible assignment over unknown positions; only when every assignment
// yields the same phenotype do we report it (the "phenotype-if-invariant"
// rule). Anything else returns "Not determined" with coverage_state=partial.
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

// Reduce a set of candidate phenotypes to a single result.
// One distinct phenotype → confident call. Anything else → Not determined.
function collapsePhenotypes(set, cov) {
  if (set.size === 1) {
    const only = set.values().next().value;
    if (only === NOT_DETERMINED) return { phenotype: NOT_DETERMINED, coverage_state: cov };
    return { phenotype: only, coverage_state: cov };
  }
  return { phenotype: NOT_DETERMINED, coverage_state: cov };
}

// ─── diplotype engine (CYP2C19) ──────────────────────────────────────────────
// For each missing position we enumerate 0/1/2 alt-count assignments and
// compute the resulting diplotype. The phenotype is reported only if every
// reachable assignment maps to the same one (spec §7's phenotype-if-invariant).
function evalDiplotype(spec, genotypes) {
  const def = spec.default_allele || "*1";
  const known = [];   // {allele, altCount} for variants we observed
  const unknown = []; // {allele} for variants whose position is missing/no-call
  let missing = 0;
  let detected = 0;

  for (const v of spec.variants) {
    const g = genotypes[v.rsid];
    if (!g) { missing++; unknown.push(v); continue; }
    const d = decodeGenotype(g, v.ref, v.alt);
    if (!d) { missing++; unknown.push(v); continue; }
    detected++;
    if (d.altCount > 0) known.push({ allele: v.allele, altCount: d.altCount });
  }

  const cov = coverageFor(missing, detected);
  if (cov === COVERAGE.NOT_CALLABLE) {
    return { phenotype: NOT_DETERMINED, coverage_state: cov };
  }

  const phenotypes = new Set();
  const counts = new Array(unknown.length).fill(0);

  function tryAssignment() {
    const slots = [def, def];
    for (const k of known) {
      for (let i = 0; i < k.altCount; i++) {
        const slot = slots.indexOf(def);
        if (slot === -1) return null; // 3+ alts in 2 chromosomes → biologically impossible
        slots[slot] = k.allele;
      }
    }
    for (let u = 0; u < unknown.length; u++) {
      for (let i = 0; i < counts[u]; i++) {
        const slot = slots.indexOf(def);
        if (slot === -1) return null;
        slots[slot] = unknown[u].allele;
      }
    }
    const k1 = `${slots[0]}/${slots[1]}`;
    const k2 = `${slots[1]}/${slots[0]}`;
    return spec.diplotype_to_phenotype[k1] || spec.diplotype_to_phenotype[k2] || null;
  }

  function iterate(i) {
    if (i === unknown.length) {
      const p = tryAssignment();
      if (p) phenotypes.add(p);
      return;
    }
    for (let c = 0; c <= 2; c++) {
      counts[i] = c;
      iterate(i + 1);
    }
  }
  iterate(0);

  return collapsePhenotypes(phenotypes, cov);
}

// ─── activity-score engine (CYP2C9) ──────────────────────────────────────────
// For each missing position we enumerate possible alt counts (0/1/2) and
// compute the resulting activity score. Only confident when every reachable
// total maps to the same phenotype.
function evalActivityScore(spec, genotypes) {
  const defAct = spec.default_activity_value ?? 1.0;
  let baseActivity = 2 * defAct;
  const unknownDeltas = [];
  let missing = 0;
  let detected = 0;

  for (const v of spec.variants) {
    const delta = (v.activity_value ?? 0) - defAct;
    const g = genotypes[v.rsid];
    if (!g) { missing++; unknownDeltas.push(delta); continue; }
    const d = decodeGenotype(g, v.ref, v.alt);
    if (!d) { missing++; unknownDeltas.push(delta); continue; }
    detected++;
    baseActivity += d.altCount * delta;
  }

  const cov = coverageFor(missing, detected);
  if (cov === COVERAGE.NOT_CALLABLE) {
    return { phenotype: NOT_DETERMINED, coverage_state: cov };
  }

  const phenotypes = new Set();
  const counts = new Array(unknownDeltas.length).fill(0);

  function iterate(i) {
    if (i === unknownDeltas.length) {
      let a = baseActivity;
      for (let u = 0; u < unknownDeltas.length; u++) a += counts[u] * unknownDeltas[u];
      const key = a.toFixed(1);
      const p = spec.activity_score_to_phenotype[key];
      phenotypes.add(p || NOT_DETERMINED);
      return;
    }
    for (let c = 0; c <= 2; c++) {
      counts[i] = c;
      iterate(i + 1);
    }
  }
  iterate(0);

  return collapsePhenotypes(phenotypes, cov);
}

// ─── single-SNP engine (VKORC1, SLCO1B1) ─────────────────────────────────────
function evalSingleSnp(spec, genotypes) {
  const v = spec.variants[0];
  const g = genotypes[v.rsid];
  if (!g) return { phenotype: NOT_DETERMINED, coverage_state: COVERAGE.NOT_CALLABLE };
  const d = decodeGenotype(g, v.ref, v.alt);
  if (!d) return { phenotype: NOT_DETERMINED, coverage_state: COVERAGE.PARTIAL };
  const phenotype = spec.single_snp_to_phenotype[d.plusGenotype];
  if (!phenotype) return { phenotype: NOT_DETERMINED, coverage_state: COVERAGE.PARTIAL };
  return { phenotype, coverage_state: COVERAGE.CONFIDENT };
}

// ─── variant-count engine (TPMT) ─────────────────────────────────────────────
// Counts non-functional variant alleles across positions. Handles two
// ambiguities the raw sum misses:
//   1. PHASING (spec §6d/§7b TPMT gotcha): if 2+ no-function positions are
//      both het and nothing is hom, the variants could be in cis (single
//      star allele like *3A → Intermediate) or trans (two star alleles like
//      *3B/*3C → Deficient). Unphased data can't tell. Report as ambiguous.
//   2. MISSING positions: enumerate possible extra contributions and only
//      report a phenotype if every total maps to the same one.
function evalVariantCount(spec, genotypes) {
  let knownAlts = 0;
  let hetCount = 0;
  let homCount = 0;
  let missing = 0;
  let detected = 0;

  for (const v of spec.variants) {
    const g = genotypes[v.rsid];
    if (!g) { missing++; continue; }
    const d = decodeGenotype(g, v.ref, v.alt);
    if (!d) { missing++; continue; }
    detected++;
    knownAlts += d.altCount;
    if (d.altCount === 1) hetCount++;
    else if (d.altCount === 2) homCount++;
  }

  const cov = coverageFor(missing, detected);
  if (cov === COVERAGE.NOT_CALLABLE) {
    return { phenotype: NOT_DETERMINED, coverage_state: cov };
  }

  // Phasing gotcha: 2+ het no-function variants, no homs → cis vs trans is
  // indeterminable from unphased array data. Report ambiguous, not Deficient.
  if (hetCount >= 2 && homCount === 0) {
    return { phenotype: NOT_DETERMINED, coverage_state: COVERAGE.PARTIAL };
  }

  // Enumerate possible extra alts from missing positions (0..missing*2).
  // Cap at the highest count the mapping defines — counts above that still
  // belong to the most-impaired bucket, not Not determined.
  const keys = Object.keys(spec.variant_count_to_phenotype).map(Number);
  const maxKey = keys.length ? Math.max(...keys) : 0;
  const phenotypes = new Set();
  for (let extra = 0; extra <= missing * 2; extra++) {
    const count = Math.min(knownAlts + extra, maxKey);
    const p = spec.variant_count_to_phenotype[String(count)];
    phenotypes.add(p || NOT_DETERMINED);
  }

  return collapsePhenotypes(phenotypes, cov);
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
