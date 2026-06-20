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
}

async function handleParsedGenotypes(genotypes) {
  setStatus(`Parsed ${Object.keys(genotypes).length} target SNPs locally.`);
  const { genotypesToResults } = await import("./pgx.js");
  currentResults = genotypesToResults(genotypes);
  renderResults(currentResults);
  if (doctorBtn) doctorBtn.disabled = false;
  if (medsCheckBtn) medsCheckBtn.disabled = false;
}

function flagColor(flag) {
  return { green: "#52d273", amber: "#ffb454", red: "#ff5f6d", gray: "#8d97a7" }[
    flag
  ] || "#8d97a7";
}

function renderResults(results) {
  resultsEl.innerHTML = "";
  for (const result of results) {
    const card = document.createElement("article");
    card.className = "gene-card";
    card.innerHTML = `
      <header>
        <h3>${result.gene}</h3>
        <span class="phenotype">${result.phenotype}</span>
      </header>
      <ul class="drugs"></ul>
      <button class="explain-btn" type="button">Explain with AI</button>
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
    const btn = card.querySelector(".explain-btn");
    const expEl = card.querySelector(".explanation");
    btn.addEventListener("click", () => loadExplanation(result, btn, expEl));
    resultsEl.appendChild(card);
  }
}

async function loadExplanation(result, btn, expEl) {
  const first = result.drugs[0];
  if (!first) return;
  btn.disabled = true;
  btn.textContent = "Loading...";
  try {
    expEl.textContent = await fetchExplanation({
      gene: result.gene,
      phenotype: result.phenotype,
      drug: first.drug,
    });
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

function renderInteractions(data) {
  const sections = [
    ["Drug–gene", data.drug_gene],
    ["Drug–drug", data.drug_drug],
    ["Phenoconversion", data.phenoconversion],
  ];
  for (const [title, flags] of sections) {
    const h = document.createElement("h4");
    h.textContent = title;
    medsResultsEl.appendChild(h);
    if (!flags?.length) {
      const p = document.createElement("p");
      p.textContent = "No flags.";
      p.style.color = "#8d97a7";
      medsResultsEl.appendChild(p);
      continue;
    }
    const ul = document.createElement("ul");
    for (const f of flags) {
      const li = document.createElement("li");
      li.className = `interaction sev-${f.severity}`;
      li.style.borderLeft = `4px solid ${
        { info: "#52d273", caution: "#ffb454", avoid: "#ff5f6d" }[f.severity] ||
        "#8d97a7"
      }`;
      li.innerHTML = `
        <strong>${f.flag}</strong> <em>(${f.severity})</em>
        <div>${f.explanation}</div>
        <div class="ask"><strong>Ask:</strong> ${f.ask_clinician}</div>
      `;
      ul.appendChild(li);
    }
    medsResultsEl.appendChild(ul);
  }
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
  doctorBtn.textContent = "Prepare questions for my doctor";
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
