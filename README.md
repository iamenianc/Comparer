# Comparer - Folder Comparison Tool

Comparer is a local, high-density folder and file comparison tool optimized for Windows 11. It features deep hashing, two-way sync, transactional backup/undo, real-time filesystem watching, side-by-side and unified text diffing, glob-based exclusions, and saved comparison sessions. It is an [Electron](https://www.electronjs.org/) desktop app — there is **no local web server and no `localhost` listener**.

---

## Running the Desktop App

Non-technical users run the prebuilt **`Comparer-<version>-portable.exe`**: double-click
it — no install, no terminal, no firewall prompt (there is no network listener; everything
stays on your machine). It is a single self-contained file.

---

## Getting Started (from source)

### Prerequisites

You need **Node.js** (v18 or higher) to run from source. The first `npm install`
downloads the Electron runtime binary.

### Installation

1. Navigate to the repository directory.
2. Install dependencies (this fetches the Electron runtime):
   ```bash
   npm install
   ```

### Running the App

```bash
npm start          # or: npm run start:electron
```

This launches the Electron window directly. There is no port, no browser, and no
auto-open step — the UI runs inside the app's own window.

### Building the portable executable

The distributable is produced with [electron-builder](https://www.electron.build/):

```bash
npm run dist
```

This packages `electron/`, `engine/`, and `public/` into a single portable Windows
`.exe` under `dist/` (`Comparer-<version>-portable.exe`). No staged `public/` folder is
required — assets are bundled into the executable.

> **Code signing (recommended for Enterprise rollout):** an unsigned `.exe` triggers
> Windows SmartScreen on first launch. To produce an Authenticode-signed artifact, set
> the `CSC_LINK` (path/URL to your `.pfx`) and `CSC_KEY_PASSWORD` environment variables
> before `npm run dist`; electron-builder signs automatically. Signing removes the
> SmartScreen warning.

---

## Features

### Folder and File Comparison

Point both inputs at directories for a full recursive scan, or point them at two individual
files for a direct side-by-side file comparison — even if the files have different names.
The scan returns a status for every entry: **Identical**, **Modified**, **Left only**, or **Right only**.

### Diff Viewer

Click the diff icon on any modified file to open a dedicated diff window:

- **Split view** — side-by-side panes with line numbers, colored additions (green) and
  removals (red), and faded unchanged context.
- **Unified view** — git-style patch (`@@ … @@` hunk headers, `+`/`-` prefixed lines).
  Toggle with the **Unified** button or press `u`.
- **Navigation** — jump between change blocks with `n` / `N` (or the ▲ ▼ buttons). The
  `+N −N` stat badge in the header shows the total line delta at a glance.
- **Word wrap** — toggle with `w` or the wrap button; applies to both split and unified views.
- **Diffs only** — hide unchanged context rows with `d`.
- **Copy** — copy the full left or right file text to the clipboard with the **L** / **R**
  buttons. Click any line number to copy a `filename:line` reference.
- **Export** — download the current diff as a self-contained HTML report (all CSS inlined,
  interactive controls stripped) via the **Export** button. The report opens with a metadata
  header listing the **Left path**, **Right path**, and **export timestamp**.

### Summary Bar

A chip strip below the header shows live counts for **Modified**, **Left Only**, **Right Only**,
and **Identical**, alongside a proportional color bar that visualizes the breakdown at a glance.
Each chip is a clickable shortcut to that filter and stays in sync with the filter tabs (clicking
a chip lights up the matching tab and vice-versa).

### Column Sort

Every sortable column header (**Filename**, **Status**, **Left/Right Date**, **Left/Right Size**)
cycles through a tri-state sort on click: ascending → descending → original. The choice is
persisted to `localStorage` (`comparer_sort`) and defaults to **Status-first** so differences
float to the top. Sorting by anything other than the path (Filename) flattens the folder grouping
into a clean flat list; sorting by Filename or returning to *original* restores the folder tree.

### Export CSV

The **Export CSV** toolbar button (enabled after a scan) downloads the full scan results — one row
per file with path, status, left/right sizes, and left/right modified dates — for audit and Excel
workflows. The file is UTF-8 with a BOM so spreadsheets read non-ASCII paths correctly.

### Two-Way Sync

Use the **Replace** buttons (in the diff window footer or the grid action buttons) to copy
one side's version over the other. Every sync action creates a timestamped backup in the OS
temp directory before touching any file, so it is always reversible.

### Undo

The **Undo** banner appears after every sync operation and lets you restore the previous
state with one click. Only the most recent action can be undone per session.

### Real-Time Watching

After a scan completes, Comparer watches both directories with `chokidar` and automatically
refreshes the grid when files change, are added, or are deleted — no manual re-scan needed.
The same glob exclusion list applied at scan time is also applied to the watchers, so ignored
paths never generate spurious updates.

### Exclusions

Open the **Exclusions** panel (header button) to manage the glob patterns skipped during a
scan. The list is seeded with sensible defaults (`**/.git`, `**/node_modules`, `**/Thumbs.db`,
`**/.DS_Store`, `**/dist`), and custom patterns can be added or removed. The list is persisted
to `localStorage` (`comparer_ignore_globs`), sent on every scan, and a change triggers an
automatic re-scan when a comparison is active.

Each pattern has a **Test** button (🔍) that previews exactly which files it would exclude from
the current scan paths — the matches are listed inline (per side) without altering the grid or
requiring a re-scan. It calls the `ignoreTest` IPC channel, which walks the paths with no filtering
and reports every entry the single pattern matches.

### Sessions

Open the **Sessions** panel to save and reload named comparison setups. A session captures
`{ name, leftPath, rightPath, recursive, ignore[], activeFilter, savedAt }`. **Reload** repopulates
the inputs, ignore list, and active filter, then runs a scan; **Delete** removes a saved session.
Saving over an existing name asks for overwrite confirmation.

**Sessions store (disk):** sessions are persisted to `sessions.json` under the per-user app data
directory (`app.getPath('userData')`), so they survive across runs. The panel header shows a
**Team (disk)** / **Local (browser)** badge indicating which backend is active; if the IPC store is
unreachable, the panel transparently falls back to `localStorage` (`comparer_sessions`), kept as a
mirror so an offline reload still shows the last-known list. Use the panel's **Import** / **Export**
buttons to move the list to/from any JSON file — e.g. a shared team folder, preserving the old
"team sessions in a shared folder" workflow now that storage is per-user.

---

## Developer Guide

### Architecture

Comparer is an Electron app: a sandboxed vanilla HTML/CSS/JS renderer driving a trusted main
process over IPC. There is no HTTP server. See [`docs/SECURITY.md`](docs/SECURITY.md) for the
full trust boundary and the IPC channel list (the app's entire attack surface).

* **Main process (`electron/main.cjs`)**: Creates the locked-down `BrowserWindow`
  (`contextIsolation`, `sandbox`, `nodeIntegration: false`, strict CSP, navigation/popup blocking),
  registers one `ipcMain.handle` per channel, writes the audit log, and owns watcher lifecycle.
* **Preload (`electron/preload.cjs`)**: The thin `contextBridge` that exposes `window.comparer.*`
  as `ipcRenderer.invoke` wrappers — and nothing else (no `fs`, no `child_process`, no raw
  `ipcRenderer`).
* **Engine (`engine/*.cjs`)**: Host-agnostic logic lifted out of the old server —
  `globs`, `scan`, `diff`, `sync`, `sessions`, `watch`. Pure Node (fs/crypto/chokidar/diff);
  unit-tested directly via `npm test`.
* **Frontend (`public/`)**:
  * `index.html`: Grid structure, diff modal, the Exclusions / Sessions side panels, and the CSP `<meta>`.
  * `style.css`: Strict light-mode theme; the Material Symbols icon font is vendored locally
    (`public/fonts/`) so the app runs fully offline under the CSP.
  * `app.js`: Frontend logic talking to the engine through `window.comparer`, the IPC watcher
    (`startWatch`/`onWatch`), grid rendering (summary bar, tri-state column sort, CSV/HTML export),
    resizing, diff view, exclusions (with pattern testing), and session management.

### Path safety

`engine/sync.cjs` and `engine/diff.cjs` validate that the user-supplied `relativePath` stays
within the resolved base directory (`safeJoin`), rejecting any `..` traversal before reading,
writing, or deleting — re-validated in the engine regardless of caller.

### IPC channels

The renderer reaches privileged code only through these channels (full table in
[`docs/SECURITY.md`](docs/SECURITY.md)). Each handler validates input, wraps the engine call in
try/catch, and returns `{ ok, data }` / `{ ok, error }` — never a raw error or stack trace.

* **`comparer:scan`** — `scan({ leftPath, rightPath, recursive, ignore[] })`. Both files →
  single-row `filePairMode`; both folders → full recursive comparison; mixed is rejected.
  `ignore` globs (`*`, `**`, `?`, literals) merge with `DEFAULT_IGNORES` (`**/.git`,
  `**/node_modules`, `**/Thumbs.db`, `**/.DS_Store`, `**/dist`); ignored subtrees are pruned
  **before** any stat/MD5 work.
* **`comparer:hash`** — `hash({ filePath })` → `{ hash }` (MD5).
* **`comparer:diff`** — `diff({ leftPath, rightPath, relativePath })` (folder mode) or
  `diff({ leftFile, rightFile })` (file-pair mode) → `{ rows, unified }`.
* **`comparer:sync`** — `sync({ leftPath, rightPath, relativePath, action })` with `action` one of
  `keepLeft | keepRight | deleteLeft | deleteRight`. Backs up before modifying; appends to the audit log.
* **`comparer:undo`** — `undo()`. Restores the most recent sync from the temp-dir backup; appends to the audit log.
* **`comparer:watch:start` / `:stop`** + push event **`comparer:watch:event`** — live `chokidar`
  events delivered to `window.comparer.onWatch(cb)` (replaces the old SSE stream).
* **`comparer:ignore-test`** — `ignoreTest({ leftPath, rightPath, recursive, pattern })` →
  `{ pattern, count, matches: [{ side, relativePath }], truncated }`. Read-only; capped at 500 matches.
* **`comparer:sessions:get` / `:set` / `:export` / `:import`** — read/overwrite the per-user session
  store, or move it to/from a JSON file via a native dialog.
* **`comparer:read-asset`** — read a bundled asset (basename under `public/`) so the HTML diff
  export can inline `style.css`.

### CSS Custom Layout Grid

The grid is built on a responsive CSS grid layout that dynamically resizes columns by updating CSS variables on the `.grid-panel` wrapper element:

```css
.grid-header,
.grid-row {
  display: grid;
  grid-template-columns: 
    var(--col-width-path, 1fr)
    var(--col-width-left-size, 85px)
    var(--col-width-left-date, 140px)
    var(--col-width-left-actions, 85px)
    var(--col-width-status, 160px)
    var(--col-width-right-actions, 85px)
    var(--col-width-right-size, 85px)
    var(--col-width-right-date, 140px);
}
```

Columns are user-resizable via drag handles on the header cells. Custom widths are persisted locally in `localStorage` (`comparer_col_widths`).
