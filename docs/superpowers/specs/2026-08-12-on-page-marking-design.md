# On-Page Marking — Design

**Date:** 2026-08-12
**Status:** Approved
**Feature:** Let users mark directly on the page — highlight text on text pages, draw freehand on non-text pages (scanned PDFs, images).

---

## 1. Scope

Two manually-selected tools whose marks live on the page for the session and disappear on reload.

| | Highlighter | Brush |
|---|---|---|
| Input | Drag-select text, release | Freehand drag |
| Paint | Active tag color at 35% alpha | Active tag color, opaque |
| Available when | Page can produce a text selection | Always |

Supporting behavior:

- **Undo** — `Cmd/Ctrl+Z` steps back through marks in creation order across *both* tools, from one shared stack.
- **Clear marks** — a button in the sidebar tool row removes all marks.
- **Capture interop** — marks appear in any snap taken over them.

### Explicitly out of scope

- Persistence across reloads or visits (and therefore all text re-anchoring).
- An eraser tool.
- Any change to the snippet schema, `DB_VERSION`, the background worker, or the popup.
- Fixing the known CSS top-layer ad gap.

### Highlighter availability rule

The highlighter is disabled — rendered greyed with an explanatory `title` — when either holds:

1. `document.contentType` is a PDF or image type. Safari's PDF plugin is not an inspectable document; `window.getSelection()` returns nothing usable from it.
2. `CSS.highlights` is undefined (pre-Safari-17.2).

The brush is never disabled. Both conditions are checked once, when `<peeksnap-marker>` is constructed, and exposed as a read-only `canHighlight` property on the element. `content_script.js` reads it after mounting and calls `sidebar.setHighlighterEnabled(bool)`, so the button state matches reality without the sidebar knowing why.

---

## 2. Architecture

One new file, `peeksnap/content/marker.js`, defining a `<peeksnap-marker>` custom element with a closed shadow root — the same IIFE pattern as `overlay.js` and `sidebar.js`. It is added to `manifest.json` **before** `content/content_script.js`, because the manifest's `content_scripts.js` order determines definition order and the orchestration layer instantiates the tag.

### Mark stack

A single ordered array is the source of truth for both tools, which is what makes cross-tool undo work:

```js
{ type: 'stroke',    points: [{x, y}, ...], color, width }
{ type: 'highlight', ranges: [Range, ...],   color }
```

### Rendering: strokes

A `position: fixed` full-viewport canvas inside the marker's shadow root, sized `w * dpr × h * dpr` with `ctx.scale(dpr, dpr)` — matching `overlay.js`. Without the DPR scaling, strokes look acceptable on screen but come out soft inside captured PNGs on Retina displays.

Rendering is **retained, not immediate-mode**: the canvas is fully repainted from `points` on undo, on clear, and on window resize. A resize blanks the canvas backing store, so immediate-mode drawing would silently lose every stroke when the window changes size.

Stroke width is a fixed `3` CSS pixels; there is no size control in this cut.

Strokes are viewport-fixed by decision: they do not follow content scroll. This sidesteps the documented PDF limitation (`window.scrollY` is permanently `0` under Safari's PDF plugin, making document-anchored positioning impossible on exactly the scanned-PDF case this tool targets) and suits an "annotate what you see, then snap it" flow.

### Rendering: highlights

Highlights use the **CSS Custom Highlight API**. Ranges are registered into `CSS.highlights` as one `Highlight` object per distinct color, named `peeksnap-mark-<n>`.

This is a deliberate choice over the conventional approach of wrapping ranges in `<span>` elements. Wrapping mutates host-page DOM, which violates the project's host-page invariant, can break page scripts and layout, and creates a cleanup problem on undo. The Custom Highlight API paints over live `Range` objects with **zero DOM mutation**, and renders into `captureVisibleTab` like any other paint.

One consequence must be honored: the highlight registry is per-document, and `::highlight()` rules cannot be reached from a shadow stylesheet. The `::highlight(peeksnap-mark-n) { background-color: … }` rules therefore live in a `<style>` element injected into the **host document** `<head>`. That element is this feature's only host-DOM mutation; it carries `data-peeksnap="1"`.

Selection handling: on `mouseup` while the highlighter is active, the current selection's ranges are captured into a mark and the native selection is cleared, so the highlight is visible rather than hidden under selection chrome.

### Pointer-event discipline

This table is the whole mechanism for not breaking the host page. Marks stay visible in every state; only input routing changes.

| Active tool | Marker element | Canvas | Why |
|---|---|---|---|
| none | `pointer-events: none` | `none` | Page behaves as if the feature does not exist |
| highlighter | `none` | `none` | Native text selection must reach the page |
| brush | `auto` | `auto` | Canvas swallows drags |

---

## 3. Component boundaries

Three units, each understandable without reading the others' internals.

**`marker.js`** — owns the mark stack, both renderers, and the injected highlight stylesheet. Public API is four methods plus one property:

```
setTool(tool)   // 'highlighter' | 'brush' | null
setColor(hex)
undo()
clear()
canHighlight    // read-only boolean, resolved at construction
```

It never references the sidebar and holds no knowledge of how tools are chosen.

**`sidebar.js`** — gains a tool row and nothing else. It knows about buttons, not about marking. It exposes one method, `setHighlighterEnabled(bool)`, and emits two events, both with `composed: true`:

- `peeksnap:tool-change` with `detail: { tool }`
- `peeksnap:clear-marks`

`composed: true` is mandatory; without it the events cannot cross the closed shadow boundary and are never heard. The existing `peeksnap:captured` event has the same requirement.

**`content_script.js`** — the only place that knows both sides. It mounts `<peeksnap-marker>`, translates sidebar events into marker method calls, and owns keyboard handling: `Cmd/Ctrl+Z` → `undo()`, `Escape` → deselect tool. Both keys are handled **only while a tool is active**, so the feature never steals undo from a page's own text inputs.

---

## 4. Color

Marks reuse the existing tag palette rather than introducing a third color picker. `overlay.js` and `popup.js` already carry duplicate copies of the palette and `generateTonalColor` logic; a third copy is the wrong direction.

The tool row shows a single color dot, seeded from `peeksnap_settings.lastUsedColor`. Clicking it **cycles** through `tagColors`. No dropdown, no new picker component.

The highlighter applies the chosen color at 35% alpha — a solid tag color behind body text is unreadable. The brush uses it opaque.

Reading `peeksnap_settings` is a `browser.storage.local` read only. This feature never writes settings, so it cannot disturb the capture flow's `lastUsedColor` behavior.

---

## 5. Error handling

- `CSS.highlights` is feature-detected at construction. When absent, the highlighter button renders disabled with a tooltip and the brush works normally — no thrown errors and no dead UI.
- `<peeksnap-marker>` carries `data-peeksnap="1"` and mounts after the sidebar, so the existing `MutationObserver` re-append defense covers it with no additional work. Omitting the attribute would both bury the element behind ads and cause it to be misread as foreign content, retriggering the re-append loop.
- The injected `<style>` element also carries `data-peeksnap="1"`.
- The feature inherits the known CSS top-layer gap: `<dialog showModal()>` and popover-API ads sit above everything regardless of z-index or DOM order. Not addressed here.
- Failures surface through the existing `showError()` toast rather than throwing.

---

## 6. Verification

This project has no linter, formatter, type checker, or test suite; verification is manual in Safari, per the project's task-completion checklist. Build with Cmd+R in `native/PeekSnap/PeekSnap.xcodeproj` and reload the page — editing `peeksnap/` alone changes nothing that is running.

Required matrix:

| Surface | Expected |
|---|---|
| Article page | Highlighter enabled and paints; brush draws; both survive scroll per their design (highlights follow text, strokes stay viewport-fixed) |
| Scanned PDF | Brush works; highlighter correctly greyed with tooltip |
| Image page | Same as scanned PDF |
| Ad-heavy page | Marker layer not buried by injected ad content |

Plus: one snap taken over a highlight and one over a stroke, both confirmed to bake in crisply at Retina DPR; and a window resize with strokes on screen, confirming they repaint rather than vanish.

Check all three consoles for errors — page, background page, and popup. All PeekSnap logging is prefixed `[PeekSnap]`.

---

## 7. Files touched

| File | Change |
|---|---|
| `peeksnap/content/marker.js` | New. `<peeksnap-marker>`: mark stack, stroke canvas, highlight registry, undo/clear |
| `peeksnap/content/sidebar.js` | Tool row markup, styles, event emission |
| `peeksnap/content/content_script.js` | Mount marker, wire sidebar events, keyboard handling |
| `peeksnap/manifest.json` | Register `content/marker.js` ahead of `content_script.js` |
| `JOURNAL.md` | Session entry |

No background, storage, or popup files are modified.
