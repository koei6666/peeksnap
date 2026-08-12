/**
 * marking_controller.js — shared sidebar↔marker wiring.
 *
 * Used by BOTH content_script.js (host pages) and viewer/viewer.js (our PDF
 * viewer page). The keydown handler has three separate bail-out conditions
 * and one of them has already been gotten wrong once, so this logic lives in
 * exactly one place.
 *
 * Content scripts are classic IIFEs with no module system, so a single
 * namespaced global is the only available sharing mechanism.
 *
 * Public API:
 *   PeekSnapMarking.attach(sidebar, marker)
 */

(function () {
  if (window.PeekSnapMarking) return;

  /**
   * Wires a sidebar element to a marker element and installs the marking
   * keyboard shortcuts. Safe to call once per page.
   */
  function attach(sidebar, marker) {
    // The sidebar owns the buttons but knows nothing about why highlighting
    // may be unavailable, so the caller relays it.
    sidebar.setHighlighterEnabled(marker.canHighlight);

    let activeTool = null;

    sidebar.addEventListener("peeksnap:tool-change", (e) => {
      activeTool = e.detail.tool;
      marker.setTool(activeTool);
    });

    sidebar.addEventListener("peeksnap:mark-color", (e) => {
      marker.setColor(e.detail.color);
    });

    sidebar.addEventListener("peeksnap:mark-width", (e) => {
      marker.setWidth(e.detail.width);
    });

    sidebar.addEventListener("peeksnap:clear-marks", () => {
      marker.clear();
    });

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
        // Ordinary editable targets.
        const t = e.target;
        const isEditable = t && (t.isContentEditable ||
          /^(input|textarea|select)$/i.test(t.tagName || ""));
        if (isEditable) return;

        // Our own capture-name field: overlay.js uses a CLOSED shadow root, so
        // the input is invisible to both e.target and composedPath().
        if (document.querySelector("peeksnap-overlay")) return;

        e.preventDefault();
        marker.undo();
      }
    });
  }

  window.PeekSnapMarking = { attach };
})();
