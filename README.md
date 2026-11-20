# ChatGPT Timezone Fix

> **Fix ChatGPT "dumbing down" with a browser extension.** It transparently spoofs the page's JavaScript timezone to a timezone of your choice — functionally identical to Chrome DevTools → Sensors → Timezone, but **you never have to open DevTools again**.

[![Tests](https://github.com/canglei9527/chatgpt-tz-fix/actions/workflows/test.yml/badge.svg)](https://github.com/canglei9527/chatgpt-tz-fix/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**English** · [简体中文](README.zh-CN.md)

---

## The problem

ChatGPT's web app reads your browser's local timezone (`Intl.DateTimeFormat().resolvedOptions().timeZone`). When it sees a timezone like `Asia/Shanghai`, many users report noticeably worse answer quality — commonly called "降智" (dumbing down) in the Chinese community.

The workaround circulating on social media is: **F12 → Console → open Console Drawer → Sensors → set timezone to a US city**.

That works — but you have to redo it every session, and it dies the moment you close DevTools.

| Manual Sensors override | This extension |
| :--- | :--- |
| Redo it every browser session | Install once, works forever |
| Must keep DevTools open | Runs silently in the background |
| Stops working when DevTools closes | Survives tab closes and reboots |
| Not usable on mobile | Stable on desktop with the same account |

**The mechanism is exactly the same.** Every local-time read the page makes returns the target timezone's wall clock, while your system timezone and system clock are untouched. HTTP requests don't carry timezone info, so the server just sees a user who appears to be in the US.

---

## Install (about 30 seconds)

### 1. Build the extension

```bash
node tools/build.cjs
```

The loadable extension lands in `dist/chatgpt-tz-fix/`.

> Windows users can just double-click `install.cmd` — it builds, opens `chrome://extensions`, and points Explorer at the folder.

### 2. Load it in Chrome or Edge

1. Go to `chrome://extensions` (Edge: `edge://extensions`)
2. Enable **Developer mode** (top-right)
3. Click **Load unpacked**
4. Select the `dist/chatgpt-tz-fix` folder

The extension opens ChatGPT automatically once loaded.

> Requires **Chrome / Edge 111+** (needs `world: "MAIN"` support in `chrome.scripting.registerContentScripts`).

### 3. Verify it works

- Click the toolbar icon — the popup shows **real timezone vs. spoofed timezone** and a side-by-side clock.
- Hit **Check current tab**. If it says "这个页面已经生效 ✓", you're done.
- For a thorough check, click **Self-check** — it opens a page that compares the injected engine against your browser's own native behavior, item by item.

---

## How to use it

The popup gives you:

| Control | What it does |
| :--- | :--- |
| **Toggle** (top right) | Turn spoofing on/off instantly |
| **Timezone picker** | Defaults to `America/Los_Angeles`. Searchable across all 419 IANA zones |
| **Scope** | "ChatGPT sites only" (default) or "All websites" |
| **Check current tab** | Runs a probe on the current page and tells you whether spoofing is live |
| **Reload page** | Reloads the current tab |
| **Self-check** | Opens the full verification page |

> **After changing settings, press F5 on the ChatGPT tab** — content scripts only inject at page load.

### Which timezone to pick

| Scenario | Recommendation |
| :--- | :--- |
| Everyday use | US West · Los Angeles |
| More "natural" | US East · New York |
| Specific region preference | UK · London / Japan · Tokyo / Singapore |

Don't pick `Asia/Shanghai` — that's a no-op.

---

## How it works

### Injection

MV3's `chrome.scripting.registerContentScripts` supports `world: "MAIN"`, which injects into the **page's main world** (same JS context as the page's own scripts) at `document_start` — before any page script runs.

Two files are injected, in fixed order:

1. `inject/zones/<slug>.js` — one line: `globalThis.__DSH_TZ_FIX_ZONE__ = "America/Los_Angeles";`
2. `inject/tz-shim.js` — the actual shim

### What gets patched

| Category | APIs |
| :--- | :--- |
| Reads | `getFullYear/getMonth/getDate/getDay/getHours/getMinutes/getSeconds/getYear/getTimezoneOffset` |
| Output | `toString/toDateString/toTimeString/toLocaleString/toLocaleDateString/toLocaleTimeString` |
| Writes | `setFullYear/setMonth/setDate/setHours/setMinutes/setSeconds/setMilliseconds/setYear` |
| Construction | all `new Date(...)` forms, `Date()`, `Date.parse`, `class X extends Date` |
| Intl | `Intl.DateTimeFormat`'s default timezone (explicit `timeZone` is respected) |
| Temporal | Synced when present (not enabled by default in browsers yet) |

**Not touched:** every UTC method, `Date.now`, `Date.UTC`, `toISOString`, and the timestamp itself. Absolute time is untouched — only "how local time is rendered and interpreted" changes.

### Why DST matches native behavior exactly

```
wall(ts)            = render ts in the target zone, get the wall-clock fields
offset(ts)          = Date.UTC(wall fields) - ts
getTimezoneOffset() = -offset(ts) / 60000

localToUtc(L):
  o1 = offset(L)
  u1 = L - o1
  o2 = offset(u1)
  return (wall(L - o2) === L) ? L - o2 : u1
```

The two-pass lookup with a wall-clock sanity check is the crux. A single lookup gets DST transitions wrong in one direction; the verification step reproduces V8's exact tie-breaking for both the **nonexistent times** in spring-forward and the **repeated times** in fall-back.

Verified against native behavior:

```js
// America/Los_Angeles, spring-forward (2:30 never exists)
new Date(2026, 2, 8, 2, 30).toISOString()  // "2026-03-08T10:30:00.000Z"
```

### Performance

Offsets are cached in per-year transition tables (a few dozen `Intl` calls build a year's table, then it's binary search). **100,000 `getHours()` calls take ~85 ms** — under 1 microsecond each. Native takes 14 ms for the same loop.

---

## Verification

Spoofing isn't hard to do approximately — it's hard to get *every corner* right. This project has three layers of tests.

### 1. Self-check page (`extension/verify/`)

Opened from the popup. It loads `inject/tz-shim.js` in a **hidden iframe**, then compares:

- **Expected values** are rebuilt in the un-spoofed host page using native `Intl` with an explicit `timeZone`;
- **Observed values** come from the spoofed iframe;
- The two implementations are completely independent, so a bug in either one surfaces as a mismatch.

300+ assertions grouped by: local fields / string output / localization / construction / setters / string parsing / Intl / native-identity guards / DST offset set / performance / injection marker.

### 2. Automated tests

```bash
node tests/run-all.cjs
```

| Suite | What it covers |
| :--- | :--- |
| `tests/shim-selfcheck.cjs` | **The core one.** Differential comparison: shim vs. real native (`TZ=<zone>` subprocess), 16 zones × 3,846 probes |
| `tests/verify-page.test.cjs` | Self-check page's reference algorithm vs. native; plus a reverse check that mismatched zones *are* detected |
| `tests/ui-mock.test.cjs` | Extension shell: registration params, state validation, message handlers, manifest integrity, popup DOM ids, JS syntax |

`tests/shim-selfcheck.cjs` also ships with:

- `--quick` — 3 zones, ~7s
- `--selftest` — runs a **no-op stub** instead of the real shim, to prove the harness has no false positives
- `--all-zones` — smoke test across all 419 zones
- `--shim <path>` — test any build artifact

### 3. Current results

```
16 zones × 3,846 probes: 0 hard mismatches
  America/Los_Angeles (host Asia/Shanghai), America/Los_Angeles (host UTC)
  America/New_York, America/St_Johns (-3:30), Europe/London, Europe/Berlin,
  Europe/Dublin, Asia/Tokyo, Asia/Shanghai (reversed host), Asia/Calcutta (+5:30),
  Asia/Kolkata, Pacific/Chatham (+12:45), Australia/Sydney,
  Australia/Lord_Howe (30-min DST), UTC, Pacific/Kiritimati (+14)

All 419 zones smoke test: 419/419 pass
Harness self-proof (--selftest, no-op stub): 16 zones, 0 mismatches
tests/run-all.cjs: shell 62 + verify-page 23 + differential 21 cases — all green

Performance: 100k getHours = 85ms (native 14ms, threshold 200ms)
```

> Note: for historical instants **before 1971**, the timezone **display name** inside
> `toString()`'s parentheses may differ from native (V8's DateCache and ICU use two
> separate naming sources). This affects text only, never numeric behavior, and ChatGPT
> never looks at pre-1970 instants.

---

## Project layout

```
chatgpt-tz-fix/
├── src/tz-shim.js              ← the shim (the only file you need to understand)
├── extension/                  ← extension source
│   ├── manifest.json
│   ├── background.js           ← MV3 service worker: register/unregister, messaging, badge
│   ├── popup/                  ← popup UI
│   ├── inject/
│   │   ├── tz-shim.js          ← build artifact (copied from src/, do not edit)
│   │   └── zones/*.js          ← 419 per-zone variable files
│   ├── shared/zones.js         ← zone catalog (IANA id + Chinese label + slug)
│   ├── icons/                  ← 16/32/48/128
│   └── verify/                 ← self-check page
├── tools/
│   ├── build.cjs               ← build + structural validation + dist assembly
│   ├── gen-zones.cjs           ← generate the zone catalog
│   └── gen-icons.py            ← generate icons (Pillow)
├── tests/
│   ├── run-all.cjs
│   ├── shim-selfcheck.cjs      ← the differential harness
│   ├── verify-page.test.cjs
│   └── ui-mock.test.cjs
├── install.cmd / install.ps1   ← Windows install helpers
└── dist/chatgpt-tz-fix/        ← load *this* folder as an unpacked extension
```

---

## A note on the "dumbing down" claim

This extension faithfully reproduces what DevTools → Sensors → Timezone does. Whether that actually changes which model your request is routed to is a **community hypothesis, not documented OpenAI behavior**.

The most credible community reports (late 2025 – 2026) consistently say the key is **matching your timezone to your egress IP**, not "always pick a US timezone":

| Your egress IP | Set the timezone to |
| :--- | :--- |
| US West / Los Angeles node | `America/Los_Angeles` (default) |
| US East / New York node | `America/New_York` |
| Japan node | `Asia/Tokyo` |
| Singapore node | `Asia/Singapore` |
| UK / EU node | `Europe/London` |

**Picking a US timezone while your IP is elsewhere creates a new inconsistency** and may make things worse. Check `https://ipinfo.io` first, then pick the matching zone.

Also worth knowing:

- **Timezone is only one of several factors.** Session length, rate limiting, and account risk scoring matter more in practice. Always try a **fresh conversation** first — long contexts are the most common cause of "dumber" answers.
- **Verifying "is it working"**: don't rely on probabilistic model-fingerprinting tools. Use the popup's **Check current tab** — it reads `Intl.DateTimeFormat().resolvedOptions().timeZone` directly, which is a factual check, not a guess.
- **After changing the timezone**, clear ChatGPT cookies and sign in again. The degraded-state flag is reported to be time-limited, so the account needs to be re-evaluated.

---

## WebRTC local-IP leak protection (optional)

If your goal is "make the site think I'm in the US", timezone is only one signal. **WebRTC leaks your real IP**, which is easier to spot than the timezone.

### The problem

Before connecting, WebRTC gathers ICE "candidates". Two kinds carry your real location:

| Candidate type | Meaning | Risk |
| :--- | :--- | :--- |
| `typ host` | Local network interface (192.168.x.x / 10.x.x.x) | Exposes internal network shape |
| `typ srflx` | Public IP after NAT | **Leaks your real IP, bypassing the proxy** |
| `typ relay` | TURN relay server address | Safe — same region as your proxy exit |

Any page can enumerate `candidates` and read the real IP out of `typ srflx` — even while you're on a US node.

### What this extension does

The popup has a **"Block WebRTC local IP"** toggle (off by default). When on:

- Filters both `onicecandidate` and `addEventListener('icecandidate')`, dropping `host` / `srflx`
- Sanitizes the SDP of `localDescription` / `currentLocalDescription` / `pendingLocalDescription`, removing matching `a=candidate` lines
- **Keeps `typ relay`**, so connectivity is unaffected

### Why not force relay-only

`iceTransportPolicy: 'relay'` requires a working TURN server; without one, WebRTC simply stops working (video calls break). This extension uses **filtering** instead: connections are established normally inside the browser, but page JS can no longer see candidates that pin down your real IP.

### When to enable it

- ✅ You're behind a proxy and want the site's view of your location to match your exit IP
- ✅ You don't want pages to obtain your real IP
- ⚠️ Leave it off if a site's audio/video breaks — toggle this first when debugging

---

## FAQ

**Nothing happens after installing.**
Check in order: ① the popup toggle is on; ② the scope includes the current site; ③ press F5 on the ChatGPT tab (content scripts only inject at page load); ④ click **Check current tab** in the popup and see what timezone the page reports.

**Does it affect other sites?**
By default no — it only matches `chatgpt.com` / `chat.openai.com` and their subdomains. Switch scope to "All websites" if you want it everywhere.

**Does it slow pages down?**
No. Offsets come from cached per-year transition tables; 100k `getHours` calls take ~85 ms total.

**Will it keep working after I reboot?**
Yes. Settings live in `chrome.storage.local` (persisted to disk) and the injected content script is registered with `persistAcrossSessions: true`. There's also an `onStartup` hook that re-registers if Chrome ever loses the registry. Tested against: normal reboot, toggle-left-off, custom timezone, all-sites scope, and registry-loss recovery.

**Will ChatGPT detect it?**
There's no behavioral tell: `Date.prototype` is the same object (never replaced), `instanceof` works, `Object.prototype.toString` still returns `[object Date]`, `JSON.stringify` works, and every UTC method is untouched.

The only theoretical trace is `Function.prototype.toString.call(Date)` returning `"function TzDate(...)"` instead of `"function Date() { [native code] }"`. No ordinary application code does this — ChatGPT's web app certainly doesn't.

**Does it change my system timezone?**
No. Your system clock, taskbar clock, and every other app are unaffected.

**Manual override instead?**
F12 → Console → ⋮ → Show Console Drawer → Sensors → Location: custom → timezone `America/Los_Angeles` → reload. Caveat: it dies when DevTools closes.

---

## Permissions

| Permission | Why |
| :--- | :--- |
| `storage` | Save your settings (toggle, timezone, scope) |
| `scripting` | Register / unregister the MAIN-world content script |
| `host_permissions: <all_urls>` | Enables "All websites" mode; in default mode injection only happens on ChatGPT domains |

The extension **collects no data**: no network requests, no remote config, no telemetry. Everything runs locally.

---

## Uninstall

`chrome://extensions` → find "时区修复 · ChatGPT" → Remove. Reload the page and you're back to your real timezone. Nothing is left behind.

---

## Development

```bash
node tools/gen-zones.cjs        # regenerate the zone catalog (419 zones)
python tools/gen-icons.py       # regenerate icons
node tools/build.cjs            # build + validate + assemble dist
node tests/run-all.cjs          # run all tests
node tools/build.cjs --no-dist  # validate only, no dist output
```

Edit `src/tz-shim.js` for the shim logic; `node tools/build.cjs` copies it to `extension/inject/tz-shim.js`.

**Always run `node tests/run-all.cjs` after changes** — especially `shim-selfcheck`, which is a native-vs-shim differential test that catches any semantic drift.

---

## License

[MIT](LICENSE)
