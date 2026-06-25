# Implementation Plan — Phase 3: Exclusions, Sessions & Standalone Distribution

This is the **final** build phase. It hardens the comparison engine for large enterprise
directories (glob exclusions), lets users save and reload named comparison setups
(sessions), and packages the whole tool into a single double-clickable Windows executable
so non-technical staff can run it without Node.js or a terminal.

> **Status as of this revision:** Phases 1–2 are complete. The app already supports
> recursive scanning, MD5 content hashing, two-way sync with transactional backup/undo,
> real-time `chokidar` SSE watching, and side-by-side text diffing. Phase 3 builds
> directly on the existing `server.js` API and the vanilla `public/` frontend.

---

## Current State (what already exists — do not rebuild)

* **Scan engine**: `scanDirectory()` in [server.js](server.js) walks both trees recursively
  and returns a flat `{ relativePath: meta }` map; `/api/scan` merges them into a `compared[]`
  array with `status` (`identical | modified | left-only | right-only`), `newerSide`,
  and `timeDiffStr`.
* **Watchers**: `setupWatchers()` already hardcodes an `ignored` list for the chokidar
  watchers (dotfiles, `**/node_modules/**`, `**/.git/**`) at [server.js:61](server.js#L61).
  ⚠️ **Gap**: `scanDirectory()` itself applies **no** ignore filtering, so excluded folders
  are still fully walked and hashed during a scan — only live file events are filtered.
  Phase 3 must close this gap so the *scan* honors the same (and user-extended) rules.
* **Sync/undo**: `/api/sync` + `/api/undo` with backups under `os.tmpdir()/.comparer-backups`,
  cleared on startup and on exit.
* **No build/packaging config** exists yet (`package.json` has only `start`); no
  auto-browser-launch; `child_process` is not yet imported.

---

## Technical Tasks

### 1. Glob Ignore Filtering (scan + watch unified)

* **Shared ignore module** (`server.js` or a small `ignore.js`):
  * Implement a `compileGlobs(patterns)` helper that converts a small glob subset
    (`*`, `**`, `?`, literal segments) into anchored `RegExp`s. Normalize all paths to
    forward slashes before matching so Windows `\` paths compare correctly.
  * Expose `isIgnored(relativePath, compiledPatterns)` used by **both** the scan loop and
    the watcher config — single source of truth, no drift between scan and live events.
* **Backend integration**:
  * Add an `ignore: string[]` field to the `POST /api/scan` request body. Merge it with a
    server-side `DEFAULT_IGNORES` constant.
  * In `scanDirectory()`, test each entry's `relativePath` **before** recursing into a
    directory or stat-ing a file, so ignored subtrees (e.g. `node_modules`) are skipped
    entirely — saving the IO and the MD5 hashing cost that currently dominates large scans.
  * Feed the same merged list into `setupWatchers()` instead of the hardcoded array.
* **Frontend Exclusions UI**:
  * A panel listing the active globs, seeded with defaults
    (`**/.git`, `**/node_modules`, `**/Thumbs.db`, `**/.DS_Store`, `**/dist`).
  * Add/remove custom patterns; persist to `localStorage` (`comparer_ignore_globs`) and
    send the list on every `/api/scan` and `refreshScanSilent()` call.
  * Re-scan automatically when the list changes.

### 2. Session Management & Named Reloading

* **Data model** — a session captures everything needed to reproduce a comparison:
  `{ name, leftPath, rightPath, recursive, ignore[], activeFilter, savedAt }`.
* **Storage strategy**:
  * Primary: browser `localStorage` under `comparer_sessions` (a JSON array), keyed by name.
    Lightweight, zero-backend, survives restarts.
  * Optional later: persist to a `.comparer/sessions.json` on disk via a new
    `GET/POST /api/sessions` route for multi-machine use. Defer unless requested — keep
    Phase 3 shippable with localStorage only.
* **UI controls**:
  * A collapsible "Sessions" side panel (matching the existing light-mode Material styling).
  * "Save current setup" → prompts for a name, snapshots the current paths/options/ignores.
  * List of saved sessions, each with a one-click **Reload** (repopulates inputs + ignores
    and triggers a scan) and **Delete**.
  * Guard against name collisions (overwrite-confirm) and empty names.

### 3. Standalone Executable Packaging & Distribution

> **Packaging note:** the original plan named `pkg` + `node18`. `pkg` (vercel) is
> **deprecated and unmaintained**. Use one of the two current options below; prefer (A).

* **Auto-browser launch** (needed for either option):
  * In `server.js`, after `app.listen` succeeds, open the default browser to
    `http://localhost:<PORT>`. On Windows use
    `import { exec } from 'child_process'; exec('start "" http://localhost:' + PORT);`
    (the empty `""` title arg avoids `start` mis-parsing the URL). Gate behind an env flag
    (e.g. `COMPARER_NO_OPEN`) so dev runs can suppress it.
  * Ensure static assets resolve when bundled: when running as a packaged binary the
    `public/` path differs from `__dirname`. Detect the SEA/pkg runtime and resolve assets
    accordingly (see option notes).

* **Option A — Node.js Single Executable Applications (SEA), recommended**:
  * Built into Node 20+, no third-party dependency. Bundle `server.js` with `--experimental-sea-config`,
    generate the blob, and inject it into a copy of the `node` binary; sign/rename to
    `comparer.exe`.
  * Because SEA bundles only JS, ship `public/` either (i) alongside the exe in the zip, or
    (ii) embedded as SEA assets and served from memory. Start with (i) for simplicity.
  * Add scripts to `package.json`, e.g.:
    `"build:blob"`, `"build:exe"` chaining the SEA steps, plus a top-level `"build"`.

* **Option B — `@yao-pkg/pkg` (maintained `pkg` fork), fallback**:
  * If SEA asset handling proves fiddly, use the community-maintained fork which still
    supports `--targets` and auto-bundles `public/` via `pkg` `assets` config.
  * Target current Node: `"build": "pkg . --targets node20-win-x64 --output dist/comparer.exe"`,
    and add a `"pkg": { "assets": ["public/**/*"] }` block to `package.json`.

* **Distribution zip**:
  * Produce `dist/comparer.zip` containing `comparer.exe` (and `public/` if using SEA
    option (i)). Double-click → server starts → browser opens automatically.
  * Document the one-step run in the README and note the firewall prompt staff may see
    on first launch (localhost listener).

---

## Cross-Cutting Concerns

* **Path safety**: now that scan/sync accept user-supplied paths and globs, validate that
  `relativePath` in `/api/sync` and `/api/diff` stays within the resolved base
  (reject `..` traversal) before any file write/delete.
* **Doc sync**: the README's `grid-template-columns` example is stale and does not match the
  real `--col-width-*` variables in `style.css`. Update the README's Architecture section
  and add Phase-3 features (exclusions, sessions, packaging) to it.
* **Performance**: confirm that skipping ignored subtrees in `scanDirectory()` measurably
  reduces scan time on a tree containing a large `node_modules` (this is the main payoff).

---

## Verification Plan

### Mock scenario for exclusions
* In `tests/mock_left/`, create `node_modules/` with many dummy files (and mirror a couple
  in `tests/mock_right/` so they'd otherwise diff).
* Ensure `**/node_modules` is in the active ignore list.

### Agentic / manual verification
* Start the server (`npm start`) on `http://localhost:3000`.
* **Exclusions**: trigger a scan and verify no `node_modules` entries appear in the grid;
  confirm scan time drops versus an unfiltered run.
* **Sessions**: create "Test Sync Session", change the path inputs to junk values, reload the
  saved session, and verify paths + ignore list + filter restore exactly.
* **Path safety**: attempt a `/api/sync` with a `relativePath` containing `..` and confirm
  it is rejected.
* **Packaging**:
  * Run `npm run build` to produce `dist/comparer.exe`.
  * Launch `comparer.exe` directly (no terminal): verify the server starts and the default
    browser opens to the app automatically, and a real scan/sync works from the packaged build.
  * Verify `dist/comparer.zip` unzips and runs on a machine without Node.js installed.
