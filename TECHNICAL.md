# Pi Monitor — Technical Documentation

This document covers the complete technical architecture: the Pi-side API server (`tempd.py`), the JSON contract between server and client, the widget's internal architecture, configuration reference, state management, and extension guides.

---

## Table of Contents

1. [System Architecture](#1-system-architecture)
2. [API Server — tempd.py](#2-api-server--tempdpy)
3. [JSON API Contract](#3-json-api-contract)
4. [Widget Architecture](#4-widget-architecture)
5. [File Reference](#5-file-reference)
6. [CONFIG Object Reference](#6-config-object-reference)
7. [localStorage Reference](#7-localstorage-reference)
8. [CSS Custom Property Contract](#8-css-custom-property-contract)
9. [Function Reference](#9-function-reference)
10. [Data Flow](#10-data-flow)
11. [Extension Guide](#11-extension-guide)
12. [Known Constraints](#12-known-constraints)

---

## 1. System Architecture

```
┌─────────────────────────────────────────────┐
│  Raspberry Pi                               │
│                                             │
│  tempd.py                                   │
│  ├── reads /proc/stat          (CPU usage)  │
│  ├── reads /proc/meminfo       (RAM)        │
│  ├── reads /proc/mounts        (disks)      │
│  ├── runs vcgencmd measure_temp (temp)      │
│  └── serves JSON on 0.0.0.0:7777           │
└───────────────────┬─────────────────────────┘
                    │  HTTP GET /
                    │  (LAN or Tailscale)
┌───────────────────▼─────────────────────────┐
│  Desktop (CachyOS / any Linux)              │
│                                             │
│  widget-server (python3 -m http.server)     │
│  └── serves pi-monitor/ on localhost:8899   │
│                                             │
│  KDE Plasma Web View applet                 │
│  └── http://localhost:8899/index.html       │
│      ├── index.html  (markup)               │
│      ├── styles.css  (visual design)        │
│      └── app.js      (all logic)            │
└─────────────────────────────────────────────┘
```

Communication is a plain HTTP GET from the browser to the Pi. There is no WebSocket, no authentication, and no HTTPS requirement (both endpoints are on a trusted private network or Tailscale tailnet).

---

## 2. API Server — tempd.py

### Location on Pi
```
/opt/tempd/tempd.py
```

### How it works

`tempd.py` is a single-file Python 3 HTTP server using only the standard library (`http.server`, `subprocess`, `json`, `os`, `time`).

On every `GET /` request it:

1. **Temperature** — calls `vcgencmd measure_temp` via subprocess and parses the `temp=42.3'C` output.
2. **CPU usage** — reads `/proc/stat` twice with a 200 ms sleep between reads, calculates the delta in idle vs. total jiffies to derive a percentage.
3. **RAM** — reads `/proc/meminfo`, extracts `MemTotal` and `MemAvailable`, derives `used = total - available` and a percentage.
4. **Disks** — reads `/proc/mounts`, filters out virtual/pseudo filesystems and internal mount prefixes (see below), calls `os.statvfs()` on each real mount point, and computes used/total/percent.
5. Serialises all four metrics to JSON and writes the response with `Access-Control-Allow-Origin: *`.

### Filesystem filtering

The following filesystem types are excluded from the disk list:

```python
SKIP_FS_TYPES = {
    'sysfs', 'proc', 'devtmpfs', 'devpts', 'tmpfs', 'cgroup', 'cgroup2',
    'pstore', 'bpf', 'tracefs', 'debugfs', 'securityfs', 'configfs',
    'fusectl', 'hugetlbfs', 'mqueue', 'usbfs', 'rpc_pipefs', 'nfsd',
    'overlay', 'aufs', 'squashfs', 'ramfs', 'efivarfs', 'autofs'
}
```

The following mount path prefixes are also excluded:

```python
SKIP_PREFIXES = ('/sys', '/proc', '/dev', '/run', '/snap', '/boot/firmware')
```

Additionally, any mount point with `total == 0` (e.g. a bind mount of a zero-byte device) is skipped.

### systemd service

File: `/etc/systemd/system/tempd.service`

```ini
[Unit]
Description=Pi Temperature HTTP API
After=network.target

[Service]
ExecStart=/usr/bin/python3 /opt/tempd/tempd.py
Restart=always
User=pi

[Install]
WantedBy=multi-user.target
```

The service runs as the `pi` user. If your Pi user is named differently, update `User=` accordingly. `Restart=always` ensures the server comes back up after a crash or Pi reboot automatically.

---

## 3. JSON API Contract

### Endpoint

```
GET http://<pi-host>:7777/
```

Returns `Content-Type: application/json` with `Access-Control-Allow-Origin: *`.

### Response schema

```jsonc
{
  "temp": 42.3,           // number — CPU temperature in °C (1 decimal place)

  "cpu": 18.4,            // number — CPU usage percentage 0.0–100.0 (1 decimal)
                          // Measured over a 200 ms window via /proc/stat delta

  "ram": {
    "used_mb":   2867.2,  // number — RAM in use, in megabytes (1 decimal)
    "total_mb":  8192.0,  // number — total RAM, in megabytes (1 decimal)
    "percent":   35.0     // number — usage percentage 0.0–100.0 (1 decimal)
  },

  "disks": [              // array — one object per real mounted filesystem
    {
      "mount":    "/",           // string  — absolute mount path
      "label":    "root",        // string  — last path component, lowercase
                                 //           ("root" for "/")
      "used_gb":  83.1,          // number  — used space in gigabytes (1 decimal)
      "total_gb": 119.0,         // number  — total size in gigabytes (1 decimal)
      "percent":  69.8           // number  — usage percentage 0.0–100.0 (1 decimal)
    },
    {
      "mount":    "/mnt/nas-bastian",
      "label":    "nas-bastian",
      "used_gb":  14.3,
      "total_gb": 183.0,
      "percent":  7.8
    }
    // ... additional disks
  ]
}
```

### Full annotated example response

```json
{
  "temp": 42.3,
  "cpu": 18.4,
  "ram": {
    "used_mb": 2867.2,
    "total_mb": 8192.0,
    "percent": 35.0
  },
  "disks": [
    {
      "mount": "/",
      "label": "root",
      "used_gb": 83.1,
      "total_gb": 119.0,
      "percent": 69.8
    },
    {
      "mount": "/mnt/nas-shared",
      "label": "nas-shared",
      "used_gb": 114.0,
      "total_gb": 183.0,
      "percent": 62.3
    },
    {
      "mount": "/mnt/nas-bastian",
      "label": "nas-bastian",
      "used_gb": 14.3,
      "total_gb": 183.0,
      "percent": 7.8
    }
  ]
}
```

### Field notes

| Field | Type | Notes |
|-------|------|-------|
| `temp` | `number` | Always 1 decimal place. Sourced from `vcgencmd` — Pi-specific. |
| `cpu` | `number` | Averaged over the 200 ms sleep in `get_cpu()`. Will be slightly stale on first request as the measurement blocks the response. |
| `ram.used_mb` | `number` | Calculated as `MemTotal - MemAvailable`, not `MemTotal - MemFree`. `MemAvailable` accounts for reclaimable cache and is more accurate for "how much RAM is actually free". |
| `disks[].label` | `string` | Lowercase, auto-derived. The widget uppercases it on display. Used as the default label if no custom name is set. |
| `disks[].used_gb` | `number` | Sourced from `os.statvfs()` `f_blocks - f_bfree`, not `f_blocks - f_bavail`. Includes blocks reserved for root. |

### Error responses

`tempd.py` does not return structured error JSON. On any internal error (e.g. `vcgencmd` not found), the server will return an HTTP 500 or close the connection. The widget handles this via the `handleNetworkError()` path, displaying `ERR: HTTP 500` or `ERR: Server unreachable` in the footer.

---

## 4. Widget Architecture

The widget follows a strict separation of concerns across three files:

| File | Responsibility |
|------|---------------|
| `index.html` | Structural markup only. No inline styles, no JS event handlers. |
| `styles.css` | All visual design. CSS custom properties, class-based state. |
| `app.js` | All application logic. JSDoc-documented, `'use strict'`. |

### Internal layer model (app.js)

```
┌─────────────────────────────────────────────────────────────┐
│  CONFIG          All magic numbers (thresholds, timings)    │
├─────────────────────────────────────────────────────────────┤
│  State           Module-level mutable variables             │
├─────────────────────────────────────────────────────────────┤
│  Formatters      Pure functions: number → display string    │
│  Classifiers     Pure functions: number → CSS class name    │
├─────────────────────────────────────────────────────────────┤
│  UI Controllers  update*() / show*() / sync*() — DOM writes │
├─────────────────────────────────────────────────────────────┤
│  API Client      fetchMetrics() — network I/O only          │
├─────────────────────────────────────────────────────────────┤
│  Poll Loop       poll() — orchestrates fetch + UI updates   │
├─────────────────────────────────────────────────────────────┤
│  Event Listeners All addEventListener() calls in one block  │
└─────────────────────────────────────────────────────────────┘
```

Pure functions (formatters and classifiers) have no side effects and never touch the DOM. UI controller functions are the only layer permitted to write to the DOM. `fetchMetrics()` is the only function permitted to make network calls.

### DOM generation — `<template>` elements

Disk rows and disk rename fields are generated dynamically at runtime. Rather than building them via `innerHTML` string injection, the widget uses two inert `<template>` elements defined in `index.html`:

| Template ID | Cloned by | Purpose |
|-------------|-----------|---------|
| `#tpl-disk-row` | `createDiskRow(id)` | One `.metric-row` in the live metrics table |
| `#tpl-disk-field` | `createDiskField(disk)` | One rename widget in Settings |

Cloning via `content.cloneNode(true)` eliminates XSS risk from mount paths or labels containing HTML-special characters, and ensures markup changes only need to be made in `index.html`.

### CSS–JS contract for bar fill widths

Progress bar widths are **not** set via `style.width`. Instead:

```js
// JS sets the data value as a CSS custom property on the element
barEl.style.setProperty('--bar-fill', pct + '%');
```

```css
/* CSS reads it and owns the transition */
.metric-bar-fill {
  width: var(--bar-fill, 0%);
  transition: width 0.8s cubic-bezier(0.4, 0, 0.2, 1);
}
```

This keeps transition timing, easing, and visual state entirely in CSS, while JS only supplies the numeric data value.

### Value column sizing

The metrics grid uses a three-column layout:

```
[label] [bar track] [value]
8%       1fr         --val-w
```

`--val-w` is calculated by `updateValColumn()` using an off-screen `<canvas>` element to measure the pixel width of the widest possible value string in the actual Orbitron font at the current `vw`-derived font size. This ensures the bar column always fills the maximum available width without any value being clipped.

---

## 5. File Reference

### index.html

| Element ID | Type | Purpose |
|------------|------|---------|
| `statusDot` | `div` | Pulsing status indicator; classes: `fetching`, `offline`, (default online) |
| `tempVal` | `span` | Temperature number; classes: `warm`, `hot`, `dead` |
| `metricsContainer` | `div` | Container for all metric rows; also carries the `.metrics` class for `--val-w` |
| `cpuBar` / `cpuVal` | `div` / `span` | Static CPU bar fill and value label |
| `ramBar` / `ramVal` | `div` / `span` | Static RAM bar fill and value label |
| `footerNormal` | `div` | Normal footer; hidden during errors |
| `footerIp` | `span` | Clickable host label; opens inline URL editor |
| `footerUrlEdit` | `div` | Inline URL editor row; class `active` = visible |
| `footerUrlInput` | `input` | URL text input inside footer editor |
| `footerUrlApplyBtn` | `button` | ↵ confirm button in footer editor |
| `footerUrlCancelBtn` | `button` | ✕ cancel button in footer editor |
| `lastUpdate` | `span` | Timestamp of last successful poll |
| `footerErr` | `div` | Error footer; hidden during normal operation |
| `errMsg` | `span` | Error message text |
| `errUrlInput` | `input` | URL correction input in error footer |
| `errUrlApplyBtn` | `button` | ↵ apply button in error footer |
| `settingsOverlay` | `div` | Full-screen settings panel; class `open` = visible |
| `gearBtn` | `button` | Opens settings |
| `settingsCloseBtn` | `button` | Closes settings without saving |
| `s-apiUrl` | `input` | Endpoint URL field in settings |
| `s-diskPct` | `input[checkbox]` | Display mode toggle in settings |
| `s-saveEndpointBtn` | `button` | Saves endpoint only and restarts polling |
| `s-saveAllBtn` | `button` | Saves all settings and closes |
| `s-resetBtn` | `button` | Resets all settings to defaults |
| `diskRenameFields` | `div` | Container for dynamic disk rename widgets |
| `tpl-disk-row` | `template` | Blueprint for a live disk metric row |
| `tpl-disk-field` | `template` | Blueprint for a disk rename field in settings |

Dynamic disk row IDs follow the pattern `disk_<sanitised_mount>`, e.g. `/mnt/nas-bastian` → `disk__mnt_nasbastian`. Bar and value sub-elements are `<id>_bar` and `<id>_val`.

### styles.css sections

| Section | Lines (approx.) | Contents |
|---------|-----------------|----------|
| §1 DESIGN TOKENS | 51–80 | All CSS custom properties |
| §2 RESET | 82–97 | Box model, body, background gradient |
| §3 WIDGET SHELL | 99–113 | `.widget` grid, `.corner` accents |
| §4 HEADER | 115–151 | Status dot, device name, gear button |
| §5 MAIN / TEMPERATURE | 153–175 | Temperature readout and unit |
| §6 METRICS TABLE | 177–220 | `.metrics` grid, bar track/fill, value column |
| §7 FOOTER | 222–288 | Normal state, inline editor, error state |
| §8 SETTINGS OVERLAY | 290–388 | Panel, toggle switch, disk rename fields |

### app.js sections

| Section | Purpose |
|---------|---------|
| `CONFIG` | All magic numbers |
| `LS_*` constants | localStorage key strings |
| `loadSettings` / `persistSettings` | localStorage I/O |
| State variables | Mutable module-level state |
| `el` object | All cached DOM references |
| URL utilities | `normaliseUrl`, `hostFromUrl` |
| Formatters | `fmtSize`, `diskValLabel`, `ramValLabel`, `diskRowId`, `diskDisplayLabel`, `mountAutoLabel` |
| Classifiers | `barClass`, `tempClass` |
| UI: Progress bar | `updateBar`, `updateValColumn` |
| UI: Temperature | `updateTempState`, `setTempDead` |
| UI: Footer | `showNormalFooter`, `showErrorFooter` |
| UI: Display mode | `setDisplayMode`, `toggleDisplayMode`, `refreshRamVal`, `refreshDiskVals` |
| UI: Disk rows | `createDiskRow`, `syncDiskRows` |
| UI: Settings | `openSettings`, `closeSettings`, `createDiskField`, `syncDiskRenameFields`, `saveDiskLabel`, `saveAllSettings`, `resetSettings` |
| UI: Footer editor | `openFooterEdit`, `closeFooterEdit`, `applyFooterUrl` |
| Polling | `restartPolling`, `applyNewUrl` |
| API client | `fetchMetrics` |
| Dashboard updater | `updateDashboard` |
| Error handler | `handleNetworkError` |
| Poll loop | `poll` |
| Event listeners | All `addEventListener` calls |
| Init | `init` |

---

## 6. CONFIG Object Reference

All values are at the top of `app.js`. Edit here only — no other file contains hardcoded thresholds or timings.

```js
const CONFIG = {
  polling: {
    interval: 2000,   // ms — time between API polls
    timeout:  5000,   // ms — fetch abort threshold; produces "Request timed out"
  },
  thresholds: {
    temp: {
      warm: 55,       // °C — temperature at which display turns amber
      hot:  75,       // °C — temperature at which display turns red
    },
    usage: {
      warn: 65,       // % — bar usage at which fill turns amber
      hot:  85,       // % — bar usage at which fill turns red
    },
  },
  defaults: {
    url: 'http://raspberrypi:7777/',  // API URL used when localStorage is empty
  },
  valCandidates: {
    // Widest expected strings per display mode, used by canvas measureText.
    // If you add disks with extremely large capacities (e.g. 10 TB+), add
    // a sample string here to keep the value column wide enough.
    size: ['114/183G', '8.00/16.0T', '114/1.8T'],
    pct:  ['100%'],
  },
};
```

---

## 7. localStorage Reference

All keys are prefixed `pi_` to avoid collisions with other apps sharing the same origin.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `pi_apiUrl` | `string` | `http://raspberrypi:7777/` | Full URL of the tempd API, always with a trailing slash. |
| `pi_diskNames` | `string` (JSON) | `{}` | JSON object mapping mount paths to custom labels. E.g. `{"/mnt/nas-bastian": "NAS"}`. |
| `pi_diskShowPct` | `string` | `'false'` | `'true'` if percentage display mode is active; `'false'` for size mode. Stored as a string because `localStorage.setItem` serialises all values to string. |

To inspect or clear from the browser devtools console:

```js
// Inspect
Object.fromEntries(['pi_apiUrl','pi_diskNames','pi_diskShowPct'].map(k => [k, localStorage.getItem(k)]))

// Clear all widget settings
['pi_apiUrl','pi_diskNames','pi_diskShowPct'].forEach(k => localStorage.removeItem(k))
```

---

## 8. CSS Custom Property Contract

Properties that cross the JS↔CSS boundary (i.e. JS writes, CSS reads):

| Property | Set by | Read by | Description |
|----------|--------|---------|-------------|
| `--bar-fill` | `updateBar()` on each `.metric-bar-fill` element | `.metric-bar-fill { width: var(--bar-fill, 0%) }` | Bar fill width as a percentage string. Default `0%` from `:root`. |
| `--val-w` | `updateValColumn()` on `.metrics` | `.metric-row { grid-template-columns: ... var(--val-w) }` | Pixel width of the value column, calculated by canvas `measureText`. |

Properties that are purely internal to CSS (JS never writes):

| Property | Defined in | Description |
|----------|-----------|-------------|
| `--bg` | `:root` | Main background colour |
| `--border` | `:root` | Subtle border colour |
| `--accent` | `:root` | Primary teal accent |
| `--accent-dim` | `:root` | 50% opacity accent |
| `--warn` | `:root` | Amber warning colour |
| `--hot` | `:root` | Red critical colour |
| `--text` | `:root` | Primary text colour |
| `--dim` | `:root` | Dimmed/secondary text colour |
| `--label` | `:root` | Label text colour (slightly brighter than dim) |
| `--glow` | `:root` | Default temperature glow shadow |
| `--glow-warm` | `:root` | Amber glow shadow |
| `--glow-hot` | `:root` | Red glow shadow |

---

## 9. Function Reference

### Formatters (pure — no side effects)

| Function | Signature | Returns | Description |
|----------|-----------|---------|-------------|
| `fmtSize` | `(gb: number) → string` | `"8.00G"`, `"183G"`, `"1.8T"` | Smart size string; picks unit and precision based on magnitude. |
| `diskValLabel` | `(disk: object) → string` | `"14.3/183G"` or `"8%"` | Value label for a disk row in the current display mode. |
| `ramValLabel` | `(ram: object) → string` | `"2.8/7.6G"` or `"35%"` | Value label for the RAM row; auto-selects MB or GB. |
| `diskRowId` | `(mount: string) → string` | `"disk__mnt_nasbastian"` | Safe element ID derived from a mount path. |
| `diskDisplayLabel` | `(disk: object) → string` | `"NAS-BASTIAN"` | Custom name if set, else auto-label, always uppercase. |
| `mountAutoLabel` | `(mount: string) → string` | `"NAS-BASTIAN"` | Last path component, uppercase. Returns `"ROOT"` for `"/"`. |
| `normaliseUrl` | `(raw: string) → string` | `"http://raspberrypi:7777/"` | Trims whitespace and ensures trailing slash. |
| `hostFromUrl` | `(url: string) → string` | `"raspberrypi:7777"` | Extracts host:port from a full URL; falls back to raw string on parse error. |

### Classifiers (pure — no side effects)

| Function | Signature | Returns | Description |
|----------|-----------|---------|-------------|
| `barClass` | `(pct: number) → string` | `''`, `'warn'`, or `'hot'` | CSS modifier class for a usage bar. Thresholds from `CONFIG.thresholds.usage`. |
| `tempClass` | `(t: number) → string` | `''`, `'warm'`, or `'hot'` | CSS modifier class for the temperature display. Thresholds from `CONFIG.thresholds.temp`. |

### API client

| Function | Signature | Description |
|----------|-----------|-------------|
| `fetchMetrics` | `async () → Promise<object>` | Fetches and parses the tempd JSON. Throws `Error('Request timed out')` on abort, `Error('Server unreachable')` on network failure, `Error('HTTP <N>')` on non-ok HTTP status. |

### Poll loop

| Function | Signature | Description |
|----------|-----------|-------------|
| `poll` | `async () → void` | Single poll cycle: sets fetching indicator → calls `fetchMetrics` → routes to `updateDashboard` or `handleNetworkError`. Handles reconnect cleanup. |

### Key UI controllers

| Function | Description |
|----------|-------------|
| `updateBar(barEl, valEl, pct, label)` | Updates bar `--bar-fill`, class, and value text. |
| `updateValColumn()` | Recalculates `--val-w` via canvas `measureText`. |
| `updateTempState(temp)` | Sets temperature text and colour class. |
| `setTempDead()` | Sets temperature to `--.-` offline state. |
| `showNormalFooter()` | Switches to online footer; updates host label. |
| `showErrorFooter(message)` | Switches to error footer; shows message. |
| `setDisplayMode(showPct)` | Toggles all values between size and percentage. |
| `syncDiskRows(disks)` | Reconciles rendered disk rows with API data. |
| `syncDiskRenameFields(disks)` | Rebuilds disk rename section in settings. |
| `applyNewUrl(raw)` | Normalises, persists, and activates a new API URL. |
| `restartPolling()` | Clears interval, polls immediately, restarts interval. |
| `init()` | Entry point: footer, layout sizing, resize listener, polling. |

---

## 10. Data Flow

### Successful poll

```
setInterval / init()
        │
        ▼
      poll()
        │  sets statusDot → fetching
        ▼
  fetchMetrics()
        │  GET http://<apiUrl>/
        │  AbortSignal.timeout(5000)
        ▼
   JSON response
        │
        ▼
  updateDashboard(data)
        ├── updateTempState(data.temp)
        ├── updateBar(cpuBar, cpuVal, data.cpu, ...)
        ├── updateBar(ramBar, ramVal, data.ram.percent, ...)
        ├── syncDiskRows(data.disks)
        │       ├── createDiskRow() for new mounts
        │       ├── updateBar() for each disk
        │       └── syncDiskRenameFields() if mount list changed
        └── updateValColumn()
        │
        ▼
  statusDot → online
  lastUpdate → HH:MM:SS
  showNormalFooter()
```

### Failed poll

```
      poll()
        │  sets statusDot → fetching
        ▼
  fetchMetrics()    ← throws Error
        │
        ▼
  handleNetworkError(err)
        ├── wasOffline = true
        ├── setTempDead()
        ├── statusDot → offline
        ├── lastUpdate → 'offline'
        └── showErrorFooter(err.message)
               └── ERR: Request timed out
                   ERR: Server unreachable
                   ERR: HTTP <status>
```

### Reconnect

When `wasOffline` is `true` and `fetchMetrics()` succeeds:

```
  poll() success, wasOffline === true
        │
        ▼
  Remove all existing disk rows from DOM
  Reset: knownDisks = []
         lastDiskMounts = []
         lastDiskData = []
         wasOffline = false
        │
        ▼
  updateDashboard() — builds disk rows fresh
```

---

## 11. Extension Guide

### Adding a new static metric (e.g. GPU temperature)

**1. tempd.py** — add the data to the response:

```python
def get_gpu_temp():
    # example: read from a sysfs path
    with open('/sys/class/thermal/thermal_zone1/temp') as f:
        return round(int(f.read()) / 1000, 1)

# In Handler.do_GET:
data = {
    'temp': get_temp(),
    'cpu':  get_cpu(),
    'ram':  get_ram(),
    'disks': get_disks(),
    'gpu_temp': get_gpu_temp(),   # new field
}
```

**2. index.html** — add a static metric row:

```html
<div class="metric-row">
  <span class="metric-label">GPU</span>
  <div class="metric-bar-track">
    <div class="metric-bar-fill" id="gpuBar"></div>
  </div>
  <span class="metric-val" id="gpuVal">--°C</span>
</div>
```

**3. app.js — `updateDashboard()`** — call `updateBar` with the new element IDs:

```js
updateBar(
  document.getElementById('gpuBar'),
  document.getElementById('gpuVal'),
  data.gpu_temp,              // use as percentage (0–100 scale)
  data.gpu_temp.toFixed(1) + '°C'
);
```

**4. CONFIG** — add a threshold if the metric needs colour coding:

```js
thresholds: {
  temp:  { warm: 55, hot: 75 },
  usage: { warn: 65, hot: 85 },
  gpu:   { warm: 60, hot: 80 },   // new
},
```

Then create a `gpuClass()` classifier mirroring `tempClass()`.

---

### Changing the polling interval

Edit `CONFIG.polling.interval` in `app.js`. The change takes effect on the next `init()` call (i.e. page reload).

```js
polling: {
  interval: 5000,   // poll every 5 seconds instead of 2
  timeout:  8000,   // give it 8 seconds before timing out
},
```

---

### Changing colour thresholds

Edit `CONFIG.thresholds` in `app.js`. No CSS changes are needed — CSS classes are applied by `barClass()` and `tempClass()` which read from CONFIG.

```js
thresholds: {
  temp:  { warm: 60, hot: 80 },   // adjusted for a case with better cooling
  usage: { warn: 70, hot: 90 },
},
```

---

### Adding a custom display mode

The `diskShowPct` flag drives all value rendering. To add a third mode (e.g. inodes):

1. Add a new state variable: `let diskShowInode = false`.
2. Add a `diskValLabelInode(disk)` formatter.
3. Extend `setDisplayMode()` to cycle through three states.
4. Add the new `valCandidates` entry to CONFIG for column sizing.

---

### Pointing the widget at a different host

At runtime: click the host label in the footer and type the new URL.

For a persistent default (e.g. if deploying on a new machine): change `CONFIG.defaults.url` in `app.js`.

For Tailscale IPs directly: use `http://100.x.x.x:7777/` — Tailscale MagicDNS may not resolve in all WebView contexts.

---

## 12. Known Constraints

| Constraint | Detail |
|------------|--------|
| `vcgencmd` dependency | `tempd.py` calls `vcgencmd measure_temp` which is Raspberry Pi-specific. On other Linux boards, replace `get_temp()` with an appropriate `/sys/class/thermal` read. |
| Single-endpoint polling | The widget polls a single URL. There is no multi-Pi support in the current design; running two separate widget instances on different ports is the simplest workaround. |
| No HTTPS | Both the local widget server and tempd run plain HTTP. This is intentional — both are on loopback or a private network. Do not expose tempd to the public internet without adding authentication. |
| localStorage scope | Settings are stored per origin (`http://localhost:8899`). If you change the local server port, localStorage will be empty and settings must be re-entered. |
| Disk label max length | 8 characters, enforced by the input `maxlength` attribute. Longer labels will overflow the fixed-width metric label column. |
| Canvas font measurement | `updateValColumn()` creates a new `<canvas>` element on every call. This is cheap but not zero-cost. It is not called inside the tight render path — only on init, font load, resize, and display mode change. |
| `AbortSignal.timeout()` | Requires a browser with the `AbortSignal.timeout()` static method (Chrome 103+, Firefox 100+, Safari 16+). Older browsers will see `TypeError: AbortSignal.timeout is not a function`. The Plasma WebView (Chromium-based) is unaffected. |
