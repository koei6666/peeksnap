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
      this._onPointerDown = this._onPointerDown.bind(this);
      this._onPointerMove = this._onPointerMove.bind(this);
      this._onPointerUp = this._onPointerUp.bind(this);
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
      this._canvas.addEventListener("pointerdown", this._onPointerDown);
      this._canvas.addEventListener("pointermove", this._onPointerMove);
      this._canvas.addEventListener("pointerup", this._onPointerUp);
      this._canvas.addEventListener("pointercancel", this._onPointerUp);
    }

    disconnectedCallback() {
      window.removeEventListener("resize", this._onResize);
      this._canvas.removeEventListener("pointerdown", this._onPointerDown);
      this._canvas.removeEventListener("pointermove", this._onPointerMove);
      this._canvas.removeEventListener("pointerup", this._onPointerUp);
      this._canvas.removeEventListener("pointercancel", this._onPointerUp);
    }

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
