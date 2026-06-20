// All proxy clients. Each function sends ONLY {gene, phenotype, drug, meds}
// shaped payloads. No DNA, no rsIDs, no identifiers ever cross the network.
// Set window.DOSEDNA_PROXY before main.js loads to point at a non-default host.

const PROXY = globalThis.DOSEDNA_PROXY ?? "http://localhost:8001";
const TIMEOUT_MS = 30000;

async function postJson(path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    let res;
    try {
      res = await fetch(`${PROXY}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (err) {
      // Distinguish timeout vs proxy-down vs other network errors. The demo
      // machine will hit the second case if uvicorn isn't running.
      if (err && err.name === "AbortError") {
        throw new Error(`Proxy timed out after ${TIMEOUT_MS}ms`);
      }
      if (err instanceof TypeError) {
        throw new Error("Proxy is offline — start the server with `make proxy`");
      }
      throw err;
    }
    if (!res.ok) throw new Error(`${path} returned ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Request a plain-language explanation from the proxy.
 * @returns {Promise<{explanation: string, source: "claude" | "fallback"}>}
 *   `source` is "fallback" when the proxy could not reach Claude and returned
 *   bundled static guidance; the UI uses this to label the response.
 */
export async function fetchExplanation({ gene, phenotype, drug }) {
  const data = await postJson("/api/explain", { gene, phenotype, drug });
  return { explanation: data.explanation, source: data.source };
}

export async function fetchDoctorQuestions({ phenotypes, medications }) {
  const data = await postJson("/api/questions", {
    phenotypes,
    medications: medications ?? [],
  });
  return data.questions;
}

export async function fetchMedInteractions({ phenotypes, medications }) {
  return postJson("/api/check-meds", { phenotypes, medications });
}
