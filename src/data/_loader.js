// Browser-only loader for the bundled gene/drug JSON. Kept out of pgx.js so
// Node tests can import buildEngine() without triggering fetch.

const GENES_URL = new URL("./genes.json", import.meta.url);
const DRUGS_URL = new URL("./drugs.json", import.meta.url);

export async function fetchBundledData() {
  const [genes, drugs] = await Promise.all([
    fetch(GENES_URL).then((r) => r.json()),
    fetch(DRUGS_URL).then((r) => r.json()),
  ]);
  return { genes, drugs };
}
