/**
 * pdf_url.js — pure URL predicates for the popup's PDF/viewer toggle.
 *
 * Kept free of browser.* so it can be loaded and tested outside Safari.
 * Attaches to globalThis rather than exporting: popup.html loads it as a
 * classic script, before popup.js.
 */
(function () {
  "use strict";

  /** Schemes that may be navigated to or fetched as a document. */
  const DOCUMENT_PROTOCOLS = ["http:", "https:", "file:"];

  function parse(url) {
    try {
      return new URL(url);
    } catch (_) {
      return null;
    }
  }

  /**
   * True when `url` is OUR viewer page.
   *
   * Compared against the real viewer URL (browser.runtime.getURL(…)) on
   * protocol + host + pathname. NOT on `origin`: for non-special schemes like
   * safari-web-extension:, `URL.origin` is the opaque string "null" wherever
   * the scheme isn't specially registered, so an origin comparison silently
   * depends on browser internals and can't be tested off-browser.
   *
   * Never a substring match — a hostile page can put "viewer/viewer.html"
   * anywhere in its own URL.
   */
  function isViewerUrl(url, viewerUrl) {
    const a = parse(url);
    const b = parse(viewerUrl);
    if (!a || !b) return false;
    return a.protocol === b.protocol && a.host === b.host && a.pathname === b.pathname;
  }

  /**
   * The document URL the viewer is currently showing, or null.
   *
   * The `file` param is attacker-influenceable and its value ends up in
   * browser.tabs.update() — a navigation sink — so it is re-validated here
   * even though viewer.js already validates it for its own fetch/link use.
   * Two checks guarding two different sinks, deliberately not merged: see
   * safeDocumentUrl() in viewer/viewer.js.
   */
  function originalPdfUrlFromViewer(url, viewerUrl) {
    if (!isViewerUrl(url, viewerUrl)) return null;
    const raw = parse(url).searchParams.get("file");
    if (!raw) return null;
    const u = parse(raw);
    if (!u || !DOCUMENT_PROTOCOLS.includes(u.protocol)) return null;
    return u.href;
  }

  /**
   * Fallback for when the content script can't be reached, so
   * document.contentType (the authoritative answer) is unavailable.
   *
   * Tests the PATH only. Testing the whole URL made any page with a
   * `?file=….pdf` query look like a PDF — which is how the viewer, whose own
   * URL carries the PDF address in exactly such a param, misidentified itself.
   */
  function looksLikePdfUrl(url) {
    const u = parse(url);
    if (!u || !DOCUMENT_PROTOCOLS.includes(u.protocol)) return false;
    return /\.pdf$/i.test(u.pathname);
  }

  globalThis.PeekSnapPdfUrl = { isViewerUrl, originalPdfUrlFromViewer, looksLikePdfUrl };
})();
