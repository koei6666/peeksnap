/**
 * viewer.js — PeekSnap's own PDF viewer.
 *
 * Renders a PDF with vendored PDF.js into an ordinary scrolling document.
 * That is the entire point: Safari's built-in PDF plugin reports scrollY as 0
 * forever and exposes no text, so neither stroke anchoring nor highlighting
 * can work there. Here both work with NO changes to marker.js.
 *
 * Opened via: viewer.html?file=<encodeURIComponent(originalPdfUrl)>
 */

import * as pdfjsLib from "../vendor/pdfjs/pdf.mjs";

const VENDOR = "../vendor/pdfjs/";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(VENDOR + "pdf.worker.mjs", import.meta.url).href;

const pagesEl = document.getElementById("pages");
const errorEl = document.getElementById("error");

const rawFileParam = new URLSearchParams(location.search).get("file");

/**
 * The `file` parameter is attacker-influenceable, so only real remote/file
 * document URLs are ever fetched or linked. Anything else — notably
 * javascript: — would run in the extension origin with full browser.* access.
 */
function safeDocumentUrl(raw) {
  if (!raw) return null;
  let u;
  try {
    u = new URL(raw, location.href);
  } catch (_) {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:" && u.protocol !== "file:") {
    return null;
  }
  return u.href;
}

const fileUrl = safeDocumentUrl(rawFileParam);

let pdfDoc = null;
let renderToken = 0;
let marker = null;
let lastRenderWidth = 0;

// ── Error UI ────────────────────────────────────────────────────────────────

/** Never leaves a blank page: always offers a way back to Safari's viewer. */
function showError(message, originalUrl) {
  pagesEl.textContent = "";
  errorEl.textContent = "";
  errorEl.hidden = false;

  const p = document.createElement("p");
  p.textContent = message;
  errorEl.appendChild(p);

  const safeUrl = safeDocumentUrl(originalUrl);
  if (safeUrl) {
    const a = document.createElement("a");
    a.href = safeUrl;
    a.textContent = "Open in Safari's viewer";
    errorEl.appendChild(a);
  }
}

// ── Rendering ───────────────────────────────────────────────────────────────

function fitWidthScale(page) {
  const unscaled = page.getViewport({ scale: 1 });
  const available = Math.min(window.innerWidth - 48, 1100);
  return Math.max(0.2, available / unscaled.width);
}

async function renderPage(page, token) {
  const scale = fitWidthScale(page);
  const viewport = page.getViewport({ scale });
  const dpr = window.devicePixelRatio || 1;

  const wrap = document.createElement("div");
  wrap.className = "page";
  wrap.style.width = Math.floor(viewport.width) + "px";
  wrap.style.height = Math.floor(viewport.height) + "px";

  const canvas = document.createElement("canvas");
  canvas.width = Math.floor(viewport.width * dpr);
  canvas.height = Math.floor(viewport.height * dpr);
  canvas.style.width = Math.floor(viewport.width) + "px";
  canvas.style.height = Math.floor(viewport.height) + "px";
  wrap.appendChild(canvas);

  if (token !== renderToken) return null;
  pagesEl.appendChild(wrap);

  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);

  await page.render({ canvasContext: ctx, viewport }).promise;
  if (token !== renderToken) return null;

  return { wrap, page, viewport };
}

/**
 * PDF.js emits absolutely-positioned real DOM text. That is what makes
 * window.getSelection() work here, which is in turn what lets the existing
 * highlighter work on PDFs with no changes to marker.js.
 */
async function buildTextLayer(wrap, page, viewport) {
  const layer = document.createElement("div");
  layer.className = "textLayer";
  layer.style.setProperty("--total-scale-factor", String(viewport.scale));
  wrap.appendChild(layer);

  const textLayer = new pdfjsLib.TextLayer({
    textContentSource: page.streamTextContent(),
    container: layer,
    viewport,
  });
  await textLayer.render();
}

async function renderAll() {
  const token = ++renderToken;
  lastRenderWidth = window.innerWidth;
  pagesEl.textContent = "";

  for (let n = 1; n <= pdfDoc.numPages; n++) {
    if (token !== renderToken) return;
    try {
      const page = await pdfDoc.getPage(n);
      if (token !== renderToken) return;
      const rendered = await renderPage(page, token);
      if (rendered) {
        try {
          await buildTextLayer(rendered.wrap, rendered.page, rendered.viewport);
        } catch (err) {
          // A missing text layer costs highlighting on this page, not the page.
          console.warn("[PeekSnap] text layer failed", n, err);
        }
      }
    } catch (err) {
      // One bad page must not kill the whole document.
      const failed = document.createElement("div");
      failed.className = "page-failed";
      failed.textContent = `Page ${n} could not be rendered.`;
      pagesEl.appendChild(failed);
      console.warn("[PeekSnap] page render failed", n, err);
    }
  }
}

// ── Marking UI ──────────────────────────────────────────────────────────────

/**
 * Snippets are keyed by the ORIGINAL PDF url, not this viewer's extension
 * URL, so a snap taken here still shows up when the same PDF is opened in
 * Safari's viewer.
 */
function mountMarkingUI() {
  const sidebar = document.createElement("peeksnap-sidebar");
  document.body.appendChild(sidebar);

  marker = document.createElement("peeksnap-marker");
  document.body.appendChild(marker);

  window.PeekSnapMarking.attach(sidebar, marker);

  if (fileUrl) {
    browser.runtime
      .sendMessage({ action: "get_snippets", pageUrl: fileUrl })
      .then((response) => {
        if (response?.action === "snippets_loaded") sidebar.render(response.snippets);
      })
      .catch(() => {
        // Background not ready — sidebar shows its empty state.
      });
  }

  document.addEventListener("peeksnap:captured", (e) => {
    const { rect, dpr, name, colorTag } = e.detail;
    browser.runtime
      .sendMessage({ action: "capture", rect, dpr, name, colorTag, pageUrl: fileUrl })
      .then((response) => {
        if (response?.action === "snippet_saved") sidebar.addSnippet(response.snippet);
      })
      .catch((err) => console.warn("[PeekSnap] capture failed", err));
  });
}

/**
 * The viewer is an extension page — content_script.js is never injected into
 * it — so it has to handle "activate_selection" itself, mirroring
 * activateSelection() in content_script.js, for the popup's "Capture Region"
 * button to do anything here.
 */
function activateSelection() {
  // Avoid stacking multiple overlays
  if (document.querySelector("peeksnap-overlay")) return;

  const overlay = document.createElement("peeksnap-overlay");
  document.body.appendChild(overlay);
}

browser.runtime.onMessage.addListener((message) => {
  if (message?.action === "activate_selection") {
    activateSelection();
  }
});

// ── Boot ────────────────────────────────────────────────────────────────────

async function boot() {
  mountMarkingUI();

  if (!fileUrl) {
    if (rawFileParam) {
      showError("This address could not be opened.", null);
    } else {
      showError("No PDF was specified.", null);
    }
    return;
  }

  let buf;
  try {
    const res = await fetch(fileUrl, { credentials: "include" });
    if (!res.ok) {
      showError(`Could not load this PDF (HTTP ${res.status}).`, fileUrl);
      return;
    }
    buf = await res.arrayBuffer();
  } catch (err) {
    showError("Could not load this PDF. It may require a sign-in that the extension cannot use.", fileUrl);
    console.warn("[PeekSnap] fetch failed", err);
    return;
  }

  try {
    pdfDoc = await pdfjsLib.getDocument({
      data: buf,
      cMapUrl: new URL(VENDOR + "cmaps/", import.meta.url).href,
      cMapPacked: true,
      standardFontDataUrl: new URL(VENDOR + "standard_fonts/", import.meta.url).href,
      wasmUrl: new URL(VENDOR + "wasm/", import.meta.url).href,
    }).promise;
  } catch (err) {
    showError("This file could not be opened as a PDF.", fileUrl);
    console.warn("[PeekSnap] getDocument failed", err);
    return;
  }

  document.title = "PeekSnap — PDF";
  await renderAll();
}

/**
 * Re-rendering wipes #pages, which detaches the text-layer nodes marker's
 * highlight Ranges point into (highlights silently stop painting) and leaves
 * stroke document-coordinates referring to now-rescaled content. That loss
 * must be explicit, so it's kept rare (width changes only, not height-only
 * resizes) and always surfaced to the user.
 */
function notifyMarksCleared() {
  const notice = document.createElement("div");
  notice.textContent = "Marks cleared — page was re-rendered at a new size.";
  Object.assign(notice.style, {
    position: "fixed",
    bottom: "24px",
    left: "50%",
    transform: "translateX(-50%)",
    background: "#f38ba8",
    color: "#1e1e2e",
    padding: "8px 16px",
    borderRadius: "6px",
    fontFamily: "system-ui, sans-serif",
    fontSize: "13px",
    fontWeight: "600",
    zIndex: "2147483647",
    pointerEvents: "none",
    boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
  });
  document.body.appendChild(notice);
  setTimeout(() => notice.remove(), 4000);
}

let resizeTimer = 0;
window.addEventListener("resize", () => {
  if (!pdfDoc) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (window.innerWidth === lastRenderWidth) return;
    marker?.clear?.();
    notifyMarksCleared();
    renderAll();
  }, 200);
});

boot();
