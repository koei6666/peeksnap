/**
 * popup.js — PeekSnap toolbar popup script.
 *
 * Two responsibilities:
 *   1. "Capture Region" button: send activate_selection to active tab, then
 *      close popup immediately (critical — popup blocks mouse events during drag).
 *   2. "Tag Colors" settings panel: load/save preset colors in
 *      browser.storage.local["peeksnap_settings"].
 */

const DEFAULT_COLORS = ["#fde047", "#22d3ee", "#f0abfc"];
const SETTINGS_KEY = "peeksnap_settings";

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
const settingsPanel = document.getElementById("settings-panel");

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
  // Average saturation + lightness of the existing palette for tonal consistency
  const avgS = hsls.reduce((sum, [, s]) => sum + s, 0) / hsls.length;
  const avgL = hsls.reduce((sum, [, , l]) => sum + l, 0) / hsls.length;
  const existingHues = hsls.map(([h]) => h);

  // Try up to 20 random hues; pick first one that's ≥30° away from all existing
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
  // Fallback if all hues are crowded
  return hslToHex(Math.random() * 360, Math.max(70, avgS), Math.max(65, avgL));
}

const addColorBtn = document.getElementById("add-color-btn");

async function renderSwatches() {
  const colors = await loadColors();
  const container = document.getElementById("color-swatches");

  // Clear previous swatches
  while (container.firstChild) container.removeChild(container.firstChild);

  colors.forEach((color) => {
    const swatch = document.createElement("div");
    swatch.className = "swatch";
    swatch.style.background = color;
    swatch.title = color;
    container.appendChild(swatch);
  });

  // Update "+ Add" button state
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

// Initial render
renderSwatches();
