/**
 * marker.js — PeekSnapMarker custom element.
 *
 * Session-only on-page marks. Two tools:
 *   highlighter — paints text selections via the CSS Custom Highlight API
 *   brush       — freehand strokes anchored to document coordinates
 *
 * Stroke points are stored in DOCUMENT space so drawings stay on the content
 * they were drawn over while scrolling. The canvas stays viewport-sized and
 * fixed, repainting with the scroll offset subtracted, so memory does not
 * scale with page length. On Safari PDF pages scrollX/scrollY are always 0,
 * so this degrades to viewport-fixed with no branching.
 *
 * Marks are never persisted and vanish on reload. They ARE rendered by
 * captureVisibleTab, so a snap taken over a mark bakes it into the PNG.
 *
 * The element tolerates being re-parented by content_script.js's ad-defense
 * MutationObserver, which re-appends every [data-peeksnap] node and thereby
 * triggers disconnectedCallback()+connectedCallback() synchronously. Marks
 * are restored (not lost) in connectedCallback().
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

  const STROKE_WIDTH = 3; // fallback only; the live value is this._width
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
      this._width = STROKE_WIDTH;
      this._drawing = false;
      this._current = null;
      this._canHighlight = supportsHighlight();
      this._highlightNames = [];
      this._styleEl = null;

      const style = document.createElement("style");
      style.textContent = STYLE_TEXT;
      this._shadow.appendChild(style);

      this._canvas = document.createElement("canvas");
      this._shadow.appendChild(this._canvas);
      this._ctx = this._canvas.getContext("2d");

      this._scrollRaf = 0;
      this._onResize = this._onResize.bind(this);
      this._onScroll = this._onScroll.bind(this);
      this._onPointerDown = this._onPointerDown.bind(this);
      this._onPointerMove = this._onPointerMove.bind(this);
      this._onPointerUp = this._onPointerUp.bind(this);
      this._onDocMouseUp = this._onDocMouseUp.bind(this);
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

      this._applyToolState();

      this._resizeCanvas();
      this._renderStrokes();
      this._renderHighlights();
      window.addEventListener("resize", this._onResize);
      window.addEventListener("scroll", this._onScroll, { passive: true });
      this._canvas.addEventListener("pointerdown", this._onPointerDown);
      this._canvas.addEventListener("pointermove", this._onPointerMove);
      this._canvas.addEventListener("pointerup", this._onPointerUp);
      this._canvas.addEventListener("pointercancel", this._onPointerUp);
      document.addEventListener("mouseup", this._onDocMouseUp);
    }

    disconnectedCallback() {
      window.removeEventListener("resize", this._onResize);
      window.removeEventListener("scroll", this._onScroll);
      this._canvas.removeEventListener("pointerdown", this._onPointerDown);
      this._canvas.removeEventListener("pointermove", this._onPointerMove);
      this._canvas.removeEventListener("pointerup", this._onPointerUp);
      this._canvas.removeEventListener("pointercancel", this._onPointerUp);
      document.removeEventListener("mouseup", this._onDocMouseUp);

      // The ad-defense observer re-parents this element by re-appending it,
      // which fires disconnectedCallback() then connectedCallback() in the
      // same task. Defer teardown so a re-parent doesn't wipe live marks.
      Promise.resolve().then(() => {
        if (this.isConnected) return; // re-parented, not torn down
        this._clearHighlightRegistry();
        if (this._styleEl) this._styleEl.remove();
      });
    }

    // ── Public API ────────────────────────────────────────────────────────────

    setTool(tool) {
      if (tool === "highlighter" && !this._canHighlight) return;
      const next = tool === "brush" || tool === "highlighter" ? tool : null;
      this._tool = next;
      this._applyToolState();
    }

    /**
     * Single source of truth for the visual/interactive state that reflects
     * `_tool`. Called from setTool() and from connectedCallback() (the
     * latter because re-parenting replaces `style.cssText` wholesale,
     * resetting pointer-events even though `_tool` hasn't changed).
     */
    _applyToolState() {
      const brushActive = this._tool === "brush";
      this._canvas.classList.toggle("active", brushActive);
      this.style.pointerEvents = brushActive ? "auto" : "none";
    }

    setColor(hex) {
      if (typeof hex === "string" && hex) this._color = hex;
    }

    /**
     * Sets the brush width for SUBSEQUENT strokes. Existing strokes keep the
     * width recorded on them at creation, the same way they keep their color.
     */
    setWidth(px) {
      const n = Number(px);
      if (Number.isFinite(n) && n > 0) this._width = n;
    }

    get canHighlight() {
      return this._canHighlight;
    }

    /**
     * Removes the most recent mark of either type. Both renderers run because
     * a single stack interleaves strokes and highlights — the popped mark's
     * type is not worth branching on, and a full re-render is cheap.
     */
    undo() {
      if (this._drawing) return;
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

    // ── Brush ─────────────────────────────────────────────────────────────────

    _onPointerDown(e) {
      if (this._tool !== "brush") return;
      e.preventDefault();

      this._drawing = true;
      this._current = {
        type: "stroke",
        points: [{ x: e.clientX + window.scrollX, y: e.clientY + window.scrollY }],
        color: this._color,
        width: this._width,
      };
      this._marks.push(this._current);

      this._canvas.setPointerCapture(e.pointerId);
      this._renderStrokes();
    }

    _onPointerMove(e) {
      if (!this._drawing || !this._current) return;
      this._current.points.push({
        x: e.clientX + window.scrollX,
        y: e.clientY + window.scrollY,
      });
      this._renderStrokes();
    }

    _onPointerUp() {
      if (!this._drawing) return;
      this._drawing = false;
      this._current = null;
      this._renderStrokes();
    }

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

    /**
     * Points are stored in DOCUMENT space, so strokes stay anchored to the
     * content they were drawn on. The canvas itself stays viewport-sized and
     * fixed; scrolling repaints with the current scroll offset subtracted.
     * Sizing the canvas to the whole document instead would blow up memory on
     * long pages.
     *
     * On Safari PDF pages scrollX/scrollY are permanently 0, so this degrades
     * to viewport-fixed behavior with no branching — the best available there,
     * since the PDF plugin scrolls internally and reports nothing.
     */
    _renderStrokes() {
      const sx = window.scrollX;
      const sy = window.scrollY;

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
          this._ctx.arc(p.x - sx, p.y - sy, mark.width / 2, 0, Math.PI * 2);
          this._ctx.fill();
          continue;
        }

        this._ctx.beginPath();
        this._ctx.moveTo(mark.points[0].x - sx, mark.points[0].y - sy);
        for (let i = 1; i < mark.points.length; i++) {
          this._ctx.lineTo(mark.points[i].x - sx, mark.points[i].y - sy);
        }
        this._ctx.stroke();
      }
    }

    _onScroll() {
      if (this._scrollRaf) return;
      this._scrollRaf = requestAnimationFrame(() => {
        this._scrollRaf = 0;
        this._renderStrokes();
      });
    }
  }

  customElements.define("peeksnap-marker", PeekSnapMarker);
})();
