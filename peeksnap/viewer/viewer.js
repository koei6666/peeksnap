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

const fileUrl = new URLSearchParams(location.search).get("file");

let pdfDoc = null;
let renderToken = 0;

// ── Error UI ────────────────────────────────────────────────────────────────

/** Never leaves a blank page: always offers a way back to Safari's viewer. */
function showError(message, originalUrl) {
  pagesEl.textContent = "";
  errorEl.textContent = "";
  errorEl.hidden = false;

  const p = document.createElement("p");
  p.textContent = message;
  errorEl.appendChild(p);

  if (originalUrl) {
    const a = document.createElement("a");
    a.href = originalUrl;
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
  pagesEl.textContent = "";

  for (let n = 1; n <= pdfDoc.numPages; n++) {
    if (token !== renderToken) return;
    try {
      const page = await pdfDoc.getPage(n);
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

// ── Boot ────────────────────────────────────────────────────────────────────

async function boot() {
  if (!fileUrl) {
    showError("No PDF was specified.", null);
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

let resizeTimer = 0;
window.addEventListener("resize", () => {
  if (!pdfDoc) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => renderAll(), 200);
});

boot();
