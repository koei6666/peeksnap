# Manual Verification Checklist — PDF Viewer

**Date:** 2026-08-12  
**Scope:** Session 4, Tasks 1–6 of the PDF viewer feature  
**Method:** Manual testing in Safari via Xcode build

---

## Build & Setup

- [ ] **Build:** Open `native/PeekSnap.xcodeproj` in Xcode and press Cmd+R
- [ ] **Install built app:** Xcode outputs to `DerivedData/…/Build/Products/Release`. Safari may load a stale `/Applications/PeekSnap.app` instead. Replace it:
  ```bash
  rm -rf /Applications/PeekSnap.app
  cp -r "$(find ~/Library/Developer/Xcode/DerivedData -name 'PeekSnap.app' -type d | head -1)" /Applications/PeekSnap.app
  ```
- [ ] **Verify version in console:** Open Safari Web Inspector (Cmd+Option+I) on any page and confirm the console shows `[PeekSnap] v0.3.0`

---

## Feature Verification Matrix

### Text-based PDF
- [ ] Navigate to a text-based PDF (e.g., `https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf`)
- [ ] Verify: Page renders; text is selectable with mouse; highlighter tool works (drag-select text, release, color appears at 35% alpha)
- [ ] Verify: Brush tool draws; strokes follow the page content while scrolling

### Scanned/Image PDF
- [ ] Locate or create a scanned PDF (image-only, no text layer)
- [ ] Verify: Page renders; brush draws; strokes follow content while scrolling
- [ ] Verify: Highlighter tool is correctly greyed out / disabled (scanned PDFs have no selectable text, so this is correct, not a bug)

### Multi-page PDF
- [ ] Open a multi-page PDF in the viewer
- [ ] Verify: All pages render
- [ ] Verify: Draw a mark on page 1, scroll to page 2, draw on page 2. Marks stay on their own page; marks do not appear on the wrong page.

### Auth-protected or Unreachable PDF
- [ ] Attempt to open a PDF that requires authentication or is behind a CORS barrier
- [ ] Verify: Viewer displays a clear error message stating the failure (fetch error, CORS, etc.)
- [ ] Verify: An "Open in Safari's viewer" link is present and works (returns the user to Safari's PDF viewer)

### Capture Inside the Viewer
- [ ] While viewing a PDF in the PeekSnap viewer, capture a region of the page (use the PeekSnap popup)
- [ ] Verify: The snap saves to the sidebar
- [ ] Verify: Navigate away from the PDF and back (e.g., open the same PDF URL in Safari, then click "Open PDF in PeekSnap" again)
- [ ] Verify: The saved snap appears in the sidebar, keyed to the original PDF URL

---

## Regression: Ordinary Web Page Marking

Verify marking on regular web pages (non-PDF) still behaves identically after the Task 2 `marking_controller.js` refactor.

- [ ] **Brush drawing on web pages:** Activate the brush tool on a normal web page. Draw strokes. Verify they appear on the canvas and follow the page content when scrolling.
- [ ] **Highlighter on web pages:** Activate the highlighter. Drag-select text. Verify the text highlights in the active tag color at 35% alpha.
- [ ] **Undo (Cmd+Z):** With marks on the page, press Cmd+Z. Verify one mark is removed. Press again; verify another is removed. Marks disappear in reverse order (LIFO).
- [ ] **Escape deactivates:** With the brush active, press Escape. Verify the tool deactivates and the mouse is no longer drawing.
- [ ] **Cmd+Z in page text fields is NOT stolen:** Click inside a page text input or textarea. Press Cmd+Z. Verify the browser's undo/redo is still active — Cmd+Z does not interact with PeekSnap marks when a form field has focus.

---

## Troubleshooting Reference

| Symptom | Likely Cause | Check |
|---------|--------------|-------|
| **Blank white viewer page** | PDF fetch failed (CORS, auth, or network) | Check browser console for fetch errors; verify "Open in Safari's viewer" link is present |
| **Text not selectable in viewer** | PDF.js text layer failed to render | Check Safari console for PDF.js errors; confirm PDF has an embedded text stream (scanned PDFs have none) |
| **Brush strokes don't follow page content while scrolling** | `window.scrollY` is not real in this context | This should not happen — the viewer is an ordinary HTML document, not a PDF plugin. Check that the viewer page loads at `safari-web-extension://…/viewer.html` |
| **Highlighter is greyed out on a text-based PDF** | `canHighlight` returned false when it should be true | Check browser console for errors during text-layer init; verify the PDF has selectable text; check that `document.contentType` is `text/html` (not `application/pdf`) |
| **"Open PDF in PeekSnap" button never appears** | Safari blocked the `tabs.update()` navigation | Check that the extension has the `tabs` permission in `manifest.json`; verify the popup is allowed to call `browser.tabs.update` |


---

## PRIORITY — verify these first (added after the final review's fix wave, commit `9fd19b2`)

The final review found two Critical and three Important defects. All are fixed in code but **none has been run**. Test in this order:

- [ ] **Scanned / image-heavy PDF renders at all.** The manifest previously declared no CSP, so the default `script-src 'self'` blocked `WebAssembly.instantiate` — and PDF.js's WASM decoders (JPEG 2000) are exactly what scanned PDFs need. A `content_security_policy` with `'wasm-unsafe-eval'` was added. If scanned PDFs render blank, this is the first suspect.
- [ ] **"Capture Region" actually works inside the viewer.** Previously impossible: nothing created a `<peeksnap-overlay>` on the viewer page, because content scripts aren't injected into extension pages and the viewer had no message listener. One was added. Open a PDF in the viewer → popup → Capture Region → the selection overlay must appear, and the saved snap must be listed.
- [ ] **The viewer still loads at all.** `web_accessible_resources` was removed entirely to stop arbitrary web pages opening the viewer with a crafted `file` parameter. If the viewer fails to load, or PDF.js fails to fetch its worker/wasm/cmaps, restore it narrowed to `{"resources": ["vendor/pdfjs/*"], "matches": ["<all_urls>"]}`.
- [ ] **Resize a text PDF with a stroke and a highlight on screen.** Marks are now deliberately cleared on a width-changing re-render, with a notice reading "Marks cleared — page was re-rendered at a new size." Height-only resizes must NOT trigger it. Silent mark loss would be a bug; the notice is the intended behavior.
- [ ] **Resize mid-load on a long PDF** (50+ pages) — watch for duplicate or out-of-order pages. A render-token hole allowed a superseded render to append stale pages; it now re-checks immediately before appending.
- [ ] **Security check:** open `viewer.html?file=javascript:alert(1)` manually. Expected: an error screen with **no link**, and no script execution. Non-http/https/file URLs are now rejected before both the fetch and the link.
- [ ] **Viewer captures are labelled by the PDF's host**, not the extension, in the popup's manager screen.
