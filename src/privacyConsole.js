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
// S5 fix: find the LONGEST base64-shaped substring (not just a match) so we
// can attempt to decode it and re-scan the plaintext for DNA.
const BASE64_BLOB_G = /[A-Za-z0-9+/=]{40,}/g;

// Rolling buffer of recent outbound bytes — defeats the chunked-leak vector
// where a hostile script splits DNA across many sub-12-char requests. Each
// individual request looks innocent; the concatenation does not.
const ROLLING_BUF_MAX = 2048;
let rollingBuffer = "";
function pushRolling(text) {
  if (!text) return;
  rollingBuffer = (rollingBuffer + text).slice(-ROLLING_BUF_MAX);
}
function resetRolling() {
  rollingBuffer = "";
}

// Pull the longest base64-shaped substring out of `haystack` (or null if
// none). Used by tagPayload before attempting a decode-and-rescan.
function longestBase64Substring(haystack) {
  if (!haystack) return null;
  let best = null;
  BASE64_BLOB_G.lastIndex = 0;
  let m;
  while ((m = BASE64_BLOB_G.exec(haystack)) !== null) {
    if (!best || m[0].length > best.length) best = m[0];
  }
  return best;
}

function tryDecodeBase64(s) {
  // atob may not exist in Node test contexts — guard accordingly.
  try {
    if (typeof atob === "function") return atob(s);
    if (typeof Buffer !== "undefined") {
      return Buffer.from(s, "base64").toString("binary");
    }
  } catch {
    /* malformed base64 — caller treats as no decode */
  }
  return null;
}

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
  // S5.3 fix: collapse whitespace so "A C G T A C G T A C G T" still trips
  // ACGT_RUN. Done on a copy so the original payload is preserved for the
  // body preview rendering.
  const haystackNoWs = haystack ? haystack.replace(/\s+/g, "") : "";

  // S5.1 fix: ACGT_RUN must run against the URL too. A fetch("/?"+dna) leak
  // had a body of "" and slipped through the haystack-only check.
  if (
    RS_ID.test(haystack) ||
    RS_ID.test(urlStr) ||
    TSV_HEADER.test(haystack) ||
    ACGT_RUN.test(haystack) ||
    ACGT_RUN.test(haystackNoWs) ||
    ACGT_RUN.test(urlStr)
  ) {
    return "dna-like";
  }

  // S5.4 fix: chunked leak. Test the rolling buffer of recent outbound bytes.
  // If the concatenation of "AC", "GT", "AC", "GT", ... finally clears 12
  // chars we mark the CURRENT call dna-like — that's the one that pushed it
  // over the line.
  if (rollingBuffer && ACGT_RUN.test(rollingBuffer)) {
    return "dna-like";
  }

  // S5.2 fix: if there's a base64-shaped blob, attempt to decode the longest
  // one and re-scan the plaintext. If it matches our DNA signatures, flip to
  // dna-like instead of the noncommittal "warn".
  if (BASE64_BLOB.test(haystack)) {
    const candidate = longestBase64Substring(haystack);
    const decoded = candidate ? tryDecodeBase64(candidate) : null;
    if (
      decoded &&
      (ACGT_RUN.test(decoded) ||
        ACGT_RUN.test(decoded.replace(/\s+/g, "")) ||
        RS_ID.test(decoded) ||
        TSV_HEADER.test(decoded))
    ) {
      return "dna-like";
    }
    // Suspicious but we won't claim dna-like without successful decoding.
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

function makeEntryLi(entry) {
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
  return li;
}

function renderEntry(entry) {
  if (!listEl) return; // panel not mounted yet (e.g. early patches firing)
  const li = makeEntryLi(entry);
  // S6: keep a handle on the entry so the async Blob recheck can replace
  // the rendered <li> in place when the tag flips.
  entry.__el = li;
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
  // S6 fix: real bodies aren't always strings. Blobs, FormData,
  // URLSearchParams, ArrayBuffers, typed arrays, and ReadableStreams all
  // stringify to garbage like "[object Blob]". Extract the actual bytes we
  // can scan synchronously here; async types (Blob, ReadableStream) get a
  // best-effort sync entry and an async recheck attached on the entry.
  const extracted = extractScannableBody(body);
  const bodyStr = extracted.bodyStr;
  const urlStr = url == null ? "" : String(url);

  // Feed the rolling buffer so the chunked-leak detector in tagPayload sees
  // BOTH the URL and the body — query strings carry the worst leaks.
  pushRolling(urlStr);
  pushRolling(bodyStr);

  // S5/S6 interaction: even when the body shape forces a tag (Blob, stream),
  // the URL might still contain a DNA-shaped payload (e.g. an attacker uses
  // a Blob body to hide bytes AND embeds the leak in the query string). Run
  // tagPayload against the URL anyway and let "dna-like" win.
  let tag = extracted.forcedTag || tagPayload(bodyStr, urlStr);
  if (tag !== "dna-like") {
    const urlTag = tagPayload("", urlStr);
    if (urlTag === "dna-like") tag = "dna-like";
  }
  const entry = {
    time: Date.now(),
    url: urlStr,
    method,
    bodyPreview: extracted.preview,
    bodySize: extracted.size,
    tag,
  };
  // Async-rescannable bodies (Blob, ReadableStream) attach a thunk that, on
  // resolve, re-tags the entry and re-renders it in place. See
  // attachAsyncRecheck() below.
  if (extracted.asyncRescan) {
    extracted.asyncRescan(entry);
  }
  return entry;
}

// S6 helper: turn whatever body shape the caller passed into something we
// can scan. Returns { bodyStr, preview, size, forcedTag?, asyncRescan? }.
function extractScannableBody(body) {
  if (body == null || body === "") {
    return { bodyStr: "", preview: "(no body)", size: 0 };
  }

  // Plain string — the original fast path.
  if (typeof body === "string") {
    return {
      bodyStr: body,
      preview: body.slice(0, 400),
      size: new Blob([body]).size,
    };
  }

  // URLSearchParams — toString() is the wire form.
  if (typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
    const s = body.toString();
    return { bodyStr: s, preview: s.slice(0, 400), size: new Blob([s]).size };
  }

  // FormData — join entries as k=v&k=v for scanning. Cannot stream; this is
  // safe to do synchronously.
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    const parts = [];
    try {
      for (const [k, v] of body.entries()) {
        const sv =
          typeof v === "string"
            ? v
            : v && typeof v === "object" && "name" in v
              ? `<file:${v.name}>`
              : String(v);
        parts.push(`${k}=${sv}`);
      }
    } catch {
      /* fall through with whatever we got */
    }
    const s = parts.join("&");
    return { bodyStr: s, preview: s.slice(0, 400), size: new Blob([s]).size };
  }

  // ArrayBuffer / TypedArray / DataView — decode as UTF-8 and scan.
  const isArrayBuf =
    typeof ArrayBuffer !== "undefined" && body instanceof ArrayBuffer;
  const isView =
    typeof ArrayBuffer !== "undefined" && ArrayBuffer.isView && ArrayBuffer.isView(body);
  if (isArrayBuf || isView) {
    try {
      const decoder = new TextDecoder("utf-8", { fatal: false });
      const s = decoder.decode(body);
      return {
        bodyStr: s,
        preview: s.slice(0, 400),
        size: isArrayBuf ? body.byteLength : body.byteLength,
      };
    } catch {
      return {
        bodyStr: "",
        preview: "<binary>",
        size: isArrayBuf ? body.byteLength : body.byteLength || 0,
      };
    }
  }

  // Blob — can't read synchronously. Stamp a placeholder entry, mark it
  // safe, then attach an async recheck that calls body.text() and flips the
  // tag + re-renders if it turns out to be DNA-shaped.
  if (typeof Blob !== "undefined" && body instanceof Blob) {
    return {
      bodyStr: "",
      preview: `<Blob: ${body.size} bytes>`,
      size: body.size,
      forcedTag: "safe",
      asyncRescan: (entry) => {
        // Best-effort. If the browser is old and Blob.text() is missing,
        // give up silently rather than throwing into the patch wrapper.
        if (typeof body.text !== "function") return;
        body.text().then(
          (text) => recheckEntry(entry, text),
          () => {
            /* unreadable blob — leave entry alone */
          },
        );
      },
    };
  }

  // ReadableStream — actually consuming it would steal bytes from the real
  // fetch. Warn loudly instead. Spec is explicit: this is a degraded path.
  if (typeof ReadableStream !== "undefined" && body instanceof ReadableStream) {
    try {
      console.warn(
        "[PrivacyConsole] outbound ReadableStream body — cannot scan without consuming the stream",
      );
    } catch {
      /* noop */
    }
    return {
      bodyStr: "",
      preview: "<stream>",
      size: 0,
      forcedTag: "warn",
    };
  }

  // Unknown type — fall back to String() but flag it clearly so we don't
  // pretend we scanned bytes we didn't.
  const fallback = String(body);
  return {
    bodyStr: fallback,
    preview: fallback.slice(0, 400),
    size: new Blob([fallback]).size,
  };
}

// S6 async-rescan: after Blob.text() resolves, see if the plaintext shows
// DNA. If so, flip the entry's tag, top up the byte counter, and replace
// the rendered <li> with a freshly-styled one.
function recheckEntry(entry, text) {
  if (!text) return;
  pushRolling(text);
  const newTag = tagPayload(text, entry.url);
  if (newTag === entry.tag) return;
  const wasDna = entry.tag === "dna-like";
  entry.tag = newTag;
  entry.bodyPreview = text.slice(0, 400);
  if (newTag === "dna-like" && !wasDna) {
    if (counterEl && badgeEl) {
      bytesOut += entry.bodySize;
      counterEl.textContent = fmtBytes(bytesOut);
      counterEl.style.color = PALETTE.alarm;
      badgeEl.style.background = PALETTE.alarm;
      badgeEl.style.color = "#1a0405";
      badgeEl.textContent = "● DNA DETECTED";
    }
  }
  // Re-render in place if we have a handle to the original <li>.
  if (entry.__el && entry.__el.parentNode) {
    const placeholder = entry.__el;
    const li = makeEntryLi(entry);
    placeholder.parentNode.replaceChild(li, placeholder);
    entry.__el = li;
  }
}

// ---------------------------------------------------------------------------
// Patch helpers
// ---------------------------------------------------------------------------

// Wrap a function-valued property and remember how to restore it.
function trackPatch(label, restore) {
  patches.push({ label, restore });
}

// S2 fix: `window.fetch = wrapped` leaves the property writable and
// configurable — any inline script or devtools user can stomp it back to
// the original. In prod, lock the property down with defineProperty so the
// assignment fails (silently in non-strict, loud in strict). In dev (when
// `globalThis.__DOSEDNA_DEV === true`) we keep the property mutable so the
// uninstall() restore path keeps working for tests.
const DEV_MODE_LOCK = globalThis.__DOSEDNA_DEV === true;
function lockOrAssign(target, prop, wrapped) {
  if (DEV_MODE_LOCK) {
    target[prop] = wrapped;
    return;
  }
  try {
    Object.defineProperty(target, prop, {
      value: wrapped,
      writable: false,
      configurable: false,
      enumerable: true,
    });
  } catch (err) {
    // If the property was already locked by a prior install we can't
    // re-define it — fall back to plain assignment so the demo still arms
    // SOMETHING rather than throwing during module init.
    try {
      target[prop] = wrapped;
    } catch {
      unavailable(prop, err && err.message ? err.message : "lock failed");
    }
  }
}

// In prod (locked) mode the restore step in uninstall() can't undo
// non-configurable defineProperty calls. Tracked patches still record their
// restore thunk, but uninstall() will only run them in dev mode.
function trackRestore(label, restore) {
  trackPatch(label, restore);
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
  // S2 fix: in prod mode, mark the redefined setter non-configurable so the
  // page can't `Object.defineProperty(proto, prop, { value: ... })` itself
  // out of being watched. In dev we keep it configurable so uninstall() can
  // put the original descriptor back.
  Object.defineProperty(proto, prop, {
    configurable: DEV_MODE_LOCK,
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
    if (DEV_MODE_LOCK) Object.defineProperty(proto, prop, desc);
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
  lockOrAssign(window, "fetch", wrapped);
  trackPatch("fetch", () => {
    if (DEV_MODE_LOCK) window.fetch = orig;
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
  const wrapped = (url, data) => {
    recordCall(makeEntry({ url, method: "BEACON", body: data }));
    return orig(url, data);
  };
  lockOrAssign(navigator, "sendBeacon", wrapped);
  trackPatch("sendBeacon", () => {
    if (DEV_MODE_LOCK) navigator.sendBeacon = orig;
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
  lockOrAssign(window, "WebSocket", Wrapped);
  trackPatch("WebSocket", () => {
    if (DEV_MODE_LOCK) window.WebSocket = Orig;
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
    lockOrAssign(window, "Image", WrappedImage);
    trackPatch("Image", () => {
      if (DEV_MODE_LOCK) window.Image = Orig;
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
  lockOrAssign(window, "EventSource", Wrapped);
  trackPatch("EventSource", () => {
    if (DEV_MODE_LOCK) window.EventSource = Orig;
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
    lockOrAssign(window, name, Wrapped);
    trackPatch(name, () => {
      if (DEV_MODE_LOCK) window[name] = Orig;
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
  const wrapped = (url, target, features) => {
    if (url != null && String(url) !== "") {
      recordCall(makeEntry({ url, method: "WINDOW.open", body: "" }));
    }
    return orig(url, target, features);
  };
  lockOrAssign(window, "open", wrapped);
  trackPatch("window.open", () => {
    if (DEV_MODE_LOCK) window.open = orig;
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

// S1 fix: Web Workers run with their own pristine globals — none of our
// window.fetch/XHR/WebSocket patches reach inside. A judge can spin up
// `new Worker(URL.createObjectURL(new Blob([code])))` in devtools and
// exfiltrate freely. Patch the Worker constructor itself: pre-fetch the
// source, prepend an in-worker patcher that hooks fetch / XHR / WebSocket
// / importScripts and posts each call back to the main thread, then build
// the worker from a Blob URL of the prepended source.
//
// If we can't fetch the source (cross-origin, opaque, or fetch itself
// fails), the spec calls for a degraded "block" mode: construct a worker
// that throws on any outbound network call. The judges can't be tricked
// by a worker we couldn't inspect.
function patchWorker() {
  if (typeof window.Worker !== "function") {
    unavailable("Worker", "Worker missing");
    return;
  }
  const OrigWorker = window.Worker;

  // Minimal in-worker patcher. Stringified verbatim and prepended to the
  // worker source. It uses the SAME tagging logic as the main thread (the
  // small subset that matters) and posts every call back via postMessage
  // so the main-thread Privacy Console can ingest it as a regular entry.
  const inWorkerPatcher = `
    (function(){
      var __RS_ID = /\\brs\\d{3,}\\b/i;
      var __TSV = /#\\s*rsid\\s+chromosome\\s+position\\s+genotype/i;
      var __ACGT = /[ACGT]{12,}/i;
      function __tag(text, url){
        var h = text || ""; var u = url == null ? "" : String(url);
        var hns = h ? h.replace(/\\s+/g, "") : "";
        if (__RS_ID.test(h) || __RS_ID.test(u) || __TSV.test(h)
            || __ACGT.test(h) || __ACGT.test(hns) || __ACGT.test(u)) return "dna-like";
        return "safe";
      }
      function __forward(entry){
        try { self.postMessage({ __privacy: true, entry: entry }); } catch(e){}
      }
      function __sizeOf(b){
        if (b == null) return 0;
        try { return new Blob([typeof b === "string" ? b : ""]).size; } catch(e){ return 0; }
      }
      function __scanBody(b){
        if (b == null) return "";
        if (typeof b === "string") return b;
        try {
          if (b instanceof ArrayBuffer || (ArrayBuffer.isView && ArrayBuffer.isView(b))) {
            return new TextDecoder("utf-8", { fatal: false }).decode(b);
          }
        } catch(e){}
        return "";
      }
      if (typeof fetch === "function") {
        var __of = fetch;
        self.fetch = function(input, init){
          init = init || {};
          var url = typeof input === "string" ? input : (input && input.url) || String(input);
          var bodyStr = __scanBody(init.body);
          __forward({ time: Date.now(), url: url,
            method: "WORKER.fetch." + (init.method || "GET").toUpperCase(),
            bodyPreview: bodyStr.slice(0, 400) || "(no body)",
            bodySize: __sizeOf(bodyStr), tag: __tag(bodyStr, url) });
          return __of(input, init);
        };
      }
      if (typeof XMLHttpRequest === "function") {
        var __op = XMLHttpRequest.prototype.open;
        var __se = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function(m, u){ this.__u = u; this.__m = m; return __op.apply(this, arguments); };
        XMLHttpRequest.prototype.send = function(b){
          var bodyStr = __scanBody(b);
          __forward({ time: Date.now(), url: this.__u,
            method: "WORKER.XHR." + (this.__m || "GET").toUpperCase(),
            bodyPreview: bodyStr.slice(0, 400) || "(no body)",
            bodySize: __sizeOf(bodyStr), tag: __tag(bodyStr, this.__u) });
          return __se.apply(this, arguments);
        };
      }
      if (typeof WebSocket === "function") {
        var __OW = WebSocket;
        self.WebSocket = function(url, p){
          __forward({ time: Date.now(), url: String(url), method: "WORKER.WS.open",
            bodyPreview: "(no body)", bodySize: 0, tag: __tag("", url) });
          var ws = new __OW(url, p);
          var __os = ws.send.bind(ws);
          ws.send = function(d){
            var bodyStr = __scanBody(d);
            __forward({ time: Date.now(), url: String(url), method: "WORKER.WS.send",
              bodyPreview: bodyStr.slice(0, 400) || "(no body)",
              bodySize: __sizeOf(bodyStr), tag: __tag(bodyStr, url) });
            return __os(d);
          };
          return ws;
        };
      }
      if (typeof importScripts === "function") {
        var __oi = importScripts;
        self.importScripts = function(){
          for (var i = 0; i < arguments.length; i++) {
            var u = String(arguments[i]);
            __forward({ time: Date.now(), url: u, method: "WORKER.importScripts",
              bodyPreview: "(no body)", bodySize: 0, tag: __tag("", u) });
          }
          return __oi.apply(this, arguments);
        };
      }
    })();
  `;

  // Block-mode patcher for the degraded path: every outbound call throws.
  // We still post a tag-like entry so the main thread sees the attempt.
  const blockingPatcher = `
    (function(){
      function __block(label){
        try { self.postMessage({ __privacy: true, entry: {
          time: Date.now(), url: "(worker)",
          method: "WORKER." + label + ".BLOCKED",
          bodyPreview: "blocked by DoseDNA worker policy",
          bodySize: 0, tag: "dna-like"
        }}); } catch(e){}
        throw new Error("network from worker is not permitted by DoseDNA");
      }
      self.fetch = function(){ __block("fetch"); };
      if (typeof XMLHttpRequest === "function") {
        XMLHttpRequest.prototype.send = function(){ __block("XHR"); };
      }
      if (typeof WebSocket === "function") {
        self.WebSocket = function(){ __block("WS"); };
      }
      if (typeof importScripts === "function") {
        self.importScripts = function(){ __block("importScripts"); };
      }
    })();
  `;

  function fetchWorkerSource(url) {
    // Same-origin fetch via XHR (synchronous-ish through await). Returns
    // null if we can't read it — caller decides fallback.
    try {
      const u = new URL(String(url), location.href);
      // Blob URLs and same-origin URLs are readable. Cross-origin is not —
      // fetch() will likely fail or return opaque.
      if (u.origin !== location.origin && !u.href.startsWith("blob:")) {
        return null;
      }
      return fetch(u.href).then(
        (r) => (r.ok ? r.text() : null),
        () => null,
      );
    } catch {
      return null;
    }
  }

  function WrappedWorker(scriptURL, options) {
    // We can't construct asynchronously inside `new` and still return the
    // same object reference the caller expects. Compromise: synchronously
    // build a "stub" worker from a wrapped source that we *can* construct
    // synchronously — same-origin URLs we can re-fetch via XHR; otherwise
    // we use the block-mode patcher and load the original script via
    // importScripts inside the worker.
    let blobUrl;
    let usedDegraded = false;
    try {
      const xhr = new XMLHttpRequest();
      const u = new URL(String(scriptURL), location.href);
      const sameOrigin = u.origin === location.origin;
      if (sameOrigin) {
        // Synchronous XHR — only acceptable during one-shot setup, not in a
        // hot path. The whole privacy console is a setup-time concern.
        try {
          xhr.open("GET", u.href, false);
          xhr.send(null);
          if (xhr.status >= 200 && xhr.status < 300) {
            const src = inWorkerPatcher + "\n" + xhr.responseText;
            blobUrl = URL.createObjectURL(
              new Blob([src], { type: "application/javascript" }),
            );
          }
        } catch {
          /* fall through to degraded */
        }
      }
      if (!blobUrl) {
        // Degraded fallback: install the blocking patcher then importScripts
        // the original URL. If THAT also fails (CSP), the worker still
        // refuses to do anything sneaky because the patcher already armed.
        usedDegraded = true;
        const src =
          blockingPatcher +
          "\ntry{importScripts(" +
          JSON.stringify(String(scriptURL)) +
          ");}catch(e){}";
        blobUrl = URL.createObjectURL(
          new Blob([src], { type: "application/javascript" }),
        );
        try {
          console.warn(
            "[PrivacyConsole] worker source unreadable — installing block-mode patcher instead",
            { scriptURL: String(scriptURL) },
          );
        } catch {
          /* noop */
        }
      }
    } catch (err) {
      unavailable("Worker", err && err.message ? err.message : "wrap failed");
      // Last resort: hand back a real Worker so the app doesn't crash, but
      // log the gap loudly. Better a noisy demo than a broken one.
      return new OrigWorker(scriptURL, options);
    }

    const w = new OrigWorker(blobUrl, options);

    // Intercept worker → main-thread messages so privacy entries land in
    // the main-thread Privacy Console exactly like a same-thread call.
    const origAddEventListener = w.addEventListener.bind(w);
    const userMessageHandlers = new Set();

    function privacyShim(ev) {
      const data = ev && ev.data;
      if (data && data.__privacy && data.entry) {
        try {
          recordCall({
            time: data.entry.time || Date.now(),
            url: String(data.entry.url || ""),
            method: data.entry.method || "WORKER",
            bodyPreview: data.entry.bodyPreview || "(no body)",
            bodySize: data.entry.bodySize || 0,
            tag: data.entry.tag || "safe",
          });
        } catch {
          /* never let a bad entry from a worker crash the page */
        }
        // Don't propagate privacy frames to user handlers.
        return true;
      }
      return false;
    }

    // Wrap addEventListener for "message".
    w.addEventListener = function (type, listener, opts) {
      if (type === "message") {
        const wrapped = (ev) => {
          if (privacyShim(ev)) return;
          listener(ev);
        };
        userMessageHandlers.add({ orig: listener, wrapped });
        return origAddEventListener(type, wrapped, opts);
      }
      return origAddEventListener(type, listener, opts);
    };

    // Wrap the `onmessage` accessor so direct assignment also flows through.
    let userOnMessage = null;
    Object.defineProperty(w, "onmessage", {
      configurable: true,
      enumerable: true,
      get() {
        return userOnMessage;
      },
      set(fn) {
        userOnMessage = fn;
      },
    });
    // And funnel raw events through our shim first via a base listener.
    origAddEventListener("message", (ev) => {
      if (privacyShim(ev)) return;
      if (typeof userOnMessage === "function") userOnMessage(ev);
    });

    if (usedDegraded) {
      // Surface a single entry so the demo's panel records the fact that
      // we couldn't read the worker source.
      recordCall({
        time: Date.now(),
        url: String(scriptURL),
        method: "WORKER.constructed.degraded",
        bodyPreview: "block-mode patcher installed (source unreadable)",
        bodySize: 0,
        tag: "warn",
      });
    } else {
      recordCall({
        time: Date.now(),
        url: String(scriptURL),
        method: "WORKER.constructed",
        bodyPreview: "in-worker patcher installed",
        bodySize: 0,
        tag: "safe",
      });
    }

    return w;
  }
  WrappedWorker.prototype = OrigWorker.prototype;

  lockOrAssign(window, "Worker", WrappedWorker);
  trackPatch("Worker", () => {
    if (DEV_MODE_LOCK) window.Worker = OrigWorker;
  });

  // Reference the helper so it isn't tree-shaken in case future code wants
  // an async path. Currently sync XHR handles same-origin reads.
  void fetchWorkerSource;
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
  safePatch("Worker", patchWorker);
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

    // S14 fix: pre-mount leaks were logged but never increment the visible
    // counter because recordCall gated bytesOut on counterEl/badgeEl being
    // set. Sum dna-like bytes already in the log and flip the badge before
    // replaying the visual entries.
    let preMountDnaBytes = 0;
    for (const entry of log) {
      if (entry.tag === "dna-like") preMountDnaBytes += entry.bodySize;
    }
    if (preMountDnaBytes > 0) {
      bytesOut += preMountDnaBytes;
      counterEl.textContent = fmtBytes(bytesOut);
      counterEl.style.color = PALETTE.alarm;
      badgeEl.style.background = PALETTE.alarm;
      badgeEl.style.color = "#1a0405";
      badgeEl.textContent = "● DNA DETECTED";
    }

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
//
// S2 fix: in prod mode the patched properties are non-configurable, so the
// `restore` thunks are intentionally no-ops there. uninstall() is therefore
// only useful in dev mode (where __DOSEDNA_DEV is set), and we don't expose
// it on `window.__dosednaPrivacy` in prod (see S13).
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
  resetRolling();
}

// Public surface for the demo / tests. Preserves the existing namespace.
//
// S13 fix: exposing `install`/`uninstall` globally lets anyone in devtools
// disarm the patches, exfiltrate, then re-arm — the green badge would never
// flinch. In production we expose only the read-only `getLog`. Tests and
// dev tooling can set `globalThis.__DOSEDNA_DEV = true` BEFORE this module
// loads to get the full surface back. We deliberately do NOT key off
// `import.meta.env?.DEV` (no Vite in this stack — it would always be
// undefined and we'd silently ship the dev surface).
if (typeof window !== "undefined") {
  const devMode = globalThis.__DOSEDNA_DEV === true;
  const surface = { getLog: getPrivacyLog };
  if (devMode) {
    surface.install = installPrivacyConsole;
    surface.uninstall = uninstall;
  }
  window.__dosednaPrivacy = Object.assign(
    window.__dosednaPrivacy || {},
    surface,
  );
}
