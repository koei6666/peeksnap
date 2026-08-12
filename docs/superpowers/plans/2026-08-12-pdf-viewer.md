# PDF Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An opt-in PDF viewer inside the extension that renders PDFs with vendored PDF.js, so brush strokes anchor to page content and the highlighter works on PDF text.

**Architecture:** A new extension page (`viewer/viewer.html`) fetches the PDF and renders every page as a stacked column of canvases with a PDF.js text layer over each. Because it is an ordinary scrolling HTML document, the existing `marker.js` works unchanged — its document-space stroke anchoring and its `contentType`-based highlighter guard both do the right thing automatically. The sidebar↔marker wiring is extracted into a shared `marking_controller.js` consumed by both the content script and the viewer.

**Tech Stack:** Vanilla ES2020+, MV3 Safari web extension, `browser.*` promise API, vendored PDF.js v6.2.108 (ES modules + web worker), Canvas 2D. Still no build step and no package manager.

## Global Constraints

- **No build step, no npm, no bundler.** Vendored PDF.js ships as authored, byte-for-byte.
- **`peeksnap/vendor/` is read-only third-party code.** Never edit a vendored file. If something needs changing, change our code around it.
- Content scripts remain classic IIFEs — no `import`/`export` in `peeksnap/content/*.js`. **The viewer page is exempt**: it is an extension page and may use `<script type="module">`.
- `browser.*`, never `chrome.*`.
- Never `innerHTML` with page-derived, PDF-derived, or user data. `textContent` only. PDF filenames and error strings are untrusted.
- Every element injected into a *host* page carries `data-peeksnap="1"`. This does not apply inside `viewer.html`, which is our own page.
- **No storage schema change.** No `DB_VERSION` bump, no new persisted snippet fields, no writes to `peeksnap_settings`. Annotations remain session-only.
- Section dividers: `// ── Section Name ──────────────`. Private fields/methods `_`-prefixed. `const` by default.
- PDF.js version is pinned at **6.2.108**. Record it in a `VERSION` file beside the vendored code.
- Bump `manifest.json` `version` to **0.3.0** and update the `[PeekSnap] v…` startup log, so the running bundle is identifiable (a stale `/Applications` copy has already cost a debugging session once).

## Verification Approach — read this before Task 1

**This project has NO test framework, NO linter, NO test runner, and no `package.json`.** There is nothing to install and no `npm test`. Verification is manual in Safari via an Xcode build. Implementer subagents have no Xcode and no browser, so:

- **Never claim runtime verification you did not perform.** Report manual steps as UNVERIFIED.
- **Never invent or simulate test output.**
- **Never add a test framework** — it violates the no-dependency constraint.

What implementers MUST do instead: run the static checks listed in each task and report their real output. A failed static check blocks the commit exactly as a failing test would.

The build loop for the human's later verification: open `native/PeekSnap/PeekSnap.xcodeproj`, Cmd+R, then **replace the `/Applications/PeekSnap.app` copy** — Xcode builds to DerivedData and Safari may load the stale `/Applications` bundle instead. Confirm the console shows `[PeekSnap] v0.3.0`.

---

### Task 1: Vendor PDF.js

**Files:**
- Create: `peeksnap/vendor/pdfjs/pdf.mjs`, `peeksnap/vendor/pdfjs/pdf.worker.mjs`, `peeksnap/vendor/pdfjs/cmaps/`, `peeksnap/vendor/pdfjs/standard_fonts/`, `peeksnap/vendor/pdfjs/wasm/`, `peeksnap/vendor/pdfjs/VERSION`, `peeksnap/vendor/README.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `peeksnap/vendor/pdfjs/pdf.mjs` exporting `getDocument`, `GlobalWorkerOptions`, `TextLayer`, `version`; and the worker at `peeksnap/vendor/pdfjs/pdf.worker.mjs`. Task 3 loads both.

- [ ] **Step 1: Download and extract the official release**

The archive has already been downloaded and extracted to the session scratchpad. Verify it is still there first:

```bash
ls /private/tmp/claude-501/-Users-richard-Documents-snippet-sidebar/57b9de35-95e1-4a40-a373-b3276665d27b/scratchpad/pdfjs/build/pdf.mjs
```

If it is missing, re-download it:

```bash
curl -sSL -o /tmp/pdfjs.zip "https://github.com/mozilla/pdf.js/releases/download/v6.2.108/pdfjs-6.2.108-dist.zip" && unzip -o -q /tmp/pdfjs.zip -d /tmp/pdfjs-extract
```

- [ ] **Step 2: Copy only the needed files into the repo**

Adjust the `SRC` path if you re-downloaded to `/tmp/pdfjs-extract`.

```bash
SRC=/private/tmp/claude-501/-Users-richard-Documents-snippet-sidebar/57b9de35-95e1-4a40-a373-b3276665d27b/scratchpad/pdfjs
mkdir -p peeksnap/vendor/pdfjs
cp "$SRC/build/pdf.mjs" peeksnap/vendor/pdfjs/
cp "$SRC/build/pdf.worker.mjs" peeksnap/vendor/pdfjs/
cp -R "$SRC/web/cmaps" peeksnap/vendor/pdfjs/
cp -R "$SRC/web/standard_fonts" peeksnap/vendor/pdfjs/
cp -R "$SRC/web/wasm" peeksnap/vendor/pdfjs/
echo "6.2.108" > peeksnap/vendor/pdfjs/VERSION
```

Do NOT copy the `.map` sourcemaps (~7 MB) or Mozilla's `web/viewer.*` UI — we render with our own viewer.

- [ ] **Step 3: Write `peeksnap/vendor/README.md`**

```markdown
# Vendored third-party code

Do not edit anything in this directory. These files ship byte-for-byte as
published upstream. If behavior needs to change, change PeekSnap's own code
around them.

## pdfjs/ — PDF.js 6.2.108

Source: https://github.com/mozilla/pdf.js/releases/download/v6.2.108/pdfjs-6.2.108-dist.zip

Copied from that archive:

| Path here | From archive | Why |
|---|---|---|
| `pdf.mjs` | `build/pdf.mjs` | Main library (ES module) |
| `pdf.worker.mjs` | `build/pdf.worker.mjs` | Parsing/rendering worker |
| `cmaps/` | `web/cmaps/` | CJK character maps |
| `standard_fonts/` | `web/standard_fonts/` | The 14 standard PDF fonts |
| `wasm/` | `web/wasm/` | Image decoders, incl. JPEG 2000 |

Deliberately excluded: `.map` sourcemaps (~7 MB) and Mozilla's own
`web/viewer.*` UI.

`cmaps`, `standard_fonts`, and `wasm` are NOT optional for this project's
purpose — scanned PDFs depend on those image decoders and font fallbacks.
Removing them makes some PDFs render blank or with wrong fonts.

To upgrade: download the new dist zip, repeat the copies above, update
`VERSION`, and re-run the manual PDF verification matrix.
```

- [ ] **Step 4: Verify the vendored payload**

```bash
ls -la peeksnap/vendor/pdfjs/
cat peeksnap/vendor/pdfjs/VERSION
du -sh peeksnap/vendor/pdfjs/
grep -c "export" peeksnap/vendor/pdfjs/pdf.mjs
find peeksnap/vendor -name "*.map" | wc -l
```

Expected: `VERSION` is `6.2.108`; total size roughly 6–7 MB; the `export` count is non-zero; **the `.map` count is exactly 0**.

- [ ] **Step 5: Commit**

```bash
git add peeksnap/vendor
git commit -m "vendor: add PDF.js 6.2.108 (library, worker, cmaps, fonts, wasm)"
```

---

### Task 2: Extract the shared marking controller

A pure refactor. Behavior on normal web pages must be **identical** afterward.

**Files:**
- Create: `peeksnap/content/marking_controller.js`
- Modify: `peeksnap/content/content_script.js` (replace the wiring block with a call)
- Modify: `peeksnap/manifest.json` (register the new script before `content_script.js`; bump version to 0.3.0)

**Interfaces:**
- Consumes: the marker's `setTool/setColor/undo/clear/canHighlight` and the sidebar's `setActiveTool/setHighlighterEnabled` plus its three `composed` events.
- Produces: the global `window.PeekSnapMarking` with one method, `attach(sidebar, marker)`. Task 5's `viewer.js` calls it.

- [ ] **Step 1: Read the current wiring**

Open `peeksnap/content/content_script.js` and locate the `// ── Mount Marker ──` block through the end of the `// ── Marking Keyboard Shortcuts ──` block. That code — the three sidebar listeners, the `setHighlighterEnabled` call, the local `activeTool` variable, and the keydown handler — is what moves.

- [ ] **Step 2: Create `peeksnap/content/marking_controller.js`**

```js
/**
 * marking_controller.js — shared sidebar↔marker wiring.
 *
 * Used by BOTH content_script.js (host pages) and viewer/viewer.js (our PDF
 * viewer page). The keydown handler has three separate bail-out conditions
 * and one of them has already been gotten wrong once, so this logic lives in
 * exactly one place.
 *
 * Content scripts are classic IIFEs with no module system, so a single
 * namespaced global is the only available sharing mechanism.
 *
 * Public API:
 *   PeekSnapMarking.attach(sidebar, marker)
 */

(function () {
  if (window.PeekSnapMarking) return;

  /**
   * Wires a sidebar element to a marker element and installs the marking
   * keyboard shortcuts. Safe to call once per page.
   */
  function attach(sidebar, marker) {
    // The sidebar owns the buttons but knows nothing about why highlighting
    // may be unavailable, so the caller relays it.
    sidebar.setHighlighterEnabled(marker.canHighlight);

    let activeTool = null;

    sidebar.addEventListener("peeksnap:tool-change", (e) => {
      activeTool = e.detail.tool;
      marker.setTool(activeTool);
    });

    sidebar.addEventListener("peeksnap:mark-color", (e) => {
      marker.setColor(e.detail.color);
    });

    sidebar.addEventListener("peeksnap:clear-marks", () => {
      marker.clear();
    });

    // Only live while a tool is active, so the page keeps its own undo.
    window.addEventListener("keydown", (e) => {
      if (!activeTool) return;

      if (e.key === "Escape") {
        activeTool = null;
        marker.setTool(null);
        sidebar.setActiveTool(null);
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
        // Ordinary editable targets.
        const t = e.target;
        const isEditable = t && (t.isContentEditable ||
          /^(input|textarea|select)$/i.test(t.tagName || ""));
        if (isEditable) return;

        // Our own capture-name field: overlay.js uses a CLOSED shadow root, so
        // the input is invisible to both e.target and composedPath().
        if (document.querySelector("peeksnap-overlay")) return;

        e.preventDefault();
        marker.undo();
      }
    });
  }

  window.PeekSnapMarking = { attach };
})();
```

- [ ] **Step 3: Replace the wiring in `content_script.js`**

Replace everything from `sidebar.setHighlighterEnabled(marker.canHighlight);` through the end of the keydown handler (the whole `// ── Marking Keyboard Shortcuts ──` section, including its comment banner) with:

```js
  window.PeekSnapMarking.attach(sidebar, marker);
```

Keep the marker creation, `marker.dataset.peeksnap = "1"`, and `document.body.appendChild(marker)` exactly as they are. The `// ── Mount Marker ──` divider stays.

- [ ] **Step 4: Register it in the manifest and bump the version**

In `peeksnap/manifest.json`, set `"version": "0.3.0"` and make the content_scripts `js` array exactly:

```json
    "js": [
      "content/overlay.js",
      "content/sidebar.js",
      "content/marker.js",
      "content/marking_controller.js",
      "content/content_script.js"
    ],
```

`marking_controller.js` must precede `content_script.js`, which calls it at load time.

- [ ] **Step 5: Update the startup log**

In `content_script.js`, change the existing log to:

```js
  console.log("[PeekSnap] v0.3.0 content scripts loaded — marking enabled");
```

- [ ] **Step 6: Verify statically**

```bash
node --check peeksnap/content/marking_controller.js
node --check peeksnap/content/content_script.js
python3 -m json.tool peeksnap/manifest.json > /dev/null && echo "manifest OK"
grep -n "PeekSnapMarking" peeksnap/content/content_script.js
grep -c "addEventListener(\"keydown\"" peeksnap/content/content_script.js
grep -n "marking_controller" peeksnap/manifest.json
```

Expected: both `node --check` silent; manifest OK; `content_script.js` references `PeekSnapMarking` exactly once; **the keydown count in `content_script.js` is 0** (it moved); `marking_controller.js` appears in the manifest before `content_script.js`.

- [ ] **Step 7: Commit**

```bash
git add peeksnap/content/marking_controller.js peeksnap/content/content_script.js peeksnap/manifest.json
git commit -m "refactor: extract shared marking controller for reuse by the PDF viewer"
```

---

### Task 3: Viewer page renders a PDF

**Files:**
- Create: `peeksnap/viewer/viewer.html`, `peeksnap/viewer/viewer.css`, `peeksnap/viewer/viewer.js`

**Interfaces:**
- Consumes: `peeksnap/vendor/pdfjs/pdf.mjs` (Task 1).
- Produces: a working render of every page into `#pages`, and the module-scoped helpers `renderAll()` and `showError(message, originalUrl)`. Task 4 adds the text layer; Task 5 mounts the marking UI.

- [ ] **Step 1: Create `peeksnap/viewer/viewer.html`**

```html
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>PeekSnap PDF Viewer</title>
  <link rel="stylesheet" href="viewer.css">
</head>
<body>
  <div id="pages"></div>
  <div id="error" hidden></div>
  <script type="module" src="viewer.js"></script>
</body>
</html>
```

- [ ] **Step 2: Create `peeksnap/viewer/viewer.css`**

The `.textLayer` rules are required by PDF.js and are copied from its stylesheet; do not invent your own.

```css
:root { color-scheme: light dark; }

body {
  margin: 0;
  background: #2a2a3a;
  font-family: system-ui, -apple-system, sans-serif;
}

#pages {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
  padding: 16px 0 64px;
}

.page {
  position: relative;
  box-shadow: 0 2px 12px rgba(0,0,0,0.4);
  background: #fff;
}

.page canvas { display: block; }

.page-failed {
  color: #f38ba8;
  background: #1e1e2e;
  padding: 24px;
  font-size: 13px;
  border-radius: 6px;
}

#error {
  color: #cdd6f4;
  background: #1e1e2e;
  margin: 48px auto;
  padding: 24px;
  max-width: 520px;
  border-radius: 10px;
  font-size: 14px;
  line-height: 1.5;
}

#error a { color: #89b4fa; }

/* ── PDF.js text layer (required for selection/highlighting) ── */
.textLayer {
  position: absolute;
  text-align: initial;
  inset: 0;
  overflow: clip;
  opacity: 1;
  line-height: 1;
  letter-spacing: normal;
  word-spacing: normal;
  text-size-adjust: none;
  forced-color-adjust: none;
  transform-origin: 0 0;
  caret-color: CanvasText;
  z-index: 0;
  --min-font-size: 1;
  --text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
  --min-font-size-inv: calc(1 / var(--min-font-size));
}

.textLayer :is(span, br) {
  color: transparent;
  position: absolute;
  white-space: pre;
  cursor: text;
  transform-origin: 0% 0%;
  user-select: text;
}

.textLayer > :not(.markedContent),
.textLayer .markedContent span:not(.markedContent) {
  z-index: 1;
  --font-height: 0;
  font-size: calc(var(--text-scale-factor) * var(--font-height));
  --scale-x: 1;
  --rotate: 0deg;
  transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));
}

.textLayer .markedContent { display: contents; }
```

- [ ] **Step 3: Create `peeksnap/viewer/viewer.js`**

```js
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

async function renderAll() {
  const token = ++renderToken;
  pagesEl.textContent = "";

  for (let n = 1; n <= pdfDoc.numPages; n++) {
    if (token !== renderToken) return;
    try {
      const page = await pdfDoc.getPage(n);
      await renderPage(page, token);
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
```

- [ ] **Step 4: Expose the viewer and vendor files in the manifest**

Add to `peeksnap/manifest.json`, as a sibling of `permissions`:

```json
  "web_accessible_resources": [{
    "resources": ["viewer/*", "vendor/pdfjs/*"],
    "matches": ["<all_urls>"]
  }],
```

- [ ] **Step 5: Verify statically**

```bash
node --check peeksnap/viewer/viewer.js || echo "NOTE: node --check cannot parse ES modules with import; use the next check instead"
node --input-type=module --check < peeksnap/viewer/viewer.js && echo "module syntax OK"
python3 -m json.tool peeksnap/manifest.json > /dev/null && echo "manifest OK"
grep -n "innerHTML" peeksnap/viewer/viewer.js
grep -n "web_accessible_resources" peeksnap/manifest.json
ls peeksnap/viewer/
```

Expected: module syntax OK; manifest OK; **`innerHTML` returns nothing**; `web_accessible_resources` present; the viewer directory contains all three files.

- [ ] **Step 6: Commit**

```bash
git add peeksnap/viewer peeksnap/manifest.json
git commit -m "feat(viewer): render PDFs with vendored PDF.js in an extension page"
```

---

### Task 4: Text layer, so the highlighter works

**Files:**
- Modify: `peeksnap/viewer/viewer.js`

**Interfaces:**
- Consumes: `renderPage()` from Task 3, `TextLayer` from `pdf.mjs`.
- Produces: a `.textLayer` div over every rendered page containing real selectable DOM text.

- [ ] **Step 1: Add the text-layer builder**

Insert after `renderPage()`:

```js
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
```

- [ ] **Step 2: Call it from the render loop**

In `renderAll()`, replace the body of the `try` block with:

```js
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
```

Note the nested `try`: a scanned PDF may have no extractable text at all, and that must not turn into a failed page.

- [ ] **Step 3: Verify statically**

```bash
node --input-type=module --check < peeksnap/viewer/viewer.js && echo "module syntax OK"
grep -n "TextLayer\|streamTextContent\|total-scale-factor" peeksnap/viewer/viewer.js
grep -n "innerHTML" peeksnap/viewer/viewer.js
```

Expected: syntax OK; `TextLayer`, `streamTextContent`, and `--total-scale-factor` all present; no `innerHTML`.

- [ ] **Step 4: Commit**

```bash
git add peeksnap/viewer/viewer.js
git commit -m "feat(viewer): add PDF.js text layer so the highlighter works on PDFs"
```

---

### Task 5: Mount the marking UI in the viewer

**Files:**
- Modify: `peeksnap/viewer/viewer.html`, `peeksnap/viewer/viewer.js`

**Interfaces:**
- Consumes: `PeekSnapMarking.attach()` (Task 2), the `<peeksnap-sidebar>` and `<peeksnap-marker>` custom elements.
- Produces: a fully wired marking surface on the viewer page, with snippets keyed to the original PDF URL.

- [ ] **Step 1: Load the marking components in `viewer.html`**

Add these BEFORE the module script — they are classic scripts and must define their custom elements first:

```html
  <script src="../content/overlay.js"></script>
  <script src="../content/sidebar.js"></script>
  <script src="../content/marker.js"></script>
  <script src="../content/marking_controller.js"></script>
  <script type="module" src="viewer.js"></script>
```

- [ ] **Step 2: Mount and wire, in `viewer.js`**

Add before `boot()`:

```js
// ── Marking UI ──────────────────────────────────────────────────────────────

/**
 * Snippets are keyed by the ORIGINAL PDF url, not this viewer's extension
 * URL, so a snap taken here still shows up when the same PDF is opened in
 * Safari's viewer.
 */
function mountMarkingUI() {
  const sidebar = document.createElement("peeksnap-sidebar");
  document.body.appendChild(sidebar);

  const marker = document.createElement("peeksnap-marker");
  document.body.appendChild(marker);

  window.PeekSnapMarking.attach(sidebar, marker);

  browser.runtime
    .sendMessage({ action: "get_snippets", pageUrl: fileUrl })
    .then((response) => {
      if (response?.action === "snippets_loaded") sidebar.render(response.snippets);
    })
    .catch(() => {
      // Background not ready — sidebar shows its empty state.
    });

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
```

Then call `mountMarkingUI();` as the first statement inside `boot()`, before the `if (!fileUrl)` check — the sidebar should be present even on the error screen.

- [ ] **Step 3: Honour a `pageUrl` override in the background worker**

In `peeksnap/background/background_worker.js`, find `handleCapture` where it destructures the message (currently including `captureDocX, captureDocY`) and add `pageUrl` to the destructured names. Then find where the snippet object sets `pageUrl: tab.url` and change it to:

```js
    pageUrl: pageUrl || tab.url,
```

When the message carries no `pageUrl` — every existing caller — behavior is byte-for-byte unchanged.

- [ ] **Step 4: Verify statically**

```bash
node --input-type=module --check < peeksnap/viewer/viewer.js && echo "viewer module OK"
node --check peeksnap/background/background_worker.js
grep -n "pageUrl" peeksnap/background/background_worker.js
grep -n "PeekSnapMarking.attach" peeksnap/viewer/viewer.js
grep -n "script src" peeksnap/viewer/viewer.html
```

Expected: both syntax checks pass; `background_worker.js` shows `pageUrl || tab.url`; `attach` called once in the viewer; the four classic scripts precede the module script in the HTML.

- [ ] **Step 5: Commit**

```bash
git add peeksnap/viewer peeksnap/background/background_worker.js
git commit -m "feat(viewer): mount marking UI and key snippets to the original PDF url"
```

---

### Task 6: The "Open PDF in PeekSnap" popup button

**Files:**
- Modify: `peeksnap/popup/popup.html`, `peeksnap/popup/popup.js`

**Interfaces:**
- Consumes: `viewer/viewer.html` (Task 3).
- Produces: the user-facing entry point. Nothing depends on this task.

- [ ] **Step 1: Add the button to `popup.html`**

Add directly after the existing capture button, matching the surrounding markup style:

```html
    <button id="open-pdf-btn" hidden>Open PDF in PeekSnap</button>
```

- [ ] **Step 2: Wire it in `popup.js`**

Add near the other initialization code:

```js
// ── Open PDF in PeekSnap ────────────────────────────────────────────────────
// Safari REJECTS declarativeNetRequest redirects to safari-web-extension://
// schemes, so the viewer can only be reached by a user-initiated navigation.

const openPdfBtn = document.getElementById("open-pdf-btn");

browser.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
  const tab = tabs[0];
  if (!tab || !tab.url) return;
  if (!/\.pdf(\?|#|$)/i.test(tab.url)) return;

  openPdfBtn.hidden = false;
  openPdfBtn.addEventListener("click", () => {
    const viewerUrl =
      browser.runtime.getURL("viewer/viewer.html") +
      "?file=" + encodeURIComponent(tab.url);
    browser.tabs.update(tab.id, { url: viewerUrl }).then(() => window.close());
  });
});
```

- [ ] **Step 3: Verify statically**

```bash
node --check peeksnap/popup/popup.js
grep -n "open-pdf-btn" peeksnap/popup/popup.html peeksnap/popup/popup.js
grep -n "innerHTML" peeksnap/popup/popup.js
grep -n "getURL" peeksnap/popup/popup.js
```

Expected: syntax OK; the id appears in both files; no `innerHTML`; `getURL` present.

- [ ] **Step 4: Commit**

```bash
git add peeksnap/popup
git commit -m "feat(popup): add Open PDF in PeekSnap entry point"
```

---

### Task 7: Journal and verification checklist

**Files:**
- Modify: `JOURNAL.md`
- Create: `docs/superpowers/plans/2026-08-12-pdf-viewer-MANUAL-VERIFICATION.md`

**Interfaces:** consumes everything above; produces nothing.

- [ ] **Step 1: Append the session entry to `JOURNAL.md`**

```markdown

---

## Session 4 — PDF Viewer
**Date:** 2026-08-12

**Features added this session:**
- **Vendored PDF.js 6.2.108** under `peeksnap/vendor/pdfjs/` (library, worker, cmaps, standard fonts, wasm image decoders)
- **`viewer/viewer.html`** — an opt-in in-extension PDF viewer that renders every page to canvas with a PDF.js text layer
- **"Open PDF in PeekSnap"** button in the popup, shown only on PDF URLs
- **`content/marking_controller.js`** — sidebar↔marker wiring extracted so the content script and the viewer share one copy

**Why:**
Safari's built-in PDF viewer is a plugin: `window.scrollY` is permanently 0 and there is no selectable text. Brush strokes could not follow PDF content and the highlighter could not work at all — on exactly the surface (scanned PDFs) the drawing tool was built for.

**Architecture decisions:**
- **Opt-in, not automatic takeover.** If our renderer fails on some PDF, the user loses annotation, never the ability to read. Cost of a failure is one click.
- Reached by a **user-initiated `tabs.update()`**, because Safari rejects `declarativeNetRequest` redirects to `safari-web-extension://` schemes.
- **`marker.js` was not modified.** Once the PDF is an ordinary document, its document-space stroke anchoring works, and `supportsHighlight()` returns true because the viewer page's contentType is `text/html`. The feature adds a renderer, not marking logic.
- Snippets captured in the viewer are keyed to the **original PDF URL**, so they appear in either viewer. The background worker takes an optional `pageUrl` override, defaulting to `tab.url` exactly as before.
- `cmaps`/`standard_fonts`/`wasm` are vendored, not trimmed: scanned PDFs depend on those image decoders and font fallbacks.

**Storage:** no changes. Annotations remain session-only.

**Known limitations:**
- No thumbnails, search, zoom controls, printing, or form filling.
- PDFs behind auth the extension cannot reuse will fail to fetch; the viewer shows an error with a link back to Safari's viewer.
- Annotations still vanish on reload, by design.
```

- [ ] **Step 2: Write the manual verification checklist**

Create `docs/superpowers/plans/2026-08-12-pdf-viewer-MANUAL-VERIFICATION.md` containing, as markdown checkboxes, exactly the matrix from §9 of `docs/superpowers/specs/2026-08-12-pdf-viewer-design.md`, plus:

- Build instructions: Cmd+R in Xcode, then replace `/Applications/PeekSnap.app` from DerivedData, and confirm `[PeekSnap] v0.3.0` appears in the console.
- A regression section confirming marking on ordinary web pages still behaves identically after the Task 2 refactor (brush draws and anchors on scroll, highlighter works, Cmd+Z undoes, Escape deactivates, Cmd+Z in a page text field is NOT stolen).
- A symptom→cause table: blank viewer → fetch/CORS; text not selectable → text layer failed; strokes not anchoring → `scrollY` not real; highlighter greyed on a text PDF → `canHighlight` false; viewer never opens → Safari blocked the navigation.

- [ ] **Step 3: Commit**

```bash
git add JOURNAL.md docs/superpowers/plans/2026-08-12-pdf-viewer-MANUAL-VERIFICATION.md
git commit -m "docs: journal and manual verification checklist for the PDF viewer"
```

---

## Self-Review Notes

Spec coverage:

| Spec requirement | Task |
|---|---|
| §2 opt-in trigger via tabs.update | 6 |
| §3 vendored PDF.js payload + read-only rule | 1 |
| §3 canvas rendering, fit-width, DPR | 3 |
| §3 text layer → highlighter works | 4 |
| §3 marker.js unchanged | verified by absence — no task modifies it |
| §4 session-only, no schema change | all (no persistence added) |
| §5 marking_controller extraction | 2 |
| §6 snippets keyed to original PDF URL | 5 |
| §7 error UI with fallback link, per-page isolation | 3 (error UI), 4 (text-layer isolation) |
| §8 scope boundaries | respected — no zoom/search/thumbnails anywhere |
| §9 verification matrix | 7 |

Deliberate notes:

1. **`marker.js` and `sidebar.js` are untouched by this entire plan.** If an implementer finds themselves editing either, something has gone wrong — the design's core claim is that the viewer needs no new marking code.
2. **Task 2 is a pure refactor** and is sequenced first so the viewer has something to consume. Its verification is explicitly a regression check on normal pages.
3. **No automated tests**, consistent with the project's total absence of test infrastructure and with the approved spec. Each task ends in static checks whose real output must be reported; manual Safari verification is collected in Task 7 for the human.
