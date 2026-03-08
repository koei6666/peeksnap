# PeekSnap — Safari Extension Product Plan
> **For AI Agents:** This document is a full build specification. Do not implement the first working solution you find — reason through trade-offs, identify edge cases, and implement the most robust, optimised approach for each requirement. Every section includes a "Naive vs Optimised" analysis to guide decision-making.

---

## Table of Contents
1. [Product Overview](#1-product-overview)
2. [Core Principles for AI Agents](#2-core-principles-for-ai-agents)
3. [Architecture Overview](#3-architecture-overview)
4. [Feature Requirements & Technical Approach](#4-feature-requirements--technical-approach)
   - F1: Region Selection
   - F2: Screenshot Capture
   - F3: Sidebar Panel
   - F4: Snippet List & Hover Preview
   - F5: Persistent Storage
   - F6: PDF Support
   - F7: Snippet Management
   - F8: Keyboard Shortcuts
5. [File & Folder Structure](#5-file--folder-structure)
6. [Data Models](#6-data-models)
7. [Safari Extension Specifics](#7-safari-extension-specifics)
8. [Testing Requirements](#8-testing-requirements)
9. [Phased Build Order](#9-phased-build-order)
10. [Known Hard Problems & Solutions](#10-known-hard-problems--solutions)

---

## 1. Product Overview

**PeekSnap** is a Safari browser extension that lets users select and save visual snippets from any webpage or PDF. Snippets are stored in a docked sidebar as a persistent list. Hovering or clicking a list item shows a floating preview of the saved image — keeping important reference information accessible without losing reading position.

**Primary User:** Someone reading a long PDF or article who wants to bookmark visual sections (charts, tables, code blocks, key paragraphs) for quick reference during the same session and across future visits.

**Elevator Pitch:** "Sticky notes for your browser, but as screenshots."

---

## 2. Core Principles for AI Agents

> These rules govern all implementation decisions throughout this project.

1. **Never accept the first working answer.** Before implementing, ask: "Is there a more robust, more performant, or less brittle way to do this?"
2. **Correctness before brevity.** Code that handles edge cases is always preferred over shorter code that breaks.
3. **Avoid layout collisions.** The extension must not break the layout of any host page. Use Shadow DOM and CSS containment everywhere.
4. **Pixel-perfect capture.** Always account for `window.devicePixelRatio` in all canvas operations. Ignoring this causes blurry screenshots on Retina/HiDPI displays.
5. **Fail gracefully.** If any feature fails (capture, storage write, render), show a clear UI error and preserve any existing snippets.
6. **Privacy by default.** All data stays in `browser.storage.local` / IndexedDB. No network calls, no telemetry.
7. **Performance ceiling.** Sidebar must render with no jank. Images in the list are thumbnails (max 200px wide). Full images load only on hover/click.

---

## 3. Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│  Safari Extension (Web Extension API)               │
│                                                     │
│  ┌─────────────┐    ┌──────────────────────────┐   │
│  │ background  │◄──►│  content_script.js       │   │
│  │  service    │    │  (injected into tab)      │   │
│  │  worker.js  │    │  - Selection overlay      │   │
│  │             │    │  - Sidebar shadow DOM     │   │
│  │  - capture  │    │  - Snippet list UI        │   │
│  │  - storage  │    │  - Hover preview UI       │   │
│  └─────────────┘    └──────────────────────────┘   │
│         │                                           │
│         ▼                                           │
│  ┌─────────────┐                                    │
│  │  IndexedDB  │  (images as Blobs + metadata)      │
│  └─────────────┘                                    │
└─────────────────────────────────────────────────────┘
```

**Message Flow for a Capture:**
```
User drags region (content_script)
  → sends {action: "capture", rect: {x,y,w,h}, devicePixelRatio}
    → background worker calls browser.tabs.captureVisibleTab()
      → crops canvas to rect × devicePixelRatio
        → converts to Blob → stores in IndexedDB
          → sends {action: "snippet_saved", snippet} back to content_script
            → content_script updates sidebar list
```

---

## 4. Feature Requirements & Technical Approach

---

### F1: Region Selection

**Requirement:** User activates selection mode (toolbar button or keyboard shortcut). A full-page overlay appears with a crosshair cursor. User clicks and drags to define a rectangular region. A highlighted rectangle shows the selection in real time. On mouse release, the selection is confirmed and capture is triggered.

#### Naive Approach (DO NOT USE)
Inject a `<div>` overlay directly into `document.body`. Problem: host page CSS may override z-index, pointer-events, or dimensions. Page reflows may occur. Conflicts with sticky headers, iframes, or React portals.

#### Optimised Approach ✓
- Inject a **Web Component** using `customElements.define()` that attaches a **closed Shadow DOM**.
- The overlay is a full-viewport `<canvas>` element inside the shadow root, sized to `window.innerWidth × window.innerHeight`.
- Draw a dimmed backdrop (rgba 0,0,0,0.35) on the canvas. On mousemove, clear and redraw, leaving the selected rectangle bright/transparent to show a "cutout" effect.
- Store selection in viewport-relative coordinates: `{x, y, width, height}`.
- On `mouseup`, dispatch a custom event to trigger capture and immediately remove the overlay component from the DOM.
- Use `document.documentElement.style.setProperty('cursor', 'crosshair')` before injection and restore on cleanup.

**Edge cases to handle:**
- User presses `Escape`: cancel selection, remove overlay, restore cursor
- User clicks without dragging (zero-size rect): ignore, show tooltip "drag to select a region"
- Page has `overflow: hidden` on `<body>`: set overlay to `position: fixed` not `absolute`
- `<iframe>` content: note that cross-origin iframes cannot be captured. Detect and warn.

---

### F2: Screenshot Capture

**Requirement:** Capture only the selected region of the current tab at full resolution, including proper handling of Retina/HiDPI displays.

#### Naive Approach (DO NOT USE)
Call `browser.tabs.captureVisibleTab()`, draw to a canvas at CSS pixel dimensions, then crop. Result: blurry images on Retina displays because the canvas operates at 1× but the screen is 2× or 3×.

#### Optimised Approach ✓
In `background_worker.js`:

```javascript
async function captureRegion(tabId, rect, dpr) {
  // 1. Capture the full visible tab at maximum quality
  const dataUrl = await browser.tabs.captureVisibleTab(null, {
    format: "png",
    quality: 100
  });

  // 2. Create an OffscreenCanvas — never use a visible DOM canvas in the background
  const img = await createImageBitmap(await (await fetch(dataUrl)).blob());
  
  // 3. Scale rect by devicePixelRatio to get physical pixels
  const physX = Math.round(rect.x * dpr);
  const physY = Math.round(rect.y * dpr);
  const physW = Math.round(rect.width * dpr);
  const physH = Math.round(rect.height * dpr);

  const canvas = new OffscreenCanvas(physW, physH);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, physX, physY, physW, physH, 0, 0, physW, physH);

  // 4. Return as Blob (not base64 string — Blobs are more memory-efficient for storage)
  return await canvas.convertToBlob({ type: "image/png" });
}
```

**Why OffscreenCanvas over regular Canvas:**
- No DOM dependency in background service worker
- Runs off the main thread, preventing UI jank
- Available in Safari 16.4+

**Why Blob over base64:**
- A 500KB PNG as base64 is ~680KB string. In IndexedDB as Blob, it is 500KB.
- Base64 strings in memory cause GC pressure; Blobs are handled natively.

---

### F3: Sidebar Panel

**Requirement:** A collapsible sidebar panel docked to the right edge of the browser viewport. Persistent across page scrolling. Does not reflow or break the host page layout. Contains the snippet list and controls.

#### Naive Approach (DO NOT USE)
Inject a `<div>` with `position: fixed; right: 0` and shift the page body with `margin-right`. Problems: modifies host page layout, breaks sticky elements, conflicts with pages that have their own fixed sidebars (e.g. GitHub, Notion).

**Also avoid:** `browser.sidebarAction` — Safari does not support this API as of 2025.

#### Optimised Approach ✓
- Inject the sidebar as a `<web-component>` with **closed Shadow DOM** using `position: fixed; right: 0; top: 0; height: 100vh; z-index: 2147483647` (max z-index).
- The sidebar **floats over** the page — it does NOT shift body margin. This avoids all layout interference.
- Sidebar has two states:
  - **Collapsed:** 28px wide tab with a vertical label "PeekSnap ▲" and snippet count badge
  - **Expanded:** 260px wide full panel
- Width transition uses `transform: translateX()` with `will-change: transform` for GPU-accelerated animation, not `width` animation (which triggers layout reflow).
- All sidebar styles are scoped entirely inside the Shadow DOM — no possibility of style bleed in or out.
- The shadow root uses `:host` CSS for the outer container and injects a `<style>` tag with a complete design system using CSS custom properties.

**Sidebar Structure (Shadow DOM):**
```
<web-component id="peeksnap-sidebar">
  #shadow-root (closed)
    <style> ... </style>
    <div class="sidebar" [data-state="collapsed|expanded"]>
      <div class="tab-handle">         <!-- Always visible, click to toggle -->
        <span class="label">PeekSnap</span>
        <span class="badge">3</span>
      </div>
      <div class="panel">             <!-- Hidden when collapsed -->
        <header class="panel-header">
          <span>Snippets (3)</span>
          <button class="clear-all">Clear</button>
        </header>
        <div class="snippet-list">   <!-- Scrollable list of snippet items -->
          ...
        </div>
      </div>
    </div>
</web-component>
```

---

### F4: Snippet List & Hover Preview

**Requirement:** Saved snippets appear in the sidebar as a vertical list. Each item shows a thumbnail, a label (auto-generated or user-edited), and a timestamp. Hovering shows a larger floating preview. Clicking the item shows the full-size image in a modal.

#### Naive Approach (DO NOT USE)
Store full-resolution images and display them at thumbnail size via CSS `width: 100%`. Problem: loading a 2MB PNG to show a 200px thumbnail wastes memory, causes slow render, and lags the sidebar on large snippet collections.

#### Optimised Approach ✓
**Two-tier image storage:**
1. **Thumbnail Blob** — generated at save time, max 200×150px, JPEG quality 75. Used in the list.
2. **Full Blob** — original PNG from capture. Only loaded when user hovers or clicks.

Generate thumbnail at capture time in background worker:
```javascript
async function generateThumbnail(fullBlob) {
  const img = await createImageBitmap(fullBlob);
  const maxW = 200, maxH = 150;
  const scale = Math.min(maxW / img.width, maxH / img.height, 1);
  const canvas = new OffscreenCanvas(
    Math.round(img.width * scale),
    Math.round(img.height * scale)
  );
  canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.convertToBlob({ type: "image/jpeg", quality: 0.75 });
}
```

**Hover Preview:**
- A `<div class="preview-popup">` is a sibling of the sidebar, also inside the shadow root, initially `display: none`.
- On `mouseenter` of a list item, fetch the full Blob from IndexedDB by snippet ID (lazy load), create an `ObjectURL`, set as `<img src>`, position popup to the left of the sidebar, `display: block`.
- On `mouseleave`, `URL.revokeObjectURL()` the object URL immediately to free memory.
- Popup is positioned dynamically: if item is near the bottom of the viewport, popup opens upward to avoid clipping.

**Auto Label Generation:**
- Default label: page title (truncated to 40 chars) + " — #N"
- User can double-click the label to edit inline (`contenteditable="true"`)
- On blur, save updated label to IndexedDB metadata

---

### F5: Persistent Storage

**Requirement:** Snippets persist across browser sessions. Organised by page URL. Storage must handle many large images without hitting browser limits.

#### Naive Approach (DO NOT USE)
Use `browser.storage.local` with base64 strings. Hard limit is 5–10MB in most browsers. A few high-res screenshots will hit this immediately.

#### Optimised Approach ✓
Use **IndexedDB** with two object stores:

```
Database: "peeksnap_db" (version 1)
├── Object Store: "snippets"
│   ├── keyPath: "id" (UUID v4)
│   ├── Index: "pageUrl" (for querying snippets per page)
│   └── Index: "createdAt" (for sorting)
│   Fields: { id, pageUrl, pageTitle, label, createdAt, thumbBlob, fullBlob }
```

**Why not two stores for thumb/full?** Keeping both blobs in one record ensures atomic reads/writes — no orphaned thumbnails without full images or vice versa.

**Storage wrapper (`storage.js`):**
```javascript
// Expose a clean async API so the rest of the codebase never touches IDB directly
export const SnippetStore = {
  async save(snippet) { ... },
  async getByPage(url) { ... },
  async getFullBlob(id) { ... },
  async delete(id) { ... },
  async clear() { ... },
  async getStorageUsage() {
    // Use StorageManager.estimate() to show user how much space is used
    const { usage, quota } = await navigator.storage.estimate();
    return { used: usage, quota };
  }
};
```

**Storage quota warning:** If usage exceeds 80% of quota, show a banner in the sidebar prompting the user to delete old snippets.

---

### F6: PDF Support

**Requirement:** The extension must work on PDF files rendered in Safari's native viewer.

#### Naive Approach (DO NOT USE)
Try to inject JavaScript into the PDF viewer. Safari's native PDF viewer does not execute injected content scripts — this will silently fail.

#### Optimised Approach ✓
This is a genuinely hard problem. The optimised solution has two tiers:

**Tier 1 — Screen-grab approach (works for all PDFs):**
`browser.tabs.captureVisibleTab()` captures what is *rendered on screen*, regardless of whether it is HTML or a native PDF viewer. The selection overlay is injected as a top-level floating element over the page (it can appear on top of the PDF viewport). The user drags to select, and the screen is captured and cropped normally.

- Inject the selection overlay into the tab even on PDF URLs using `"matches": ["<all_urls>"]` and `"run_at": "document_end"` — on PDF pages, the overlay will sit on top of the rendered PDF.
- This works because the overlay is positioned with `position: fixed` inside a Shadow DOM element injected into the page's thin DOM wrapper that Safari creates around the PDF object.

**Tier 2 — Detect and handle PDF-specific UX:**
Detect if the active tab URL ends in `.pdf` or has `Content-Type: application/pdf`:
```javascript
// In background worker, listen for tab updates
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.url?.match(/\.pdf(\?.*)?$/i)) {
    // Inject PDF-mode flag into content script
    browser.tabs.sendMessage(tabId, { action: "set_pdf_mode" });
  }
});
```

In PDF mode, show an informational tooltip in the sidebar: "📄 PDF mode: screenshots capture the visible screen area."

---

### F7: Snippet Management

**Requirement:** Users can label, delete, reorder, and export snippets.

#### Features:
| Action | UI | Implementation |
|---|---|---|
| Rename | Double-click label → `contenteditable` | `blur` event saves to IndexedDB |
| Delete | Hover item → show ✕ button | Remove from IndexedDB, update list |
| Reorder | Drag-and-drop within list | HTML5 Drag API, update `order` field in IndexedDB |
| Export single | Right-click → "Save Image" | Create `<a download>` with `ObjectURL` of fullBlob |
| Export all | Panel header button | Zip using `fflate` (pure-JS zip library, no server needed) |
| Clear all | "Clear" button with confirmation | Prompt "Delete all N snippets?" before executing |
| Filter by page | Toggle in panel header | Query IndexedDB index `pageUrl` = current tab URL |

#### Reorder Implementation:
- Add an `order` integer field to each snippet record (default = insertion index)
- On drag-drop, calculate new order values and batch-update IndexedDB in a single transaction
- Re-render list sorted by `order`

---

### F8: Keyboard Shortcuts

**Requirement:** Power users should be able to use the extension without touching the toolbar.

| Shortcut | Action |
|---|---|
| `Cmd+Shift+S` | Activate region selection mode |
| `Escape` | Cancel selection in progress |
| `Cmd+Shift+P` | Toggle sidebar open/closed |
| `Cmd+Shift+X` | Delete last added snippet |

Register in `manifest.json` under `commands`:
```json
"commands": {
  "activate-selection": {
    "suggested_key": { "mac": "Command+Shift+S" },
    "description": "Start region selection"
  },
  "toggle-sidebar": {
    "suggested_key": { "mac": "Command+Shift+P" },
    "description": "Toggle PeekSnap sidebar"
  }
}
```

In background worker, listen for `browser.commands.onCommand` and forward to content script via `browser.tabs.sendMessage`.

---

## 5. File & Folder Structure

```
peeksnap/
├── manifest.json                  # Web Extension manifest v3
├── background/
│   ├── background_worker.js       # Service worker: capture, storage coordination
│   └── storage.js                 # IndexedDB wrapper (SnippetStore)
├── content/
│   ├── content_script.js          # Entry point, message router
│   ├── overlay.js                 # SelectionOverlay web component
│   ├── sidebar.js                 # Sidebar web component + snippet list UI
│   ├── preview.js                 # Hover preview popup logic
│   └── content.css                # Minimal reset (scoped in Shadow DOM)
├── icons/
│   ├── icon-16.png
│   ├── icon-32.png
│   ├── icon-48.png
│   └── icon-128.png
├── popup/
│   ├── popup.html                 # Toolbar popup (quick stats + open sidebar button)
│   ├── popup.js
│   └── popup.css
├── lib/
│   └── fflate.min.js              # ZIP library for export feature
├── native/                        # macOS App wrapper (required for Safari)
│   ├── PeekSnap.xcodeproj
│   └── PeekSnap/
│       └── AppDelegate.swift      # Minimal host app
└── README.md
```

---

## 6. Data Models

### Snippet Record (IndexedDB)
```typescript
interface Snippet {
  id: string;              // UUID v4
  pageUrl: string;         // Full URL of the page (used as index)
  pageTitle: string;       // document.title at time of capture
  label: string;           // User-editable display name
  createdAt: number;       // Date.now() timestamp
  order: number;           // Integer for manual sort ordering
  rect: {                  // CSS-pixel rect of the selection (for reference)
    x: number;
    y: number;
    width: number;
    height: number;
  };
  thumbBlob: Blob;         // JPEG thumbnail, max 200×150px
  fullBlob: Blob;          // Full PNG from capture
}
```

### Message Protocol (between content_script ↔ background_worker)
```typescript
// content_script → background_worker
type OutboundMessage =
  | { action: "capture"; rect: DOMRect; dpr: number; tabId: number }
  | { action: "delete_snippet"; id: string }
  | { action: "get_snippets"; pageUrl: string }
  | { action: "update_label"; id: string; label: string }
  | { action: "reorder_snippets"; orderedIds: string[] }

// background_worker → content_script
type InboundMessage =
  | { action: "snippet_saved"; snippet: Snippet }
  | { action: "snippets_loaded"; snippets: Snippet[] }
  | { action: "capture_error"; reason: string }
  | { action: "set_pdf_mode" }
```

---

## 7. Safari Extension Specifics

### Manifest v3 for Safari
Safari supports Manifest v3 as of Safari 15.4. Use `"background": { "service_worker": "background/background_worker.js" }`.

### Required Permissions
```json
"permissions": [
  "activeTab",
  "storage",
  "tabs"
],
"host_permissions": [
  "<all_urls>"
]
```

Note: `activeTab` alone is insufficient for `captureVisibleTab` — `tabs` permission is required.

### macOS App Wrapper
Safari extensions must be embedded in a macOS (or iOS) app container. The Xcode project is minimal:
- A single `NSWindow` with a brief "PeekSnap is a Safari Extension" description
- In `AppDelegate.swift`, call `SFSafariApplication.getActiveWindow` to open the extension preferences
- App must be signed with an Apple Developer certificate for distribution

### `captureVisibleTab` Permission Prompt
Safari will show a per-site permission prompt the first time `captureVisibleTab` is called. Handle this:
```javascript
try {
  const dataUrl = await browser.tabs.captureVisibleTab(...);
} catch (e) {
  if (e.message.includes("permission")) {
    // Send message back to content_script to show a banner:
    // "PeekSnap needs screen recording permission. Click here to allow."
  }
}
```

---

## 8. Testing Requirements

### Unit Tests
- `storage.js`: save, retrieve, delete, clear, pagination
- `captureRegion()`: correct pixel math at dpr=1, dpr=2, dpr=3
- `generateThumbnail()`: output dimensions never exceed 200×150

### Integration Tests
- Full capture flow: select region → message to background → capture → store → sidebar update
- Sidebar renders with 0, 1, 50 snippets without layout issues
- Hover preview loads and frees ObjectURL correctly (no memory leaks)
- Delete and reorder update IndexedDB correctly

### Manual Test Matrix
| Scenario | Expected Result |
|---|---|
| Capture on a page with `overflow:hidden` body | Overlay appears correctly |
| Capture on a Retina (2×) display | Screenshot is sharp, not blurry |
| Capture on a page with a fixed sidebar (e.g. GitHub) | PeekSnap sidebar does not collide |
| Capture from a PDF tab | Screen grab works, PDF mode tooltip shown |
| Capture across a cross-origin iframe | Warning shown: "Cannot capture iframe content" |
| Open sidebar with 0 snippets | Empty state with instruction shown |
| Storage at 80% capacity | Warning banner appears |
| Export all as ZIP | All full-res images included, ZIP is valid |

---

## 9. Phased Build Order

### Phase 1 — Core Capture Loop
1. Set up Xcode project + Safari extension skeleton
2. `manifest.json` with correct permissions
3. `background_worker.js`: implement `captureRegion()` with DPR-aware cropping
4. `overlay.js`: SelectionOverlay web component with canvas drawing
5. Wire message passing: overlay → background → console.log confirmation
6. **Milestone:** Can select region, see cropped PNG in background worker console

### Phase 2 — Storage & Thumbnail
1. `storage.js`: full IndexedDB SnippetStore wrapper
2. `generateThumbnail()` in background worker
3. Save snippets on capture, retrieve by pageUrl
4. **Milestone:** Snippets survive page refresh and browser restart

### Phase 3 — Sidebar UI
1. `sidebar.js`: Shadow DOM sidebar component, collapsed/expanded states
2. Snippet list renders thumbnails from IndexedDB
3. Badge count on collapsed tab handle
4. **Milestone:** Sidebar visible, snippets listed correctly

### Phase 4 — Hover Preview & Interactions
1. `preview.js`: lazy-load full Blob on hover, position popup
2. Rename (double-click label), delete (✕ button), reorder (drag-drop)
3. **Milestone:** Full CRUD on snippets via UI

### Phase 5 — Polish & Edge Cases
1. Keyboard shortcuts
2. PDF mode detection and messaging
3. Storage quota warning
4. Export single / export all (ZIP)
5. Toolbar popup with quick stats
6. Cross-origin iframe warning
7. Escape key cancels selection
8. Empty state UI
9. **Milestone:** All manual test matrix cases pass

### Phase 6 — App Store Prep
1. App icons in all required sizes
2. Privacy manifest (`PrivacyInfo.xcprivacy`)
3. App Store screenshots and metadata
4. Notarization and signing

---

## 10. Known Hard Problems & Solutions

### Problem 1: Shadow DOM and `z-index` stacking contexts
**Symptom:** Sidebar appears behind fixed elements on some pages.
**Root cause:** Some pages create new stacking contexts via `transform`, `filter`, or `will-change` on ancestors.
**Solution:** The shadow host element itself must have `position: fixed; z-index: 2147483647` set via JavaScript (`element.style.setProperty(...)`) not via a stylesheet, because user-agent stylesheets can override injected `<style>`. Additionally, set `isolation: isolate` on the shadow host.

### Problem 2: Service Worker lifecycle (Manifest v3)
**Symptom:** Background service worker is terminated by the browser, losing in-flight captures.
**Solution:** Never store state in global variables in the service worker. All state lives in IndexedDB. Messages that require a response use `sendResponse` with `return true` to keep the port open. For long operations, use `browser.alarms` to keep the worker alive if needed.

### Problem 3: `captureVisibleTab` timing on page navigation
**Symptom:** User activates selection, then the page redirects before they finish dragging, resulting in a capture of the new page.
**Solution:** Record `document.URL` at the moment selection mode is activated. Before executing capture in the background, verify the current tab URL matches. If not, cancel and show "Page changed during selection."

### Problem 4: Memory leaks from ObjectURLs
**Symptom:** After many hover events, browser memory climbs continuously.
**Solution:** Every `URL.createObjectURL()` must be paired with a `URL.revokeObjectURL()`. In the preview component, revoke on `mouseleave` and also on `disconnectedCallback` (when the sidebar is removed from DOM). Keep a `Set<string>` of active object URLs to force-revoke all of them on sidebar close.

### Problem 5: Drag-to-reorder conflicts with page scroll
**Symptom:** Dragging a snippet item in the sidebar accidentally scrolls the host page.
**Solution:** In the sidebar's Shadow DOM, set `overscroll-behavior: contain` on the `.snippet-list` element. Use `e.stopPropagation()` and `e.preventDefault()` on `dragstart` events within the sidebar. Pointer events on the sidebar should not propagate to the host page.
