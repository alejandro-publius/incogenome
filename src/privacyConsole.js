// Privacy Console — the demo's hero moment.
//
// Monkey-patches window.fetch so every outbound network call from this page
// is intercepted, recorded, and shown in a live panel. Judges can pop this
// open and verify that DNA never leaves the device — only tiny anonymized
// {gene, phenotype, drug, meds} payloads do.
//
// Self-contained: builds its own DOM + CSS. Mount with installPrivacyConsole().

const DNA_TOKENS = ["rs", "rsid", "genotype", "chromosome", "AA", "AG", "CC", "TT"];
const PALETTE = {
  bg: "#0b0f17",
  fg: "#e7ecf3",
  accent: "#52d273",
  warn: "#ffb454",
  alarm: "#ff5f6d",
  dim: "#8d97a7",
};

let mounted = false;
let bytesOut = 0;
const log = [];
let originalFetch = null;
let listEl, counterEl, badgeEl;

function tagPayload(text) {
  if (!text) return "empty";
  const lower = text.toLowerCase();
  for (const tok of DNA_TOKENS) {
    if (lower.includes(tok.toLowerCase())) return "dna-like";
  }
  return "safe";
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function styleEl(el, styles) {
  for (const [k, v] of Object.entries(styles)) el.style[k] = v;
}

function buildPanel() {
  const root = document.createElement("aside");
  root.id = "privacy-console";
  styleEl(root, {
    position: "fixed",
    bottom: "0",
    right: "0",
    width: "420px",
    maxHeight: "60vh",
    background: PALETTE.bg,
    color: PALETTE.fg,
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "12px",
    boxShadow: "-4px -4px 24px rgba(0,0,0,0.4)",
    zIndex: "999999",
    display: "flex",
    flexDirection: "column",
    borderTopLeftRadius: "12px",
    overflow: "hidden",
  });

  const header = document.createElement("header");
  styleEl(header, {
    padding: "10px 14px",
    background: "#11171f",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    borderBottom: "1px solid #1d2533",
  });
  header.innerHTML = `
    <strong style="letter-spacing:.5px">PRIVACY CONSOLE</strong>
    <span id="pc-toggle" style="cursor:pointer;color:${PALETTE.dim}">[collapse]</span>
  `;

  const counter = document.createElement("div");
  styleEl(counter, {
    padding: "12px 14px",
    borderBottom: "1px solid #1d2533",
    lineHeight: "1.5",
  });
  counter.innerHTML = `
    <div>DNA bytes that left your device: <strong id="pc-bytes" style="color:${PALETTE.accent}">0 B</strong></div>
    <div style="color:${PALETTE.dim};margin-top:4px">
      Every fetch() from this page is logged below in real time.
    </div>
  `;

  const list = document.createElement("ol");
  styleEl(list, {
    margin: "0",
    padding: "8px 0",
    listStyle: "none",
    overflowY: "auto",
    flex: "1",
  });

  root.append(header, counter, list);

  const badge = document.createElement("div");
  badge.id = "privacy-badge";
  styleEl(badge, {
    position: "fixed",
    top: "16px",
    right: "16px",
    padding: "6px 10px",
    background: PALETTE.accent,
    color: "#06140b",
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: "11px",
    borderRadius: "999px",
    zIndex: "999998",
    fontWeight: "600",
  });
  badge.textContent = "● ON-DEVICE";

  document.body.append(root, badge);

  const toggle = header.querySelector("#pc-toggle");
  let collapsed = false;
  toggle.addEventListener("click", () => {
    collapsed = !collapsed;
    counter.style.display = collapsed ? "none" : "";
    list.style.display = collapsed ? "none" : "";
    toggle.textContent = collapsed ? "[expand]" : "[collapse]";
  });

  return { list, counter: counter.querySelector("#pc-bytes"), badge };
}

function renderEntry(entry) {
  const li = document.createElement("li");
  const color = {
    safe: PALETTE.accent,
    "dna-like": PALETTE.alarm,
    empty: PALETTE.dim,
  }[entry.tag];
  styleEl(li, {
    padding: "8px 14px",
    borderBottom: "1px dashed #1d2533",
    color: PALETTE.fg,
  });
  const t = new Date(entry.time).toLocaleTimeString();
  li.innerHTML = `
    <div style="display:flex;gap:8px;align-items:center">
      <span style="color:${color}">●</span>
      <span style="color:${PALETTE.dim}">${t}</span>
      <span>${entry.method} ${entry.url}</span>
    </div>
    <pre style="margin:6px 0 0;padding:6px 8px;background:#11171f;color:${PALETTE.fg};white-space:pre-wrap;word-break:break-all;border-radius:4px;font-size:11px">${escapeHtml(entry.bodyPreview)}</pre>
  `;
  listEl.prepend(li);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function recordCall(entry) {
  log.push(entry);
  if (entry.tag === "dna-like") {
    bytesOut += entry.bodySize;
    counterEl.textContent = fmtBytes(bytesOut);
    counterEl.style.color = PALETTE.alarm;
    badgeEl.style.background = PALETTE.alarm;
    badgeEl.style.color = "#1a0405";
    badgeEl.textContent = "● DNA DETECTED";
  }
  renderEntry(entry);
}

export function installPrivacyConsole() {
  if (mounted) return;
  mounted = true;
  const dom = buildPanel();
  listEl = dom.list;
  counterEl = dom.counter;
  badgeEl = dom.badge;

  originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input.url;
    const method = (init.method || "GET").toUpperCase();
    const body = init.body ? String(init.body) : "";
    const tag = tagPayload(body);
    const entry = {
      time: Date.now(),
      url,
      method,
      bodyPreview: body ? body.slice(0, 400) : "(no body)",
      bodySize: new Blob([body]).size,
      tag,
    };
    recordCall(entry);
    return originalFetch(input, init);
  };

  console.log(
    "%cPrivacy Console armed. Every fetch is now logged on screen.",
    "color:#52d273;font-weight:bold",
  );
}

export function getPrivacyLog() {
  return [...log];
}
