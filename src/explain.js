// All proxy clients. Each function sends ONLY {gene, phenotype, drug, meds}
// shaped payloads. No DNA, no rsIDs, no identifiers ever cross the network.

const PROXY = "http://localhost:8001";

async function postJson(path, body) {
  const res = await fetch(`${PROXY}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} returned ${res.status}`);
  return res.json();
}

export async function fetchExplanation({ gene, phenotype, drug }) {
  const data = await postJson("/api/explain", { gene, phenotype, drug });
  return data.explanation;
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
