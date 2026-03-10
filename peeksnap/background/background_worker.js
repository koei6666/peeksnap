/**
 * background_worker.js — PeekSnap service worker (single-file, no ES modules).
 *
 * storage.js is inlined here to avoid the ES module import which Safari
 * does not support in extension service workers.
 */

// ─── Storage (IndexedDB) ──────────────────────────────────────────────────────

const DB_NAME = "peeksnap_db";
const DB_VERSION = 1;
const STORE = "snippets";

let _db = null;

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      const store = db.createObjectStore(STORE, { keyPath: "id" });
      store.createIndex("by_page", "pageUrl", { unique: false });
      store.createIndex("by_date", "createdAt", { unique: false });
    };
    req.onsuccess = (e) => { _db = e.target.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function getTx(mode) {
  return openDB().then((db) => db.transaction(STORE, mode).objectStore(STORE));
}

function idbPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const SnippetStore = {
  save(snippet) {
    return getTx("readwrite").then((s) => idbPromise(s.add(snippet)));
  },

  getByPage(url) {
    return getTx("readonly").then((store) => {
      const index = store.index("by_page");
      return new Promise((resolve, reject) => {
        const results = [];
        const req = index.openCursor(IDBKeyRange.only(url));
        req.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            const { fullBlob, ...meta } = cursor.value;
            results.push(meta);
            cursor.continue();
          } else {
            results.sort((a, b) => b.createdAt - a.createdAt);
            resolve(results);
          }
        };
        req.onerror = () => reject(req.error);
      });
    });
  },

  getFullBlob(id) {
    return getTx("readonly").then((store) => {
      return new Promise((resolve, reject) => {
        const req = store.get(id);
        req.onsuccess = () => resolve(req.result ? req.result.fullBlob : null);
        req.onerror = () => reject(req.error);
      });
    });
  },

  getAll() {
    return getTx("readonly").then((store) => {
      return new Promise((resolve, reject) => {
        const results = [];
        const req = store.index("by_date").openCursor(null, "prev"); // newest first
        req.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            const { fullBlob, ...meta } = cursor.value;
            results.push(meta);
            cursor.continue();
          } else {
            resolve(results);
          }
        };
        req.onerror = () => reject(req.error);
      });
    });
  },

  delete(id) {
    return getTx("readwrite").then((s) => idbPromise(s.delete(id)));
  },

  clear() {
    return getTx("readwrite").then((s) => idbPromise(s.clear()));
  },
};

// ─── Message Router ───────────────────────────────────────────────────────────

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log("[PeekSnap] message received:", message.action);
  switch (message.action) {
    case "capture": {
      const tabId = sender && sender.tab ? sender.tab.id : null;
      handleCapture(message, tabId)
        .then(sendResponse)
        .catch((err) => {
          console.error("[PeekSnap] capture failed:", String(err), err.stack || "(no stack)");
          sendResponse({ action: "capture_error", reason: String(err) });
        });
      return true;
    }

    case "get_snippets":
      SnippetStore.getByPage(message.pageUrl)
        .then(async (snippets) => {
          // Convert thumbBlobs → data URL strings so they cross the message boundary
          const safe = await Promise.all(snippets.map(async (s) => {
            const thumbDataUrl = s.thumbBlob ? await blobToDataUrl(s.thumbBlob) : null;
            const { thumbBlob: _tb, ...meta } = s;
            return { ...meta, thumbDataUrl };
          }));
          sendResponse({ action: "snippets_loaded", snippets: safe });
        })
        .catch((err) => sendResponse({ action: "capture_error", reason: err.message }));
      return true;

    case "get_full_blob":
      SnippetStore.getFullBlob(message.id)
        .then(async (blob) => {
          const dataUrl = blob ? await blobToDataUrl(blob) : null;
          sendResponse({ dataUrl });
        })
        .catch((err) => sendResponse({ error: err.message }));
      return true;

    case "delete_snippet":
      SnippetStore.delete(message.id)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ error: err.message }));
      return true;

    case "get_all_snippets":
      SnippetStore.getAll()
        .then(async (snippets) => {
          const safe = await Promise.all(snippets.map(async (s) => {
            const thumbDataUrl = s.thumbBlob ? await blobToDataUrl(s.thumbBlob) : null;
            const { thumbBlob: _tb, ...meta } = s;
            return { ...meta, thumbDataUrl };
          }));
          sendResponse({ snippets: safe });
        })
        .catch((err) => sendResponse({ error: err.message }));
      return true;

    case "clear_all_snippets":
      SnippetStore.clear()
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ error: err.message }));
      return true;
  }
});

// ─── Capture Pipeline ─────────────────────────────────────────────────────────

function canvasToBlob(canvas, type, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

async function captureRegion(rect, dpr) {
  console.log("[PeekSnap] getting current window...");
  const win = await browser.windows.getCurrent();
  console.log("[PeekSnap] window id:", win.id);

  console.log("[PeekSnap] calling captureVisibleTab...");
  const dataUrl = await browser.tabs.captureVisibleTab(win.id, { format: "png" });
  console.log("[PeekSnap] got dataUrl, length:", dataUrl ? dataUrl.length : "null");

  const img = await loadImage(dataUrl);
  console.log("[PeekSnap] image loaded:", img.width, "x", img.height);

  const physX = Math.round(rect.x * dpr);
  const physY = Math.round(rect.y * dpr);
  const physW = Math.round(rect.width * dpr);
  const physH = Math.round(rect.height * dpr);
  console.log("[PeekSnap] crop rect (physical px):", physX, physY, physW, physH);

  if (physW < 10 || physH < 10) throw new Error("Selection too small");

  const canvas = document.createElement("canvas");
  canvas.width = physW;
  canvas.height = physH;
  const ctx = canvas.getContext("2d");
  console.log("[PeekSnap] canvas context:", ctx ? "ok" : "null");
  ctx.drawImage(img, physX, physY, physW, physH, 0, 0, physW, physH);
  console.log("[PeekSnap] drawImage done, calling toBlob...");

  const blob = await canvasToBlob(canvas, "image/png");
  console.log("[PeekSnap] toBlob result:", blob ? blob.size + " bytes" : "NULL");
  if (!blob) throw new Error("canvas.toBlob returned null — canvas may be tainted");
  return blob;
}

async function generateThumbnail(fullBlob) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(fullBlob);
  });
  const img = await loadImage(dataUrl);

  const MAX_W = 200;
  const MAX_H = 150;
  const scale = Math.min(MAX_W / img.width, MAX_H / img.height, 1);
  const thumbW = Math.max(1, Math.round(img.width * scale));
  const thumbH = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = thumbW;
  canvas.height = thumbH;
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, 0, 0, thumbW, thumbH);

  return canvasToBlob(canvas, "image/jpeg", 0.75);
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function handleCapture(message, tabId) {
  const { rect, dpr, name = "", colorTag = "", captureDocX, captureDocY } = message;

  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab) throw new Error("Could not find active tab");

  const fullBlob = await captureRegion(rect, dpr);
  const thumbBlob = await generateThumbnail(fullBlob);

  const snippet = {
    id: crypto.randomUUID(),
    pageUrl: tab.url,
    pageTitle: tab.title || "",
    label: (() => { try { return new URL(tab.url).hostname; } catch (e) { return tab.url; } })(),
    name,
    colorTag,
    captureDocX,
    captureDocY,
    createdAt: Date.now(),
    thumbBlob,
    fullBlob,
  };

  await SnippetStore.save(snippet);

  // Blobs cannot reliably cross the extension message boundary in Safari —
  // convert the thumbnail to a data URL string for safe transfer.
  const thumbDataUrl = await blobToDataUrl(thumbBlob);
  const { fullBlob: _dropped, thumbBlob: _thumb, ...snippetMeta } = snippet;
  return { action: "snippet_saved", snippet: { ...snippetMeta, thumbDataUrl } };
}
