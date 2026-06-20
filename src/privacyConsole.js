// Privacy Console — the demo's hero moment.
//
// Patches every common outbound-network primitive so any data leaving the page
// is intercepted, recorded, and shown in a live panel. Judges can pop this
// open and verify that DNA never leaves the device — only tiny anonymized
// {gene, phenotype, drug, meds} payloads do.
//
// Patches: fetch, XMLHttpRequest, navigator.sendBeacon, WebSocket.
// Self-contained: builds its own DOM + CSS. Mount with installPrivacyConsole().

// Tag a payload as "dna-like" only on hard evidence of genetic data: rsIDs
// ("rs" followed by 3+ digits), the 23andMe TSV header signature, or a long
// run of ACGT-only characters. Loose letter pairs ("AA", "AG") would false-
// positive on normal English / JSON like "caution" or "PAGE" — a red badge
// during the demo would torpedo the whole pitch.
const RS_ID = /\brs\d{3,}\b/i;
const TSV_HEADER = /#\s*rsid\s+chromosome\s+position\s+genotype/i;
const ACGT_RUN = /[ACGT]{20,}/;

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
let listEl, counterEl, badgeEl;

function tagPayload(text) {
  if (!text) return "empty";
  if (RS_ID.test(text) || TSV_HEADER.test(text) || ACGT_RUN.test(text)) {
    return "dna-like";
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
    <div>Bytes tagged as DNA-shaped that left your device: <strong id="pc-bytes" style="color:${PALETTE.accent}">0 B</strong></div>
    <div style="color:${PALETTE.dim};margin-top:4px">
      Every fetch, XHR, beacon, and WebSocket from this page is logged below.
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

function makeEntry({ url, method, body }) {
  const bodyStr = body ? String(body) : "";
  return {
    time: Date.now(),
    url: String(url),
    method,
    bodyPreview: bodyStr ? bodyStr.slice(0, 400) : "(no body)",
    bodySize: new Blob([bodyStr]).size,
    tag: tagPayload(bodyStr),
  };
}

function patchFetch() {
  const orig = window.fetch.bind(window);
  window.fetch = (input, init = {}) => {
    const url =
      typeof input === "string" ? input : input.url ?? input.toString();
    recordCall(
      makeEntry({
        url,
        method: (init.method || "GET").toUpperCase(),
        body: init.body,
      }),
    );
    return orig(input, init);
  };
}

function patchXHR() {
  const proto = window.XMLHttpRequest.prototype;
  const origOpen = proto.open;
  const origSend = proto.send;
  proto.open = function (method, url) {
    this._pcUrl = url;
    this._pcMethod = method;
    return origOpen.apply(this, arguments);
  };
  proto.send = function (body) {
    recordCall(
      makeEntry({
        url: this._pcUrl,
        method: `XHR.${(this._pcMethod || "GET").toUpperCase()}`,
        body,
      }),
    );
    return origSend.apply(this, arguments);
  };
}

function patchSendBeacon() {
  if (!navigator.sendBeacon) return;
  const orig = navigator.sendBeacon.bind(navigator);
  navigator.sendBeacon = (url, data) => {
    recordCall(makeEntry({ url, method: "BEACON", body: data }));
    return orig(url, data);
  };
}

function patchWebSocket() {
  const Orig = window.WebSocket;
  if (!Orig) return;
  const Wrapped = function (url, protocols) {
    recordCall(makeEntry({ url, method: "WS.open", body: "" }));
    const ws = new Orig(url, protocols);
    const origSend = ws.send.bind(ws);
    ws.send = (data) => {
      recordCall(makeEntry({ url, method: "WS.send", body: data }));
      return origSend(data);
    };
    return ws;
  };
  Wrapped.prototype = Orig.prototype;
  Wrapped.CONNECTING = Orig.CONNECTING;
  Wrapped.OPEN = Orig.OPEN;
  Wrapped.CLOSING = Orig.CLOSING;
  Wrapped.CLOSED = Orig.CLOSED;
  window.WebSocket = Wrapped;
}

export function installPrivacyConsole() {
  if (mounted) return;
  mounted = true;

  function mount() {
    const dom = buildPanel();
    listEl = dom.list;
    counterEl = dom.counter;
    badgeEl = dom.badge;

    patchFetch();
    patchXHR();
    patchSendBeacon();
    patchWebSocket();

    console.log(
      "%cPrivacy Console armed. fetch / XHR / sendBeacon / WebSocket all logged.",
      "color:#52d273;font-weight:bold",
    );
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
}

export function getPrivacyLog() {
  return [...log];
}
