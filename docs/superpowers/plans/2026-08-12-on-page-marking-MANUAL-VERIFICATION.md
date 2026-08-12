# On-Page Marking — Manual Verification Checklist

Every task in this plan was implemented and code-reviewed, but **no runtime verification was possible** — subagents have no Xcode and no browser. This checklist collects every deferred manual step into one pass. Nothing here has been performed.

## Build once, then work down the list

```bash
open native/PeekSnap/PeekSnap.xcodeproj
```

Press **Cmd+R**. Then in Safari: Settings → Advanced → "Show features for web developers", then Develop → **Allow Unsigned Extensions** (this resets on every Safari restart). Reload the test page so content scripts re-inject.

Console handle used throughout:

```js
const m = document.querySelector('peeksnap-marker');
```

---

## A. Inertness — the highest-stakes check

If this fails, PeekSnap breaks every page in the browser. Test on `https://en.wikipedia.org/wiki/Cartography`.

- [ ] `document.querySelector('peeksnap-marker')` returns the element
- [ ] `getComputedStyle(document.querySelector('peeksnap-marker')).pointerEvents` → `"none"`
- [ ] Clicking a link navigates normally
- [ ] Selecting text with the mouse works normally
- [ ] Scrolling works normally
- [ ] Zero `[PeekSnap]` errors and zero uncaught exceptions in the console

## B. Brush

- [ ] `m.setTool('brush')` → cursor over the page becomes a crosshair
- [ ] Dragging draws a stroke that follows the pointer smoothly
- [ ] A single click without dragging leaves a small round dot
- [ ] **Resize the Safari window** → strokes are still present and correctly positioned
      *(If they vanish, retained-mode rendering is broken — the canvas backing store blanks on resize and `_renderStrokes()` must repaint from `_marks`.)*
- [ ] On a Retina display, stroke edges are crisp, not soft *(softness = DPR scaling wrong)*
- [ ] `m.setTool(null)` → strokes stay visible, but links and text selection work again

## C. Highlighter

- [ ] `m.canHighlight` → `true` on the Wikipedia page
- [ ] `m.setTool('highlighter')`, select a sentence, release → it turns translucent yellow and the blue selection clears
- [ ] **Page layout does not shift by a single pixel** *(a shift means DOM was mutated, which must never happen)*
- [ ] `document.querySelectorAll('style[data-peeksnap]').length` → `1`
- [ ] Highlight a second separate sentence → both persist
- [ ] Scroll away and back → highlights are still on the correct text
- [ ] `m.setTool(null)`, then select text → no new highlight is created

## D. Highlighter self-disables on a PDF

Open `https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf`.

- [ ] `m.canHighlight` → `false`
- [ ] `m.setTool('highlighter')` is a silent no-op — no error thrown
- [ ] `m.setTool('brush')` still works — dragging draws a stroke

## E. Undo ordering across both tools

This is what the single shared mark stack exists for.

- [ ] Draw a stroke, then highlight a sentence, then draw a second stroke
- [ ] `m._marks.length` → `3`
- [ ] `m.undo()` → removes the **second stroke** (highlight + first stroke remain)
- [ ] `m.undo()` → removes the **highlight** (first stroke remains)
- [ ] `m.undo()` → removes the first stroke; page is clean
- [ ] A fourth `m.undo()` does nothing and throws nothing

*(If undo removes all strokes before any highlight, the stack has been split — that's a real defect.)*

## F. Clear

- [ ] With two strokes and one highlight on screen, `m.clear()`
- [ ] `m._marks.length` → `0`
- [ ] `window.CSS.highlights.size` → `0`
- [ ] `document.querySelector('style[data-peeksnap]').textContent` → `""`
- [ ] Canvas is blank, no text highlighted

## G. Sidebar tool row + events

Expand the sidebar by clicking its tab.

- [ ] Tool row appears below the header: two tool buttons, a color dot, "Clear marks"
- [ ] The snippet list below is unchanged
- [ ] Register probes (these only fire if the events are `composed: true`):

```js
document.addEventListener('peeksnap:tool-change', (e) => console.log('tool', e.detail));
document.addEventListener('peeksnap:mark-color', (e) => console.log('color', e.detail));
document.addEventListener('peeksnap:clear-marks', () => console.log('clear'));
```

- [ ] Clicking brush logs `tool {tool: "brush"}` and the button turns indigo
- [ ] Clicking brush **again** logs `tool {tool: null}` and deactivates it
- [ ] Clicking highlighter while brush is active switches — only one is indigo at a time
- [ ] Clicking the color dot logs a new hex each time and cycles back to the first after the last
- [ ] "Clear marks" logs `clear`

## H. End-to-end through the UI

- [ ] Brush button → drag → stroke appears in the color shown on the dot
- [ ] **Cmd+Z** → stroke disappears
- [ ] Change color via the dot → draw again → new stroke uses the new color; earlier strokes keep theirs
- [ ] Highlighter button → select a sentence → it highlights
- [ ] **Cmd+Z** → highlight disappears
- [ ] **Escape** → both tool buttons deactivate; clicking page links works again
- [ ] **The undo-hijack check:** with no tool active, go to `https://en.wikipedia.org/w/index.php?search=`, type in the search box, press Cmd+Z → the **page's** undo works, not ours
      *(This is the check that matters most for not annoying users on every site they visit.)*
- [ ] **The harder undo-hijack check, WITH a tool active:** activate the brush, then click into the Wikipedia search box, type, and press Cmd+Z → the **page's** undo must still work. This is the editable-target bail-out added in `1fb3528`.
- [ ] **Our own naming field:** activate the brush, then start a capture and type a name in the overlay's name box, press Cmd+Z → the **name field's** undo works and no mark is removed. This one needs its own guard because `overlay.js` uses a *closed* shadow root, so the event target at window level is the host element and `composedPath()` cannot see the input.
- [ ] "Clear marks" with several marks of both types → all vanish

## I. On a PDF, through the UI

- [ ] Highlighter button is greyed and unclickable
- [ ] Hovering it shows "Highlighting needs selectable text — unavailable on this page"
- [ ] Brush works and draws

## J. Ad-heavy page — TEST THIS FIRST

The final whole-branch review caught a Critical defect here that every per-task review missed, and it was fixed in commit `1fb3528`. **This section verifies that fix.** It is the most likely place for the feature to still be broken.

The bug: the pre-existing ad-defense `MutationObserver` re-appends every `[data-peeksnap]` element to `<body>` whenever any external element is inserted. `appendChild` on an already-connected node is remove-then-insert, so it fired `disconnectedCallback()` → `connectedCallback()` on the marker — wiping highlights, blanking the stroke canvas, and resetting `pointer-events` to `none` while the brush was still active. On a real page this fires constantly.

- [ ] Load a news site with ads, activate brush, draw → stroke is visible above page content
- [ ] **Draw two strokes AND highlight a paragraph, then wait for an ad or lazy-loaded block to appear.** Both must survive. If strokes vanish or the highlight unpaints, the fix did not hold.
- [ ] **After that ad insertion, keep drawing without touching the tool buttons.** The brush must still respond. If drawing is dead until you toggle the tool off and on, `_applyToolState()` is not being reapplied on reconnect.
- [ ] Force it deterministically from the console — this injects an external element and triggers the observer:

```js
document.body.appendChild(document.createElement('div'));
```

- [ ] After running that line, marks are still on screen and the brush still draws
- [ ] *Known and accepted:* content in the CSS top layer (`<dialog showModal()>`, popover API) still covers PeekSnap UI

## K. Capture interop — the payoff

- [ ] Draw a circle around a paragraph with the brush
- [ ] Highlight a sentence inside that circle
- [ ] Press **Escape** to deactivate
- [ ] Click the PeekSnap toolbar icon, drag a region covering both marks, save
- [ ] Hover the new sidebar item to preview, then click to open the viewer
- [ ] **Both the stroke and the highlight are present in the captured image**
- [ ] Stroke edges are crisp in the capture, not soft *(captures resolve at device pixels and will expose DPR bugs the screen hides)*
- [ ] The capture overlay drew **above** the marks while selecting

## L. Session-only behavior

- [ ] Reload the page → the sidebar still lists the saved snap, and the page has **no marks**

This is intended behavior, not a bug.

---

## Check all three consoles

Errors can appear in any of them; all PeekSnap logging is prefixed `[PeekSnap]`.

- [ ] Page / content script — Develop → the tab
- [ ] Background page — Develop → Web Extension Background Pages → PeekSnap
- [ ] Popup — right-click the toolbar icon → Inspect

## If something fails

Report which lettered section failed and what you saw. The likely suspects, by symptom:

| Symptom | Likely cause |
|---|---|
| Highlighter never paints, no error | `const CSS` shadowing the global `CSS` object, or the `<style>` landed in the shadow root instead of the host document |
| Strokes vanish on window resize | Retained-mode repaint not wired to the resize handler |
| Strokes soft only in captures | DPR scaling in `_resizeCanvas()` |
| Page clicks dead after using a tool | Host element left at `pointer-events: auto` |
| Cmd+Z hijacked on normal pages | The `if (!activeTool) return;` guard in the keydown handler |
| Tool buttons do nothing | Events missing `composed: true` — they cannot leave the closed shadow root |
