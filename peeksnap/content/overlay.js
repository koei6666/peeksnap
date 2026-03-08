/**
 * overlay.js — SelectionOverlay custom element.
 *
 * Renders a full-viewport darkened canvas over the page. The user clicks and
 * drags to select a rectangular region; a "cutout" shows original content
 * through the selection.
 *
 * A naming bar is always visible at the top of the overlay. After a valid
 * selection (mouseup with rect ≥ 10×10), Save + Retry become enabled.
 *
 * Save dispatches:
 *   CustomEvent("peeksnap:captured", {
 *     detail: { rect, dpr, name, colorTag },
 *     composed: true, bubbles: true
 *   })
 *
 * Escape key cancels and removes the overlay.
 */

(function () {
  if (customElements.get("peeksnap-overlay")) return;

  const DEFAULT_TAG_COLORS = ["#fde047", "#22d3ee", "#f0abfc"];
  const SETTINGS_KEY = "peeksnap_settings";

  function hexToHsl(hex) {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0;
    const l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      switch (max) {
        case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
        case g: h = ((b - r) / d + 2) / 6; break;
        case b: h = ((r - g) / d + 4) / 6; break;
      }
    }
    return [h * 360, s * 100, l * 100];
  }

  function hslToHex(h, s, l) {
    h /= 360; s /= 100; l /= 100;
    const hue2rgb = (p, q, t) => {
      if (t < 0) t += 1;
      if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    let r, g, b;
    if (s === 0) {
      r = g = b = l;
    } else {
      const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
      const p = 2 * l - q;
      r = hue2rgb(p, q, h + 1 / 3);
      g = hue2rgb(p, q, h);
      b = hue2rgb(p, q, h - 1 / 3);
    }
    return "#" + [r, g, b].map((x) => Math.round(x * 255).toString(16).padStart(2, "0")).join("");
  }

  function generateTonalColor(existingColors) {
    const hsls = existingColors.map(hexToHsl);
    const avgS = hsls.reduce((sum, [, s]) => sum + s, 0) / hsls.length;
    const avgL = hsls.reduce((sum, [, , l]) => sum + l, 0) / hsls.length;
    const existingHues = hsls.map(([h]) => h);
    for (let attempt = 0; attempt < 20; attempt++) {
      const h = Math.random() * 360;
      const minDist = Math.min(...existingHues.map((eh) => {
        const d = Math.abs(h - eh);
        return Math.min(d, 360 - d);
      }));
      if (minDist >= 30) {
        const s = Math.max(70, Math.min(100, avgS + (Math.random() * 20 - 10)));
        const l = Math.max(65, Math.min(85, avgL + (Math.random() * 10 - 5)));
        return hslToHex(h, s, l);
      }
    }
    return hslToHex(Math.random() * 360, Math.max(70, avgS), Math.max(65, avgL));
  }

  const CSS = `
    #container {
      position: relative;
      width: 100%;
      height: 100%;
      overflow: hidden;
    }
    canvas {
      display: block;
      width: 100%;
      height: 100%;
    }
    #naming-bar {
      position: absolute;
      top: 16px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(30, 30, 46, 0.92);
      border: 1px solid #45475a;
      border-radius: 12px;
      padding: 10px 18px;
      display: none;
      align-items: center;
      gap: 12px;
      z-index: 10;
      backdrop-filter: blur(6px);
      font-family: system-ui, sans-serif;
      font-size: 13px;
      color: #cdd6f4;
      white-space: nowrap;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5);
    }
    #naming-bar.visible { display: flex; }
    .nt-label { font-size: 11px; color: #a6adc8; font-weight: 600; }
    .color-dot {
      width: 22px; height: 22px;
      border-radius: 50%;
      cursor: pointer;
      border: 2px solid transparent;
      transition: border-color 0.1s, transform 0.1s;
      flex-shrink: 0;
    }
    .color-dot.selected { border-color: #fff; transform: scale(1.15); }
    .color-more {
      background: none; border: none; color: #a6adc8;
      cursor: pointer; font-size: 14px; padding: 0 4px;
    }
    .nt-divider { width: 1px; height: 28px; background: #45475a; flex-shrink: 0; }
    #nt-name-input {
      background: #313244; border: 1px solid #45475a; border-radius: 6px;
      color: #cdd6f4; font-size: 12px; padding: 5px 10px;
      width: 200px; outline: none;
    }
    #nt-name-input:focus { border-color: #6366f1; }
    #nt-save {
      background: #22c55e; color: #fff; border: none; border-radius: 6px;
      padding: 6px 16px; font-size: 12px; font-weight: 600;
      opacity: 0.4; cursor: default;
    }
    #nt-save:not([disabled]) { opacity: 1; cursor: pointer; }
    #nt-save:not([disabled]):hover { background: #16a34a; }
    #nt-retry {
      background: #ef4444; color: #fff; border: none; border-radius: 6px;
      padding: 6px 14px; font-size: 12px; font-weight: 600;
      opacity: 0.4; cursor: default;
    }
    #nt-retry:not([disabled]) { opacity: 1; cursor: pointer; }
    #nt-retry:not([disabled]):hover { background: #dc2626; }

    #color-dropdown {
      position: absolute;
      top: 70px;
      left: 50%;
      transform: translateX(-50%);
      background: rgba(30, 30, 46, 0.96);
      border: 1px solid #45475a;
      border-radius: 10px;
      padding: 12px;
      display: none;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
      z-index: 11;
      backdrop-filter: blur(6px);
      box-shadow: 0 4px 20px rgba(0,0,0,0.5);
      max-width: 240px;
    }
    #color-dropdown.visible { display: flex; }
    .dd-dot {
      width: 28px; height: 28px;
      border-radius: 50%;
      cursor: pointer;
      border: 2px solid transparent;
      transition: border-color 0.1s, transform 0.1s;
      flex-shrink: 0;
    }
    .dd-dot.selected { border-color: #fff; transform: scale(1.1); }
    #dd-custom-btn {
      background: #313244; border: 1px solid #45475a; color: #cdd6f4;
      border-radius: 6px; padding: 4px 10px; font-size: 11px; cursor: pointer;
      white-space: nowrap;
    }
    #dd-custom-btn:hover { background: #45475a; }
  `;

  class SelectionOverlay extends HTMLElement {
    constructor() {
      super();
      this._shadow = this.attachShadow({ mode: "closed" });
      this._dragging = false;
      this._startX = 0;
      this._startY = 0;
      this._curX = 0;
      this._curY = 0;
      this._savedRect = null;
      this._selectedColor = DEFAULT_TAG_COLORS[0];
      this._tagColors = [...DEFAULT_TAG_COLORS];
      this._colorDots = [];
      this._ddDots = [];

      const style = document.createElement("style");
      style.textContent = CSS;
      this._shadow.appendChild(style);

      this._container = document.createElement("div");
      this._container.id = "container";
      this._shadow.appendChild(this._container);

      this._canvas = document.createElement("canvas");
      this._container.appendChild(this._canvas);
      this._ctx = this._canvas.getContext("2d");

      this._onMouseDown = this._onMouseDown.bind(this);
      this._onMouseMove = this._onMouseMove.bind(this);
      this._onMouseUp = this._onMouseUp.bind(this);
      this._onKeyDown = this._onKeyDown.bind(this);
    }

    connectedCallback() {
      this.style.cssText = [
        "position: fixed !important",
        "top: 0",
        "left: 0",
        "width: 100vw",
        "height: 100vh",
        "z-index: 2147483646",
        "cursor: crosshair",
        "pointer-events: all",
      ].join(";");

      this._resizeCanvas();

      this._canvas.addEventListener("mousedown", this._onMouseDown);
      this._canvas.addEventListener("mousemove", this._onMouseMove);
      this._canvas.addEventListener("mouseup", this._onMouseUp);
      window.addEventListener("keydown", this._onKeyDown);

      this._draw();
      this._initNamingBar();
    }

    disconnectedCallback() {
      this._canvas.removeEventListener("mousedown", this._onMouseDown);
      this._canvas.removeEventListener("mousemove", this._onMouseMove);
      this._canvas.removeEventListener("mouseup", this._onMouseUp);
      window.removeEventListener("keydown", this._onKeyDown);
    }

    _resizeCanvas() {
      this._canvas.width = window.innerWidth;
      this._canvas.height = window.innerHeight;
    }

    // ── Naming Bar ─────────────────────────────────────────────────────────────

    async _initNamingBar() {
      try {
        const data = await browser.storage.local.get(SETTINGS_KEY);
        const settings = data[SETTINGS_KEY] || {};
        if (Array.isArray(settings.tagColors) && settings.tagColors.length) {
          this._tagColors = settings.tagColors;
        }
        if (settings.lastUsedColor) {
          this._selectedColor = settings.lastUsedColor;
        } else {
          this._selectedColor = this._tagColors[0];
        }
      } catch (_) {
        // Use defaults if storage unavailable
      }
      this._buildNamingBar();
    }

    _buildNamingBar() {
      this._colorDots = [];

      const bar = document.createElement("div");
      bar.id = "naming-bar";

      // Prevent bar clicks from triggering canvas mousedown
      bar.addEventListener("mousedown", (e) => e.stopPropagation());

      // — Color tag section —
      const colorLabel = document.createElement("span");
      colorLabel.className = "nt-label";
      colorLabel.textContent = "Color Tag";
      bar.appendChild(colorLabel);

      // Show first 3 preset dots
      const visibleColors = this._tagColors.slice(0, 3);
      for (const color of visibleColors) {
        bar.appendChild(this._makeBarDot(color));
      }

      // "▶" more button
      const moreBtn = document.createElement("button");
      moreBtn.className = "color-more";
      moreBtn.textContent = "▶";
      moreBtn.title = "All colors / custom";
      moreBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this._dropdown.classList.toggle("visible");
      });
      bar.appendChild(moreBtn);

      // Divider
      const divider = document.createElement("div");
      divider.className = "nt-divider";
      bar.appendChild(divider);

      // — Name section —
      const nameLabel = document.createElement("span");
      nameLabel.className = "nt-label";
      nameLabel.textContent = "Name";
      bar.appendChild(nameLabel);

      this._nameInput = document.createElement("input");
      this._nameInput.id = "nt-name-input";
      this._nameInput.type = "text";
      this._nameInput.placeholder = "Name";
      this._nameInput.value = (document.title || "").slice(0, 60);
      this._nameInput.addEventListener("mousedown", (e) => e.stopPropagation());
      bar.appendChild(this._nameInput);

      // Save button
      this._saveBtn = document.createElement("button");
      this._saveBtn.id = "nt-save";
      this._saveBtn.textContent = "Save";
      this._saveBtn.disabled = true;
      this._saveBtn.addEventListener("click", () => this._onSave());
      bar.appendChild(this._saveBtn);

      // Retry button
      this._retryBtn = document.createElement("button");
      this._retryBtn.id = "nt-retry";
      this._retryBtn.textContent = "Retry";
      this._retryBtn.disabled = true;
      this._retryBtn.addEventListener("click", () => this._onRetry());
      bar.appendChild(this._retryBtn);

      this._namingBar = bar;
      this._container.appendChild(bar);

      // Build the dropdown (all colors + custom)
      this._buildColorDropdown();

      // Show bar immediately
      bar.classList.add("visible");

      // Sync selected dot highlight
      this._updateDotSelection();
    }

    _makeBarDot(color) {
      const dot = document.createElement("div");
      dot.className = "color-dot";
      dot.style.background = color;
      dot.dataset.color = color;
      dot.addEventListener("click", (e) => {
        e.stopPropagation();
        this._selectColor(color);
        this._dropdown.classList.remove("visible");
      });
      this._colorDots.push(dot);
      return dot;
    }

    _buildColorDropdown() {
      this._ddDots = [];
      const dropdown = document.createElement("div");
      dropdown.id = "color-dropdown";

      dropdown.addEventListener("mousedown", (e) => e.stopPropagation());

      for (const color of this._tagColors) {
        const dot = document.createElement("div");
        dot.className = "dd-dot";
        dot.style.background = color;
        dot.dataset.color = color;
        dot.addEventListener("click", (e) => {
          e.stopPropagation();
          this._selectColor(color);
          dropdown.classList.remove("visible");
        });
        this._ddDots.push(dot);
        dropdown.appendChild(dot);
      }

      // Random color button — generates a tonal color from the current palette
      const randomBtn = document.createElement("button");
      randomBtn.id = "dd-custom-btn";
      randomBtn.textContent = "+ Random";

      randomBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const color = generateTonalColor(this._tagColors);
        this._selectColor(color);
        dropdown.classList.remove("visible");
      });

      dropdown.appendChild(randomBtn);

      this._dropdown = dropdown;
      this._container.appendChild(dropdown);

      // Close dropdown when user starts a new drag
      this._canvas.addEventListener("mousedown", () => {
        dropdown.classList.remove("visible");
      });
    }

    _selectColor(color) {
      this._selectedColor = color;
      this._updateDotSelection();
    }

    _updateDotSelection() {
      for (const dot of this._colorDots) {
        dot.classList.toggle("selected", dot.dataset.color === this._selectedColor);
      }
      for (const dot of this._ddDots) {
        dot.classList.toggle("selected", dot.dataset.color === this._selectedColor);
      }
    }

    // ── Drawing ────────────────────────────────────────────────────────────────

    _selectionRect() {
      const x = Math.min(this._startX, this._curX);
      const y = Math.min(this._startY, this._curY);
      const w = Math.abs(this._curX - this._startX);
      const h = Math.abs(this._curY - this._startY);
      return { x, y, width: w, height: h };
    }

    _draw() {
      const ctx = this._ctx;
      const cw = this._canvas.width;
      const ch = this._canvas.height;

      ctx.clearRect(0, 0, cw, ch);
      ctx.fillStyle = "rgba(0,0,0,0.4)";
      ctx.fillRect(0, 0, cw, ch);

      // Show active drag or frozen saved rect
      const rect = this._dragging ? this._selectionRect() : this._savedRect;
      if (!rect) return;

      const { x, y, width, height } = rect;
      ctx.clearRect(x, y, width, height);
      ctx.strokeStyle = "rgba(255,255,255,0.9)";
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, width, height);

      if (this._dragging && width > 40 && height > 20) {
        ctx.fillStyle = "rgba(255,255,255,0.85)";
        ctx.font = "11px system-ui, sans-serif";
        ctx.fillText(`${Math.round(width)} × ${Math.round(height)}`, x + 4, y + 14);
      }
    }

    // ── Mouse Events ───────────────────────────────────────────────────────────

    _onMouseDown(e) {
      this._dragging = true;
      this._savedRect = null;
      this._startX = e.clientX;
      this._startY = e.clientY;
      this._curX = e.clientX;
      this._curY = e.clientY;
      this._draw();
    }

    _onMouseMove(e) {
      if (!this._dragging) return;
      this._curX = e.clientX;
      this._curY = e.clientY;
      this._draw();
    }

    _onMouseUp(e) {
      if (!this._dragging) return;
      this._dragging = false;

      const rect = this._selectionRect();
      if (rect.width < 10 || rect.height < 10) {
        this._draw();
        return;
      }

      this._savedRect = rect;
      // Freeze canvas — user now interacts with naming bar only
      this._canvas.style.pointerEvents = "none";
      this._saveBtn.disabled = false;
      this._retryBtn.disabled = false;
    }

    // ── Naming Bar Actions ─────────────────────────────────────────────────────

    _onSave() {
      if (!this._savedRect) return;

      const name = this._nameInput.value.trim();
      const colorTag = this._selectedColor;

      // Persist last-used color for next capture
      browser.storage.local.get(SETTINGS_KEY).then((data) => {
        const settings = data[SETTINGS_KEY] || {};
        browser.storage.local.set({
          [SETTINGS_KEY]: { ...settings, lastUsedColor: colorTag },
        });
      });

      const savedRect = this._savedRect;
      this._cleanup();
      this.dispatchEvent(
        new CustomEvent("peeksnap:captured", {
          detail: { rect: savedRect, dpr: window.devicePixelRatio, name, colorTag },
          bubbles: true,
          composed: true,
        })
      );
    }

    _onRetry() {
      // Re-enable canvas for a fresh drag
      this._canvas.style.pointerEvents = "";
      this._startX = this._startY = this._curX = this._curY = 0;
      this._savedRect = null;
      this._saveBtn.disabled = true;
      this._retryBtn.disabled = true;
      if (this._dropdown) this._dropdown.classList.remove("visible");
      this._draw();
    }

    _onKeyDown(e) {
      if (e.key === "Escape") this._cleanup();
    }

    _cleanup() {
      window.removeEventListener("keydown", this._onKeyDown);
      this.remove();
    }
  }

  customElements.define("peeksnap-overlay", SelectionOverlay);
})();
