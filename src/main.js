// Glue layer: wires UI -> parser worker -> pgx logic -> proxy.
//
// Contract this file expects from index.html (Varsha owns the markup):
//   #dna-file-input       <input type="file">
//   #file-status          element where parse status text goes
//   #results              container where per-gene result cards render
//   #meds-input           <input type="text"> for the medications list
//   #meds-check-btn       button to run the interaction check
//   #meds-results         container where flagged interactions render
//   #doctor-questions-btn button to generate clinician questions
//   #doctor-questions     <ul> where bulleted questions render
//   #demo-load-btn        (optional) loads the bundled sample file
//
// Contract this file expects from src/pgx.js (Lindsay):
//   import { genotypesToResults } from "./pgx.js";
//   genotypesToResults(genotypeMap) -> Array<{
//     gene, phenotype,
//     drugs: [{ drug, flag, recommendation }]
//   }>
//
// Contract this file expects from src/parser.worker.js (Lindsay):
//   postMessage({ type: "parse", fileText: string })
//   -> postMessage({ type: "result", genotypes: { rsId: "AG", ... } })
//   -> postMessage({ type: "error", message: string })

import {
  fetchExplanation,
  fetchDoctorQuestions,
  fetchMedInteractions,
} from "./explain.js";
import { installPrivacyConsole } from "./privacyConsole.js";

installPrivacyConsole();

const fileInput = document.getElementById("dna-file-input");
const statusEl = document.getElementById("file-status");
const resultsEl = document.getElementById("results");
const medsInput = document.getElementById("meds-input");
const medsCheckBtn = document.getElementById("meds-check-btn");
const medsResultsEl = document.getElementById("meds-results");
const doctorBtn = document.getElementById("doctor-questions-btn");
const doctorListEl = document.getElementById("doctor-questions");
const demoBtn = document.getElementById("demo-load-btn");

let worker = null;
let currentResults = [];

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

function startWorker() {
  if (worker) worker.terminate();
  worker = new Worker(new URL("./parser.worker.js", import.meta.url), {
    type: "module",
  });
  worker.onmessage = (event) => {
    const { type } = event.data;
    if (type === "result") handleParsedGenotypes(event.data.genotypes);
    else if (type === "error") setStatus(`Parse error: ${event.data.message}`);
  };
  worker.onerror = (event) => {
    setStatus(
      `Worker failed to load: ${event.message || event.filename || "unknown"}`,
    );
  };
}

async function handleParsedGenotypes(genotypes) {
  // Privacy boundary: only the COUNT of parsed SNPs is surfaced in the UI or
  // logged anywhere. Genotype values stay inside this function's scope and
  // flow into pgx.js (in-page) -> currentResults (gene/phenotype only).
  // They must never appear in setStatus, console.log, fetch bodies, etc.
  setStatus(`Parsed ${Object.keys(genotypes).length} target SNPs locally.`);
  const { genotypesToResults } = await import("./pgx.js");
  currentResults = await genotypesToResults(genotypes);
  renderResults(currentResults);
  if (doctorBtn) doctorBtn.disabled = false;
  if (medsCheckBtn) medsCheckBtn.disabled = false;
}

function flagColor(flag) {
  return { green: "#52d273", amber: "#ffb454", red: "#ff5f6d", gray: "#8d97a7" }[
    flag
  ] || "#8d97a7";
}

const COVERAGE_LABELS = {
  confident: "Tested",
  partial: "Partially tested",
  "not-callable": "Not callable from this file",
};

function renderResults(results) {
  resultsEl.innerHTML = "";
  for (const result of results) {
    const card = document.createElement("article");
    card.className = "gene-card";
    const coverageChip = result.coverage_state
      ? `<span class="coverage-state coverage-${result.coverage_state}">${COVERAGE_LABELS[result.coverage_state] ?? ""}</span>`
      : "";
    const hasDrugs = result.drugs.length > 0;
    card.innerHTML = `
      <header>
        <h3>${result.gene}</h3>
        <span class="phenotype">${result.phenotype}</span>
        ${coverageChip}
      </header>
      <ul class="drugs"></ul>
      ${hasDrugs ? '<button class="explain-btn" type="button">Explain with AI</button>' : ""}
      <p class="explanation" hidden></p>
    `;
    const drugList = card.querySelector(".drugs");
    for (const d of result.drugs) {
      const li = document.createElement("li");
      li.className = `drug flag-${d.flag}`;
      li.style.borderLeft = `4px solid ${flagColor(d.flag)}`;
      li.textContent = `${d.drug}: ${d.recommendation}`;
      drugList.appendChild(li);
    }
    if (hasDrugs) {
      const btn = card.querySelector(".explain-btn");
      const expEl = card.querySelector(".explanation");
      btn.addEventListener("click", () => loadExplanation(result, btn, expEl));
    }
    resultsEl.appendChild(card);
  }
}

async function loadExplanation(result, btn, expEl) {
  const first = result.drugs[0];
  if (!first) return;
  btn.disabled = true;
  btn.textContent = "Loading...";
  try {
    const data = await fetchExplanation({
      gene: result.gene,
      phenotype: result.phenotype,
      drug: first.drug,
      coverageState: result.coverage_state,
    });
    const prefix =
      data.source === "fallback" ? "(AI offline — showing static guidance.) " : "";
    expEl.textContent = `${prefix}${data.explanation}`;
  } catch {
    expEl.textContent = first.recommendation;
  }
  expEl.hidden = false;
  btn.hidden = true;
}

function parseMeds(raw) {
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function phenotypePayload() {
  return currentResults.map((r) => ({ gene: r.gene, phenotype: r.phenotype }));
}

async function onCheckMeds() {
  if (!medsInput || !medsResultsEl) return;
  const meds = parseMeds(medsInput.value);
  if (meds.length === 0) {
    medsResultsEl.textContent = "Enter at least one medication.";
    return;
  }
  medsCheckBtn.disabled = true;
  medsCheckBtn.textContent = "Reasoning...";
  medsResultsEl.innerHTML = "";
  try {
    const data = await fetchMedInteractions({
      phenotypes: phenotypePayload(),
      medications: meds,
    });
    renderInteractions(data);
  } catch (err) {
    medsResultsEl.textContent = `Could not analyze: ${err.message}`;
  }
  medsCheckBtn.disabled = false;
  medsCheckBtn.textContent = "Check interactions";
}

const SEVERITY_COLOR = {
  info: "#52d273",
  caution: "#ffb454",
  avoid: "#ff5f6d",
};

function renderInteractionSection(title, flags) {
  const h = document.createElement("h4");
  h.textContent = title;
  medsResultsEl.appendChild(h);
  if (!flags?.length) {
    const p = document.createElement("p");
    p.textContent = "No flags.";
    p.style.color = "#8d97a7";
    medsResultsEl.appendChild(p);
    return;
  }
  const ul = document.createElement("ul");
  for (const f of flags) {
    const li = document.createElement("li");
    li.className = `interaction sev-${f.severity}`;
    li.style.borderLeft = `4px solid ${SEVERITY_COLOR[f.severity] || "#8d97a7"}`;
    li.innerHTML = `
      <strong>${f.flag}</strong> <em>(${f.severity})</em>
      <div>${f.explanation}</div>
      <div class="ask"><strong>Ask:</strong> ${f.ask_clinician}</div>
    `;
    ul.appendChild(li);
  }
  medsResultsEl.appendChild(ul);
}

function renderInteractions(data) {
  renderInteractionSection("Drug–gene", data.drug_gene);
  renderInteractionSection("Drug–drug", data.drug_drug);
  renderInteractionSection("Phenoconversion", data.phenoconversion);
}

async function onDoctorQuestions() {
  if (!doctorListEl) return;
  const meds = medsInput ? parseMeds(medsInput.value) : [];
  doctorBtn.disabled = true;
  doctorBtn.textContent = "Generating...";
  doctorListEl.innerHTML = "";
  try {
    const questions = await fetchDoctorQuestions({
      phenotypes: phenotypePayload(),
      medications: meds,
    });
    for (const q of questions) {
      const li = document.createElement("li");
      li.textContent = q;
      doctorListEl.appendChild(li);
    }
  } catch (err) {
    const li = document.createElement("li");
    li.textContent = `Could not generate: ${err.message}`;
    doctorListEl.appendChild(li);
  }
  doctorBtn.disabled = false;
  doctorBtn.textContent = "Generate questions for my clinician";
}

function onFileChange(event) {
  const file = event.target.files?.[0];
  if (!file) return;
  setStatus(`Reading ${file.name} locally...`);
  const reader = new FileReader();
  reader.onload = () => {
    startWorker();
    worker.postMessage({ type: "parse", fileText: reader.result });
  };
  reader.onerror = () => setStatus("Could not read file.");
  reader.readAsText(file);
}

async function onLoadDemo() {
  setStatus("Loading bundled sample file locally...");
  try {
    const res = await fetch("./sample/sample_23andme.txt");
    const text = await res.text();
    startWorker();
    worker.postMessage({ type: "parse", fileText: text });
  } catch (err) {
    setStatus(`Could not load sample: ${err.message}`);
  }
}

// Dev hook: lets the dev harness inject results without going through the
// parser worker, so Alex can test the AI pipeline before Lindsay ships pgx.js.
// Production UI never calls this.
// Gated on __DOSEDNA_DEV so the global is never attached in production builds,
// preventing devtools/extensions/iframes from spoofing rendered gene cards.
if (globalThis.__DOSEDNA_DEV === true) {
  window.__DOSEDNA_INJECT_MOCK_RESULTS = (results) => {
    currentResults = results;
    renderResults(results);
    if (doctorBtn) doctorBtn.disabled = false;
    if (medsCheckBtn) medsCheckBtn.disabled = false;
    setStatus("Mock results injected (dev only). Network calls below are real.");
  };
}

if (fileInput) fileInput.addEventListener("change", onFileChange);
if (medsCheckBtn) {
  medsCheckBtn.disabled = true;
  medsCheckBtn.addEventListener("click", onCheckMeds);
}
if (doctorBtn) {
  doctorBtn.disabled = true;
  doctorBtn.addEventListener("click", onDoctorQuestions);
}
if (demoBtn) demoBtn.addEventListener("click", onLoadDemo);
