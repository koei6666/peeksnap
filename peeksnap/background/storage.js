/**
 * storage.js — IndexedDB wrapper for PeekSnap snippets.
 *
 * Schema:
 *   Database: "peeksnap_db" (v1)
 *   Object Store: "snippets" (keyPath: "id")
 *     Index: "by_page"  on pageUrl   (unique: false)
 *     Index: "by_date"  on createdAt (unique: false)
 *
 * Snippet shape stored:
 *   { id, pageUrl, pageTitle, label, createdAt, thumbBlob, fullBlob }
 */

const DB_NAME = "peeksnap_db";
const DB_VERSION = 1;
const STORE = "snippets";

let db = null;

function openDB() {
  if (db) return Promise.resolve(db);

  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const database = e.target.result;
      const store = database.createObjectStore(STORE, { keyPath: "id" });
      store.createIndex("by_page", "pageUrl", { unique: false });
      store.createIndex("by_date", "createdAt", { unique: false });
    };

    req.onsuccess = (e) => {
      db = e.target.result;
      resolve(db);
    };

    req.onerror = () => reject(req.error);
  });
}

function tx(mode) {
  return openDB().then((database) => {
    const transaction = database.transaction(STORE, mode);
    const store = transaction.objectStore(STORE);
    return store;
  });
}

function promisify(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const SnippetStore = {
  /** Save a new snippet. Fails if ID already exists. */
  save(snippet) {
    return tx("readwrite").then((store) => promisify(store.add(snippet)));
  },

  /**
   * Get all snippets for a given page URL, sorted by createdAt descending.
   * Returns snippet records WITHOUT fullBlob (excluded for performance).
   */
  getByPage(url) {
    return tx("readonly").then((store) => {
      const index = store.index("by_page");
      const range = IDBKeyRange.only(url);
      return new Promise((resolve, reject) => {
        const results = [];
        const req = index.openCursor(range);
        req.onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor) {
            // Strip fullBlob from list results — load lazily on hover
            const { fullBlob, ...meta } = cursor.value;
            results.push(meta);
            cursor.continue();
          } else {
            // Sort descending by createdAt
            results.sort((a, b) => b.createdAt - a.createdAt);
            resolve(results);
          }
        };
        req.onerror = () => reject(req.error);
      });
    });
  },

  /** Retrieve only the fullBlob for a given snippet ID (lazy load). */
  getFullBlob(id) {
    return tx("readonly").then((store) => {
      return new Promise((resolve, reject) => {
        const req = store.get(id);
        req.onsuccess = () => {
          const record = req.result;
          resolve(record ? record.fullBlob : null);
        };
        req.onerror = () => reject(req.error);
      });
    });
  },

  /** Delete a snippet by ID. */
  delete(id) {
    return tx("readwrite").then((store) => promisify(store.delete(id)));
  },

  /** Clear all snippets from the store. */
  clear() {
    return tx("readwrite").then((store) => promisify(store.clear()));
  },
};
