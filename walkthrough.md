# Phase 2 Walkthrough - Synchronization & Conflict Resolution

We have successfully completed the implementation and validation of **Phase 2** of the Folder Comparison Tool. Below is a summary of the accomplishments, codebase changes, and verification testing results.

---

## Accomplishments

1. **Backend Synchronization & Watching Engine**:
   - **On-Demand Hashing**: Created `/api/hash` using MD5 encryption to fetch file hash metadata instantly when loading comparisons.
   - **Text Diffing**: Created `/api/diff` using the `diff` library, parsing changed chunks into unified side-by-side line alignment rows for the frontend.
   - **Two-Way Manual Sync**: Built `/api/sync` to execute `keepLeft`, `keepRight`, `deleteLeft`, and `deleteRight` file operations.
   - **Transaction Undo Engine**: Integrated an automatic backup system storing overwritten or deleted files under `os.tmpdir()/.comparer-backups/` with unique IDs, and implemented `/api/undo` to restore files.
   - **Real-Time Directory Watcher**: Configured a `chokidar` watcher stream over a `/api/watch` Server-Sent Events (SSE) connection that instantly alerts the client to additions, deletions, or modification changes.

2. **Frontend UI Enhancements**:
   - **Side-by-Side Diff Modal**: Built a modal container in `index.html` displaying side-by-side code diffs with green/red line highlighting.
   - **Double Scroll Lock**: Added scroll synchronizers linking horizontal and vertical offsets of the left/right code panes when scroll-lock is enabled.
   - **Metadata Viewer**: Styled a binary comparison table showing file size, mtime, and MD5 hashes side-by-side.
   - **Smart Path Column Headers**: Developed a backtracking condensation algorithm (e.g. `C:\...\repo\src`) displaying distinct paths in headers when folders share head folder names.
   - **Ghost Placeholders**: Displayed missing files in the opposing panel with a low opacity (`0.35`) and an italicized `(Absent)` tag.
   - **Conflict Action Buttons**: Rendered warning badges and action buttons (`Keep Left`, `Keep Right`, `Diff`) in row cells, handling events via robust click delegation.
   - **Undo Action Banner**: Designed a Google-styled floating banner alerting synchronization completion and linking to the Undo API.

---

## Code Base Changes

### Modified Files
* [server.js](file:///c:/Users/ianch/sourecode/repos/FolderCompare/server.js) — Added `/api/hash`, `/api/diff`, `/api/sync`, `/api/undo`, `/api/watch` routes, os backup buffers, and chokidar watcher callbacks.
* [public/index.html](file:///c:/Users/ianch/sourecode/repos/FolderCompare/public/index.html) — Embedded modal templates and the Undo notification toast.
* [public/style.css](file:///c:/Users/ianch/sourecode/repos/FolderCompare/public/style.css) — Added layout styles for code lines, binary grids, modal windows, action buttons, banners, and ghost formatting.
* [public/app.js](file:///c:/Users/ianch/sourecode/repos/FolderCompare/public/app.js) — Wired SSE EventSource, smart paths, modal scroll handlers, toast control systems, and click event handlers.

---

## Verification Results

We verified our modifications using two customized node automation scripts:

### 1. Synchronization and Undo Verification (`test_api.js`)
We ran a test script that:
- Performed a scan, detecting `conflict.txt` in a conflicted state.
- Checked right-pane initial content: `This is the RIGHT side version of this file.`
- Dispatched a sync request (`keepLeft` version).
- Verified right-pane synced content: `This is the LEFT side version of this file.` (Success)
- Dispatched an undo request.
- Verified right-pane restored content: `This is the RIGHT side version of this file.` (Success)

### 2. Real-Time Directory Watcher Verification (`test_watcher.js`)
We ran a watcher test script that:
- Handshook an SSE connection with the `/api/watch` endpoint.
- Programmatically created `tests/mock_left/live_watcher_test.txt`.
- Successfully received watch notification over SSE:
  `data: {"event":"add","relativePath":"live_watcher_test.txt","side":"left"}` (Success)
