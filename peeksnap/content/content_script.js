/**
 * content_script.js — Orchestration layer for PeekSnap.
 *
 * Runs at document_idle in every top-level frame.
 * Responsibilities:
 *   1. Mount the sidebar onto the page
 *   2. Load existing snippets for this page URL from storage
 *   3. Listen for messages from the background worker
 *   4. Coordinate the selection overlay → capture → sidebar flow
 *   5. Mount the marker and relay sidebar tool events to it
 */

(function () {
  // ── Mount Sidebar ───────────────────────────────────────────────────────────

  // Build marker — confirms in the console which bundle Safari actually loaded.
  console.log("[PeekSnap] v0.3.2 content scripts loaded — marking enabled");

  // Guard against double-injection
  if (document.querySelector("peeksnap-sidebar")) return;

  const sidebar = document.createElement("peeksnap-sidebar");
  sidebar.dataset.peeksnap = "1";
  document.body.appendChild(sidebar);

  // ── Mount Marker ────────────────────────────────────────────────────────────

  const marker = document.createElement("peeksnap-marker");
  marker.dataset.peeksnap = "1";
  document.body.appendChild(marker);

  window.PeekSnapMarking.attach(sidebar, marker);

  // ── DOM-Order Defense Against Ads ────────────────────────────────────────────
  // Re-append all PeekSnap elements to the end of document.body whenever any
  // external element is added, ensuring PeekSnap wins z-index ties by DOM order.
  let _rafPending = false;
  const _bodyObserver = new MutationObserver((mutations) => {
    const hasExternal = mutations.some(m =>
      [...m.addedNodes].some(n => n.nodeType === 1 && !n.dataset.peeksnap)
    );
    if (!hasExternal || _rafPending) return;
    _rafPending = true;
    requestAnimationFrame(() => {
      _rafPending = false;
      document.querySelectorAll('[data-peeksnap]').forEach(el => document.body.appendChild(el));
    });
  });
  _bodyObserver.observe(document.body, { childList: true, subtree: true });

  // ── Load Existing Snippets ──────────────────────────────────────────────────

  browser.runtime
    .sendMessage({ action: "get_snippets", pageUrl: location.href })
    .then((response) => {
      if (response?.action === "snippets_loaded") {
        sidebar.render(response.snippets);
        response.snippets.forEach(placeDot);
      }
    })
    .catch(() => {
      // Background worker not ready yet — sidebar shows empty state
    });

  // ── Message Listener ────────────────────────────────────────────────────────

  browser.runtime.onMessage.addListener((message) => {
    switch (message.action) {
      // Authoritative PDF check for the popup. A URL regex misses the many
      // PDFs served without a .pdf extension (arxiv.org/pdf/1234, download
      // endpoints), and contentType is what actually decides how Safari
      // renders the page.
      case "is_pdf":
        return Promise.resolve({
          isPdf: document.contentType === "application/pdf",
        });

      case "activate_selection":
        activateSelection();
        break;

      case "snippet_saved":
        sidebar.addSnippet(message.snippet);
        break;

      case "capture_error":
        showError(message.reason);
        break;
    }
  });

  // ── Selection Activation ────────────────────────────────────────────────────

  function activateSelection() {
    // Avoid stacking multiple overlays
    if (document.querySelector("peeksnap-overlay")) return;

    const overlay = document.createElement("peeksnap-overlay");
    overlay.dataset.peeksnap = "1";
    document.body.appendChild(overlay);

    overlay.addEventListener("peeksnap:captured", (e) => {
      const { rect, dpr, name, colorTag } = e.detail;
      const captureDocX = Math.round(rect.x + window.scrollX + rect.width / 2);
      const captureDocY = Math.round(rect.y + window.scrollY + rect.height / 2);

      browser.runtime
        .sendMessage({ action: "capture", rect, dpr, name, colorTag, captureDocX, captureDocY })
        .then((response) => {
          if (response?.action === "snippet_saved") {
            sidebar.addSnippet(response.snippet);
            placeDot(response.snippet);
          } else if (response?.action === "capture_error") {
            showError(response.reason);
          }
        })
        .catch((err) => showError(err.message));
    });
  }

  // ── Capture Dot ─────────────────────────────────────────────────────────────

  function placeDot(snippet) {
    if (!snippet.captureDocX || !snippet.captureDocY) return;
    if (document.contentType === 'application/pdf') return; // PDF scroll is internal to plugin, dots can't follow it
    const dot = document.createElement("div");
    dot.dataset.peeksnap = "1";
    dot.dataset.snippetId = snippet.id;
    dot.style.cssText = `
      position: absolute;
      left: ${snippet.captureDocX}px;
      top: ${snippet.captureDocY}px;
      width: 14px; height: 14px;
      border-radius: 50%;
      background: ${snippet.colorTag || "#888"};
      border: 2px solid #fff;
      box-shadow: 0 1px 4px rgba(0,0,0,0.5);
      transform: translate(-50%, -50%);
      z-index: 2147483630;
      pointer-events: none;
    `;
    document.body.appendChild(dot);
  }

  // ── Error Display ───────────────────────────────────────────────────────────

  function showError(reason) {
    // Simple non-blocking toast — uses a temporary element
    const toast = document.createElement("div");
    toast.dataset.peeksnap = "1";
    toast.textContent = `PeekSnap: ${reason}`;
    Object.assign(toast.style, {
      position: "fixed",
      bottom: "24px",
      left: "50%",
      transform: "translateX(-50%)",
      background: "#f38ba8",
      color: "#1e1e2e",
      padding: "8px 16px",
      borderRadius: "6px",
      fontFamily: "system-ui, sans-serif",
      fontSize: "13px",
      fontWeight: "600",
      zIndex: "2147483647",
      pointerEvents: "none",
      boxShadow: "0 4px 12px rgba(0,0,0,0.3)",
    });
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }
})();
