# On-Page Marking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users mark directly on a live page — highlight text with a highlighter, draw freehand with a brush — with marks lasting for the session and baking into any snap taken over them.

**Architecture:** One new custom element, `<peeksnap-marker>`, owns a single ordered mark stack that both tools push onto (which is what makes cross-tool undo work). Strokes render to a viewport-fixed, DPR-scaled canvas inside the element's closed shadow root. Highlights render through the CSS Custom Highlight API, which paints over live `Range` objects with zero host-DOM mutation. The sidebar grows a tool row that only emits events; `content_script.js` is the sole place that knows about both sides.

**Tech Stack:** Vanilla ES2020+, MV3 Safari web extension, `browser.*` promise API, custom elements with closed shadow DOM, Canvas 2D, CSS Custom Highlight API. No build step, no bundler, no dependencies.

## Global Constraints

- **No build step.** No npm packages, no imports, no bundler. Files ship exactly as authored.
- **Content scripts are IIFEs loaded as classic scripts.** No `import`/`export` in `peeksnap/content/*.js`. The only cross-file coupling mechanism is `customElements.define` in one file plus tag usage in another.
- **Manifest load order is load-bearing.** `content/marker.js` must be listed before `content/content_script.js`.
- **Every element appended to the host page carries `data-peeksnap="1"`.** Omitting it both buries the element behind ads and causes the existing `MutationObserver` to misread it as foreign content.
- **Never `innerHTML` with page-derived or user data.** Use `textContent`. Author-written literal markup only.
- **`browser.*`, never `chrome.*`.**
- **Zero storage changes.** No `DB_VERSION` bump, no snippet schema fields, no writes to `peeksnap_settings`. This feature reads settings only.
- **Never mutate host-page DOM** except the single injected `<style>` element specified in Task 3.
- Section dividers use the existing convention: `// ── Section Name ─────────────────────`
- Private fields and methods are `_`-prefixed. `const` by default.
- Stroke width is fixed at `3` CSS pixels. Highlight alpha is fixed at `0.35`.
- Minimum platform: Safari 17.2 (the floor for `CSS.highlights`). Below it the highlighter self-disables; the brush still works.

## Verification Approach — read this before Task 1

**This project has no test framework, no linter, and no test runner.** There is nothing to install and no `npm test` to run. The approved spec sets verification as manual in Safari. So the usual red/green TDD cycle does not apply here; instead **every task ends with an explicit manual verification step with exact actions and exact expected results, performed before the commit.** Treat a failed verification exactly like a failing test: do not commit, fix first.

The build loop for every verification step:

1. Open `native/PeekSnap/PeekSnap.xcodeproj`, press Cmd+R.
2. Reload the test page in Safari so content scripts re-inject.
3. Open Web Inspector on the page (Develop → the tab).

**Editing files under `peeksnap/` changes nothing that is running** — the converter copies them into the app bundle at build time. Every change needs a rebuild.

Tasks 2–4 are verified by calling the marker's public API from the Web Inspector console before any UI exists to drive it. That is deliberate: it tests the unit through its real interface, in isolation from the sidebar. The console handle is:

```js
const m = document.querySelector('peeksnap-marker');
```

---

### Task 1: Scaffold the marker element

Creates the element, mounts it, and proves it is completely inert — the page must behave exactly as if the feature did not exist. No tools yet.

**Files:**
- Create: `peeksnap/content/marker.js`
- Modify: `peeksnap/manifest.json` (the `content_scripts[0].js` array)
- Modify: `peeksnap/content/content_script.js` (after the sidebar mount block, around line 20)

**Interfaces:**
- Consumes: nothing.
- Produces: `<peeksnap-marker>` custom element with `_marks: Array`, `_tool: string|null`, `_color: string`, `_canvas`, `_ctx`, and methods `_resizeCanvas()`, `_renderStrokes()`. Later tasks add `setTool`, `setColor`, `undo`, `clear`, `canHighlight`.

- [ ] **Step 1: Create `peeksnap/content/marker.js`**

Note the constant is named `STYLE_TEXT`, **not** `CSS`. `overlay.js` and `sidebar.js` both name their style constant `CSS`, but this file must call `CSS.highlights` in Task 3 — a local `const CSS` would shadow the global `CSS` object and silently break highlight detection. This is the single most likely bug in the whole feature.

```js
/**
 * marker.js — PeekSnapMarker custom element.
 *
 * Session-only on-page marks. Two tools:
 *   highlighter — paints text selections via the CSS Custom Highlight API
 *   brush       — freehand strokes on a viewport-fixed canvas
 *
 * Marks are never persisted and vanish on reload. They ARE rendered by
 * captureVisibleTab, so a snap taken over a mark bakes it into the PNG.
 *
 * Public API:
 *   marker.setTool(tool)  — 'highlighter' | 'brush' | null
 *   marker.setColor(hex)
 *   marker.undo()
 *   marker.clear()
 *   marker.canHighlight   — read-only boolean, resolved at construction
 *
 * NOTE: the style constant is STYLE_TEXT, not CSS. A local `const CSS`
 * would shadow the global CSS object that the highlighter depends on.
 */

(function () {
  if (customElements.get("peeksnap-marker")) return;

  const STROKE_WIDTH = 3;

  const STYLE_TEXT = `
    canvas {
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      display: block;
      pointer-events: none;
    }
    canvas.active {
      pointer-events: all;
      cursor: crosshair;
    }
  `;

  class PeekSnapMarker extends HTMLElement {
    constructor() {
      super();
      this._shadow = this.attachShadow({ mode: "closed" });
      this._marks = [];
      this._tool = null;
      this._color = "#fde047";
      this._drawing = false;
      this._current = null;

      const style = document.createElement("style");
      style.textContent = STYLE_TEXT;
      this._shadow.appendChild(style);

      this._canvas = document.createElement("canvas");
      this._shadow.appendChild(this._canvas);
      this._ctx = this._canvas.getContext("2d");

      this._onResize = this._onResize.bind(this);
    }

    connectedCallback() {
      this.style.cssText = [
        "position: fixed !important",
        "top: 0",
        "left: 0",
        "width: 100vw",
        "height: 100vh",
        "z-index: 2147483640",
        "pointer-events: none",
      ].join(";");

      this._resizeCanvas();
      window.addEventListener("resize", this._onResize);
    }

    disconnectedCallback() {
      window.removeEventListener("resize", this._onResize);
    }

    // ── Canvas ────────────────────────────────────────────────────────────────

    _resizeCanvas() {
      const dpr = window.devicePixelRatio || 1;
      this._canvas.width = Math.round(window.innerWidth * dpr);
      this._canvas.height = Math.round(window.innerHeight * dpr);
      this._ctx.setTransform(1, 0, 0, 1, 0, 0);
      this._ctx.scale(dpr, dpr);
    }

    _onResize() {
      this._resizeCanvas();
      this._renderStrokes();
    }

    _renderStrokes() {
      this._ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
      this._ctx.lineCap = "round";
      this._ctx.lineJoin = "round";

      for (const mark of this._marks) {
        if (mark.type !== "stroke" || !mark.points.length) continue;

        this._ctx.strokeStyle = mark.color;
        this._ctx.fillStyle = mark.color;
        this._ctx.lineWidth = mark.width;

        if (mark.points.length === 1) {
          const p = mark.points[0];
          this._ctx.beginPath();
          this._ctx.arc(p.x, p.y, mark.width / 2, 0, Math.PI * 2);
          this._ctx.fill();
          continue;
        }

        this._ctx.beginPath();
        this._ctx.moveTo(mark.points[0].x, mark.points[0].y);
        for (let i = 1; i < mark.points.length; i++) {
          this._ctx.lineTo(mark.points[i].x, mark.points[i].y);
        }
        this._ctx.stroke();
      }
    }
  }

  customElements.define("peeksnap-marker", PeekSnapMarker);
})();
```

The z-index is `2147483640` — deliberately below the overlay (`…646`) and viewer (`…645`) so marking chrome never covers the capture UI, and above capture dots (`…630`).

- [ ] **Step 2: Register the file in `peeksnap/manifest.json`**

Replace the `js` array of `content_scripts[0]` with:

```json
    "js": [
      "content/overlay.js",
      "content/sidebar.js",
      "content/marker.js",
      "content/content_script.js"
    ],
```

`marker.js` must come before `content_script.js` — the orchestration layer instantiates the tag, so the definition must already exist.

- [ ] **Step 3: Mount it in `peeksnap/content/content_script.js`**

Immediately after the existing `document.body.appendChild(sidebar);` line (currently line 20), insert:

```js

  // ── Mount Marker ────────────────────────────────────────────────────────────

  const marker = document.createElement("peeksnap-marker");
  marker.dataset.peeksnap = "1";
  document.body.appendChild(marker);
```

- [ ] **Step 4: Verify the element mounts and the page is untouched**

Build (Cmd+R), reload any article page (use `https://en.wikipedia.org/wiki/Cartography`), then in the page console:

```js
document.querySelector('peeksnap-marker')  // → <peeksnap-marker data-peeksnap="1">
getComputedStyle(document.querySelector('peeksnap-marker')).pointerEvents  // → "none"
```

Then confirm by hand, all four:
- Clicking a link on the page navigates normally.
- Selecting text with the mouse works normally.
- Scrolling works normally.
- The console has zero `[PeekSnap]` errors and zero uncaught exceptions.

If pointer events are being swallowed, the element is stealing input and the rest of the plan will build on a broken base. Do not proceed until this passes.

- [ ] **Step 5: Commit**

```bash
git add peeksnap/content/marker.js peeksnap/manifest.json peeksnap/content/content_script.js
git commit -m "feat(marker): scaffold inert marker element with DPR-scaled canvas"
```

---

### Task 2: Brush tool

**Files:**
- Modify: `peeksnap/content/marker.js`

**Interfaces:**
- Consumes: `_marks`, `_tool`, `_color`, `_canvas`, `_renderStrokes()`, `STROKE_WIDTH` from Task 1.
- Produces: `setTool(tool)`, `setColor(hex)`, and stroke marks shaped `{ type: 'stroke', points: [{x, y}], color, width }`. Task 4 relies on this shape; Task 5 calls `setTool` and `setColor`.

- [ ] **Step 1: Add pointer handler bindings to the constructor**

In `constructor()`, immediately after `this._onResize = this._onResize.bind(this);`, add:

```js
      this._onPointerDown = this._onPointerDown.bind(this);
      this._onPointerMove = this._onPointerMove.bind(this);
      this._onPointerUp = this._onPointerUp.bind(this);
```

- [ ] **Step 2: Attach and detach the listeners**

In `connectedCallback()`, after `window.addEventListener("resize", this._onResize);`, add:

```js
      this._canvas.addEventListener("pointerdown", this._onPointerDown);
      this._canvas.addEventListener("pointermove", this._onPointerMove);
      this._canvas.addEventListener("pointerup", this._onPointerUp);
      this._canvas.addEventListener("pointercancel", this._onPointerUp);
```

In `disconnectedCallback()`, after the resize removal, add:

```js
      this._canvas.removeEventListener("pointerdown", this._onPointerDown);
      this._canvas.removeEventListener("pointermove", this._onPointerMove);
      this._canvas.removeEventListener("pointerup", this._onPointerUp);
      this._canvas.removeEventListener("pointercancel", this._onPointerUp);
```

- [ ] **Step 3: Add the public API and brush handlers**

Insert this block immediately before the `// ── Canvas ──` divider in the class:

```js
    // ── Public API ────────────────────────────────────────────────────────────

    setTool(tool) {
      const next = tool === "brush" || tool === "highlighter" ? tool : null;
      this._tool = next;

      const brushActive = next === "brush";
      this._canvas.classList.toggle("active", brushActive);
      this.style.pointerEvents = brushActive ? "auto" : "none";
    }

    setColor(hex) {
      if (typeof hex === "string" && hex) this._color = hex;
    }

    // ── Brush ─────────────────────────────────────────────────────────────────

    _onPointerDown(e) {
      if (this._tool !== "brush") return;
      e.preventDefault();

      this._drawing = true;
      this._current = {
        type: "stroke",
        points: [{ x: e.clientX, y: e.clientY }],
        color: this._color,
        width: STROKE_WIDTH,
      };
      this._marks.push(this._current);

      this._canvas.setPointerCapture(e.pointerId);
      this._renderStrokes();
    }

    _onPointerMove(e) {
      if (!this._drawing || !this._current) return;
      this._current.points.push({ x: e.clientX, y: e.clientY });
      this._renderStrokes();
    }

    _onPointerUp() {
      if (!this._drawing) return;
      this._drawing = false;
      this._current = null;
      this._renderStrokes();
    }
```

`clientX`/`clientY` are viewport coordinates, which is exactly the space the fixed canvas draws in — no scroll offset is added anywhere, by design.

- [ ] **Step 4: Verify drawing, DPR sharpness, and resize retention**

Build, reload the Wikipedia page, then in the console:

```js
const m = document.querySelector('peeksnap-marker');
m.setTool('brush');
```

Confirm, in order:
1. The cursor over the page is a crosshair.
2. Dragging draws a yellow stroke that follows the pointer smoothly.
3. A single click without dragging leaves a small round dot.
4. **Resize the Safari window.** The strokes must still be there and correctly positioned. If they vanish, `_renderStrokes()` is not being called from `_onResize` — this is the retained-mode requirement and it is the whole reason for the `_marks` array.
5. Zoom the Web Inspector into a stroke edge, or view on a Retina display: the stroke edge is crisp, not soft. Softness means the DPR scaling in `_resizeCanvas()` is wrong.
6. Now run `m.setTool(null);` — the strokes stay visible, but clicking links and selecting text work normally again.

- [ ] **Step 5: Commit**

```bash
git add peeksnap/content/marker.js
git commit -m "feat(marker): add freehand brush tool with retained-mode rendering"
```

---

### Task 3: Highlighter tool

**Files:**
- Modify: `peeksnap/content/marker.js`

**Interfaces:**
- Consumes: `_marks`, `_tool`, `_color` from Tasks 1–2.
- Produces: `canHighlight` (read-only boolean getter), `_renderHighlights()`, and highlight marks shaped `{ type: 'highlight', ranges: [Range], color }`. Task 4 relies on this shape and calls `_renderHighlights()`. Task 5 reads `canHighlight`.

- [ ] **Step 1: Add module constants and helpers**

After `const STROKE_WIDTH = 3;`, add:

```js
  const HIGHLIGHT_ALPHA = 0.35;
  const HIGHLIGHT_PREFIX = "peeksnap-mark";

  /**
   * Highlighting requires BOTH the CSS Custom Highlight API (Safari 17.2+)
   * and a document that can actually produce a text selection. Safari's PDF
   * plugin is not an inspectable document — getSelection() returns nothing
   * usable from it — and image documents have no text at all.
   */
  function supportsHighlight() {
    if (typeof window.CSS === "undefined" || !window.CSS.highlights) return false;
    if (typeof window.Highlight === "undefined") return false;

    const type = (document.contentType || "").toLowerCase();
    if (type === "application/pdf") return false;
    if (type.startsWith("image/")) return false;

    return true;
  }

  function hexToRgba(hex, alpha) {
    const clean = hex.replace("#", "");
    const full = clean.length === 3
      ? clean.split("").map((c) => c + c).join("")
      : clean;
    const num = parseInt(full, 16);
    if (Number.isNaN(num)) return `rgba(253, 224, 71, ${alpha})`;
    const r = (num >> 16) & 255;
    const g = (num >> 8) & 255;
    const b = num & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }
```

`window.CSS` and `window.Highlight` are written explicitly rather than bare — a defensive habit given how close this file came to shadowing `CSS`.

- [ ] **Step 2: Initialize highlighter state in the constructor**

In `constructor()`, after `this._current = null;`, add:

```js
      this._canHighlight = supportsHighlight();
      this._highlightNames = [];
      this._styleEl = null;
```

And after the existing pointer bindings, add:

```js
      this._onDocMouseUp = this._onDocMouseUp.bind(this);
```

- [ ] **Step 3: Attach and detach the selection listener**

In `connectedCallback()`, after the pointer listeners, add:

```js
      document.addEventListener("mouseup", this._onDocMouseUp);
```

In `disconnectedCallback()`, add:

```js
      document.removeEventListener("mouseup", this._onDocMouseUp);
      this._clearHighlightRegistry();
      if (this._styleEl) this._styleEl.remove();
```

The listener is on `document`, not the canvas, because during highlighting the marker is `pointer-events: none` — selection events go to the page and never reach our element.

- [ ] **Step 4: Add the `canHighlight` getter**

Insert immediately after `setColor(hex)` in the Public API section:

```js
    get canHighlight() {
      return this._canHighlight;
    }
```

- [ ] **Step 5: Guard `setTool` against an unavailable highlighter**

Replace the first line of the `setTool` body with:

```js
      if (tool === "highlighter" && !this._canHighlight) return;
      const next = tool === "brush" || tool === "highlighter" ? tool : null;
```

- [ ] **Step 6: Add the highlighter section**

Insert this block immediately after the `// ── Brush ──` section's `_onPointerUp()` method:

```js
    // ── Highlighter ───────────────────────────────────────────────────────────

    _onDocMouseUp() {
      if (this._tool !== "highlighter") return;

      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;

      const ranges = [];
      for (let i = 0; i < sel.rangeCount; i++) {
        ranges.push(sel.getRangeAt(i).cloneRange());
      }
      if (!ranges.length) return;

      this._marks.push({ type: "highlight", ranges, color: this._color });
      sel.removeAllRanges();
      this._renderHighlights();
    }

    _ensureHostStyle() {
      if (this._styleEl && this._styleEl.isConnected) return;
      this._styleEl = document.createElement("style");
      this._styleEl.dataset.peeksnap = "1";
      (document.head || document.documentElement).appendChild(this._styleEl);
    }

    _clearHighlightRegistry() {
      for (const name of this._highlightNames) {
        window.CSS.highlights.delete(name);
      }
      this._highlightNames = [];
    }

    /**
     * Rebuilds the whole highlight registry from _marks. Rebuilding rather
     * than incrementally patching keeps undo trivial: drop a mark, re-render.
     */
    _renderHighlights() {
      if (!this._canHighlight) return;

      this._clearHighlightRegistry();

      const byColor = new Map();
      for (const mark of this._marks) {
        if (mark.type !== "highlight") continue;
        if (!byColor.has(mark.color)) byColor.set(mark.color, []);
        byColor.get(mark.color).push(...mark.ranges);
      }

      if (!byColor.size) {
        if (this._styleEl) this._styleEl.textContent = "";
        return;
      }

      this._ensureHostStyle();

      const rules = [];
      let i = 0;
      for (const [color, ranges] of byColor) {
        const name = `${HIGHLIGHT_PREFIX}-${i++}`;
        window.CSS.highlights.set(name, new window.Highlight(...ranges));
        this._highlightNames.push(name);
        rules.push(
          `::highlight(${name}) { background-color: ${hexToRgba(color, HIGHLIGHT_ALPHA)}; }`
        );
      }
      this._styleEl.textContent = rules.join("\n");
    }
```

Two things that will look wrong but are correct:

- The `<style>` goes into the **host document**, not the shadow root. The highlight registry is per-document and `::highlight()` rules cannot be reached from inside a shadow tree. This is the feature's only host-DOM mutation.
- That `<style>` carries `data-peeksnap="1"`, so `content_script.js`'s MutationObserver will relocate it from `<head>` to the end of `<body>` on the next foreign insertion. **That is fine** — a `<style>` element is valid and fully active in `<body>`. Do not "fix" it by removing the attribute; without it, the observer treats the element as foreign and retriggers its re-append pass.

- [ ] **Step 7: Verify highlighting on a text page**

Build, reload `https://en.wikipedia.org/wiki/Cartography`, then:

```js
const m = document.querySelector('peeksnap-marker');
m.canHighlight;      // → true
m.setTool('highlighter');
```

Confirm:
1. Select a sentence with the mouse and release — it turns translucent yellow and the blue selection disappears.
2. The page layout does not shift by a single pixel. Compare against a highlighted paragraph's neighbors. A shift means DOM was mutated, which must not happen.
3. `document.querySelectorAll('style[data-peeksnap]').length` → `1`.
4. Highlight a second, separate sentence — both stay highlighted.
5. **Scroll away and back** — highlights are still on the correct text (they follow content, unlike strokes).
6. `m.setTool(null)` then select text — no new highlight is created.

- [ ] **Step 8: Verify the highlighter correctly self-disables on a PDF**

Open any PDF URL in Safari (for example `https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf`), then:

```js
const m = document.querySelector('peeksnap-marker');
m.canHighlight;         // → false
m.setTool('highlighter');
m.setTool('brush');     // brush must still work — drag to confirm a stroke appears
```

`setTool('highlighter')` must be a silent no-op with no thrown error. The brush must be unaffected. This is the scanned-PDF case the feature exists for.

- [ ] **Step 9: Commit**

```bash
git add peeksnap/content/marker.js
git commit -m "feat(marker): add highlighter via CSS Custom Highlight API"
```

---

### Task 4: Undo and clear

**Files:**
- Modify: `peeksnap/content/marker.js`

**Interfaces:**
- Consumes: `_marks`, `_renderStrokes()`, `_renderHighlights()`, `_clearHighlightRegistry()`, `_styleEl`.
- Produces: `undo()` and `clear()`. Task 5 calls both.

- [ ] **Step 1: Add `undo()` and `clear()`**

Insert into the Public API section, immediately after the `canHighlight` getter:

```js
    /**
     * Removes the most recent mark of either type. Both renderers run because
     * a single stack interleaves strokes and highlights — the popped mark's
     * type is not worth branching on, and a full re-render is cheap.
     */
    undo() {
      if (!this._marks.length) return;
      this._marks.pop();
      this._renderStrokes();
      this._renderHighlights();
    }

    clear() {
      this._marks = [];
      this._drawing = false;
      this._current = null;
      this._renderStrokes();
      this._clearHighlightRegistry();
      if (this._styleEl) this._styleEl.textContent = "";
    }
```

- [ ] **Step 2: Verify undo interleaves correctly across both tools**

Build, reload the Wikipedia page. In the console, build a mixed stack by hand:

```js
const m = document.querySelector('peeksnap-marker');
m.setTool('brush');    // drag a stroke on screen
m.setTool('highlighter');  // select and release over a sentence
m.setTool('brush');    // drag a second stroke
m._marks.length;       // → 3, in creation order: stroke, highlight, stroke
```

Now call `m.undo()` three times, checking after each:
1. First call removes the **second stroke** — the highlight and first stroke remain.
2. Second call removes the **highlight** — the first stroke remains.
3. Third call removes the first stroke — the page is clean.
4. A fourth `m.undo()` does nothing and throws nothing.

This ordering is the entire point of the single shared stack. If undo removes all strokes before any highlight, the stack has been split somewhere and must be fixed.

- [ ] **Step 3: Verify clear**

```js
m.setTool('brush');        // draw two strokes
m.setTool('highlighter');  // highlight one sentence
m.clear();
m._marks.length;                                  // → 0
window.CSS.highlights.size;                       // → 0
document.querySelector('style[data-peeksnap]').textContent;  // → ""
```

The canvas is blank and no text is highlighted.

- [ ] **Step 4: Commit**

```bash
git add peeksnap/content/marker.js
git commit -m "feat(marker): add cross-tool undo and clear"
```

---

### Task 5: Sidebar tool row

The sidebar gains buttons and emits events. It learns nothing about marking.

**Files:**
- Modify: `peeksnap/content/sidebar.js` — the `CSS` constant (before its closing backtick at line 234), `_buildDOM()` (line 246), and the class body

**Interfaces:**
- Consumes: nothing from the marker.
- Produces: three `composed: true` events — `peeksnap:tool-change` with `detail: { tool }`, `peeksnap:clear-marks`, `peeksnap:mark-color` with `detail: { color }` — plus two methods, `setActiveTool(tool)` and `setHighlighterEnabled(enabled)`. Task 6 wires all of these.

Note: the spec named two events; a third, `peeksnap:mark-color`, is added here so the sidebar can report palette cycling without knowing what a mark is. `setActiveTool` exists so Escape (Task 6) can visually deselect a tool without the sidebar re-emitting a change event and causing a feedback loop.

- [ ] **Step 1: Add tool row styles**

Append to the `CSS` template literal in `sidebar.js`, immediately before its closing backtick (currently line 234, after the `#preview-popup.visible` rule):

```css
    /* ── Tool row (marking) ── */
    #tool-row {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 14px;
      border-bottom: 1px solid #313244;
      flex-shrink: 0;
    }

    .tool-btn {
      background: none;
      border: 1px solid #45475a;
      color: #a6adc8;
      border-radius: 6px;
      cursor: pointer;
      font-size: 13px;
      line-height: 1;
      width: 30px;
      height: 26px;
      padding: 0;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .tool-btn:hover:not(:disabled) { border-color: #6366f1; color: #cdd6f4; }
    .tool-btn.active {
      background: #6366f1;
      border-color: #6366f1;
      color: #fff;
    }
    .tool-btn:disabled { opacity: 0.35; cursor: not-allowed; }

    #mark-color-dot {
      width: 18px;
      height: 18px;
      border-radius: 50%;
      border: 2px solid #45475a;
      padding: 0;
      cursor: pointer;
      margin-left: 2px;
    }

    #clear-marks-btn {
      margin-left: auto;
      background: none;
      border: 1px solid #45475a;
      color: #6c7086;
      border-radius: 4px;
      font-size: 9px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 4px 6px;
      cursor: pointer;
    }
    #clear-marks-btn:hover { color: #f38ba8; border-color: #f38ba8; }
```

- [ ] **Step 2: Initialize tool state in the constructor**

In `PeekSnapSidebar`'s `constructor()`, after `this._snippets = [];` (line 241), add:

```js
      this._activeTool = null;
      this._tagColors = ["#fde047", "#22d3ee", "#f0abfc"];
      this._colorIndex = 0;
```

- [ ] **Step 3: Build the tool row**

In `_buildDOM()`, replace this existing pair of lines (currently lines 291–292):

```js
      this._panel.appendChild(header);
      this._panel.appendChild(this._list);
```

with:

```js
      this._panel.appendChild(header);
      this._panel.appendChild(this._buildToolRow());
      this._panel.appendChild(this._list);
```

Then add this method to the class, immediately after `_buildDOM()`:

```js
    // ── Tool Row (marking) ────────────────────────────────────────────────────

    _buildToolRow() {
      const row = document.createElement("div");
      row.id = "tool-row";

      this._highlighterBtn = document.createElement("button");
      this._highlighterBtn.className = "tool-btn";
      this._highlighterBtn.textContent = "🖍";
      this._highlighterBtn.title = "Highlight text";
      this._highlighterBtn.addEventListener("click", () => this._onToolClick("highlighter"));

      this._brushBtn = document.createElement("button");
      this._brushBtn.className = "tool-btn";
      this._brushBtn.textContent = "🖌";
      this._brushBtn.title = "Draw freehand";
      this._brushBtn.addEventListener("click", () => this._onToolClick("brush"));

      this._markColorDot = document.createElement("button");
      this._markColorDot.id = "mark-color-dot";
      this._markColorDot.title = "Cycle mark color";
      this._markColorDot.style.background = this._tagColors[0];
      this._markColorDot.addEventListener("click", () => this._onMarkColorClick());

      this._clearMarksBtn = document.createElement("button");
      this._clearMarksBtn.id = "clear-marks-btn";
      this._clearMarksBtn.textContent = "Clear marks";
      this._clearMarksBtn.addEventListener("click", () => {
        this.dispatchEvent(new CustomEvent("peeksnap:clear-marks", {
          bubbles: true,
          composed: true,
        }));
      });

      row.appendChild(this._highlighterBtn);
      row.appendChild(this._brushBtn);
      row.appendChild(this._markColorDot);
      row.appendChild(this._clearMarksBtn);

      this._initMarkColors();
      return row;
    }

    _onToolClick(tool) {
      const next = this._activeTool === tool ? null : tool;
      this.setActiveTool(next);
      this.dispatchEvent(new CustomEvent("peeksnap:tool-change", {
        detail: { tool: next },
        bubbles: true,
        composed: true,
      }));
    }

    _onMarkColorClick() {
      if (!this._tagColors.length) return;
      this._colorIndex = (this._colorIndex + 1) % this._tagColors.length;
      const color = this._tagColors[this._colorIndex];
      this._markColorDot.style.background = color;
      this.dispatchEvent(new CustomEvent("peeksnap:mark-color", {
        detail: { color },
        bubbles: true,
        composed: true,
      }));
    }

    /** Reads the shared tag palette. Read-only — never writes settings. */
    async _initMarkColors() {
      try {
        const data = await browser.storage.local.get("peeksnap_settings");
        const settings = data["peeksnap_settings"] || {};
        if (Array.isArray(settings.tagColors) && settings.tagColors.length) {
          this._tagColors = settings.tagColors;
        }
        if (settings.lastUsedColor) {
          const idx = this._tagColors.indexOf(settings.lastUsedColor);
          this._colorIndex = idx >= 0 ? idx : 0;
        }
      } catch (_) {
        // Defaults already set in the constructor
      }
      this._markColorDot.style.background = this._tagColors[this._colorIndex];
      this.dispatchEvent(new CustomEvent("peeksnap:mark-color", {
        detail: { color: this._tagColors[this._colorIndex] },
        bubbles: true,
        composed: true,
      }));
    }
```

`composed: true` on all three events is mandatory. Without it they cannot cross the closed shadow boundary and `content_script.js` will never hear them — the same requirement the existing `peeksnap:captured` event has.

- [ ] **Step 4: Add the two public methods**

Add to the Public API section, after `updateBadge(count)` (line 362):

```js
    /** Sets button state WITHOUT emitting — for external deselection (Escape). */
    setActiveTool(tool) {
      this._activeTool = tool;
      this._highlighterBtn.classList.toggle("active", tool === "highlighter");
      this._brushBtn.classList.toggle("active", tool === "brush");
    }

    setHighlighterEnabled(enabled) {
      this._highlighterBtn.disabled = !enabled;
      this._highlighterBtn.title = enabled
        ? "Highlight text"
        : "Highlighting needs selectable text — unavailable on this page";
    }
```

- [ ] **Step 5: Update the file's header docblock**

Replace the `Public API:` block at the top of `sidebar.js` (lines 8–11) with:

```
 * Public API:
 *   sidebar.render(snippets)            — full re-render from array
 *   sidebar.addSnippet(snippet)         — prepend a new item
 *   sidebar.updateBadge(count)          — refresh the badge
 *   sidebar.setActiveTool(tool)         — set tool button state without emitting
 *   sidebar.setHighlighterEnabled(bool) — enable/disable the highlighter button
 *
 * Emits (all composed: true, so they escape the closed shadow root):
 *   peeksnap:tool-change  detail { tool }   — 'highlighter' | 'brush' | null
 *   peeksnap:mark-color   detail { color }  — hex
 *   peeksnap:clear-marks
```

- [ ] **Step 6: Verify the row renders and emits**

Build, reload the Wikipedia page, click the sidebar tab to expand it. Confirm the tool row appears below the header with two tool buttons, a color dot, and "Clear marks", and that the snippet list below is unchanged.

Then, in the page console — note this listens on `document`, which only works because the events are `composed`:

```js
document.addEventListener('peeksnap:tool-change', (e) => console.log('tool', e.detail));
document.addEventListener('peeksnap:mark-color', (e) => console.log('color', e.detail));
document.addEventListener('peeksnap:clear-marks', () => console.log('clear'));
```

Confirm:
1. Clicking the brush button logs `tool {tool: "brush"}` and the button turns indigo.
2. Clicking the brush button **again** logs `tool {tool: null}` and it deactivates (toggle behavior).
3. Clicking the highlighter while the brush is active switches — only one is indigo at a time.
4. Clicking the color dot logs a new hex each time and the dot's color changes, cycling back to the first after the last.
5. Clicking "Clear marks" logs `clear`.

If nothing logs, the events are not `composed: true`.

- [ ] **Step 7: Commit**

```bash
git add peeksnap/content/sidebar.js
git commit -m "feat(sidebar): add marking tool row emitting composed events"
```

---

### Task 6: Wire the sidebar to the marker

**Files:**
- Modify: `peeksnap/content/content_script.js` — the marker mount block from Task 1

**Interfaces:**
- Consumes: `marker.setTool/setColor/undo/clear/canHighlight` (Tasks 2–4) and `sidebar.setActiveTool/setHighlighterEnabled` plus the three events (Task 5).
- Produces: the finished feature. Nothing depends on this task.

- [ ] **Step 1: Replace the marker mount block with the full wiring**

Replace the three-line mount block added in Task 1 with:

```js
  // ── Mount Marker ────────────────────────────────────────────────────────────

  const marker = document.createElement("peeksnap-marker");
  marker.dataset.peeksnap = "1";
  document.body.appendChild(marker);

  // The sidebar owns the buttons but knows nothing about why highlighting may
  // be unavailable, so the orchestration layer relays it.
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

  // ── Marking Keyboard Shortcuts ──────────────────────────────────────────────
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
      e.preventDefault();
      marker.undo();
    }
  });
```

The `if (!activeTool) return;` guard is the important line. Without it, PeekSnap would swallow Cmd+Z on every page in the browser, breaking undo in every comment box and text field the user touches.

- [ ] **Step 2: Update the file's header docblock**

In the `Responsibilities:` list at the top of `content_script.js`, add a fifth entry after line 9:

```
 *   5. Mount the marker and relay sidebar tool events to it
```

- [ ] **Step 3: Verify the full flow end to end**

Build, reload the Wikipedia page, expand the sidebar.

1. Click the brush button → drag on the page → a stroke appears in the color shown on the dot.
2. Press **Cmd+Z** → the stroke disappears.
3. Click the color dot to change color → draw again → the new stroke uses the new color, and any earlier stroke keeps its original color.
4. Click the highlighter → select a sentence → it highlights.
5. Press **Cmd+Z** → the highlight disappears.
6. Press **Escape** → both tool buttons deactivate, and clicking page links works again.
7. With no tool active, click into any text input on a page and press Cmd+Z — the **page's** undo works, not ours. (Test on `https://en.wikipedia.org/w/index.php?search=` — type text in the search box, then Cmd+Z.)
8. Click "Clear marks" with several marks of both types on screen → all vanish.

- [ ] **Step 4: Verify on a PDF**

Open a PDF URL, expand the sidebar. The highlighter button is greyed and unclickable; hovering shows "Highlighting needs selectable text — unavailable on this page". The brush works and draws.

- [ ] **Step 5: Verify on an ad-heavy page**

Load a news site with ads. Expand the sidebar, activate the brush, draw. The stroke must be visible above page content. Known and accepted limitation: content in the CSS top layer (`<dialog showModal()>`, popover API) will still cover it.

- [ ] **Step 6: Commit**

```bash
git add peeksnap/content/content_script.js
git commit -m "feat(marker): wire sidebar tool row to marker and add shortcuts"
```

---

### Task 7: Capture interop and journal

Confirms the payoff — marks baking into snaps — and records the session.

**Files:**
- Modify: `JOURNAL.md`

**Interfaces:**
- Consumes: everything above. Produces: nothing.

- [ ] **Step 1: Verify marks bake into a capture**

Build, reload the Wikipedia page. Then:

1. Activate the brush and draw a distinctive shape (a circle around a paragraph).
2. Activate the highlighter and highlight a sentence inside that circle.
3. Press **Escape** to deactivate, so the tool does not interfere with selection.
4. Click the PeekSnap toolbar icon to start a capture, and drag a region covering both marks.
5. Save the snap.
6. Hover the new item in the sidebar to preview it, then click to open the viewer.

**Expected:** both the stroke and the highlight are present in the captured image, and the stroke edges are crisp rather than soft. Softness here — even though the stroke looked fine on screen — means the DPR scaling in `_resizeCanvas()` is wrong; captures resolve at device pixels and will expose it.

Also confirm the capture overlay draws **above** the marks while selecting (the marker sits at z-index `2147483640`, below the overlay's `…646`).

- [ ] **Step 2: Verify marks do not survive a reload**

Reload the page. The sidebar still lists the saved snap, and the page has no marks on it. This is the intended session-only behavior, not a bug.

- [ ] **Step 3: Append the session entry to `JOURNAL.md`**

```markdown

---

## Session 3 — On-Page Marking
**Date:** 2026-08-12

**Features added this session:**
- **Highlighter tool**: drag-select text on a page, release, and the selection is painted in the active tag color at 35% alpha
- **Brush tool**: freehand drawing on a viewport-fixed canvas, fixed 3px stroke width
- **Tool row** in the sidebar panel: highlighter, brush, cycling color dot, "Clear marks"
- **Undo** (Cmd/Ctrl+Z) across both tools from one shared stack; **Escape** deactivates the active tool
- Marks are **captured** — a snap taken over a mark bakes it into the PNG

**Architecture decisions:**
- New `content/marker.js` defines `<peeksnap-marker>`, registered in the manifest *before* `content_script.js`
- Highlights use the **CSS Custom Highlight API** rather than wrapping ranges in spans — zero host-DOM mutation, so page layout and page scripts are untouched, and undo needs no cleanup. Requires Safari 17.2+; the tool self-disables below that and on PDF/image documents where `getSelection()` yields nothing
- The `::highlight()` rules must live in a host-document `<style>` (the highlight registry is per-document and unreachable from a shadow tree). It carries `data-peeksnap="1"`, so the ad-defense observer relocates it into `<body>` — harmless, a `<style>` is active anywhere
- The stroke canvas is **retained-mode**: it repaints from the mark stack on undo, clear, and resize. A resize blanks the backing store, so immediate-mode drawing would silently lose every stroke
- The canvas is DPR-scaled (`w*dpr × h*dpr` + `ctx.scale`). Note `overlay.js` does *not* do this — its canvas is only a dim mask, where softness is invisible
- Strokes are **viewport-fixed** and do not follow scroll, sidestepping the PDF limitation where `window.scrollY` is permanently 0
- Marking keyboard shortcuts are active only while a tool is selected, so the page keeps its own Cmd+Z
- The marker's `_marks` array is one stack for both mark types — this is what makes undo interleave correctly across tools

**Storage:** no changes. Marks are session-only; nothing is persisted and no schema changed. The tag palette is read from `peeksnap_settings` but never written.

**Known limitations:**
- Marks do not survive a reload (by design)
- No eraser; undo and clear-all only
- Inherits the existing CSS top-layer gap — `<dialog>`/popover ads still cover PeekSnap UI
```

- [ ] **Step 4: Commit**

```bash
git add JOURNAL.md
git commit -m "docs: add session 3 journal entry for on-page marking"
```

---

## Self-Review Notes

Checked against `docs/superpowers/specs/2026-08-12-on-page-marking-design.md`:

| Spec requirement | Task |
|---|---|
| Highlighter, 35% alpha, tag color | 3 |
| Brush, opaque, fixed 3px | 2 |
| Highlighter disabled on PDF/image/unsupported | 3 (impl), 5 (button state), 6 (relay) |
| Shared mark stack, cross-tool undo | 4 |
| Clear marks | 4 (impl), 5 (button), 6 (wiring) |
| Marks bake into captures | 7 |
| Viewport-fixed strokes, DPR-scaled, retained-mode | 1, 2 |
| CSS Custom Highlight API, host `<style>`, zero DOM mutation | 3 |
| Pointer-event discipline table | 1, 2 |
| `marker` API: setTool/setColor/undo/clear/canHighlight | 2, 3, 4 |
| `sidebar.setHighlighterEnabled` | 5 |
| Sidebar tool row, color cycling from palette | 5 |
| Keyboard: Cmd/Ctrl+Z, Escape, only while tool active | 6 |
| `data-peeksnap="1"` on all injected elements | 1, 3 |
| Manifest load order | 1 |
| Verification matrix (article, PDF, image, ad-heavy) | 2, 3, 6, 7 |
| JOURNAL entry | 7 |

**Deviations from the spec, deliberate:**

1. **A third event, `peeksnap:mark-color`.** The spec named two. Cycling the color needs to reach the marker, and routing it through the sidebar's existing event pattern keeps the sidebar ignorant of marking. Documented in Task 5.
2. **`sidebar.setActiveTool(tool)` added.** Escape must visually deselect the tool without the sidebar re-emitting a change event and looping. Documented in Task 5.
3. **The spec said the canvas is DPR-scaled "matching `overlay.js`" — it is not.** `overlay.js:256` sets `canvas.width = window.innerWidth` with no DPR factor. Its canvas is only a dim mask, so softness is invisible there. DPR scaling is new work in Task 1, not a copied pattern.
4. **No automated tests.** The spec sets verification as manual in Safari and this project has no test infrastructure. Every task ends with an explicit manual verification step instead, with exact actions and expected results; a failed verification blocks the commit exactly as a failing test would.
