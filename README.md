# Comparer - Folder Comparison Tool

Comparer is a local, high-density folder and file comparison tool optimized for Windows 11. It features deep hashing, two-way sync, transactional backup/undo, real-time filesystem watching, side-by-side and unified text diffing, glob-based exclusions, saved comparison sessions, and a standalone double-clickable Windows executable.

---

## Standalone Executable (no Node.js required)

Non-technical users can run Comparer without installing Node.js or using a terminal:

1. Download and unzip `comparer.zip`.
2. Double-click `comparer.exe`. The local server starts and your default browser
   opens to the app automatically.

> **First-launch note:** Windows may show a firewall prompt the first time, because
> the exe opens a local `http://localhost` listener. Allow access on private networks;
> nothing leaves your machine.

The `comparer.zip` distributable contains `comparer.exe` alongside the `public/` folder
(static assets). Keep them together when copying.

---

## Getting Started

### Prerequisites

You need **Node.js** (v18 or higher) installed on your system to run from source.
Building the standalone executable requires **Node.js v20 or higher** (for SEA support).
End users running the prebuilt `comparer.exe` need nothing installed.

### Installation

1. Navigate to the repository directory.
2. Install the lightweight Node.js dependencies:
   ```bash
   npm install
   ```

### Running the App

Start the local server:
```bash
npm start
```

The application will launch a web server listening on port **3000** and open your default
browser automatically. To suppress the auto-open (e.g. during development), set
`COMPARER_NO_OPEN=1`. To use a different port, set `PORT`. If the browser does not open,
navigate to [http://localhost:3000](http://localhost:3000).

### Building the standalone executable

The standalone `comparer.exe` is produced via [Node.js Single Executable Applications (SEA)](https://nodejs.org/api/single-executable-applications.html).
Requires Node 20+ and the build devDependencies (`npm install` installs them):

```bash
npm run build
```

This bundles `server.js` (and its dependencies) with `esbuild`, generates the SEA blob,
injects it into a copy of the `node` binary with `postject`, stages `public/` alongside the
exe, and produces `dist/comparer.exe` and `dist/comparer.zip`. See [scripts/build.mjs](scripts/build.mjs).

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
requiring a re-scan. It calls `POST /api/ignore-test`, which walks the paths with no filtering and
reports every entry the single pattern matches.

### Sessions

Open the **Sessions** panel to save and reload named comparison setups. A session captures
`{ name, leftPath, rightPath, recursive, ignore[], activeFilter, savedAt }`. **Reload** repopulates
the inputs, ignore list, and active filter, then runs a scan; **Delete** removes a saved session.
Saving over an existing name asks for overwrite confirmation.

**Team sessions (disk):** sessions are persisted to `.comparer/sessions.json` in the directory you
run `npm start` from, so anyone running from that project folder sees the same list immediately. The
panel header shows a **Team (disk)** / **Local (browser)** badge indicating which backend is active.
If the API is unreachable, the panel transparently falls back to `localStorage` (`comparer_sessions`),
which is also kept as a mirror so an offline reload still shows the last-known list.

---

## Developer Guide

### Architecture

The project is structured with a lightweight Express backend and a zero-compilation vanilla HTML/CSS/JS frontend.

* **Backend (`server.js`)**: Express server exposing API routes for directory operations, diff computation, sync, hashing, and real-time SSE watchers.
* **Frontend (`public/`)**:
  * `index.html`: Grid structure, diff modal, and the Exclusions / Sessions side panels.
  * `style.css`: Clean, strict light mode theme implementing Google Material Design guidelines and CSS grid columns.
  * `app.js`: Main frontend logic, EventSource watcher, grid rendering (with the summary bar,
    tri-state column sort, and CSV/HTML export), resizing mechanics, diff popup, exclusions
    (with pattern testing), and disk-backed session management.

### Path safety

`/api/sync` and `/api/diff` validate that the user-supplied `relativePath` stays within the
resolved base directory, rejecting any `..` traversal before reading, writing, or deleting.

### Key API Endpoints

* **`POST /api/scan`**: Scans the Left and Right paths (folders or individual files).
  * Body: `{ leftPath: String, rightPath: String, recursive: Boolean, ignore: String[] }`
  * When both paths are files, returns a single-row `filePairMode` result; when both are
    folders, returns the full recursive comparison. Mixed (file + folder) is rejected.
  * `ignore` is a list of glob patterns (`*`, `**`, `?`, literal segments). It is merged
    with the server-side `DEFAULT_IGNORES` (`**/.git`, `**/node_modules`, `**/Thumbs.db`,
    `**/.DS_Store`, `**/dist`). Ignored subtrees are pruned **before** any stat/MD5 work,
    so excluding a large `node_modules` measurably speeds up scans.
* **`POST /api/hash`**: Returns MD5 hash for a file.
  * Body: `{ filePath: String }`
* **`POST /api/diff`**: Calculates line-by-line diff between two files.
  * Body (folder mode): `{ leftPath: String, rightPath: String, relativePath: String }`
  * Body (file-pair mode): `{ leftFile: String, rightFile: String }`
  * Response: `{ rows: Row[], unified: UnifiedLine[] }` — `rows` powers the split view;
    `unified` (produced by `diff.structuredPatch`) powers the unified view.
* **`POST /api/sync`**: Executes a copy/delete sync operation. Creates a backup before modifying any files.
  * Body: `{ leftPath: String, rightPath: String, relativePath: String, action: 'keepLeft' | 'keepRight' | 'deleteLeft' | 'deleteRight' }`
* **`POST /api/undo`**: Restores the last sync action using backed up files stored in the OS temp directory.
* **`GET /api/watch`**: Establishes a Server-Sent Events (SSE) connection mapping real-time `chokidar` filesystem event alerts.
* **`POST /api/ignore-test`**: Previews which files a single glob would exclude from the given paths.
  * Body: `{ leftPath: String, rightPath: String, recursive: Boolean, pattern: String }`
  * Response: `{ pattern, count, matches: [{ side, relativePath }], truncated }`. Read-only — it
    walks both trees with no ignore filtering and reports every entry the pattern matches (capped
    at 500 matches, with `truncated: true` when more exist).
* **`GET /api/sessions`** / **`POST /api/sessions`**: Read and overwrite the shared, disk-backed
  session list stored at `.comparer/sessions.json` (relative to the server's working directory).
  * `GET` → `{ sessions: Session[] }` (empty array if the file is absent).
  * `POST` body: `{ sessions: Session[] }` — the client owns the full list (load-all / mutate /
    save-all). The frontend falls back to `localStorage` if these routes are unreachable.

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
