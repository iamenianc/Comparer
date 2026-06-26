# Handover — Phase 5: Migrate Comparer from localhost HTTP to Electron IPC

Agent-to-agent implementation handover. The engine semantics do not change; only
the host (Express server → Electron main) and transport (`fetch`/SSE → IPC).

## Goal

Remove the `localhost:3000` HTTP listener. Run the existing vanilla `public/` UI
inside an Electron `BrowserWindow`; route all `/api/*` calls and the SSE watcher
through `contextBridge` + `ipcMain`. Keep `server.js` runnable until cutover (5.5).

## Target architecture

```
Renderer (public/, sandboxed)  --ipcRenderer.invoke-->  preload.cjs (contextBridge)
   window.comparer.scan(...)                                |
                                                            v
                                          main.cjs  ipcMain.handle(channel)
                                                            |
                                                            v
                                          engine/*.cjs  (fs, crypto, diff, chokidar)
   window.comparer.onWatch(cb)  <--webContents.send('comparer:watch:event')--
```

## Implementation order (each step independently runnable)

1. Extract engine (5.2) — `npm start` still works.
2. Add Electron shell + IPC (5.1, 5.3) — `npm run start:electron` works alongside Express.
3. Port frontend (5.4).
4. Cutover: delete Express/SEA, package (5.5).

---

## 5.1 — Electron shell

New `electron/main.cjs`. Required `BrowserWindow` config (do not weaken):

```js
new BrowserWindow({
  webPreferences: {
    preload: path.join(__dirname, 'preload.cjs'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    webSecurity: true,
    allowRunningInsecureContent: false,
  },
});
win.loadFile(path.join(__dirname, '..', 'public', 'index.html'));
```

Also in `main.cjs`:
- `app.enableSandbox()` before `app.whenReady()`.
- CSP via `session.defaultSession.webRequest.onHeadersReceived` **or** a `<meta>` in
  `index.html`: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'`.
- Block navigation/new windows: `webContents.on('will-navigate', e => e.preventDefault())`
  and `webContents.setWindowOpenHandler(() => ({ action: 'deny' }))`.
- External links via `shell.openExternal` (allowlist-checked). This replaces the
  `child_process.exec` browser-opener at `server.js:837`.

New `electron/preload.cjs`: only `contextBridge.exposeInMainWorld('comparer', {...})`
exposing the methods in the IPC table below as thin `ipcRenderer.invoke` wrappers.
Do **not** expose `fs`, `child_process`, or raw `ipcRenderer`.

`package.json`: add `"start:electron": "electron electron/main.cjs"`; keep `"start"`.

---

## 5.2 — Engine extraction (mechanical, no behavior change)

Lift these `server.js` regions into `engine/` (use `.cjs` to match the main process):

| New module | Function(s) | Source in `server.js` |
|------------|-------------|------------------------|
| `engine/globs.cjs` | `globToRegExp`, `compileGlobs`, `isIgnored`, `DEFAULT_IGNORES` | lines 30–80 |
| `engine/scan.cjs` | `scan({leftPath,rightPath,recursive,ignore})`, `scanDirectory`, `classify` | route `:312` |
| `engine/diff.cjs` | `computeDiff(...) → {rows, unified}`, `hashFile(...)` | routes `:483`, `:466` |
| `engine/sync.cjs` | `sync(...)`, `undo(...)`, traversal guard, temp-dir backup, `lastTransaction` state | routes `:602`, `:692` (fs ops 643–677, 702–710) |
| `engine/sessions.cjs` | `getSessions()`, `setSessions(list)` | routes `:780`, `:794` |
| `engine/watch.cjs` | `startWatch(leftPath, rightPath, ignore, onEvent)` calling `onEvent` instead of writing SSE | `chokidar` setup `:132–137`, route `:810` |

Requirements:
- **Keep the path-traversal guard** (resolved `relativePath` must stay within base)
  in `sync`/`diff`. Re-validate inputs in the engine regardless of caller.
- `lastTransaction` lives in the main process (single window → single in-memory
  transaction, same "undo most recent" semantics as today).
- During transition, rewrite `server.js` routes as thin adapters calling `engine/`.

---

## 5.3 — IPC contract (this list IS the entire attack surface)

One `ipcMain.handle` per channel; one `window.comparer.*` method per channel.

| `window.comparer.*` | channel | main → engine | replaces |
|----------------------|---------|---------------|----------|
| `scan(opts)` | `comparer:scan` | `engine.scan` | `POST /api/scan` |
| `hash(opts)` | `comparer:hash` | `engine.hashFile` | `POST /api/hash` |
| `diff(opts)` | `comparer:diff` | `engine.computeDiff` | `POST /api/diff` |
| `sync(opts)` | `comparer:sync` | `engine.sync` + audit log | `POST /api/sync` |
| `undo()` | `comparer:undo` | `engine.undo` + audit log | `POST /api/undo` |
| `ignoreTest(opts)` | `comparer:ignore-test` | `engine.ignoreTest` | `POST /api/ignore-test` |
| `getSessions()` | `comparer:sessions:get` | `engine.getSessions` | `GET /api/sessions` |
| `setSessions(list)` | `comparer:sessions:set` | `engine.setSessions` | `POST /api/sessions` |
| `startWatch(opts)` / `stopWatch()` | `comparer:watch:start` / `:stop` | `engine.startWatch` | `GET /api/watch` |
| `onWatch(cb)` | event `comparer:watch:event` (push) | `webContents.send` | SSE `onmessage` |

Handler rules:
- Wrap each call in try/catch; return `{ ok:true, data }` / `{ ok:false, error }`.
  Never throw raw across IPC; never return stack traces.
- Validate input shape/types at the handler before calling the engine.
- `onWatch(cb)` returns an unsubscribe fn; deliver the same event object shape the
  SSE stream emitted so renderer logic is unchanged.
- **Response payload of each handler must match the current JSON shape** so the UI
  rendering code needs no changes.

---

## 5.4 — Frontend port (`public/app.js`)

Replace each call site. Lowest-risk approach: add a top-of-file adapter
(`const api = window.comparer;`) and swap calls mechanically.

| Current | Replace with | Line(s) |
|---------|--------------|---------|
| `fetch('/api/scan', …)` | `comparer.scan(body)` | 162, 308 |
| `fetch('/api/hash', …)` | `comparer.hash(body)` | 366 |
| `fetch('/api/sync', …)` | `comparer.sync(body)` | 383 |
| `fetch('/api/undo', …)` | `comparer.undo()` | 411 |
| `fetch('/api/diff', …)` | `comparer.diff(body)` | 810, 982 |
| `fetch('/api/ignore-test', …)` | `comparer.ignoreTest(body)` | 1881 |
| `fetch('/api/sessions')` GET / POST | `comparer.getSessions()` / `comparer.setSessions(list)` | 1985, 2004 |
| `new EventSource('/api/watch')` | `comparer.startWatch(opts)` + `comparer.onWatch(handler)` | 284–289 |
| `fetch(`${location.origin}/style.css`)` (CSS inline for HTML export) | `comparer.readAsset('style.css')` IPC, or inline CSS at build | 457 |

Add CSP `<meta>` to `public/index.html`. Call `stopWatch()` on new scan / unload.

---

## 5.5 — Packaging (cutover)

- Replace SEA pipeline with `electron-builder`. Remove `server.js`,
  `sea-config.json`, `scripts/build.mjs`; drop `express` from dependencies.
- `package.json` build block: appId `com.comparer.app`; Windows target `nsis`
  (installer) or `portable` — **see decision 1**.
- Code-sign the Windows artifact (removes SmartScreen + the firewall prompt noted
  in README).
- Update README: remove the localhost/firewall note; document `start:electron` and
  the new build command. Remove SEA instructions.

---

## Blocking decisions (resolve before/with implementation)

1. **Distribution:** signed NSIS installer (recommended) vs portable exe (matches
   current "unzip & double-click" UX).
2. **Sessions location:** move `.comparer/sessions.json` from `process.cwd()` to
   `app.getPath('userData')` (recommended — Electron has no meaningful cwd) vs keep
   project-relative for the "team sessions in a shared folder" workflow. If moved,
   add import/export to preserve that workflow.
3. **Auto-update:** scaffold `electron-updater` now vs defer (recommended: defer
   until a signed release channel exists).

---

## Also required (security tasks, not optional polish)

- `docs/SECURITY.md`: trust boundary (renderer untrusted / preload thin / main
  trusted) and the IPC channel list as the attack surface.
- Audit log: append `{timestamp, action, resolvedPaths}` for every `sync`/`undo`
  to a file under `userData`.

---

## Verification

- **No listener:** after `start:electron`, `ss`/`netstat` shows no `:3000`;
  `curl http://localhost:3000` refuses connection.
- **Renderer locked down:** DevTools `typeof require` → `"undefined"`,
  `typeof process` → `"undefined"`; setting `window.location` to a remote URL is
  blocked.
- **Functional parity** on `tests/mock_left` vs `tests/mock_right`: scan, split +
  unified diff, sync + undo (verify temp-dir backup and restore), ignore-test,
  CSV/HTML export, live watch (edit watched file → grid refreshes via `onWatch`).
- **Traversal guard:** `sync`/`diff` with `relativePath` containing `..` → rejected,
  no file touched.
- **Packaging:** built artifact is Authenticode-signed; installs/launches with no
  firewall prompt.

## Files

New: `electron/main.cjs`, `electron/preload.cjs`, `engine/{globs,scan,diff,sync,sessions,watch}.cjs`, `docs/SECURITY.md`.
Edit: `public/app.js`, `public/index.html`, `package.json`, `README.md`, `tests/`.
Remove at cutover: `server.js`, `sea-config.json`, `scripts/build.mjs`.
