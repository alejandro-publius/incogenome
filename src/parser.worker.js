// DoseDNA parser worker
//
// PRIVACY CONTRACT:
//   - The raw DNA file text enters this worker via postMessage and NEVER leaves.
//   - We post back ONLY:
//       { type: "result", genotypes: { <targetRsId>: "XY", ... }, meta: {...} }
//       { type: "error",  message: string }
//   - `genotypes` contains only rsIDs in TARGET_RSIDS. Non-target rows are
//     discarded immediately. We never echo file contents, line numbers, or
//     non-target variants back to the main thread.

const TARGET_RSIDS = new Set([
  "rs4244285",   // CYP2C19 *2
  "rs4986893",   // CYP2C19 *3
  "rs12248560",  // CYP2C19 *17
  "rs1799853",   // CYP2C9 *2
  "rs1057910",   // CYP2C9 *3
  "rs9923231",   // VKORC1
  "rs4149056",   // SLCO1B1
  "rs1800462",   // TPMT *2
  "rs1800460",   // TPMT *3B
  "rs1142345",   // TPMT *3C
]);

const VALID_BASES = new Set(["A", "C", "G", "T"]);

function isValidGenotype(g) {
  if (!g || g.length !== 2) return false;
  return VALID_BASES.has(g[0]) && VALID_BASES.has(g[1]);
}

function detectProviderFromHeader(headerText) {
  // Returns { provider, chip_hint } based on comment header text.
  let provider = "unknown";
  let chip_hint = "unknown";

  const lower = headerText.toLowerCase();
  if (lower.includes("ancestrydna") || lower.includes("ancestry.com")) {
    provider = "AncestryDNA";
  } else if (lower.includes("23andme")) {
    provider = "23andMe";
  }

  // Chip version hint — look for v3/v4/v5, GSA, OmniExpress, etc.
  const chipMatch = headerText.match(/\b(v[1-9][0-9]?|GSA|OmniExpress)\b/i);
  if (chipMatch) {
    chip_hint = chipMatch[1];
  }

  return { provider, chip_hint };
}

function parse(fileText) {
  const lines = fileText.split(/\r?\n/);

  // First pass: collect header comments and find first data line for
  // column-count fallback detection + validation.
  const headerParts = [];
  let firstDataCols = 0;
  let sawRsidRow = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (line.charCodeAt(0) === 35 /* '#' */) {
      headerParts.push(line);
      continue;
    }
    // First non-empty, non-comment line: use it for column-count detection.
    const cols = line.split("\t");
    firstDataCols = cols.length;
    if (/^rs\d+/.test(cols[0])) {
      sawRsidRow = true;
    }
    break;
  }

  // Validation heuristic: must have at least one comment header line AND
  // at least one rsID-looking row somewhere.
  if (headerParts.length === 0 || !sawRsidRow) {
    // Cheap second check: scan ahead a bit for any rs<digits> row in case
    // the first data line happened to be malformed.
    if (headerParts.length === 0) {
      throw new Error(
        "This doesn't look like a consumer DNA file (no rsID rows found)."
      );
    }
    if (!sawRsidRow) {
      let found = false;
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line || line.charCodeAt(0) === 35) continue;
        const first = line.split("\t", 1)[0];
        if (/^rs\d+/.test(first)) {
          found = true;
          break;
        }
      }
      if (!found) {
        throw new Error(
          "This doesn't look like a consumer DNA file (no rsID rows found)."
        );
      }
    }
  }

  const headerText = headerParts.join("\n");
  let { provider, chip_hint } = detectProviderFromHeader(headerText);

  // Column-count fallback: 4 cols = 23andMe-style, 5 cols = Ancestry-style.
  if (provider === "unknown") {
    if (firstDataCols === 5) provider = "AncestryDNA";
    else if (firstDataCols === 4) provider = "23andMe";
  }

  // Decide whether genotype is one column or two based on provider, with
  // column-count as a safety net per-row.
  const ancestryStyle = provider === "AncestryDNA";

  const genotypes = Object.create(null);
  let total_lines = 0;
  let matched_count = 0;
  let no_call_count = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (line.charCodeAt(0) === 35 /* '#' */) continue;

    total_lines++;

    // Cheap pre-filter: must start with "rs".
    if (line.charCodeAt(0) !== 114 /* 'r' */) continue;

    const tab1 = line.indexOf("\t");
    if (tab1 === -1) continue;
    const rsid = line.substring(0, tab1);

    if (!TARGET_RSIDS.has(rsid)) continue;
    // Keep FIRST occurrence only.
    if (rsid in genotypes) continue;

    const cols = line.split("\t");

    let genotype;
    if (ancestryStyle || cols.length === 5) {
      // rsid, chromosome, position, allele1, allele2
      if (cols.length < 5) {
        no_call_count++;
        continue;
      }
      genotype = (cols[3] + cols[4]).toUpperCase();
    } else {
      // 23andMe: rsid, chromosome, position, genotype
      if (cols.length < 4) {
        no_call_count++;
        continue;
      }
      genotype = cols[3].toUpperCase();
    }

    if (!isValidGenotype(genotype)) {
      no_call_count++;
      continue;
    }

    genotypes[rsid] = genotype;
    matched_count++;
  }

  return {
    genotypes,
    meta: {
      provider,
      chip_hint,
      total_lines,
      matched_count,
      no_call_count,
    },
  };
}

self.onmessage = function (e) {
  const msg = e.data;
  if (!msg || msg.type !== "parse") return;

  try {
    const fileText = msg.fileText;
    if (typeof fileText !== "string") {
      self.postMessage({
        type: "error",
        message: "No file text provided to parser worker.",
      });
      return;
    }

    const { genotypes, meta } = parse(fileText);

    self.postMessage({
      type: "result",
      genotypes,
      meta,
    });
  } catch (err) {
    self.postMessage({
      type: "error",
      message: (err && err.message) ? err.message : String(err),
    });
  }
};
