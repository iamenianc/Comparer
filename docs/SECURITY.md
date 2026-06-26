# Security Model

Comparer is an Electron desktop app. As of Phase 5 it no longer runs a local
HTTP server (`localhost:3000` is gone); the renderer talks to the privileged
main process exclusively over Electron IPC. This document describes the trust
boundary and the IPC surface that defines it.

## Trust boundary

```
┌─────────────────────────────┐   ipcRenderer.invoke   ┌──────────────────────────┐
│  Renderer (public/)         │ ─────────────────────▶ │  preload.cjs             │
│  UNTRUSTED                  │                        │  THIN BRIDGE             │
│  • sandbox: true            │ ◀───────────────────── │  • contextIsolation      │
│  • nodeIntegration: false   │  webContents.send      │  • exposes window.comparer│
│  • contextIsolation: true   │  (watch events)        │  • no fs / child / raw   │
│  • CSP: default-src 'self'  │                        │    ipcRenderer leaked    │
└─────────────────────────────┘                        └────────────┬─────────────┘
                                                                     │ ipcMain.handle
                                                                     ▼
                                                        ┌──────────────────────────┐
                                                        │  main.cjs + engine/*.cjs │
                                                        │  TRUSTED                 │
                                                        │  • fs, crypto, chokidar  │
                                                        │  • path-traversal guards │
                                                        │  • audit log             │
                                                        └──────────────────────────┘
```

- **Renderer — untrusted.** Treated as if it could be compromised by hostile file
  content (a diff of an attacker-controlled file, a crafted filename). It runs
  sandboxed with context isolation and no Node integration, under a strict
  Content-Security-Policy (`default-src 'self'`; see `public/index.html` and the
  response header set in `electron/main.cjs`). All assets — scripts, styles, and
  the Material Symbols icon font — are bundled locally; no network origins are
  allowed, so the app works fully offline. Navigation away from the bundled page
  and `window.open` popups are blocked; external links are only opened in the
  system browser after an allowlist check (`https:` / `mailto:` via
  `shell.openExternal`).

- **preload.cjs — thin bridge.** The only code that spans the isolation boundary.
  It exposes exactly the methods listed below on `window.comparer` as
  `ipcRenderer.invoke` wrappers and nothing else. It does **not** expose `fs`,
  `child_process`, or the raw `ipcRenderer`. Each call returns the main process's
  `{ ok, data }` / `{ ok, error }` envelope, unwrapped back into a resolved value
  or a thrown `Error`.

- **main.cjs + engine/*.cjs — trusted.** The only place with filesystem, crypto,
  and watcher access. Every renderer request arrives as an `ipcMain.handle` call
  on one of the channels below; handlers validate input shape/types before calling
  the engine, wrap everything in try/catch, and return only an error *message*
  across the boundary — never a stack trace. The engine re-validates inputs
  regardless of caller (defense in depth).

## Attack surface — the IPC channel list

This list **is** the entire attack surface. There is no other way for the
renderer to reach privileged code.

| `window.comparer.*`            | IPC channel               | Main → engine                  |
|--------------------------------|---------------------------|--------------------------------|
| `scan(opts)`                   | `comparer:scan`           | `engine.scan`                  |
| `hash(opts)`                   | `comparer:hash`           | `engine.hashFile`              |
| `diff(opts)`                   | `comparer:diff`           | `engine.computeDiff`           |
| `sync(opts)`                   | `comparer:sync`           | `engine.sync` + audit log      |
| `undo()`                       | `comparer:undo`           | `engine.undo` + audit log      |
| `ignoreTest(opts)`             | `comparer:ignore-test`    | `engine.ignoreTest`            |
| `getSessions()`                | `comparer:sessions:get`   | `engine.getSessions`           |
| `setSessions(list)`            | `comparer:sessions:set`   | `engine.setSessions`           |
| `exportSessions()`             | `comparer:sessions:export`| `engine.exportSessions` (dialog)|
| `importSessions()`             | `comparer:sessions:import`| `engine.importSessions` (dialog)|
| `readAsset(name)`              | `comparer:read-asset`     | read a basename under `public/` |
| `startWatch(opts)`             | `comparer:watch:start`    | `engine.startWatch`            |
| `stopWatch()`                  | `comparer:watch:stop`     | `engine.stopWatch`             |
| `onWatch(cb)`                  | event `comparer:watch:event` (push) | `webContents.send`   |

### Guards on the surface

- **Path traversal.** `sync` and `diff` resolve any user-supplied `relativePath`
  under the resolved base directory and reject results that escape it
  (`engine/diff.cjs` `safeJoin`, re-checked in `engine/sync.cjs`). A
  `relativePath` containing `..` is rejected and no file is touched.
- **Asset reads.** `readAsset` only accepts a bare basename and reads from
  `public/` — no directories, no traversal, no arbitrary filesystem read.
- **No raw errors.** Handlers never throw across IPC and never return stack
  traces; only `{ ok:false, error: <message> }` crosses the boundary.

## Audit log

Every `sync` and `undo` appends one JSON line —
`{ timestamp, action, resolvedPaths }` — to `audit.log` under the per-user app
data directory (`app.getPath('userData')`). This is an integrity record of every
destructive file operation the app performed.

## Data locations

- **Sessions:** `app.getPath('userData')/sessions.json`. Import/Export (native
  file dialogs) move the list to/from any JSON file to preserve the shared-folder
  team workflow.
- **Sync backups:** a temp directory (`os.tmpdir()/.comparer-backups`), cleared on
  startup and process exit. Backups exist only to power "undo most recent".
- **Audit log:** `app.getPath('userData')/audit.log`.
