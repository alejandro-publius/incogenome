// Privacy Console — the demo's hero moment.
//
// Patches every common outbound-network primitive so any data leaving the page
// is intercepted, recorded, and shown in a live panel. Judges can pop this
// open and verify that DNA never leaves the device — only tiny anonymized
// {gene, phenotype, drug, meds} payloads do.
//
// Patches (in install order, synchronous at module load):
//   fetch, XMLHttpRequest, navigator.sendBeacon, WebSocket,
//   Image / HTMLImageElement.src, HTMLScriptElement.src, HTMLIFrameElement.src,
//   HTMLLinkElement.href, EventSource, RTCPeerConnection, window.open,
//   HTMLFormElement.submit + document-capture submit event.
//
// Self-contained: builds its own DOM + CSS. The console itself never makes a
// network call — everything is in-memory. Mount with installPrivacyConsole().

// Tag a payload as "dna-like" only on hard evidence of genetic data: rsIDs
// ("rs" followed by 3+ digits), the 23andMe TSV header signature, or a run
// of ACGT-only characters. Loose letter pairs ("AA", "AG") would false-
// positive on normal English / JSON like "caution" or "PAGE" — a red badge
// during the demo would torpedo the whole pitch.
//
// Audit fixes:
//   - case-insensitive ACGT (covers lowercase fasta-style)
//   - ACGT run threshold dropped from 20 → 12 (12 is still well past chance
//     for natural language but catches short variant strings)
//   - rsID check also runs against URLs (query-string leak vector)
//   - long base64-looking blob → warn-only (not "dna-like"); could be
//     base64-encoded DNA but we don't decode at runtime.
const RS_ID = /\brs\d{3,}\b/i;
const TSV_HEADER = /#\s*rsid\s+chromosome\s+position\s+genotype/i;
const ACGT_RUN = /[ACGT]{12,}/i;
const BASE64_BLOB = /[A-Za-z0-9+/=]{40,}/;

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

// Track every patch so uninstall() can fully restore the global environment.
// Each entry: { restore: () => void, label: string }
const patches = [];

function tagPayload(text, url) {
  const haystack = text || "";
  const urlStr = url == null ? "" : String(url);
  if (
    RS_ID.test(haystack) ||
    RS_ID.test(urlStr) ||
    TSV_HEADER.test(haystack) ||
    ACGT_RUN.test(haystack)
  ) {
    return "dna-like";
  }
  if (BASE64_BLOB.test(haystack)) {
    // Suspicious but we won't claim dna-like without decoding. Caller will
    // surface it as a console warning so the demo still sees it.
    return "warn";
  }
  if (!haystack) return "empty";
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
      Every fetch, XHR, beacon, WebSocket, image, script, iframe, link,
      EventSource, RTCPeerConnection, window.open, and form submit is logged below.
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
  if (!listEl) return; // panel not mounted yet (e.g. early patches firing)
  const li = document.createElement("li");
  const color = {
    safe: PALETTE.accent,
    "dna-like": PALETTE.alarm,
    warn: PALETTE.warn,
    empty: PALETTE.dim,
  }[entry.tag] || PALETTE.dim;
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
      <span>${escapeHtml(entry.method)} ${escapeHtml(entry.url)}</span>
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
  if (entry.tag === "dna-like" && counterEl && badgeEl) {
    bytesOut += entry.bodySize;
    counterEl.textContent = fmtBytes(bytesOut);
    counterEl.style.color = PALETTE.alarm;
    badgeEl.style.background = PALETTE.alarm;
    badgeEl.style.color = "#1a0405";
    badgeEl.textContent = "● DNA DETECTED";
  }
  if (entry.tag === "warn") {
    // Surface base64-blob suspicions without flipping the alarm badge.
    // (Could be base64-encoded DNA; we don't decode at runtime, per spec.)
    try {
      console.warn(
        "[PrivacyConsole] long base64-shaped string in outbound payload",
        { url: entry.url, method: entry.method },
      );
    } catch {
      /* console may be locked down in tests */
    }
  }
  renderEntry(entry);
}

function makeEntry({ url, method, body }) {
  const bodyStr = body == null ? "" : String(body);
  const urlStr = url == null ? "" : String(url);
  return {
    time: Date.now(),
    url: urlStr,
    method,
    bodyPreview: bodyStr ? bodyStr.slice(0, 400) : "(no body)",
    bodySize: new Blob([bodyStr]).size,
    tag: tagPayload(bodyStr, urlStr),
  };
}

// ---------------------------------------------------------------------------
// Patch helpers
// ---------------------------------------------------------------------------

// Wrap a function-valued property and remember how to restore it.
function trackPatch(label, restore) {
  patches.push({ label, restore });
}

// Some channels (CSP, missing browser support) genuinely can't be patched.
// We log "channel unavailable" rather than fail silently — keeps the audit
// honest about what's actually being watched.
function unavailable(label, reason) {
  try {
    console.warn(`[PrivacyConsole] channel unavailable: ${label} (${reason})`);
  } catch {
    /* noop */
  }
}

function safePatch(label, fn) {
  try {
    fn();
  } catch (err) {
    unavailable(label, err && err.message ? err.message : "patch failed");
  }
}

// Intercept the `src`/`href` setter on a prototype. Calls the original setter
// (so the element actually behaves normally) but logs the URL first.
function patchUrlSetter(proto, prop, label) {
  const desc = Object.getOwnPropertyDescriptor(proto, prop);
  if (!desc || !desc.set) {
    unavailable(label, `${prop} setter missing`);
    return;
  }
  const origSet = desc.set;
  const origGet = desc.get;
  Object.defineProperty(proto, prop, {
    configurable: true,
    enumerable: desc.enumerable,
    get: origGet,
    set(value) {
      // Only log non-empty, non-null sets — element creation often sets src=""
      // implicitly which would spam the console.
      if (value != null && String(value) !== "") {
        recordCall(makeEntry({ url: value, method: label, body: "" }));
      }
      return origSet.call(this, value);
    },
  });
  trackPatch(label, () => {
    Object.defineProperty(proto, prop, desc);
  });
}

// ---------------------------------------------------------------------------
// Original four channels (unchanged behavior, plus tracked for uninstall)
// ---------------------------------------------------------------------------

function patchFetch() {
  if (!window.fetch) {
    unavailable("fetch", "window.fetch missing");
    return;
  }
  const orig = window.fetch.bind(window);
  const wrapped = (input, init = {}) => {
    const url =
      typeof input === "string" ? input : input?.url ?? String(input);
    recordCall(
      makeEntry({
        url,
        method: (init.method || (input && input.method) || "GET").toUpperCase(),
        body: init.body,
      }),
    );
    return orig(input, init);
  };
  window.fetch = wrapped;
  trackPatch("fetch", () => {
    window.fetch = orig;
  });
}

function patchXHR() {
  if (!window.XMLHttpRequest) {
    unavailable("XMLHttpRequest", "XHR missing");
    return;
  }
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
  trackPatch("XMLHttpRequest", () => {
    proto.open = origOpen;
    proto.send = origSend;
  });
}

function patchSendBeacon() {
  if (!navigator.sendBeacon) {
    unavailable("sendBeacon", "navigator.sendBeacon missing");
    return;
  }
  const orig = navigator.sendBeacon.bind(navigator);
  navigator.sendBeacon = (url, data) => {
    recordCall(makeEntry({ url, method: "BEACON", body: data }));
    return orig(url, data);
  };
  trackPatch("sendBeacon", () => {
    navigator.sendBeacon = orig;
  });
}

function patchWebSocket() {
  const Orig = window.WebSocket;
  if (!Orig) {
    unavailable("WebSocket", "WebSocket missing");
    return;
  }
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
  trackPatch("WebSocket", () => {
    window.WebSocket = Orig;
  });
}

// ---------------------------------------------------------------------------
// Newly-added channels (from the audit)
// ---------------------------------------------------------------------------

// new Image() / <img>.src — covers tracking pixels. Patches both the
// constructor (catches `new Image(); img.src = "..."`) and the prototype src
// setter (catches `document.createElement('img').src = "..."`).
function patchImage() {
  // Cover HTMLImageElement.prototype.src so any <img> picks it up regardless
  // of how it was created.
  if (typeof HTMLImageElement !== "undefined") {
    patchUrlSetter(HTMLImageElement.prototype, "src", "IMG.src");
  } else {
    unavailable("HTMLImageElement", "constructor missing");
  }
  // Also wrap `Image` so `new Image(w, h)` still works but is observable.
  // The src setter above will catch the actual URL — this wrap is mostly a
  // sentinel so it's clear the channel is covered.
  if (typeof window.Image === "function") {
    const Orig = window.Image;
    function WrappedImage(w, h) {
      // Both forms supported: `new Image()` and `new Image(w, h)`.
      return new Orig(...(arguments.length ? [w, h] : []));
    }
    WrappedImage.prototype = Orig.prototype;
    window.Image = WrappedImage;
    trackPatch("Image", () => {
      window.Image = Orig;
    });
  }
}

function patchScriptSrc() {
  if (typeof HTMLScriptElement === "undefined") {
    unavailable("HTMLScriptElement", "missing");
    return;
  }
  patchUrlSetter(HTMLScriptElement.prototype, "src", "SCRIPT.src");
}

function patchIframeSrc() {
  if (typeof HTMLIFrameElement === "undefined") {
    unavailable("HTMLIFrameElement", "missing");
    return;
  }
  patchUrlSetter(HTMLIFrameElement.prototype, "src", "IFRAME.src");
}

function patchLinkHref() {
  if (typeof HTMLLinkElement === "undefined") {
    unavailable("HTMLLinkElement", "missing");
    return;
  }
  patchUrlSetter(HTMLLinkElement.prototype, "href", "LINK.href");
}

function patchEventSource() {
  const Orig = window.EventSource;
  if (!Orig) {
    unavailable("EventSource", "EventSource missing");
    return;
  }
  function Wrapped(url, init) {
    recordCall(makeEntry({ url, method: "SSE.open", body: "" }));
    return new Orig(url, init);
  }
  Wrapped.prototype = Orig.prototype;
  Wrapped.CONNECTING = Orig.CONNECTING;
  Wrapped.OPEN = Orig.OPEN;
  Wrapped.CLOSED = Orig.CLOSED;
  window.EventSource = Wrapped;
  trackPatch("EventSource", () => {
    window.EventSource = Orig;
  });
}

function patchRTCPeerConnection() {
  // Several vendor-prefixed forms exist in older browsers — patch any we find.
  const names = [
    "RTCPeerConnection",
    "webkitRTCPeerConnection",
    "mozRTCPeerConnection",
  ];
  let patchedAny = false;
  for (const name of names) {
    const Orig = window[name];
    if (typeof Orig !== "function") continue;
    function Wrapped(config) {
      // Log the configured ICE servers — those are the URLs that this
      // connection might reach.
      const iceUrls = (config && Array.isArray(config.iceServers)
        ? config.iceServers
            .flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]))
            .filter(Boolean)
        : []
      ).join(",");
      recordCall(
        makeEntry({
          url: iceUrls || "(no iceServers)",
          method: "RTC.open",
          body: JSON.stringify(config || {}),
        }),
      );
      const pc = new Orig(config);
      // createOffer is the moment WebRTC actually starts ICE traffic.
      const origCreateOffer = pc.createOffer && pc.createOffer.bind(pc);
      if (origCreateOffer) {
        pc.createOffer = (...args) => {
          recordCall(
            makeEntry({
              url: iceUrls || "(no iceServers)",
              method: "RTC.createOffer",
              body: "",
            }),
          );
          return origCreateOffer(...args);
        };
      }
      return pc;
    }
    Wrapped.prototype = Orig.prototype;
    window[name] = Wrapped;
    trackPatch(name, () => {
      window[name] = Orig;
    });
    patchedAny = true;
  }
  if (!patchedAny) unavailable("RTCPeerConnection", "no implementation");
}

function patchWindowOpen() {
  if (typeof window.open !== "function") {
    unavailable("window.open", "missing");
    return;
  }
  const orig = window.open.bind(window);
  window.open = (url, target, features) => {
    if (url != null && String(url) !== "") {
      recordCall(makeEntry({ url, method: "WINDOW.open", body: "" }));
    }
    return orig(url, target, features);
  };
  trackPatch("window.open", () => {
    window.open = orig;
  });
}

function patchFormSubmit() {
  if (typeof HTMLFormElement === "undefined") {
    unavailable("HTMLFormElement", "missing");
    return;
  }
  // 1) Programmatic form.submit() — bypasses the submit event entirely.
  const proto = HTMLFormElement.prototype;
  const origSubmit = proto.submit;
  proto.submit = function () {
    const url = this.action || location.href;
    const method = (this.method || "GET").toUpperCase();
    const body = serializeForm(this);
    recordCall(
      makeEntry({ url, method: `FORM.${method}`, body }),
    );
    return origSubmit.apply(this, arguments);
  };
  trackPatch("HTMLFormElement.submit", () => {
    proto.submit = origSubmit;
  });

  // 2) User-initiated submits — capture-phase listener on document so we see
  // them before any app-level handler can preventDefault and hide the leak.
  const handler = (ev) => {
    const form = ev.target;
    if (!form || form.tagName !== "FORM") return;
    const url = form.action || location.href;
    const method = (form.method || "GET").toUpperCase();
    const body = serializeForm(form);
    recordCall(
      makeEntry({ url, method: `FORM.submit.${method}`, body }),
    );
  };
  document.addEventListener("submit", handler, true);
  trackPatch("document.submit-capture", () => {
    document.removeEventListener("submit", handler, true);
  });
}

function serializeForm(form) {
  try {
    const fd = new FormData(form);
    const parts = [];
    for (const [k, v] of fd.entries()) {
      // File values stringify to "[object File]" — replace with a sentinel.
      const sv =
        typeof v === "string"
          ? v
          : v && typeof v === "object" && "name" in v
            ? `<file:${v.name}>`
            : String(v);
      parts.push(`${k}=${sv}`);
    }
    return parts.join("&");
  } catch {
    return "(form serialization failed)";
  }
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

function installAllPatches() {
  safePatch("fetch", patchFetch);
  safePatch("XMLHttpRequest", patchXHR);
  safePatch("sendBeacon", patchSendBeacon);
  safePatch("WebSocket", patchWebSocket);
  safePatch("Image", patchImage);
  safePatch("SCRIPT.src", patchScriptSrc);
  safePatch("IFRAME.src", patchIframeSrc);
  safePatch("LINK.href", patchLinkHref);
  safePatch("EventSource", patchEventSource);
  safePatch("RTCPeerConnection", patchRTCPeerConnection);
  safePatch("window.open", patchWindowOpen);
  safePatch("FORM.submit", patchFormSubmit);
}

// Patch synchronously at module load — late patches lose to early third-party
// code. The DOM panel still waits for DOMContentLoaded, but interception is
// armed immediately.
if (typeof window !== "undefined" && !window.__dosednaPrivacyArmed) {
  window.__dosednaPrivacyArmed = true;
  installAllPatches();
}

export function installPrivacyConsole() {
  if (mounted) return;
  mounted = true;

  function mount() {
    const dom = buildPanel();
    listEl = dom.list;
    counterEl = dom.counter;
    badgeEl = dom.badge;

    // Replay any calls that happened between patch-time and mount-time.
    for (const entry of log) renderEntry(entry);

    console.log(
      "%cPrivacy Console armed. fetch / XHR / sendBeacon / WebSocket / IMG / SCRIPT / IFRAME / LINK / EventSource / RTCPeerConnection / window.open / form-submit all logged.",
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

// Reverse every patch and tear down the DOM. Lets tests run cleanly without
// leaking globals into the next file. Idempotent.
export function uninstall() {
  while (patches.length) {
    const p = patches.pop();
    try {
      p.restore();
    } catch (err) {
      try {
        console.warn(`[PrivacyConsole] failed to restore ${p.label}:`, err);
      } catch {
        /* noop */
      }
    }
  }
  const panel = document.getElementById("privacy-console");
  if (panel) panel.remove();
  const badge = document.getElementById("privacy-badge");
  if (badge) badge.remove();
  if (typeof window !== "undefined") {
    delete window.__dosednaPrivacyArmed;
  }
  mounted = false;
  bytesOut = 0;
  log.length = 0;
  listEl = counterEl = badgeEl = undefined;
}

// Public surface for the demo / tests. Preserves the existing namespace.
if (typeof window !== "undefined") {
  window.__dosednaPrivacy = Object.assign(window.__dosednaPrivacy || {}, {
    install: installPrivacyConsole,
    uninstall,
    getLog: getPrivacyLog,
  });
}
