# Implementation Plan - Phase 2: Synchronization & Conflict Resolution

This phase focuses on enabling file comparison checks (deep hashing), implementing the Two-Way Merge Sync engine, creating interactive visual conflict markers, building the inline side-by-side text diff modal, setting up real-time directory watching using `chokidar`, and implementing an "Undo Last Action" backup engine.

---

## Technical Tasks

### 1. Backend Deep Hashing, Sync, Watcher & Undo APIs
* **On-Demand Hashing**:
  * Implement an endpoint `/api/hash` that calculates the MD5/SHA-256 hash of a file on request (triggered when a user clicks a file or runs a content-verification pass).
* **Manual File Sync Endpoint (`/api/sync`)**:
  * Perform manual file-by-file synchronization actions only (no bulk sync).
  * Expose an endpoint that accepts a POST payload specifying a target file path and action:
    * `keepLeft`: Copies the file from the left folder to the right folder.
    * `keepRight`: Copies the file from the right folder to the left folder.
    * `deleteLeft`: Deletes the file from the left folder.
    * `deleteRight`: Deletes the file from the right folder.
  * Update directory representation and return the updated file comparison node state.
* **Undo Engine Backup Buffer**:
  * Before performing any copy/delete sync operation, copy the target file to be replaced or deleted into a temporary directory inside the system's temp folder (using Node's native `os.tmpdir()`, e.g. `tmpdir/.comparer-backups/`).
  * Record transaction metadata: `{ originalPath, backupPath, actionType: 'overwrite' | 'delete' }`.
  * Create a POST `/api/undo` endpoint:
    * Restores files from the temp backup directory to their original locations.
    * Instantly deletes the backup files once restored.
  * Clear the backup cache whenever a new folder pair scan is initiated or when the server processes exit.
* **Backend Real-Time Watcher (`chokidar`)**:
  * Create a Server-Sent Events (SSE) route `/api/watch` in `server.js` using `chokidar`.
  * Maintain active directory watchers. When a new scan is initiated, close previous watchers and spin up new `chokidar` instances on the resolved `leftPath` and `rightPath`.
  * Exclude watched folders using default ignore globs (e.g. `node_modules`, `.git`).
  * On detecting file creation, change, or deletion, broadcast a notification event (JSON payload indicating the event type) over the active SSE stream.

### 2. Frontend Diff Modal, Real-Time Sync & Undo UI
* **Side-by-Side Text & Binary Diff Modal**:
  * Create a clean UI modal overlay.
  * For text files: Fetch difference chunks from backend (`/api/diff` using the `diff` library). Render lines side-by-side with line numbers (green/red highlights for inserts/deletions) and double-scroll lock.
  * For binary files: Render a metadata grid comparison showing File Size, Modification Timestamp, and MD5 hashes side-by-side.
* **Conflict Resolution Interface**:
  * For conflicted files, render a warning icon in the grid.
  * Provide action buttons inline: `[Keep Left]` `[Keep Right]` `[View Diff]`.
  * Trigger immediate backend resolution API call when an action is selected, reloading the file state dynamically on success.
* **Undo Action Banner**:
  * Show a subtle, Google-styled notification banner/toast (e.g. `"Sync completed. [Undo last action]"`) at the top of the grid when a file transaction completes.
  * Wire the click event to trigger POST `/api/undo`, followed by a silent refresh of the folder lists.
* **Condensed Header Paths (Smart Columns)**:
  * Replace the static "Left Pane" and "Right Pane" column headers dynamically with condensed folder paths after a comparison completes.
  * The condensation algorithm will output: `DriveLetter:\...\HeadFolder` (e.g., `C:\...\mock_left` vs `C:\...\mock_right`).
  * If the head folders have identical names, backtrack recursively through subfolder layers until a naming difference is found (e.g., `C:\...\v1\src` vs `C:\...\v2\src`), ensuring the user can instantly distinguish folders at a glance.
* **Ghost Placeholders for Absent Files**:
  * Render a "ghost-like" file placeholder in the pane column where a file is absent (e.g., if a file is only present on the left, the right column cell will not be blank, but will show the file metadata in a "ghost" visual state).
  * Ghost placeholders will have low opacity (e.g., `0.35`), italic font styles, dashed gray borders, and a muted visual cue to signify the file is missing from that location but will be synced there.
* **Real-Time UI Refresh (Live Connection)**:
  * Wire up an `EventSource` connection to `/api/watch` in `app.js` upon scan completion.
  * When a change signal is received from the server, perform a silent comparison refresh (`fetch('/api/scan')`) to update file listings and statuses without interrupting active user scrolling or collapsing parent trees.

---

## Verification Plan

### Mock Scenario for Conflict Resolution
Create files in the mock folders:
* `tests/mock_left/conflict.txt` -> Content: "Hello from Left side"
* `tests/mock_right/conflict.txt` -> Content: "Hello from Right side"
* Both files have matching names but different modifications.

### Agentic Verification Tasks
* Start the server on `http://localhost:3000`.
* Run a `browser_subagent` task to:
  * Load the mock directories scan.
  * Check that `conflict.txt` shows a warning icon.
  * Click `View Diff` to open the text diff modal and verify the line-by-side display has correctly highlighted the different text.
  * Click `Keep Left` and verify the sync copies the left version to the right side, resolving the visual warning indicator.
  * **Verify Undo**: Click the "Undo last action" banner and verify that the sync is rolled back (the conflict warning re-appears, and the right file is restored to its original content).
  * **Verify Watcher**: Create a new file `tests/mock_left/live.txt` using a command line script. Verify that the UI list automatically and silently refreshes to display `live.txt` (Left Only status) without clicking Compare again.


