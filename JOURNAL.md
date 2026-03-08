# PeekSnap — Development Journal

## Project Overview
A Safari Web Extension that lets users capture screenshot regions ("snaps") and view them in a collapsible sidebar on any webpage.

---

## Session 1 — Initial Build
**Features completed:**
- `manifest.json` — Extension manifest (MV3, Safari)
- `background/background_worker.js` — Service worker with IndexedDB storage (SnippetStore), capture pipeline (captureVisibleTab → crop → thumbnail), message router
- `content/overlay.js` — Full-viewport selection overlay (canvas-based, closed shadow DOM, Escape to cancel)
- `content/sidebar.js` — Collapsible right-edge panel (custom element, shadow DOM, thumbnail list, hover preview, delete)
- `content/content_script.js` — Orchestration layer; mounts sidebar, handles activate_selection / snippet_saved messages
- `popup/popup.html` + `popup/popup.js` — Toolbar popup; sends activate_selection then immediately closes to free mouse events
- `icons/` — Placeholder PNG icons (16, 32, 48, 128, 1024 px)

**Architecture decisions:**
- Content scripts are IIFEs (not modules) loaded as classic scripts in manifest order
- Background worker inlines storage to avoid ES module issues in Safari service workers
- Thumbnails stored as JPEG blobs (quality 0.75); full captures as PNG
- `fullBlob` excluded from list queries (lazy-loaded on hover only)
- All user data rendered via `textContent` (never `innerHTML`) for XSS safety

**Blocked:** `xcrun safari-web-extension-converter` requires full Xcode (not CommandLineTools). Xcode not installed; native wrapper deferred.

---

## Session 2 — Naming Header, Tag Colors, Settings
**Date:** 2026-03-08

**Features added this session:**
- **Naming bar** in the selection overlay: always visible while overlay is open; shows color tag selector + name input; Save + Retry buttons activate after a valid selection is drawn
- **Tag colors**: up to 5 user-defined preset colors stored in `browser.storage.local` under key `peeksnap_settings`; last-used color is pre-selected on next capture
- **Color dropdown** in overlay: "▶" opens a panel showing all stored colors as larger dots + a "+ Custom" native color picker (custom color applies to this capture only, does not auto-persist)
- **Retry flow**: clears selection and re-enables dragging without closing the overlay
- **Color dot + name in sidebar**: left-edge colored stripe on each snippet item; snippet name shown (falls back to hostname if not set)
- **Settings panel in popup**: collapsible "⚙ Tag Colors" section; click any swatch to change its color via native picker; "+ Add" adds a new slot (max 5); "Reset" restores defaults

**Storage schema:**
```
browser.storage.local["peeksnap_settings"] = {
  tagColors: string[],    // array of hex colors (user-defined, max 5)
  lastUsedColor: string   // hex — pre-selected on next capture
}
```

**Snippet schema additions** (backwards-compatible, optional fields):
```
snippet.name: string      // user-provided name (default '')
snippet.colorTag: string  // hex color (default '')
```
