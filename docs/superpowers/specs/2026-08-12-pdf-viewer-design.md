# PeekSnap PDF Viewer — Design

**Date:** 2026-08-12
**Status:** Approved
**Feature:** An opt-in, in-extension PDF viewer that renders PDFs with vendored PDF.js, so brush drawings anchor to the page content and the highlighter works on PDF text.

---

## 1. Why this exists

Safari's built-in PDF viewer is a plugin, not an inspectable document. `window.scrollY` is permanently `0`, no scroll events fire, and there is no text to select. Consequently:

- Brush strokes cannot follow PDF content — they stay pinned to the viewport.
- The highlighter cannot work at all; `getSelection()` yields nothing.

Since scanned PDFs are the primary use case for freehand drawing, this defeats the feature's purpose on exactly the surface it was built for.

The standard fix — redirecting PDF requests to an extension viewer page — is unavailable on Safari, which rejects redirects to `safari-web-extension://` schemes ("Redirection to URL with a scheme that is not HTTP(S)"). A **user-initiated navigation** via `browser.tabs.update()` is not a redirect and is not subject to that restriction. That is the mechanism this design uses.

## 2. Trigger — opt-in, never automatic

The popup gains an **"Open PDF in PeekSnap"** button, enabled only when the active tab looks like a PDF. It navigates the tab to:

```
browser.runtime.getURL("viewer/viewer.html") + "?file=" + encodeURIComponent(originalUrl)
```

Safari's own PDF viewing is untouched unless the user asks. This is deliberate: automatic takeover means a viewer failure costs the user the ability to *read* the document, not merely to annotate it. Opt-in caps the downside at one wasted click.

## 3. Architecture

### New files

```
peeksnap/vendor/pdfjs/          ← vendored, unmodified, from the official Mozilla release
  pdf.mjs                       (834 KB)
  pdf.worker.mjs                (2.0 MB)
  cmaps/                        (1.6 MB — CJK character maps)
  standard_fonts/               (800 KB — the 14 standard PDF fonts)
  wasm/                         (1.5 MB — image decoders, incl. JPEG 2000)
peeksnap/viewer/
  viewer.html                   ← extension page; loads PDF.js as an ES module
  viewer.js                     ← fetch → render → mount marking UI
  viewer.css                    ← page layout + PDF.js text-layer rules
peeksnap/content/
  marking_controller.js         ← shared sidebar↔marker wiring (see §5)
```

Source: `https://github.com/mozilla/pdf.js/releases/download/v6.2.108/pdfjs-6.2.108-dist.zip`. Only the files listed above are vendored; the `.map` sourcemaps (~7 MB) and Mozilla's own viewer UI are excluded. The vendored files are never edited — treat the directory as read-only third-party code.

`cmaps`, `standard_fonts`, and `wasm` are included rather than trimmed because the feature's stated purpose is scanned PDFs, whose image encodings (including JPEG 2000) and embedded font situations are exactly what those assets handle. Omitting them produces PDFs that render blank or with fallback fonts.

### Rendering

`viewer.js` fetches the PDF with `credentials: "include"` (so cookie-authenticated PDFs work), passes the `ArrayBuffer` to `getDocument`, and renders **every page** into a vertically stacked column of `<canvas>` elements in an ordinary scrolling document. Each canvas is sized at `viewport.scale * devicePixelRatio` for crispness, matching the DPR discipline used in `marker.js`.

Pages render at fit-width scale, recomputed on window resize. There are no zoom controls in this cut.

### Why this needs almost no new marking code

Two properties fall out of the PDF becoming an ordinary document:

1. The page scrolls normally, so `window.scrollY` is real. `marker.js` already stores stroke points in document space and repaints with the scroll offset subtracted — **it needs no changes.**
2. PDF.js's `TextLayer` emits absolutely-positioned real DOM text over each canvas, so `window.getSelection()` works. `supportsHighlight()` already returns `true` here, because the viewer page's `contentType` is `text/html`, not `application/pdf` — **the highlighter needs no changes either.**

The `application/pdf` guard in `supportsHighlight()` and the `scrollY === 0` degradation in `_renderStrokes()` both become inert on their own inside the viewer. This design adds a *renderer*, not marking logic.

## 4. Session-only

Unchanged from the existing marking feature. Marks vanish on reload. No IndexedDB schema change, no new persisted fields, no writes to `peeksnap_settings`.

## 5. Shared wiring — one targeted refactor

`viewer.js` cannot reuse `content_script.js`: that file keys snippets by `location.href`, which on the viewer page is the extension URL. Snaps would be filed under `safari-web-extension://…` and disappear when the user returns to the real PDF.

Rather than duplicate the wiring, the sidebar↔marker glue moves into `peeksnap/content/marking_controller.js`, which defines exactly one global:

```js
window.PeekSnapMarking = { attach(sidebar, marker) { … } }
```

`attach()` owns: relaying the three sidebar events to the marker, calling `setHighlighterEnabled(marker.canHighlight)`, and the keydown handler (Cmd/Ctrl+Z with its three bail-outs, Escape). Both `content_script.js` and `viewer.js` call it.

This is not gold-plating. The Cmd+Z handler has three separate bail-out conditions — no active tool, editable target, capture overlay open — and one of them was already gotten wrong once. Two divergent copies of that logic is a defect with a delivery date.

A single global is acceptable here for the same reason custom elements are: content scripts are classic IIFEs with no module system, so a namespaced global is the only sharing mechanism available.

## 6. Snippet identity

Captures taken inside the viewer are stored under the **original PDF URL**, not the viewer URL, so a snap appears consistently whether the user is in our viewer or Safari's. `viewer.js` passes the decoded `file` parameter as `pageUrl` when it requests and saves snippets.

The background worker currently derives `pageUrl` from `tab.url` when saving a capture. It gains an optional `pageUrl` override in the `capture` message; when absent, behavior is exactly as today. This is the only background change in the design.

## 7. Failure handling

The realistic failure is the fetch being refused — PDFs behind auth schemes that reject the extension origin, unusual CORS, or `file://` URLs. On any failure (fetch rejection, non-OK status, PDF.js parse error) the viewer renders a plain message stating what failed, plus an **"Open in Safari's viewer"** link back to the original URL.

Never a blank page, and never a dead end. Because the feature is opt-in, a failed render costs a click and nothing else.

Per-page render failures are isolated: a page that fails to render shows an inline placeholder and the remaining pages still render.

## 8. Scope boundaries

Explicitly **not** in this cut: page thumbnails, text search, zoom controls beyond fit-width, printing, form filling, annotation export, and persistent annotations. This is a reading surface that supports marking, not a PDF suite.

## 9. Verification

No test framework exists in this project; verification is manual in Safari via an Xcode build, per `mem:task_completion`. Required checks:

| Surface | Expected |
|---|---|
| Text-based PDF | Renders; text selectable; **highlighter works**; brush anchors to content while scrolling |
| Scanned/image PDF | Renders; brush anchors to content; highlighter correctly greyed (no text layer content to select) |
| Multi-page PDF | All pages render; marks stay on their own page while scrolling |
| Auth-protected or unreachable PDF | Clear error message plus a working "Open in Safari's viewer" link |
| Capture inside the viewer | Snap saves, and appears in the sidebar when viewing that same PDF URL |
| Regression: normal web page | Marking still works exactly as before the `marking_controller.js` refactor |

Window resize must re-render pages at the new fit-width scale without losing marks.
