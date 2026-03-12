/**
 * @file app.js
 * @description Pi System Monitor — application logic.
 *
 * Architecture overview
 * ─────────────────────
 *  CONFIG          All magic numbers (thresholds, timings, defaults). Edit here only.
 *  State           Module-level variables that represent the current app state.
 *  el              Cached DOM references gathered once at startup.
 *  Settings        loadSettings() / persistSettings() — localStorage I/O.
 *  Formatters      Pure functions: numbers → display strings. No side effects.
 *  Classifiers     Pure functions: numbers → CSS class names. No side effects.
 *  UI Controllers  Functions that write to the DOM. Named update…/show…/set…/sync….
 *  API Client      fetchMetrics() — network only; throws typed errors on failure.
 *  Poll Loop       poll() — orchestrates fetch → updateDashboard / handleNetworkError.
 *  Event Listeners All addEventListener calls in one block at the bottom.
 *  Init            Startup calls after the DOM is ready.
 *
 * Adding a new metric
 * ───────────────────
 *  1. Add a static row in index.html (or let it be injected dynamically).
 *  2. Add a threshold entry in CONFIG.thresholds if needed.
 *  3. Call updateBar() inside updateDashboard() with the new element IDs.
 *
 * Changing the API endpoint at runtime
 * ─────────────────────────────────────
 *  Click the host label in the footer, or open Settings → Endpoint.
 *  The new URL is normalised, persisted to localStorage, and polling restarts.
 */

'use strict';

// ── CONFIGURATION ─────────────────────────────────────────────────────────────
/**
 * Central configuration object.  ALL magic numbers live here.
 * Never hard-code thresholds, timings, or defaults elsewhere in the file.
 *
 * @namespace CONFIG
 * @property {object} polling
 * @property {number} polling.interval  - Milliseconds between API polls.
 * @property {number} polling.timeout   - Milliseconds before a fetch is force-aborted.
 * @property {object} thresholds
 * @property {object} thresholds.temp   - Temperature thresholds in °C.
 * @property {number} thresholds.temp.warm  - Above this → amber colour.
 * @property {number} thresholds.temp.hot   - Above this → red colour.
 * @property {object} thresholds.usage  - Usage percentage thresholds (bars, RAM, disks).
 * @property {number} thresholds.usage.warn - Above this → amber bar.
 * @property {number} thresholds.usage.hot  - Above this → red bar.
 * @property {object} defaults
 * @property {string} defaults.url      - API base URL used when localStorage is empty.
 * @property {object} valCandidates     - Widest expected value strings per display mode,
 *                                        used by canvas measureText to size the value column.
 * @property {string[]} valCandidates.size - Sample strings for used/total size mode.
 * @property {string[]} valCandidates.pct  - Sample strings for percentage mode.
 */
const CONFIG = {
  polling: {
    interval: 2000,   // ms
    timeout:  5000,   // ms — after this, fetchMetrics() throws "Request timed out"
  },
  thresholds: {
    temp:  { warm: 55, hot: 75 },   // °C
    usage: { warn: 65, hot: 85 },   // %
  },
  defaults: {
    url: 'http://raspberrypi:7777/',
  },
  valCandidates: {
    size: ['114/183G', '8.00/16.0T', '114/1.8T'],
    pct:  ['100%'],
  },
};

// ── LOCAL STORAGE KEYS ────────────────────────────────────────────────────────
// String constants prevent typo-bugs when reading/writing localStorage.
/** @constant {string} */ const LS_URL      = 'pi_apiUrl';
/** @constant {string} */ const LS_DISKS    = 'pi_diskNames';
/** @constant {string} */ const LS_DISK_PCT = 'pi_diskShowPct';

// ── SETTINGS PERSISTENCE ──────────────────────────────────────────────────────
/**
 * Reads persisted settings from localStorage, falling back to CONFIG defaults.
 * Call once at startup to initialise the mutable state variables below.
 *
 * @returns {{ apiUrl: string, diskNames: Object.<string,string>, diskShowPct: boolean }}
 */
function loadSettings() {
  return {
    apiUrl:      localStorage.getItem(LS_URL) || CONFIG.defaults.url,
    diskNames:   JSON.parse(localStorage.getItem(LS_DISKS) || '{}'),
    diskShowPct: localStorage.getItem(LS_DISK_PCT) === 'true',
  };
}

/**
 * Writes the current mutable state variables to localStorage.
 * Called whenever apiUrl, diskNames, or diskShowPct changes.
 */
function persistSettings() {
  localStorage.setItem(LS_URL,      apiUrl);
  localStorage.setItem(LS_DISKS,    JSON.stringify(diskNames));
  localStorage.setItem(LS_DISK_PCT, diskShowPct ? 'true' : 'false');
}

// ── APPLICATION STATE ─────────────────────────────────────────────────────────
// Mutable module-level state.  Only UI controllers and the poll loop write here.
let { apiUrl, diskNames, diskShowPct } = loadSettings();
/** @type {string[]}  Mount paths whose rows are currently rendered in the metrics table. */
let knownDisks     = [];
/** @type {string[]}  Previous poll's mount list — used to detect changes for rename fields. */
let lastDiskMounts = [];
/** @type {object[]}  Latest disk objects received from the API. */
let lastDiskData   = [];
/** @type {object|null} Latest RAM object received from the API. */
let lastRamData    = null;
/** @type {boolean}   True while the API is unreachable; cleared on successful reconnect. */
let wasOffline     = false;
/** @type {number|null} setInterval handle for the poll loop. */
let pollingTimer   = null;

// ── DOM REFERENCES ────────────────────────────────────────────────────────────
/**
 * All DOM nodes used by the application, gathered once at startup.
 * Using a single `el` object prevents repeated getElementById calls in hot paths
 * and makes every dependency visible at a glance.
 *
 * @namespace el
 */
const el = {
  // Header
  statusDot:        document.getElementById('statusDot'),
  // Main
  tempVal:          document.getElementById('tempVal'),
  metrics:          document.querySelector('.metrics'),
  metricsContainer: document.getElementById('metricsContainer'),
  // Footer — normal state
  lastUpdate:       document.getElementById('lastUpdate'),
  footerIp:         document.getElementById('footerIp'),
  footerNormal:     document.getElementById('footerNormal'),
  footerUrlEdit:    document.getElementById('footerUrlEdit'),
  footerUrlInput:   document.getElementById('footerUrlInput'),
  // Footer — error state
  footerErr:        document.getElementById('footerErr'),
  errMsg:           document.getElementById('errMsg'),
  errUrlInput:      document.getElementById('errUrlInput'),
  // Settings overlay
  settingsOverlay:  document.getElementById('settingsOverlay'),
  sApiUrl:          document.getElementById('s-apiUrl'),
  sDiskPct:         document.getElementById('s-diskPct'),
  diskRenameFields: document.getElementById('diskRenameFields'),
  // HTML <template> elements — cloned by createDiskRow() / createDiskField()
  tplDiskRow:       document.getElementById('tpl-disk-row'),
  tplDiskField:     document.getElementById('tpl-disk-field'),
};

// ── URL UTILITIES ─────────────────────────────────────────────────────────────
/**
 * Ensures a URL string ends with a trailing slash.
 * The tempd API requires one for correct routing.
 *
 * @param {string} raw - Raw user-supplied URL string.
 * @returns {string} Normalised URL with trailing slash.
 */
function normaliseUrl(raw) {
  const s = raw.trim();
  return s.endsWith('/') ? s : s + '/';
}

/**
 * Extracts the `host:port` portion from a full URL string.
 * Used to display a compact label in the footer without showing the full path.
 *
 * @param {string} url - A full URL string, e.g. "http://raspberrypi:7777/".
 * @returns {string} The host (and port if non-standard), or the raw string on parse failure.
 */
function hostFromUrl(url) {
  try { return new URL(url).host; } catch { return url; }
}

// ── FORMAT HELPERS ────────────────────────────────────────────────────────────
// Pure functions: input → display string.  No DOM access, no side effects.

/**
 * Formats a gigabyte value into the most readable unit string.
 * Breakpoints: ≥1000 GB → TB (1 decimal), ≥100 GB → G (0 decimal),
 * ≥10 GB → G (1 decimal), else G (2 decimal).
 *
 * @param {number} gb - Size in gigabytes.
 * @returns {string} Formatted string, e.g. "1.8T", "183G", "14.3G", "8.00G".
 */
function fmtSize(gb) {
  if (gb >= 1000) return (gb / 1000).toFixed(1) + 'T';
  if (gb >= 100)  return gb.toFixed(0) + 'G';
  if (gb >= 10)   return gb.toFixed(1) + 'G';
  return gb.toFixed(2) + 'G';
}

/**
 * Returns the display label for a disk metric value based on the current display mode.
 * Reads the module-level `diskShowPct` flag.
 *
 * @param {{ used_gb: number, total_gb: number, percent: number }} disk - Disk data object.
 * @returns {string} E.g. "14.3/183G" (size mode) or "8%" (pct mode).
 */
function diskValLabel(disk) {
  return diskShowPct
    ? disk.percent.toFixed(0) + '%'
    : fmtSize(disk.used_gb) + '/' + fmtSize(disk.total_gb);
}

/**
 * Returns the display label for the RAM metric value based on the current display mode.
 * Automatically selects GB or MB depending on total RAM size.
 * Reads the module-level `diskShowPct` flag.
 *
 * @param {{ used_mb: number, total_mb: number, percent: number }} ram - RAM data object.
 * @returns {string} E.g. "3.1/7.6G", "512/1024M", or "41%" (pct mode).
 */
function ramValLabel(ram) {
  if (diskShowPct) return ram.percent.toFixed(0) + '%';
  return ram.total_mb >= 1024
    ? (ram.used_mb / 1024).toFixed(1) + '/' + (ram.total_mb / 1024).toFixed(1) + 'G'
    : ram.used_mb.toFixed(0) + '/' + ram.total_mb.toFixed(0) + 'M';
}

/**
 * Converts a mount path into a safe HTML element ID string.
 * Replaces slashes with underscores and strips non-alphanumeric characters.
 *
 * @param {string} mount - Mount path, e.g. "/mnt/nas-bastian".
 * @returns {string} Safe ID string, e.g. "disk__mnt_nasbastian".
 */
function diskRowId(mount) {
  return 'disk_' + mount.replace(/\//g, '_').replace(/[^a-z0-9_]/gi, '');
}

/**
 * Returns the display label for a disk row, preferring any user-defined custom name.
 *
 * @param {{ mount: string, label: string }} disk - Disk object from the API.
 * @returns {string} Custom label if set, otherwise the auto-derived label — always uppercase.
 */
function diskDisplayLabel(disk) {
  return (diskNames[disk.mount] || disk.label).toUpperCase();
}

/**
 * Derives an automatic label from a mount path by taking the last path component.
 * Used as a fallback when no custom name has been set.
 *
 * @param {string} mount - Mount path, e.g. "/mnt/nas-bastian".
 * @returns {string} Uppercase last component, e.g. "NAS-BASTIAN", or "ROOT" for "/".
 */
function mountAutoLabel(mount) {
  return (mount.split('/').filter(Boolean).pop() || 'ROOT').toUpperCase();
}

// ── CLASSIFIERS ───────────────────────────────────────────────────────────────
// Pure functions: number → CSS class name string.  Thresholds sourced from CONFIG.

/**
 * Returns the CSS modifier class for a usage percentage bar.
 * Thresholds are defined in CONFIG.thresholds.usage.
 *
 * @param {number} pct - Usage percentage (0–100).
 * @returns {'hot'|'warn'|''} CSS class suffix to append to .metric-bar-fill.
 */
function barClass(pct) {
  if (pct >= CONFIG.thresholds.usage.hot)  return 'hot';
  if (pct >= CONFIG.thresholds.usage.warn) return 'warn';
  return '';
}

/**
 * Returns the CSS modifier class for the temperature display.
 * Thresholds are defined in CONFIG.thresholds.temp.
 *
 * @param {number} t - Temperature in °C.
 * @returns {'hot'|'warm'|''} CSS class suffix to append to .temp-value.
 */
function tempClass(t) {
  if (t >= CONFIG.thresholds.temp.hot)  return 'hot';
  if (t >= CONFIG.thresholds.temp.warm) return 'warm';
  return '';
}

// ── UI CONTROLLER: PROGRESS BAR ───────────────────────────────────────────────
/**
 * Updates a metric progress bar's fill width, colour class, and value label.
 *
 * Width is applied via the CSS custom property `--bar-fill` on the fill element,
 * not via `style.width`.  This keeps transition and appearance logic in CSS while
 * JS only sets the data value.
 *
 * @param {HTMLElement} barEl  - The `.metric-bar-fill` element to update.
 * @param {HTMLElement} valEl  - The `.metric-val` text label element to update.
 * @param {number}      pct    - Usage percentage (0–100); clamped to 100 internally.
 * @param {string}      label  - The formatted string to show in the value column.
 */
function updateBar(barEl, valEl, pct, label) {
  barEl.style.setProperty('--bar-fill', Math.min(100, pct) + '%');
  barEl.className   = 'metric-bar-fill ' + barClass(pct);
  valEl.textContent = label;
}

/**
 * Recalculates and sets the `--val-w` CSS variable on the metrics container so the
 * value column is exactly wide enough for the widest possible value string.
 *
 * Uses an off-screen Canvas to measure text with the actual Orbitron font metrics.
 * This avoids both clipping and wasted space without any trial-and-error CSS sizing.
 * Called on init, on font load, on window resize, and whenever the display mode changes.
 */
function updateValColumn() {
  const vw       = window.innerWidth / 100;
  const fontSize = Math.min(13, Math.max(8, 2.4 * vw));
  const canvas   = document.createElement('canvas');
  const ctx      = canvas.getContext('2d');
  ctx.font       = `700 ${fontSize}px Orbitron, monospace`;

  const candidates = diskShowPct
    ? CONFIG.valCandidates.pct
    : CONFIG.valCandidates.size;

  const maxPx = Math.ceil(
    candidates.reduce((max, s) => Math.max(max, ctx.measureText(s).width), 0)
  ) + 4; // +4 px padding buffer

  el.metrics.style.setProperty('--val-w', maxPx + 'px');
  el.metrics.classList.toggle('pct-mode', diskShowPct);
}

// ── UI CONTROLLER: TEMPERATURE ────────────────────────────────────────────────
/**
 * Updates the temperature display with a live reading.
 * Applies a colour class (warm/hot/none) based on CONFIG.thresholds.temp.
 *
 * @param {number} temp - Temperature in °C.
 */
function updateTempState(temp) {
  el.tempVal.className   = 'temp-value ' + tempClass(temp);
  el.tempVal.textContent = temp.toFixed(1);
}

/**
 * Sets the temperature display to its offline/dead state ("--.-", dimmed colour).
 * Called by handleNetworkError() whenever a fetch fails.
 */
function setTempDead() {
  el.tempVal.className   = 'temp-value dead';
  el.tempVal.textContent = '--.-';
}

// ── UI CONTROLLER: FOOTER ─────────────────────────────────────────────────────
/**
 * Switches the footer to its normal (online) state.
 * Updates the host label to reflect the current `apiUrl`.
 * Hides the error footer if it was previously visible.
 */
function showNormalFooter() {
  el.footerIp.textContent       = hostFromUrl(apiUrl);
  el.footerNormal.style.display = '';
  el.footerErr.style.display    = 'none';
}

/**
 * Switches the footer to its error state, displaying the error message and a
 * pre-filled URL input so the user can correct the endpoint immediately.
 * Does not overwrite the URL input if the user is actively editing it.
 *
 * @param {string} message - Short error description to display, e.g. "Request timed out".
 */
function showErrorFooter(message) {
  el.errMsg.textContent = 'ERR: ' + message;
  if (document.activeElement !== el.errUrlInput) el.errUrlInput.value = apiUrl;
  el.footerNormal.style.display = 'none';
  el.footerErr.style.display    = '';
}

// ── UI CONTROLLER: DISPLAY MODE ───────────────────────────────────────────────
/**
 * Switches between size mode (used/total) and percentage mode for RAM and all disks.
 * Persists the new mode to localStorage and immediately refreshes all value labels.
 *
 * @param {boolean} showPct - True to show percentages; false to show used/total sizes.
 */
function setDisplayMode(showPct) {
  diskShowPct         = showPct;
  el.sDiskPct.checked = diskShowPct;
  persistSettings();
  updateValColumn();
  refreshRamVal();
  refreshDiskVals();
}

/**
 * Toggles the display mode between size and percentage.
 * Bound to click events on the RAM value label and each disk value label.
 */
function toggleDisplayMode() { setDisplayMode(!diskShowPct); }

/**
 * Re-renders the RAM value label using the latest cached RAM data.
 * Called after a display mode change to avoid waiting for the next API poll.
 */
function refreshRamVal() {
  if (!lastRamData) return;
  document.getElementById('ramVal').textContent = ramValLabel(lastRamData);
}

/**
 * Re-renders every disk value label using the latest cached disk data.
 * Called after a display mode change to avoid waiting for the next API poll.
 */
function refreshDiskVals() {
  lastDiskData.forEach(disk => {
    const valEl = document.getElementById(diskRowId(disk.mount) + '_val');
    if (valEl) valEl.textContent = diskValLabel(disk);
  });
}

// ── UI CONTROLLER: DISK ROWS ──────────────────────────────────────────────────
/**
 * Creates a new metric row element for a disk by cloning the `#tpl-disk-row` template.
 *
 * Using a `<template>` element (rather than innerHTML string injection) ensures:
 *  - No XSS risk if mount paths or labels contain HTML-special characters.
 *  - Markup changes only need to be made in index.html, not in JS strings.
 *  - Event listeners are attached to real elements, not re-parsed HTML.
 *
 * @param {string} id - The element ID to assign to the row (derived via diskRowId()).
 * @returns {HTMLElement} A fully wired `.metric-row` element, ready to append to the DOM.
 */
function createDiskRow(id) {
  const fragment = el.tplDiskRow.content.cloneNode(true);
  const row      = fragment.querySelector('.metric-row');
  const bar      = fragment.querySelector('.metric-bar-fill');
  const val      = fragment.querySelector('.metric-val');

  row.id = id;
  bar.id = id + '_bar';
  val.id = id + '_val';
  val.addEventListener('click', toggleDisplayMode);

  return row;
}

/**
 * Reconciles the rendered disk rows in the metrics table with the latest API data.
 *
 * Strategy:
 *  - Remove rows for any mount paths absent from the new data.
 *  - Create rows for any mount paths not yet rendered.
 *  - Update bar fill, colour class, and value label for all rows.
 *  - Trigger rename field rebuild only when the set of mount paths actually changes,
 *    avoiding unnecessary DOM churn on every poll.
 *
 * @param {{ mount: string, label: string, used_gb: number, total_gb: number, percent: number }[]} disks
 *   Array of disk objects as returned by the tempd API.
 */
function syncDiskRows(disks) {
  const incomingMounts = disks.map(d => d.mount);

  // Remove rows whose mount paths are no longer in the API response
  knownDisks
    .filter(m => !incomingMounts.includes(m))
    .forEach(m => document.getElementById(diskRowId(m))?.remove());

  // Add new rows and update all existing ones
  disks.forEach(disk => {
    const id  = diskRowId(disk.mount);
    let   row = document.getElementById(id);

    if (!row) {
      row = createDiskRow(id);
      el.metricsContainer.appendChild(row);
    }

    row.querySelector('.metric-label').textContent = diskDisplayLabel(disk);
    updateBar(
      document.getElementById(id + '_bar'),
      document.getElementById(id + '_val'),
      disk.percent,
      diskValLabel(disk)
    );
  });

  knownDisks   = incomingMounts;
  lastDiskData = disks.slice();

  // Rebuild rename fields only when the mount list actually changes
  if (JSON.stringify(incomingMounts) !== JSON.stringify(lastDiskMounts)) {
    lastDiskMounts = incomingMounts.slice();
    syncDiskRenameFields(disks);
  }
}

// ── UI CONTROLLER: SETTINGS OVERLAY ──────────────────────────────────────────
/**
 * Opens the settings overlay and populates all input fields with the current state.
 * Rebuilds disk rename fields from the latest cached disk data.
 */
function openSettings() {
  el.sApiUrl.value    = apiUrl;
  el.sDiskPct.checked = diskShowPct;
  syncDiskRenameFields(lastDiskData);
  el.settingsOverlay.classList.add('open');
}

/**
 * Closes the settings overlay without saving any unsaved changes.
 * Note: per-disk SAVE buttons write to state immediately when clicked,
 * so those changes are already persisted before this function is called.
 */
function closeSettings() {
  el.settingsOverlay.classList.remove('open');
}

/**
 * Creates a rename field widget for one disk by cloning the `#tpl-disk-field` template.
 * See createDiskRow() for rationale on using <template> over innerHTML.
 *
 * @param {{ mount: string, label: string, used_gb: number, total_gb: number, percent: number }} disk
 *   Disk object as returned by the API.
 * @returns {HTMLElement} A `.disk-field-wrap` element ready to append to diskRenameFields.
 */
function createDiskField(disk) {
  const fieldId  = 'rename_' + diskRowId(disk.mount);
  const current  = diskNames[disk.mount] || disk.label;
  const fragment = el.tplDiskField.content.cloneNode(true);
  const wrap     = fragment.querySelector('.disk-field-wrap');

  wrap.querySelector('.disk-field-mount').textContent = disk.mount;
  wrap.querySelector('.disk-field-size').textContent  =
    `${fmtSize(disk.used_gb)}/${fmtSize(disk.total_gb)} · ${disk.percent}%`;

  const input       = wrap.querySelector('.s-input');
  input.id          = fieldId;
  input.value       = current;
  input.placeholder = disk.label;

  wrap.querySelector('.s-btn').addEventListener('click', () => saveDiskLabel(disk.mount, fieldId));

  return wrap;
}

/**
 * Rebuilds the entire disk rename section in settings from scratch.
 * Shows a placeholder notice if no disks have been detected yet.
 *
 * @param {object[]} disks - Array of disk objects from the latest API response (may be empty).
 */
function syncDiskRenameFields(disks) {
  el.diskRenameFields.replaceChildren();

  if (!disks?.length) {
    const notice       = document.createElement('div');
    notice.className   = 's-empty-notice';
    notice.textContent = 'No disks detected.';
    el.diskRenameFields.appendChild(notice);
    return;
  }

  disks.forEach(disk => el.diskRenameFields.appendChild(createDiskField(disk)));
}

/**
 * Reads and saves a single disk's custom label from its rename input field.
 * Immediately updates the corresponding metric row label in the live dashboard.
 * Deletes the custom entry (reverting to auto-label) if the input is cleared.
 *
 * @param {string} mount   - Mount path used as the key in `diskNames`.
 * @param {string} fieldId - The ID of the `<input>` element to read the value from.
 */
function saveDiskLabel(mount, fieldId) {
  const input = document.getElementById(fieldId);
  if (!input) return;
  const val = input.value.trim();
  if (val) diskNames[mount] = val.toUpperCase();
  else     delete diskNames[mount];
  persistSettings();

  const row = document.getElementById(diskRowId(mount));
  if (row) row.querySelector('.metric-label').textContent =
    diskNames[mount] || mountAutoLabel(mount);
}

/**
 * Saves all settings fields at once: endpoint URL, display mode, and all disk labels.
 * Persists to localStorage, refreshes the entire UI, closes the overlay,
 * and restarts polling against the (potentially new) endpoint.
 * Bound to the "SAVE & CLOSE" button.
 */
function saveAllSettings() {
  const urlVal = el.sApiUrl.value.trim();
  if (urlVal) apiUrl = normaliseUrl(urlVal);

  diskShowPct = el.sDiskPct.checked;

  knownDisks.forEach(mount => {
    const input = document.getElementById('rename_' + diskRowId(mount));
    if (input?.value.trim()) diskNames[mount] = input.value.trim().toUpperCase();
    else                     delete diskNames[mount];

    const row = document.getElementById(diskRowId(mount));
    if (row) row.querySelector('.metric-label').textContent =
      diskNames[mount] || mountAutoLabel(mount);
  });

  persistSettings();
  showNormalFooter();
  updateValColumn();
  refreshRamVal();
  refreshDiskVals();
  closeSettings();
  restartPolling();
}

/**
 * Clears all localStorage keys and resets every state variable and UI input to
 * factory defaults.  Prompts for confirmation before proceeding.
 * Bound to the "RESET ALL" button.
 */
function resetSettings() {
  if (!confirm('Reset all settings to defaults?')) return;
  localStorage.removeItem(LS_URL);
  localStorage.removeItem(LS_DISKS);
  localStorage.removeItem(LS_DISK_PCT);
  apiUrl              = CONFIG.defaults.url;
  diskNames           = {};
  diskShowPct         = false;
  el.sApiUrl.value    = apiUrl;
  el.sDiskPct.checked = false;
  showNormalFooter();
  syncDiskRenameFields(lastDiskData);
  updateValColumn();
  refreshRamVal();
  refreshDiskVals();
  closeSettings();
}

// ── UI CONTROLLER: FOOTER URL EDIT ────────────────────────────────────────────
/**
 * Opens the inline URL editor embedded in the normal footer bar.
 * Hides the host label and timestamp; reveals and focuses the input field.
 */
function openFooterEdit() {
  el.footerUrlInput.value      = apiUrl;
  el.footerIp.style.display    = 'none';
  el.lastUpdate.style.display  = 'none';
  el.footerUrlEdit.classList.add('active');
  el.footerUrlInput.focus();
  el.footerUrlInput.select();
}

/**
 * Closes the inline URL editor, restoring the normal footer layout
 * (host label and timestamp visible, input hidden).
 */
function closeFooterEdit() {
  el.footerIp.style.display   = '';
  el.lastUpdate.style.display = '';
  el.footerUrlEdit.classList.remove('active');
}

/**
 * Reads the footer URL input value, closes the editor, and applies the new URL.
 * Bound to the ↵ confirm button and the Enter key inside the footer input.
 */
function applyFooterUrl() {
  const val = el.footerUrlInput.value.trim();
  closeFooterEdit();
  if (val) applyNewUrl(val);
}

// ── POLLING ───────────────────────────────────────────────────────────────────
/**
 * Stops the active polling interval, fires one immediate fetch, then restarts
 * the interval at CONFIG.polling.interval.
 * Called whenever the API URL changes so the new endpoint is hit immediately.
 */
function restartPolling() {
  clearInterval(pollingTimer);
  poll();
  pollingTimer = setInterval(poll, CONFIG.polling.interval);
}

/**
 * Normalises a raw URL string, persists it, updates the settings input field,
 * and calls restartPolling() to begin fetching from the new endpoint.
 *
 * @param {string} raw - User-supplied URL string (may lack a trailing slash).
 */
function applyNewUrl(raw) {
  if (!raw.trim()) return;
  apiUrl           = normaliseUrl(raw);
  persistSettings();
  el.sApiUrl.value = apiUrl;
  restartPolling();
}

// ── API CLIENT ────────────────────────────────────────────────────────────────
/**
 * Fetches and parses the JSON metrics payload from the tempd API.
 *
 * Single responsibility: network I/O only.  Does not touch the DOM.
 *
 * Error discrimination — the error message is shown verbatim in the footer,
 * so each failure mode produces a distinct, user-readable string:
 *
 *  | Condition                              | Error message thrown       |
 *  |----------------------------------------|----------------------------|
 *  | AbortSignal timeout fires              | "Request timed out"        |
 *  | Network down / DNS failure / refused   | "Server unreachable"       |
 *  | Server responds with HTTP error status | "HTTP 404" (etc.)          |
 *
 * AbortError vs TimeoutError: AbortSignal.timeout() throws a TimeoutError in
 * modern browsers (name === 'TimeoutError') and an AbortError in older ones
 * (name === 'AbortError').  We check both for broad compatibility.
 *
 * @async
 * @throws {Error} With a human-readable `.message` in all failure cases.
 * @returns {Promise<{ temp: number, cpu: number, ram: object, disks: object[] }>}
 *   Parsed JSON payload from the API.
 */
async function fetchMetrics() {
  let res;
  try {
    res = await fetch(apiUrl, {
      signal: AbortSignal.timeout(CONFIG.polling.timeout),
    });
  } catch (err) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error('Request timed out');
    }
    // TypeError: Failed to fetch — DNS failure, refused connection, network down
    throw new Error('Server unreachable');
  }

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// ── DASHBOARD UPDATER ─────────────────────────────────────────────────────────
/**
 * Takes a fully parsed API response and delegates each metric to its UI controller.
 *
 * Single responsibility: routing data to the correct controller.
 * Does not perform any network requests.
 *
 * @param {{ temp: number, cpu: number, ram: object, disks: object[] }} data
 *   Parsed response object from fetchMetrics().
 */
function updateDashboard(data) {
  updateTempState(parseFloat(data.temp));

  updateBar(
    document.getElementById('cpuBar'),
    document.getElementById('cpuVal'),
    data.cpu,
    data.cpu.toFixed(0) + '%'
  );

  lastRamData = data.ram;
  updateBar(
    document.getElementById('ramBar'),
    document.getElementById('ramVal'),
    data.ram.percent,
    ramValLabel(data.ram)
  );

  syncDiskRows(data.disks);
  updateValColumn();
}

// ── ERROR HANDLER ─────────────────────────────────────────────────────────────
/**
 * Puts the entire UI into its offline/error state.
 *
 * Single responsibility: error presentation only.
 * Does not perform any network requests.
 *
 * @param {Error} err - The error thrown by fetchMetrics().
 *   Its `.message` property is displayed verbatim in the error footer.
 */
function handleNetworkError(err) {
  wasOffline                = true;
  setTempDead();
  el.statusDot.className    = 'status-dot offline';
  el.lastUpdate.textContent = 'offline';
  showErrorFooter(err.message || 'no connection');
}

// ── POLL LOOP ─────────────────────────────────────────────────────────────────
/**
 * Main poll function, called on every tick of `pollingTimer`.
 *
 * Orchestration only: sets the fetching indicator, calls fetchMetrics(),
 * and routes the result to updateDashboard() or handleNetworkError().
 *
 * On reconnect after an outage, all disk rows are removed and the tracking
 * state is reset so syncDiskRows() starts from a blank slate.  This prevents
 * stale IDs or mismatched mount lists from a previous session surviving a
 * Pi reboot or remount.
 *
 * @async
 */
async function poll() {
  el.statusDot.className = 'status-dot fetching';

  try {
    const data = await fetchMetrics();

    if (wasOffline) {
      // Wipe disk rows so syncDiskRows() rebuilds from scratch on reconnect
      knownDisks.forEach(m => document.getElementById(diskRowId(m))?.remove());
      knownDisks = []; lastDiskMounts = []; lastDiskData = [];
      wasOffline = false;
    }

    updateDashboard(data);

    el.statusDot.className    = 'status-dot';
    el.lastUpdate.textContent = new Date().toLocaleTimeString('de-CH');
    showNormalFooter();

  } catch (err) {
    handleNetworkError(err);
  }
}

// ── EVENT LISTENERS ───────────────────────────────────────────────────────────
// All addEventListener calls are centralised here.
// index.html contains zero inline onclick/onchange/onkeydown attributes.

// Settings overlay
document.getElementById('gearBtn').addEventListener('click', openSettings);
document.getElementById('settingsCloseBtn').addEventListener('click', closeSettings);
document.getElementById('s-saveEndpointBtn').addEventListener('click', () => applyNewUrl(el.sApiUrl.value));
document.getElementById('s-resetBtn').addEventListener('click', resetSettings);
document.getElementById('s-saveAllBtn').addEventListener('click', saveAllSettings);

// Display mode toggle (checkbox in settings + click on any value label)
el.sDiskPct.addEventListener('change', () => setDisplayMode(el.sDiskPct.checked));
document.getElementById('ramVal').addEventListener('click', toggleDisplayMode);

// Footer inline URL editor
el.footerIp.addEventListener('click', openFooterEdit);
document.getElementById('footerUrlApplyBtn').addEventListener('click', applyFooterUrl);
document.getElementById('footerUrlCancelBtn').addEventListener('click', closeFooterEdit);
el.footerUrlInput.addEventListener('keydown', e => {
  if (e.key === 'Enter')  applyFooterUrl();
  if (e.key === 'Escape') closeFooterEdit();
});

// Error footer URL correction input
document.getElementById('errUrlApplyBtn').addEventListener('click', () => applyNewUrl(el.errUrlInput.value));
el.errUrlInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') applyNewUrl(el.errUrlInput.value);
});

// ── INIT ──────────────────────────────────────────────────────────────────────
/**
 * Application entry point.  Called once after the DOM and this script are ready.
 *
 * Startup sequence:
 *  1. Render the footer host label from the persisted/default API URL.
 *  2. Size the value column immediately using monospace fallback metrics —
 *     acceptable for the first frame since Orbitron may not have loaded yet.
 *  3. Re-measure once fonts are confirmed loaded so the column width uses
 *     actual Orbitron glyph metrics (Orbitron is notably wider than monospace).
 *  4. Register a resize listener so the canvas measurement stays accurate if
 *     the widget is resized (e.g. Plasma panel width change).
 *  5. Fire the first API fetch immediately, then start the polling interval.
 *     Interval is started after poll() so the timer period begins from a
 *     successful (or failed) response, not from script execution time.
 */
function init() {
  showNormalFooter();
  updateValColumn();

  document.fonts.ready.then(updateValColumn);
  window.addEventListener('resize', updateValColumn);

  poll();
  pollingTimer = setInterval(poll, CONFIG.polling.interval);
}

init();