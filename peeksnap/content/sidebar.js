/**
 * sidebar.js — PeekSnap Sidebar custom element.
 *
 * A docked panel on the right edge of the viewport. States:
 *   Collapsed: 28px wide tab handle with label + badge count
 *   Expanded:  260px panel sliding in from the right
 *
 * Public API:
 *   sidebar.render(snippets)    — full re-render from array
 *   sidebar.addSnippet(snippet) — prepend a new item
 *   sidebar.updateBadge(count)  — refresh the badge
 */

(function () {
  if (customElements.get("peeksnap-sidebar")) return;

  const CSS = `
    :host {
      all: initial;
      position: fixed !important;
      right: 0;
      top: 0;
      height: 100vh;
      z-index: 2147483647;
      isolation: isolate;
      pointer-events: none;
      font-family: system-ui, -apple-system, sans-serif;
    }

    /* ── Tab handle (always visible) ── */
    #tab {
      position: absolute;
      right: 0;
      top: 50%;
      transform: translateY(-50%);
      width: 28px;
      background: #6366f1;
      color: #fff;
      border-radius: 6px 0 0 6px;
      padding: 12px 4px;
      cursor: pointer;
      pointer-events: all;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 6px;
      box-shadow: -2px 0 8px rgba(0,0,0,0.2);
      transition: background 0.15s;
      user-select: none;
      z-index: 1;
    }
    #tab:hover { background: #4f46e5; }

    #tab-label {
      writing-mode: vertical-rl;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }

    #badge {
      background: #fff;
      color: #6366f1;
      border-radius: 9999px;
      font-size: 9px;
      font-weight: 700;
      min-width: 16px;
      height: 16px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0 3px;
    }
    #badge[data-count="0"] { display: none; }

    /* ── Sliding panel ── */
    #panel {
      position: absolute;
      right: 0;
      top: 0;
      height: 100vh;
      width: 260px;
      background: #1e1e2e;
      color: #cdd6f4;
      display: flex;
      flex-direction: column;
      pointer-events: all;
      transform: translateX(232px);
      transition: transform 0.2s ease;
      box-shadow: -4px 0 20px rgba(0,0,0,0.35);
      overflow: hidden;
    }
    #panel.expanded { transform: translateX(0); }

    /* ── Panel header ── */
    #panel-header {
      padding: 12px 14px 8px;
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #a6adc8;
      border-bottom: 1px solid #313244;
      flex-shrink: 0;
    }

    /* ── Snippet list ── */
    #snippet-list {
      flex: 1;
      overflow-y: auto;
      padding: 8px 0;
      scrollbar-width: thin;
      scrollbar-color: #45475a transparent;
    }

    .snippet-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px 6px 0;
      cursor: default;
      border-bottom: 1px solid #313244;
      position: relative;
      transition: background 0.1s;
    }
    .snippet-item:hover { background: #2a2a3e; }

    .color-tag-dot {
      width: 6px;
      align-self: stretch;
      border-radius: 2px 0 0 2px;
      flex-shrink: 0;
      background: transparent;
    }

    .thumb {
      width: 52px;
      height: 38px;
      object-fit: cover;
      border-radius: 3px;
      border: 1px solid #45475a;
      flex-shrink: 0;
      background: #313244;
    }

    .snippet-info {
      flex: 1;
      overflow: hidden;
    }
    .label {
      font-size: 11px;
      font-weight: 500;
      color: #cdd6f4;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .date {
      font-size: 9px;
      color: #6c7086;
      margin-top: 2px;
    }

    .delete-btn {
      background: none;
      border: none;
      color: #6c7086;
      cursor: pointer;
      font-size: 13px;
      padding: 2px 4px;
      border-radius: 3px;
      flex-shrink: 0;
      line-height: 1;
    }
    .delete-btn:hover { background: #45475a; color: #f38ba8; }

    /* ── Empty state ── */
    #empty-state {
      text-align: center;
      padding: 40px 16px;
      color: #6c7086;
      font-size: 12px;
      line-height: 1.5;
    }

    /* ── Preview popup ── */
    #preview-popup {
      position: fixed;
      right: 264px;
      background: #1e1e2e;
      border: 1px solid #45475a;
      border-radius: 6px;
      box-shadow: -4px 4px 24px rgba(0,0,0,0.5);
      padding: 6px;
      pointer-events: none;
      display: none;
      z-index: 2147483647;
      max-width: 400px;
    }
    #preview-popup img {
      display: block;
      max-width: 380px;
      max-height: 280px;
      border-radius: 3px;
      object-fit: contain;
    }
    #preview-popup.visible { display: block; }
  `;

  class PeekSnapSidebar extends HTMLElement {
    constructor() {
      super();
      this._shadow = this.attachShadow({ mode: "closed" });
      this._expanded = false;
      this._snippets = [];

      this._buildDOM();
    }

    _buildDOM() {
      const style = document.createElement("style");
      style.textContent = CSS;
      this._shadow.appendChild(style);

      // Tab handle
      this._tab = document.createElement("div");
      this._tab.id = "tab";

      const tabLabel = document.createElement("span");
      tabLabel.id = "tab-label";
      tabLabel.textContent = "Snaps";

      this._badge = document.createElement("span");
      this._badge.id = "badge";
      this._badge.dataset.count = "0";
      this._badge.textContent = "0";

      this._tab.appendChild(tabLabel);
      this._tab.appendChild(this._badge);
      this._tab.addEventListener("click", () => this._togglePanel());
      this._shadow.appendChild(this._tab);

      // Sliding panel
      this._panel = document.createElement("div");
      this._panel.id = "panel";

      const header = document.createElement("div");
      header.id = "panel-header";
      header.textContent = "PeekSnap";

      this._list = document.createElement("div");
      this._list.id = "snippet-list";

      this._panel.appendChild(header);
      this._panel.appendChild(this._list);
      this._shadow.appendChild(this._panel);

      // Preview popup
      this._preview = document.createElement("div");
      this._preview.id = "preview-popup";
      this._previewImg = document.createElement("img");
      this._previewImg.id = "preview-img";
      this._previewImg.alt = "Preview";
      this._preview.appendChild(this._previewImg);
      this._shadow.appendChild(this._preview);

      // Event delegation for list actions
      this._list.addEventListener("click", (e) => this._onListClick(e));
    }

    connectedCallback() {
      Object.assign(this.style, {
        position: "fixed",
        right: "0",
        top: "0",
        height: "100vh",
        zIndex: "2147483647",
        isolation: "isolate",
        pointerEvents: "none",
      });
    }

    disconnectedCallback() {}

    _togglePanel() {
      this._expanded = !this._expanded;
      this._panel.classList.toggle("expanded", this._expanded);
    }

    // ── Public API ────────────────────────────────────────────────────────────

    render(snippets) {
      this._snippets = snippets;
      this._list.textContent = "";

      if (!snippets.length) {
        const empty = document.createElement("div");
        empty.id = "empty-state";
        empty.textContent = "No snaps yet. Click the toolbar icon to capture a region.";
        this._list.appendChild(empty);
        this.updateBadge(0);
        return;
      }

      for (const snippet of snippets) {
        this._list.appendChild(this._buildItem(snippet));
      }
      this.updateBadge(snippets.length);
    }

    addSnippet(snippet) {
      const emptyState = this._list.querySelector("#empty-state");
      if (emptyState) emptyState.remove();

      this._snippets.unshift(snippet);
      this._list.insertBefore(this._buildItem(snippet), this._list.firstChild);
      this.updateBadge(this._snippets.length);

      if (!this._expanded) this._togglePanel();
    }

    updateBadge(count) {
      this._badge.textContent = String(count);
      this._badge.dataset.count = String(count);
    }

    // ── Item Builder (safe DOM methods — no innerHTML with user data) ──────────

    _buildItem(snippet) {
      const item = document.createElement("div");
      item.className = "snippet-item";
      item.dataset.snippetId = snippet.id;

      // Color tag stripe (left edge)
      const dot = document.createElement("div");
      dot.className = "color-tag-dot";
      if (snippet.colorTag) dot.style.background = snippet.colorTag;

      const thumb = document.createElement("img");
      thumb.className = "thumb";
      thumb.src = snippet.thumbDataUrl || "";
      thumb.alt = "Snippet thumbnail";

      const info = document.createElement("div");
      info.className = "snippet-info";

      const primaryLabel = snippet.name || snippet.label;
      const labelEl = document.createElement("div");
      labelEl.className = "label";
      labelEl.textContent = primaryLabel;    // textContent — safe
      labelEl.title = primaryLabel;

      const date = new Date(snippet.createdAt);
      const dateStr =
        date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
        " " +
        date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

      const dateEl = document.createElement("div");
      dateEl.className = "date";
      dateEl.textContent = dateStr;           // textContent — safe

      info.appendChild(labelEl);
      info.appendChild(dateEl);

      const deleteBtn = document.createElement("button");
      deleteBtn.className = "delete-btn";
      deleteBtn.title = "Delete snippet";
      deleteBtn.textContent = "✕";

      item.appendChild(dot);
      item.appendChild(thumb);
      item.appendChild(info);
      item.appendChild(deleteBtn);

      item.addEventListener("mouseenter", () => this._showPreview(item, snippet.id));
      item.addEventListener("mouseleave", () => this._hidePreview());

      item.addEventListener("click", (e) => {
        if (e.target.closest(".delete-btn")) return;
        this._togglePanel();
        this._openViewer(snippet);
      });

      return item;
    }

    _openViewer(snippet) {
      browser.runtime.sendMessage({ action: "get_full_blob", id: snippet.id }).then(({ dataUrl }) => {
        if (!dataUrl) return;

        const panel = document.createElement("div");
        panel.style.cssText = `
          position: fixed;
          top: 60px; right: 288px;
          width: min(50vw, 800px);
          height: min(50vh, 600px);
          background: #1e1e2e;
          border-radius: 10px;
          box-shadow: 0 8px 32px rgba(0,0,0,0.6);
          overflow: hidden;
          z-index: 2147483645;
          cursor: grab;
          user-select: none;
        `;

        const img = document.createElement("img");
        img.src = dataUrl;
        img.style.cssText = `
          width: 100%; height: 100%;
          object-fit: contain;
          display: block;
        `;

        const closeBtn = document.createElement("button");
        closeBtn.textContent = "✕";
        closeBtn.style.cssText = `
          position: absolute; top: 8px; right: 8px;
          width: 28px; height: 28px; border-radius: 50%;
          background: rgba(0,0,0,0.5);
          border: 1.5px solid rgba(255,255,255,0.3);
          color: #fff; font-size: 13px; cursor: pointer;
          display: flex; align-items: center; justify-content: center;
          z-index: 1;
        `;
        closeBtn.addEventListener("click", () => panel.remove());

        let dragOffsetX = 0, dragOffsetY = 0;
        panel.addEventListener("mousedown", (e) => {
          if (e.target === closeBtn) return;
          e.preventDefault();
          const rect = panel.getBoundingClientRect();
          dragOffsetX = e.clientX - rect.left;
          dragOffsetY = e.clientY - rect.top;
          panel.style.cursor = "grabbing";

          const onMove = (e) => {
            panel.style.left = (e.clientX - dragOffsetX) + "px";
            panel.style.top  = (e.clientY - dragOffsetY) + "px";
            panel.style.right = "auto";
          };
          const onUp = () => {
            panel.style.cursor = "grab";
            document.removeEventListener("mousemove", onMove);
            document.removeEventListener("mouseup", onUp);
          };
          document.addEventListener("mousemove", onMove);
          document.addEventListener("mouseup", onUp);
        });

        const onKey = (e) => {
          if (e.key === "Escape") { panel.remove(); document.removeEventListener("keydown", onKey); }
        };
        document.addEventListener("keydown", onKey);
        panel.addEventListener("remove", () => document.removeEventListener("keydown", onKey));

        panel.dataset.peeksnap = "1";
        panel.appendChild(img);
        panel.appendChild(closeBtn);
        document.body.appendChild(panel);
      });
    }

    // ── Event Delegation ──────────────────────────────────────────────────────

    _onListClick(e) {
      const deleteBtn = e.target.closest(".delete-btn");
      if (!deleteBtn) return;

      const item = deleteBtn.closest(".snippet-item");
      const id = item?.dataset.snippetId;
      if (!id) return;

      browser.runtime.sendMessage({ action: "delete_snippet", id }).then(() => {
        this._snippets = this._snippets.filter((s) => s.id !== id);
        this.render(this._snippets);
      });
    }

    _showPreview(item, id) {
      if (item._loadingPreview) return;
      item._loadingPreview = true;

      browser.runtime
        .sendMessage({ action: "get_full_blob", id })
        .then(({ dataUrl }) => {
          if (!dataUrl || !item.matches(":hover")) return;

          this._previewImg.src = dataUrl;

          const itemRect = item.getBoundingClientRect();
          const popupH = 292;
          let top = itemRect.top;
          if (top + popupH > window.innerHeight) {
            top = Math.max(8, window.innerHeight - popupH - 8);
          }
          this._preview.style.top = `${top}px`;
          this._preview.classList.add("visible");
        })
        .catch(() => {})
        .finally(() => { item._loadingPreview = false; });
    }

    _hidePreview() {
      this._preview.classList.remove("visible");
    }
  }

  customElements.define("peeksnap-sidebar", PeekSnapSidebar);
})();
