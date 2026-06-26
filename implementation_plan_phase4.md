# Implementation Plan — Phase 4: Summary Bar, Column Sort, Ignore Testing, Exports & Team Sessions

This phase is purely additive UI/UX and reporting work on top of the existing
`server.js` API and the vanilla `public/` frontend. Five independent features,
each shippable on its own. No change to the scan/diff/sync engine semantics.

> **Status:** Phases 1–3 complete. The app has recursive scanning with glob
> exclusions, MD5 hashing, transactional sync/undo, SSE watching, side-by-side +
> unified diffing, a localStorage-backed Exclusions panel and Sessions panel, and
> SEA packaging. Phase 4 builds on:
> - `updateTabCounts()` ([app.js:1089](public/app.js#L1089)) — already computes all five counts.
> - `renderGrid()` ([app.js:1127](public/app.js#L1127)) — filters, sorts by `relativePath`, groups by folder.
> - the filter-tab click handler ([app.js:1445](public/app.js#L1445)) — sets `currentFilter`.
> - `exportDiffHtml()` ([app.js:464](public/app.js#L464)) — already inlines CSS + a generated-timestamp footer.
> - the Exclusions panel ([app.js:1610](public/app.js#L1610)) and Sessions panel ([app.js:1683](public/app.js#L1683)).
> - `compileGlobs()` / `isIgnored()` / `scanDirectory()` in [server.js](server.js).

---

## Cross-cutting refactor (do this first)

Three of the five features touch filtering/sorting state, so start by extracting a
single source of truth to avoid the chips, tabs, and sort headers drifting:

* **`setFilter(filter)`** — one function that (a) sets `currentFilter`, (b) toggles
  `.active` on the matching `.filter-tab`, (c) toggles `.active` on the matching
  summary chip, then (d) calls `renderGrid()`. Replace the inline body of the
  existing tab handler and the new chip handler with calls to this. This is what
  keeps the Summary Bar and the filter tabs in sync (requirement 1).
* **Add an `identical` filter** to the existing filter set. Today filters are
  `all | diff | modified | left | right`; the summary bar needs an `Identical`
  chip, so `renderGrid()`'s filter switch and the filter-tab markup gain an
  `identical` case (files where `status === 'identical'`). The existing
  `diff`/`all`/`modified`/`left`/`right` semantics stay unchanged.
* **`getSortedFiles(files)`** — pulls the current sort logic out of `renderGrid()`
  so both the grouped path-view and the new flat sorted-view share it (requirement 2).

---

## 1. Summary Bar (chip strip + proportional color bar)

A strip inserted between `</header>` and `<main class="grid-panel">` in
[index.html](public/index.html). Hidden until the first scan completes.

**Markup (`index.html`):** a `.summary-bar` containing
* four `.summary-chip` buttons — Modified, Left Only, Right Only, Identical — each
  `data-filter` matching a filter value (`modified | left | right | identical`),
  with a colored dot (reuse `.dot-modified/.dot-left/.dot-right` + a new
  `.dot-identical`, already defined as a CSS var) and a count span.
* a `.summary-proportional-bar` — a flex container of four `<div>` segments whose
  `flex-grow` (or width %) is set from the counts.

**JS (`app.js`):**
* Extend `updateTabCounts()` (or add `updateSummaryBar()` called from the same
  spots — `runScan`, `refreshScanSilent`) to write the four chip counts and set
  each color-bar segment's width to `count / total * 100%`. Show the bar
  (`.summary-bar` un-hidden) once `scanResult` exists; segments with 0 count get
  `display:none` so the bar stays clean.
* Chip click → `setFilter(chip.dataset.filter)`. Because `setFilter` also toggles
  chip `.active`, clicking a real filter tab lights up the matching chip and vice
  versa — the "stay in sync" requirement falls out for free.

**CSS (`style.css`):** `.summary-bar` (flex row, light surface, bottom border to
match `.app-header`), `.summary-chip` (pill, `.active` state using the existing
status color vars), `.summary-proportional-bar` (rounded, fixed height ~6px,
segments colored via the four `--color-*` vars). `.dot-identical` if not present.

**Edge cases:** zero-file scan → hide the bar; file-pair mode (single synthetic
row) → bar still valid (one segment). Color bar segments use the same color
vocabulary as the status badges so it reads instantly.

---

## 2. Column Sort (tri-state, persisted, status-first default)

Every `.header-col` in the grid header becomes clickable with a 3-state cycle:
**asc → desc → original (folder-grouped)**.

**Sortable columns & keys:**
| Column        | `data-col`     | sort key |
|---------------|----------------|----------|
| Filename      | `filename`     | `relativePath.toLowerCase()` |
| Status        | `status`       | rank map: `modified=0, left-only=1, right-only=2, identical=3` (diffs float up) |
| Left Date     | `left-date`    | `left?.mtimeMs ?? -Infinity` |
| Left Size     | `left-size`    | `left?.size ?? -Infinity` |
| Right Date    | `right-date`   | `right?.mtimeMs ?? -Infinity` |
| Right Size    | `right-size`   | `right?.size ?? -Infinity` |

(`Type` and the two action columns are not sortable.)

**State & persistence:**
* New module-level `sortState = { col, dir }` where `dir ∈ {'asc','desc'}` and
  `col === null` means "original".
* Persist to `localStorage['comparer_sort']`. **Default when nothing stored:**
  `{ col: 'status', dir: 'asc' }` (with the rank map above, `asc` puts Modified
  first — "diffs float to the top").
* ⚠️ Note: [app.js:1540](public/app.js#L1540) currently *clears* `comparer_col_widths`
  on load; the sort key is independent and must **not** be cleared.

**Header interaction:**
* Add click handlers to each sortable `.header-col` (in `initResizableColumns` or a
  new `initSortableHeaders`). Guard against clicks that originate on
  `.resize-handle` (`e.target.closest('.resize-handle')` → ignore) so resizing
  doesn't trigger a sort.
* Cycle: click a new column → that column `asc`; click the active column → `desc`;
  click again → back to `original` (`col=null`). Render a sort caret
  (`arrow_upward`/`arrow_downward` material symbol) in the active header, none when
  original.

**Render path (`renderGrid` via `getSortedFiles`):**
* If `sortState.col === null` **or** `=== 'filename'`-as-path → keep the current
  folder-grouped rendering (`groupFilesByDirectory` + collapsible folder rows).
* If `sortState.col` is any other column → **flatten**: skip
  `groupFilesByDirectory`, render one flat list of rows sorted by the key (then by
  `relativePath` as a stable tiebreaker), `desc` reverses. Folder rows / indent are
  omitted in flat mode (filename cell shows the full `relativePath` so context
  isn't lost). This satisfies "folder-grouping flattens to a clean flat list."
* Decision to confirm: spec says default is Status-first, which is a non-path
  column → **the app opens in flat, status-sorted view by default.** Folder
  grouping returns when the user cycles a column back to original or sorts by
  Filename. (Flagged as the one user-visible behavior change in this phase.)

---

## 3. Ignore Pattern Testing (`POST /api/ignore-test`)

A per-exclusion **Test 🔍** button that previews exactly which files a single
pattern would exclude from the current scan paths — no re-scan, no mutation.

**Backend — new route in [server.js](server.js):**
```
POST /api/ignore-test  { leftPath, rightPath, recursive, pattern }
→ { pattern, matches: [{ side, relativePath }], count }
```
* Resolve + validate `leftPath`/`rightPath` (reuse the `classify()` logic from
  `/api/scan`; 400 on missing).
* Walk each side with `scanDirectory(root, recursive, root, [])` (**no** ignores so
  the pattern is tested against the full tree), then keep entries where
  `isIgnored(relativePath, compileGlobs([pattern]))` is true. Tag each with its
  `side`. Cap the response (e.g. first 500 matches + a `truncated` flag) so a broad
  pattern like `**` doesn't return a huge payload.
* Pure read-only; no watchers, no backups.

**Frontend — Exclusions panel ([app.js:1610](public/app.js#L1610)):**
* In `renderExclusions()`, add a `🔍 Test` mini-button next to the existing delete
  button for each glob.
* Handler POSTs the current paths (`lastScanParams` if present, else the
  `left-path`/`right-path` input values) + that glob, then renders the returned
  matches **inline** under the item: a collapsible `<ul>` of `side · relativePath`
  rows with a count header ("Excludes 12 files"). Toggling Test again collapses it.
* Empty result → "No files match this pattern in the current paths." Missing paths
  → inline hint to enter/scan paths first.

**CSS:** `.exclusion-test-results` (indented, mono, scroll-capped ~200px), a
`.side-panel-mini-btn` variant for the search icon, reusing existing panel styles.

---

## 4. Diff Export improvements

### 4a. HTML export metadata header
`exportDiffHtml(win, wd, file)` ([app.js:464](public/app.js#L464)) already inlines
CSS and appends a generated-timestamp *footer*. Add a **metadata header block** at
the top of the exported `<body>`:
* **Left path**, **Right path**, **Exported** timestamp.
* Source the paths from the file object / `scanResult`: file-pair mode →
  `file.leftFile` / `file.rightFile`; folder mode →
  `scanResult.leftPath + '/' + file.relativePath` and the right equivalent.
  `scanResult` is already module-scoped and in reach.
* Render as a `.export-meta-header` (reuse the existing `.export-meta` styling),
  inserted before `${body.innerHTML}`. Keep the existing footer.

### 4b. Export CSV button (toolbar)
* **Markup:** an `Export CSV` button in the `.header-tools` group of
  [index.html](public/index.html) (next to Exclusions/Sessions), `disabled` by
  default.
* **Enable** it at the end of a successful `runScan()` (and keep enabled across
  `refreshScanSilent`); disable again on scan error.
* **Generate client-side** from `scanResult.files`. Columns:
  `relativePath, status, leftSize, rightSize, leftMtime, rightMtime`
  (ISO dates from `left.mtime`/`right.mtime`, empty for the absent side). Build a
  CSV string with a small `escapeCsv()` (quote fields containing `, " \n`, double
  embedded quotes), prepend a header row, download via `Blob`/`URL.createObjectURL`
  with filename `comparer-<timestamp>.csv` — same download pattern already used in
  `exportDiffHtml`.
* Honors nothing about the active filter by default (full results, for audit) —
  note this in the button title; a "current view only" variant can come later.

---

## 5. Team Sessions (disk-backed with localStorage fallback)

Persist sessions to `.comparer/sessions.json` **in the directory `npm start` runs
from** (`process.cwd()`), so a checked-in/shared project folder gives everyone the
same session list. Transparent fallback to localStorage if the API is unreachable.

**Backend — new routes in [server.js](server.js):**
* `const SESSIONS_DIR = path.join(process.cwd(), '.comparer')` /
  `SESSIONS_FILE = path.join(SESSIONS_DIR, 'sessions.json')`.
* `GET /api/sessions` → read + parse the file (return `[]` if absent).
* `POST /api/sessions` → write the full array (`mkdirSync(..,{recursive:true})`
  then `writeFileSync`). Body is the whole session list (matches the frontend's
  existing "load all / mutate / save all" pattern) — keeps the route trivial and
  atomic-enough for a single-user-at-a-time local tool.
* Both wrapped in try/catch returning 500 on FS error so the client can fall back.
* Add `.comparer/` consideration to `.gitignore` discussion: leave it **un-ignored**
  if teams want to commit the shared session list; document the choice in README.

**Frontend — Sessions panel ([app.js:1683](public/app.js#L1683)):**
* Convert `loadSessions`/`saveSessions` to async with an API-first, localStorage-
  fallback strategy, plus a module-level `sessionsBackend = 'disk' | 'local'` flag
  set by whichever path succeeded:
  * `loadSessions()`: `GET /api/sessions`; on ok → `sessionsBackend='disk'`; on
    network/HTTP error → read localStorage, `sessionsBackend='local'`.
  * `saveSessions(list)`: `POST /api/sessions`; on failure → write localStorage and
    flip to `'local'`. Always mirror to localStorage as a cache even on disk
    success, so an offline reload still shows the last-known list.
* `renderSessions()` becomes async (await the load) and shows a **badge** in the
  panel header: `Team (disk)` (e.g. green) vs `Local (browser)` (gray), driven by
  `sessionsBackend`. The existing save/reload/delete handlers call the async
  save/load; reload/delete logic is otherwise unchanged.

**CSS:** `.sessions-backend-badge` with `.badge-disk` / `.badge-local` modifiers in
the Sessions panel header.

---

## Files touched (summary)

| File | Changes |
|------|---------|
| `public/index.html` | Summary bar markup; sortable header carets; `identical` filter tab; `Export CSV` button; sessions-backend badge slot |
| `public/app.js` | `setFilter()`; `identical` filter; summary-bar update; `sortState` + `getSortedFiles()` + sortable-header handlers + flat render; `ignore-test` button + inline results; CSV export + HTML export meta-header; async disk-backed sessions w/ fallback |
| `public/style.css` | `.summary-bar`/`.summary-chip`/`.summary-proportional-bar`; sort caret + `.sortable` header; `.exclusion-test-results`; `.export-meta-header`; `.sessions-backend-badge` |
| `server.js` | `POST /api/ignore-test`; `GET`+`POST /api/sessions` (`.comparer/sessions.json`) |
| `README.md` | Document the five new features + the `.comparer/` session file |

No new dependencies. All five features degrade gracefully (disk → localStorage,
popup-export already has a modal fallback, sort/summary need only a completed scan).

---

## Verification plan

* **Summary bar:** scan the `tests/mock_left` vs `tests/mock_right` fixtures; confirm
  the four counts equal the filter-tab counts and the color bar widths are
  proportional. Click each chip → grid filters and the matching filter tab lights up
  (and vice-versa).
* **Column sort:** click each sortable header through asc→desc→original; confirm
  carets, flat-vs-grouped switch, and that a reload restores the persisted sort
  (default = Status/asc, Modified on top).
* **Ignore test:** with paths set, click 🔍 on `**/node_modules` → inline list shows
  the mock `node_modules` files for both sides without altering the grid; try a
  non-matching pattern → empty-state message.
* **Exports:** open a modified file's diff → Export → confirm the HTML header shows
  Left path, Right path, timestamp. Click Export CSV → open in a spreadsheet and
  verify a row per file with correct status/size/date columns and proper quoting of
  paths containing commas.
* **Team sessions:** save a session, confirm `.comparer/sessions.json` appears in the
  cwd and the badge reads **Team (disk)**; stop the server, reload the page (API
  down) → badge flips to **Local (browser)** and the cached list still shows; restart
  → disk list returns.
