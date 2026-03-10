/**
 * popup.js — PeekSnap toolbar popup script.
 *
 * Two views:
 *   Main:    "Capture Region" button + "Manage Snaps" link + Tag Colors settings
 *   Manager: All snippets across every URL, grouped by hostname, with delete + Clear All
 */

const DEFAULT_COLORS = ["#fde047", "#22d3ee", "#f0abfc"];
const SETTINGS_KEY = "peeksnap_settings";

// ── View switching ────────────────────────────────────────────────────────────

const mainView    = document.getElementById("main-view");
const managerView = document.getElementById("manager-view");

function showMain() {
  document.body.classList.remove("manager-active");
  managerView.classList.add("hidden");
  mainView.classList.remove("hidden");
  resetClearAllConfirm();
}

function showManager() {
  document.body.classList.add("manager-active");
  mainView.classList.add("hidden");
  managerView.classList.remove("hidden");
  loadManagerSnippets();
}

document.getElementById("back-btn").addEventListener("click", showMain);
document.getElementById("manage-btn").addEventListener("click", showManager);

// ── Capture ──────────────────────────────────────────────────────────────────

document.getElementById("capture-btn").addEventListener("click", async () => {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    await browser.tabs.sendMessage(tab.id, { action: "activate_selection" });
  } catch (err) {
    // Tab may not have a content script (e.g. about:blank, PDF)
    console.error("PeekSnap: could not activate selection —", err.message);
  } finally {
    // CRITICAL: must close popup so it doesn't block mouse events during drag
    window.close();
  }
});

// ── Settings panel toggle ─────────────────────────────────────────────────────

const settingsToggle = document.getElementById("settings-toggle");
const settingsPanel  = document.getElementById("settings-panel");

settingsToggle.addEventListener("click", () => {
  settingsToggle.classList.toggle("open");
  settingsPanel.classList.toggle("open");
});

// ── Color management ──────────────────────────────────────────────────────────

async function loadColors() {
  const data = await browser.storage.local.get(SETTINGS_KEY);
  return data[SETTINGS_KEY]?.tagColors ?? [...DEFAULT_COLORS];
}

async function saveColors(colors) {
  const data = await browser.storage.local.get(SETTINGS_KEY);
  const settings = data[SETTINGS_KEY] || {};
  await browser.storage.local.set({ [SETTINGS_KEY]: { ...settings, tagColors: colors } });
}

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

const addColorBtn = document.getElementById("add-color-btn");

async function renderSwatches() {
  const colors = await loadColors();
  const container = document.getElementById("color-swatches");

  while (container.firstChild) container.removeChild(container.firstChild);

  colors.forEach((color) => {
    const swatch = document.createElement("div");
    swatch.className = "swatch";
    swatch.style.background = color;
    swatch.title = color;
    container.appendChild(swatch);
  });

  const atMax = colors.length >= 5;
  addColorBtn.disabled = atMax;
  addColorBtn.title = atMax ? "Maximum of 5 colors" : "";
  addColorBtn.textContent = atMax ? "Max 5" : "+ Add";
}

addColorBtn.addEventListener("click", async () => {
  const colors = await loadColors();
  if (colors.length >= 5) return;
  colors.push(generateTonalColor(colors));
  await saveColors(colors);
  renderSwatches();
});

document.getElementById("reset-colors-btn").addEventListener("click", async () => {
  await saveColors([...DEFAULT_COLORS]);
  renderSwatches();
});

// ── Manager: snippet list ─────────────────────────────────────────────────────

let _managerSnippets = [];

async function loadManagerSnippets() {
  const list  = document.getElementById("manager-list");
  const empty = document.getElementById("manager-empty");
  list.textContent = "Loading…";
  empty.classList.add("hidden");

  try {
    const response = await browser.runtime.sendMessage({ action: "get_all_snippets" });
    _managerSnippets = response.snippets ?? [];
    renderManagerList();
  } catch (err) {
    list.textContent = "";
    empty.textContent = "Could not load snaps.";
    empty.classList.remove("hidden");
  }
}

function renderManagerList() {
  const list  = document.getElementById("manager-list");
  const empty = document.getElementById("manager-empty");
  const clearBtn = document.getElementById("clear-all-popup-btn");
  list.textContent = "";

  if (!_managerSnippets.length) {
    empty.textContent = "No snaps saved yet.";
    empty.classList.remove("hidden");
    clearBtn.disabled = true;
    clearBtn.style.opacity = "0.4";
    return;
  }

  empty.classList.add("hidden");
  clearBtn.disabled = false;
  clearBtn.style.opacity = "";

  // Group by hostname
  const groups = new Map();
  for (const s of _managerSnippets) {
    let host;
    try { host = new URL(s.pageUrl).hostname; } catch { host = s.pageUrl; }
    if (!groups.has(host)) groups.set(host, []);
    groups.get(host).push(s);
  }

  for (const [host, snippets] of groups) {
    const group = document.createElement("div");
    group.className = "manager-group";

    const label = document.createElement("div");
    label.className = "manager-group-label";
    label.textContent = host;
    label.title = host;
    group.appendChild(label);

    for (const snippet of snippets) {
      group.appendChild(buildManagerItem(snippet));
    }
    list.appendChild(group);
  }
}

function buildManagerItem(snippet) {
  const item = document.createElement("div");
  item.className = "manager-item";
  item.dataset.snippetId = snippet.id;

  const colorDot = document.createElement("div");
  colorDot.className = "manager-color-dot";
  if (snippet.colorTag) colorDot.style.background = snippet.colorTag;

  const thumb = document.createElement("img");
  thumb.className = "manager-thumb";
  thumb.src = snippet.thumbDataUrl || "";
  thumb.alt = "";

  const info = document.createElement("div");
  info.className = "manager-info";

  const name = document.createElement("div");
  name.className = "manager-name";
  const primaryLabel = snippet.name || snippet.label || "Untitled";
  name.textContent = primaryLabel;
  name.title = primaryLabel;

  const date = new Date(snippet.createdAt);
  const dateStr =
    date.toLocaleDateString(undefined, { month: "short", day: "numeric" }) +
    " " +
    date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

  const dateEl = document.createElement("div");
  dateEl.className = "manager-date";
  dateEl.textContent = dateStr;

  info.appendChild(name);
  info.appendChild(dateEl);

  const deleteBtn = document.createElement("button");
  deleteBtn.className = "manager-delete-btn";
  deleteBtn.title = "Delete snippet";
  deleteBtn.textContent = "✕";
  deleteBtn.addEventListener("click", () => deleteManagerSnippet(snippet.id, item));

  item.appendChild(colorDot);
  item.appendChild(thumb);
  item.appendChild(info);
  item.appendChild(deleteBtn);
  return item;
}

async function deleteManagerSnippet(id, itemEl) {
  await browser.runtime.sendMessage({ action: "delete_snippet", id });
  _managerSnippets = _managerSnippets.filter((s) => s.id !== id);

  // Remove the item row; if its group is now empty, remove the group too
  const group = itemEl.closest(".manager-group");
  itemEl.remove();
  if (group && !group.querySelector(".manager-item")) group.remove();

  // Re-evaluate empty state and button
  if (!_managerSnippets.length) renderManagerList();
}

// ── Manager: Clear All ────────────────────────────────────────────────────────

const clearAllPopupBtn = document.getElementById("clear-all-popup-btn");

function resetClearAllConfirm() {
  clearAllPopupBtn.textContent = "Clear All";
  delete clearAllPopupBtn.dataset.confirming;
}

clearAllPopupBtn.addEventListener("click", async () => {
  if (!clearAllPopupBtn.dataset.confirming) {
    // First click — ask for confirmation
    clearAllPopupBtn.dataset.confirming = "1";
    clearAllPopupBtn.textContent = "Sure?";
    setTimeout(resetClearAllConfirm, 3000); // auto-reset after 3 s
    return;
  }

  resetClearAllConfirm();
  await browser.runtime.sendMessage({ action: "clear_all_snippets" });
  _managerSnippets = [];
  renderManagerList();
});

// ── Init ──────────────────────────────────────────────────────────────────────

renderSwatches();
