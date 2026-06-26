# Implementation Plan — Phase 5: ISO 27001 Hardening — Migrate from localhost HTTP to Electron IPC

This phase is an **architectural security migration**, not a feature phase. It
replaces the current "Express server on `localhost:3000` + browser frontend over
`fetch`/SSE" model with an **Electron desktop app** where the renderer talks to a
privileged main process over **in-process IPC** (`contextBridge` + `ipcMain`).
The scan/diff/sync engine semantics are preserved; what changes is the
transport and the trust boundary.

> **Status:** Phases 1–4 complete. The app is a vanilla `public/` frontend that
> calls a local Express API (`server.js`) over HTTP and subscribes to a
> `text/event-stream` watcher, packaged as a Node SEA `comparer.exe`. This phase
> rehosts the same engine inside Electron and removes the network surface.

---

## 1. The security case (why move to IPC / Electron)

The current model's trust boundary is a **TCP port**, and that is the core
problem from a cyber-security / ISO 27001 standpoint:

| # | Current exposure | Where | Impact |
|---|------------------|-------|--------|
| R1 | **Unauthenticated HTTP listener** bound on `localhost:3000`. No auth, no token, no `Origin`/CSRF check. | `server.js:825` (`app.listen`) | Any local process — or, via **DNS rebinding**, any website the user visits — can call the API. |
| R2 | **Privileged, destructive endpoints** reachable over that port. `/api/sync` copies/deletes arbitrary files; `/api/undo` restores/deletes; `/api/scan`/`/api/diff` read arbitrary paths. | `server.js:602` (`fs.copyFileSync`/`fs.unlinkSync` 643–677), `692`, `312`, `483` | A hostile page could silently delete or overwrite user files (CSRF state-change; JSON body alone does not protect a route that doesn't check `Origin`). |
| R3 | **No Content-Security-Policy / served over plain HTTP.** | `server.js:164` static serve | XSS in any rendered path/diff content runs with full `fetch` access to R2. |
| R4 | **Shells out to the OS** to open a browser. | `server.js:837` `exec("start"/"open"/"xdg-open" …)` | `child_process.exec` with an interpolated URL is an unnecessary command-exec surface. |
| R5 | **Windows Firewall prompt** on first run because a localhost listener is opened. | README "First-launch note" | Operational friction + an inbound-rule footprint that security teams must review. |
| R6 | **Unsigned executable** produced via SEA/postject. | `scripts/build.mjs` | No code-signing → SmartScreen warnings, no integrity/authenticity guarantee. |

**What Electron + IPC changes:** there is **no listening socket**. The Chromium
renderer (the UI) communicates with the Node main process through Electron's
internal IPC, which is not bound to any network interface and is not reachable by
other processes or by web pages. The destructive filesystem engine (R2) moves
entirely into the main process and is exposed only through a **narrow, validated
`contextBridge` API** to our own bundled UI. R1, R3 (CSRF/rebinding angle), R5 all
disappear; R4 is replaced by Electron's `shell`/window model; R6 is addressed by
`electron-builder` code signing.

### ISO 27001:2022 Annex A mapping

| Control | How this phase satisfies it |
|---------|------------------------------|
| **A.8.20 / A.8.21 / A.8.22** Network security, security of network services, segregation of networks | Removes the localhost listener entirely — no network service to secure or segregate. |
| **A.8.27 / A.8.26** Secure system architecture & application security requirements | Explicit trust boundary: untrusted renderer ↔ validated IPC ↔ privileged main. Secure-by-default `BrowserWindow` (`contextIsolation`, `sandbox`, `nodeIntegration:false`). |
| **A.8.28** Secure coding | Centralized input validation on every IPC handler; path-traversal guard kept and unit-tested; CSP on the renderer. |
| **A.8.25 / A.8.29** Secure SDLC & security testing | Threat model (Phase 5.0), `npm audit`/SCA in CI, IPC contract tests. |
| **A.8.15 / A.8.16** Logging & monitoring | Append-only audit log of every `sync`/`undo` (who/what/when/paths) in the main process. |
| **A.8.7 / A.8.8** Malware protection & technical-vulnerability management | Signed installer (SmartScreen-trusted), pinned deps, SBOM, scheduled dependency scan. |
| **A.8.19** Software on operational systems | Reproducible, signed `electron-builder` artifact replaces the hand-rolled SEA blob. |

---

## 2. Target architecture

```
┌─────────────────────────── Electron process model ───────────────────────────┐
│                                                                               │
│  Renderer (Chromium)              preload.cjs                  Main (Node)     │
│  public/index.html  ──IPC──►  contextBridge.exposeIn   ──►  ipcMain.handle()   │
│  public/app.js      window.comparer.scan(...)              engine/*.js (pure)  │
│  public/style.css   window.comparer.onWatch(cb)   ◄──  webContents.send(...)   │
│                                                            chokidar watchers   │
│   sandbox:true                  no Node in renderer        fs / crypto / diff  │
│   contextIsolation:true         only typed channels        (no Express)        │
└───────────────────────────────────────────────────────────────────────────────┘
```

- **No `app.listen`, no `express`, no SSE, no `fetch` to localhost.**
- The renderer stays pure HTML/CSS/JS (no `nodeIntegration`); it only sees the
  `window.comparer` object the preload script exposes.
- `server.js`'s route bodies become **pure engine functions** the main process
  calls directly. The glob/scan/diff/sync logic is reused almost verbatim.

---

## 3. Phase 5.0 — Threat model & gap analysis (evidence artifact)

Before code, produce `docs/SECURITY.md` (and check it in) so the migration has an
auditable rationale — this is the ISO 27001 "secure development requirements"
evidence.

- Document R1–R6 above with the current code references and residual risk.
- Define the **post-migration trust boundary**: renderer = untrusted; preload =
  thin, no business logic; main = trusted, validates all inputs.
- List the **IPC channels** that will exist (the API contract in 5.3) as the
  complete attack surface — anything not on the list is not reachable.
- Record accepted residual risks (e.g. the app still runs with the user's own
  filesystem rights by design — it is a file comparison/sync tool).

---

## 4. Phase 5.1 — Electron shell scaffold (secure defaults)

Add Electron as a dev dependency and create the main/preload entry points. **Do
not delete `server.js` yet** — keep it runnable in parallel until 5.4 lands
(incremental/rollback safety).

**New files:**

- `electron/main.cjs` — creates the `BrowserWindow` and registers IPC handlers.
  Hard-required secure window options:
  ```js
  new BrowserWindow({
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,      // renderer cannot touch preload/main internals
      nodeIntegration: false,      // no require() in the renderer
      sandbox: true,               // renderer runs in an OS sandbox
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  win.loadFile(path.join(__dirname, '..', 'public', 'index.html'));
  ```
- `electron/preload.cjs` — the only bridge. Uses `contextBridge.exposeInMainWorld`
  to expose a frozen `window.comparer` object whose methods are thin
  `ipcRenderer.invoke(channel, payload)` wrappers (see 5.3). **No `fs`, no
  `child_process`, no raw `ipcRenderer`** is exposed to the page.

**Hardening to apply in `main.cjs` (ISO A.8.27/A.8.28):**

- Set a strict **CSP** via `session.defaultSession.webRequest.onHeadersReceived`
  (or a `<meta http-equiv>` in `index.html`): `default-src 'self'; script-src
  'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;`
  `object-src 'none'; base-uri 'none'`.
- **Block navigation & new windows:** `webContents.on('will-navigate', …)` and
  `setWindowOpenHandler(() => ({ action: 'deny' }))` so the renderer can never be
  driven to a remote origin. External links (e.g. README/ACK) go through
  `shell.openExternal` after an allowlist check — this replaces the `exec()`
  browser-opener (R4).
- Disable the `remote` module (not enabled by default in modern Electron — assert
  it stays off).
- `app.enableSandbox()` before `app.whenReady()`.

**`package.json` scripts:** add `"start:electron": "electron electron/main.cjs"`.
The existing `"start": "node server.js"` stays during the transition.

---

## 5. Phase 5.2 — Extract the engine from Express into a pure module

The route handlers in `server.js` already contain self-contained logic; pull it
out so both the (temporary) Express server **and** the Electron main process can
call it. This is a mechanical refactor with no behavior change.

**New `engine/` module** (CJS or ESM — match what Electron main uses; `.cjs` is
simplest for the main process):

- `engine/globs.js` — `globToRegExp`, `compileGlobs`, `isIgnored`,
  `DEFAULT_IGNORES` (lifted from `server.js:30–80`).
- `engine/scan.js` — `scanDirectory`, the `classify()`/file-pair logic, and the
  `scan({ leftPath, rightPath, recursive, ignore })` entry used by `/api/scan`
  (`server.js:312`).
- `engine/diff.js` — the `/api/diff` body (`server.js:483`) → `computeDiff(...)`
  returning `{ rows, unified }`; plus `hashFile(...)` from `/api/hash`.
- `engine/sync.js` — `sync(...)` and `undo(...)` from `server.js:602`/`692`,
  including the **path-traversal validation** ("`relativePath` stays within the
  resolved base") and the temp-dir backup transaction. Keep `lastTransaction`
  state in the main process (single-window → single in-memory transaction is fine,
  matching today's "most recent action" semantics).
- `engine/sessions.js` — `getSessions()`/`setSessions()` from `server.js:780`/`794`.
  **Decision (see §9):** sessions move from `process.cwd()/.comparer/` to
  `app.getPath('userData')` because an Electron app has no meaningful cwd.
- `engine/watch.js` — `startWatch(leftPath, rightPath, ignore, onEvent)` wrapping
  the `chokidar` setup (`server.js:132–137`), calling `onEvent` instead of writing
  to an SSE stream.

**Validation hardening (A.8.28):** each engine entry re-validates its inputs
(types, absolute-path normalization, traversal guard) regardless of caller — the
IPC layer is the boundary, but defense-in-depth keeps validation in the engine.

`server.js` is rewritten to import these and keep its routes as thin adapters
during the transition; it can be deleted in 5.5.

---

## 6. Phase 5.3 — IPC contract + preload bridge

Define the **complete, typed channel list** — this is both the API and (per 5.0)
the entire attack surface. One `ipcMain.handle` per channel in `main.cjs`; one
`window.comparer` method per channel in `preload.cjs`.

| Renderer call (`window.comparer.*`) | IPC channel | Main → engine | Replaces |
|--------------------------------------|-------------|---------------|----------|
| `scan(opts)` | `comparer:scan` | `engine.scan` | `POST /api/scan` |
| `hash(opts)` | `comparer:hash` | `engine.hashFile` | `POST /api/hash` |
| `diff(opts)` | `comparer:diff` | `engine.computeDiff` | `POST /api/diff` |
| `sync(opts)` | `comparer:sync` | `engine.sync` (+ audit log) | `POST /api/sync` |
| `undo()` | `comparer:undo` | `engine.undo` (+ audit log) | `POST /api/undo` |
| `ignoreTest(opts)` | `comparer:ignore-test` | `engine.ignoreTest` | `POST /api/ignore-test` |
| `getSessions()` | `comparer:sessions:get` | `engine.getSessions` | `GET /api/sessions` |
| `setSessions(list)` | `comparer:sessions:set` | `engine.setSessions` | `POST /api/sessions` |
| `startWatch(opts)` / `stopWatch()` | `comparer:watch:start` / `:stop` | `engine.startWatch` | `GET /api/watch` (SSE) |
| `onWatch(cb)` | event: `comparer:watch:event` | `webContents.send` | SSE `onmessage` |

**Rules baked into the contract (A.8.27/A.8.28):**

- Every `handle` wraps the engine call in try/catch and returns
  `{ ok: true, data }` / `{ ok: false, error }` — never throws raw across IPC, and
  never leaks stack traces to the renderer.
- Inputs are validated **at the handler** before reaching the engine (string
  types, length caps, the existing traversal guard). Reject unknown shapes.
- The watcher uses **main → renderer push** (`webContents.send`) for events and
  `ipcRenderer.on` in preload, surfaced as `comparer.onWatch(callback)` returning
  an unsubscribe function. No long-lived stream/socket.

---

## 7. Phase 5.4 — Port the frontend (fetch → IPC, EventSource → IPC events)

`public/app.js` has a small, enumerable set of network touchpoints. Replace each
`fetch('/api/…')` with the matching `await window.comparer.*` call and the
`EventSource` with `onWatch`. The UI logic, rendering, and DOM stay untouched.

**Touchpoints to convert (`public/app.js`):**

- `fetch('/api/scan', …)` → `comparer.scan(body)` — lines **162**, **308**.
- `fetch('/api/hash', …)` → `comparer.hash(body)` — line **366**.
- `fetch('/api/sync', …)` → `comparer.sync(body)` — line **383**.
- `fetch('/api/undo', …)` → `comparer.undo()` — line **411**.
- `fetch('/api/diff', …)` → `comparer.diff(body)` — lines **810**, **982**.
- `fetch('/api/ignore-test', …)` → `comparer.ignoreTest(body)` — line **1881**.
- `fetch('/api/sessions')` / `POST` → `comparer.getSessions()` /
  `comparer.setSessions(list)` — lines **1985**, **2004**.
- `new EventSource('/api/watch')` → `comparer.startWatch(...)` +
  `comparer.onWatch(handler)` — lines **284–289**.
- `fetch(`${window.location.origin}/style.css`)` (used by HTML export to inline
  CSS) — line **457**: under `file://` this becomes a `comparer.readAsset('style.css')`
  IPC call (or inline the CSS at build time). Small, but on the list.

**Compatibility-shim option (lower-risk first cut):** add a tiny adapter at the
top of `app.js` that maps the old call sites to `window.comparer`, e.g. a local
`api.scan = (b) => window.comparer.scan(b)`, so the diff is mechanical and
reviewable. The response shape from each handler is made identical to today's JSON
so downstream rendering code is unchanged.

**Watcher semantics:** `onWatch(handler)` delivers the same `{ type, side, path }`
event objects the SSE stream emitted, so `refreshScanSilent` and the grid-refresh
path are reused as-is. Call `stopWatch()` on new scan / window unload.

---

## 8. Phase 5.5 — Packaging & code signing (electron-builder)

Replace the SEA/postject pipeline (`scripts/build.mjs`, `sea-config.json`) with
**`electron-builder`**.

- Add `electron`, `electron-builder` to `devDependencies`; add a `build` block to
  `package.json` (appId `com.comparer.app`, Windows `nsis` target — installer —
  or `portable` if a single double-clickable exe is required to match today's UX).
- **Code signing (A.8.7/A.8.19):** configure Windows signing
  (`win.certificateFile`/`certificatePassword` or an Azure Trusted Signing /
  EV-cert flow in CI). Document the certificate handling as ISO key-management
  evidence. A signed installer removes the SmartScreen warning that the unsigned
  SEA exe currently triggers.
- **SBOM + SCA (A.8.8):** generate an SBOM (`@cyclonedx/cyclonedx-npm`) as a build
  artifact; run `npm audit --production` (and ideally a scheduled scan) in CI and
  fail on high severity.
- Update README "Standalone Executable" section: the **firewall prompt note is
  removed** (no listener) — call this out explicitly as the user-visible security
  win. Remove SEA build instructions; document `npm run dist`.
- Delete `server.js`, `sea-config.json`, `scripts/build.mjs`, and the
  `express`/SEA-only paths once Electron is the sole entry point. Drop `express`
  from dependencies.

---

## 9. Decisions to confirm

1. **Distribution format:** NSIS **installer** (better for signing/auto-update,
   standard for enterprise deployment & ISO change-management) vs **portable exe**
   (matches today's "unzip and double-click, nothing installed" UX). *Recommended:
   signed NSIS installer*, with a portable target as a secondary.
2. **Sessions storage location:** move `.comparer/sessions.json` to
   `app.getPath('userData')` (correct for a desktop app) **vs** keep it
   project-relative for the existing "team sessions committed to a shared folder"
   workflow. *Recommended: userData by default, with an optional "open from
   folder" import/export to preserve the team-sessions use case.*
3. **Auto-update:** wire `electron-updater` now (signed releases, A.8.8 patch
   delivery) or defer. *Recommended: scaffold but ship disabled until a signed
   release channel exists.*
4. **Frontend port style:** thin compatibility shim (mechanical, low-risk, keeps
   `app.js` diff small) vs a full rewrite of the call sites to `window.comparer`.
   *Recommended: shim first, inline later.*

---

## 10. Files touched (summary)

| File | Change |
|------|--------|
| `electron/main.cjs` | **New.** Secure `BrowserWindow`, CSP, navigation lockdown, `ipcMain.handle` per channel, chokidar→`webContents.send`, audit logging. |
| `electron/preload.cjs` | **New.** `contextBridge` exposes the frozen `window.comparer` API; nothing else. |
| `engine/globs.js`, `scan.js`, `diff.js`, `sync.js`, `sessions.js`, `watch.js` | **New.** Pure engine extracted from `server.js` route bodies; input validation + traversal guard retained and unit-tested. |
| `public/app.js` | `fetch('/api/*')` → `window.comparer.*`; `EventSource` → `onWatch`; CSS-inline fetch → asset IPC (lines 162, 284–289, 308, 366, 383, 411, 457, 810, 982, 1881, 1985, 2004). |
| `public/index.html` | Add CSP `<meta>`; no structural change. |
| `package.json` | Add `electron`/`electron-builder`; `build` config; `start:electron`/`dist` scripts; drop `express` + SEA scripts at cutover. |
| `docs/SECURITY.md` | **New.** Threat model, trust boundary, IPC attack surface, ISO control mapping (5.0). |
| `server.js`, `sea-config.json`, `scripts/build.mjs` | **Removed** at cutover (5.5). |
| `README.md` | Electron run/build docs; remove firewall note; note the security improvement. |
| `tests/` | IPC handler validation tests; engine unit tests; keep scan/diff fixtures. |

No change to the comparison/diff/sync **engine semantics** — only its host and
transport. The five Phase 4 features (summary bar, sort, ignore-test, exports,
sessions) all ride on the unchanged engine and the new IPC API.

---

## 11. Incremental / rollback strategy

The phases are ordered so each is independently shippable and reversible:

- **5.0–5.2** add files and refactor without removing the working Express app —
  `npm start` still works throughout.
- **5.3–5.4** make Electron functional (`npm run start:electron`) while Express
  remains as a fallback; both share the same `engine/`.
- **5.5** is the cutover: only after the Electron build is verified do we delete
  `server.js`/SEA. If signing or packaging slips, the Express path still ships.

---

## 12. Verification plan

- **No listener (R1):** after `start:electron`, confirm nothing is bound —
  `netstat`/`ss` shows no `:3000`; `curl http://localhost:3000` refuses. This is
  the headline ISO/network-control check.
- **Renderer is sandboxed (A.8.27):** in DevTools console, `typeof require`,
  `typeof process`, `window.comparer.__proto__` confirm no Node access and a
  frozen, method-only bridge. Attempting `window.location='https://example.com'`
  is blocked by the navigation handler.
- **Functional parity:** run `tests/mock_left` vs `tests/mock_right` — scan, diff
  (split + unified), sync + undo (verify temp-dir backup + restore), ignore-test,
  CSV/HTML export, and live watching (edit a watched file → grid refreshes via
  `onWatch`) all behave identically to the Express build.
- **Traversal guard (A.8.28):** call `comparer.sync`/`comparer.diff` with a
  `relativePath` containing `..` → rejected, no file touched (port the existing
  guard's tests to the IPC layer).
- **Audit log (A.8.15):** every sync/undo appends a record (timestamp, action,
  resolved paths) to the userData audit log; verify entries after a sync.
- **Packaging (A.8.7/A.8.19):** built installer is signed (Authenticode verifies),
  installs and launches without a firewall prompt; SBOM + `npm audit` artifacts are
  produced in CI.
