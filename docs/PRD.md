# Product Requirements Document — Folder Comparison Utility

## Document Metadata

- **Audience**: AI LLM implementing or evaluating this product
- **Platform assumption**: Windows only (all paths use backslash convention; path roots are drive letters or UNC paths)
- **Connectivity assumption**: Must function fully offline; must also function when both compared folders reside on a Windows shared network drive (UNC path, e.g. `\\server\share\...`)
- **Non-priority**: Continuous background file-watching after a scan completes is explicitly deprioritized; it may be omitted entirely without violating requirements
- **Language/framework**: Agnostic — no implementation technology is mandated

---

## 1. Product Purpose

A local desktop utility that lets a user compare the contents of two filesystem locations (either two directories or two individual files), view differences at the file and line level, optionally synchronize content between the two locations, and export results. The utility runs entirely on the local Windows machine with no outbound network calls and no dependency on any remote service.

---

## 2. Functional Requirements

### 2.1 Input Selection

**REQ-INPUT-01**: The user must be able to specify two filesystem paths as the left input and the right input. Each path is independently selectable via a text field that accepts manual entry and via a native folder-picker dialog.

**REQ-INPUT-02**: The utility must support two comparison modes selectable at scan time:
- **Directory mode**: both paths point to directories; the utility compares their entire contents.
- **File-pair mode**: both paths point to individual files (which may have different names); the utility compares those two files directly.

**REQ-INPUT-03**: A **recursive** flag (default on) must control whether directory mode descends into subdirectories. When off, only the immediate children of each directory are compared.

**REQ-INPUT-04**: Paths may be local drive paths (`C:\...`) or UNC network paths (`\\server\share\...`). The utility must handle both transparently without any special configuration.

---

### 2.2 Exclusion Patterns

**REQ-EXCL-01**: The user must be able to maintain a list of glob exclusion patterns. Files and directories matching any pattern are excluded from all scan, hash, and diff operations.

**REQ-EXCL-02**: Built-in default patterns (pre-loaded and not user-deletable unless explicitly overridden) must include at minimum: `.git` trees, `node_modules` trees, `Thumbs.db`, `.DS_Store`, and `dist` trees.

**REQ-EXCL-03**: The pattern language must support: `*` (matches any characters within a single path segment), `**` (matches across path segments), `?` (matches any single character), and literal characters. Patterns are matched against forward-slash-normalized relative paths.

**REQ-EXCL-04**: The exclusion list must be persisted between sessions.

**REQ-EXCL-05**: A **pattern test** function must be available that, given a pattern and the current left/right paths, returns the list of files that would be excluded — without modifying or triggering a real scan. This is a dry-run preview only.

**REQ-EXCL-06**: Modifying the exclusion list while a comparison result is displayed must automatically re-trigger a scan with the updated pattern list.

---

### 2.3 Scan and Comparison Engine

**REQ-SCAN-01**: The scan must walk both input locations and produce one result record per unique relative path encountered in either or both locations.

**REQ-SCAN-02**: Each result record must carry: relative path, entry type (file or directory), status (see REQ-SCAN-03), size in bytes for each side (null if absent), and last-modified timestamp for each side (null if absent).

**REQ-SCAN-03**: Status values:
- **Identical**: the file exists on both sides and its content is identical (verified by cryptographic hash, not metadata alone).
- **Modified**: the file exists on both sides but content differs.
- **Left only**: the entry exists only on the left side.
- **Right only**: the entry exists only on the right side.

**REQ-SCAN-04**: Content identity must be determined via MD5 hash of the full file contents. Size or timestamp alone is insufficient for the **Identical** determination.

**REQ-SCAN-05**: Directories that exist on both sides are reported only if they have differing child contents (i.e., a directory whose entire subtree is identical may be collapsed); directories that exist on only one side are always reported as **Left only** or **Right only**.

**REQ-SCAN-06**: Excluded paths (matched by REQ-EXCL-01) must be pruned before any stat or hash work is performed on them.

**REQ-SCAN-07**: File-pair mode (REQ-INPUT-02) must produce exactly one result record comparing the two named files.

---

### 2.4 Results Grid

**REQ-GRID-01**: Scan results must be displayed in a tabular grid with at minimum the following columns: relative path/filename, status, left size, right size, left modified date, right modified date.

**REQ-GRID-02**: A summary bar must display live counts for each status category (Modified, Left Only, Right Only, Identical) and allow the user to filter the grid to show only one category or all categories.

**REQ-GRID-03**: A proportional color bar must visually represent the distribution of status categories across all results.

**REQ-GRID-04**: Each column must be sortable (ascending / descending / default). The default sort is by status. Sorting by path/filename must preserve folder-group nesting; sorting by any other column may flatten nesting.

**REQ-GRID-05**: A text search/filter field must allow the user to filter displayed rows by filename substring.

**REQ-GRID-06**: Directory rows must be collapsible/expandable.

**REQ-GRID-07**: Sort state must be persisted between sessions.

**REQ-GRID-08**: The grid must display appropriate file-type icons distinguishing directories, text files, images, archives, executables, and other common categories.

---

### 2.5 Diff Viewer

**REQ-DIFF-01**: Opening a **Modified** file from the results grid must display a line-level diff view for that file pair.

**REQ-DIFF-02**: The diff viewer must support two display modes switchable by the user:
- **Split view**: left and right file contents displayed side-by-side with synchronized scrolling; added lines highlighted in green, removed lines highlighted in red, unchanged context lines faded.
- **Unified view**: combined view using `+`/`-` prefix notation and `@@ ... @@` hunk headers (git patch format).

**REQ-DIFF-03**: The diff viewer must display line numbers for both sides.

**REQ-DIFF-04**: A **diffs-only** toggle must hide unchanged context lines, showing only changed blocks.

**REQ-DIFF-05**: A **word wrap** toggle must control whether long lines wrap or scroll horizontally.

**REQ-DIFF-06**: Navigation controls (keyboard shortcuts and/or buttons) must allow jumping between changed blocks (next change / previous change).

**REQ-DIFF-07**: A badge must show the total line delta (e.g., `+12 −5`).

**REQ-DIFF-08**: The user must be able to copy the full contents of the left file or the right file to the clipboard from within the diff viewer.

**REQ-DIFF-09**: Clicking a line number must copy a `filename:linenumber` reference string to the clipboard.

**REQ-DIFF-10**: **Binary file detection**: for files identified as binary (by extension — including at minimum: images, archives, Office documents, executables, media files, compiled objects), the diff viewer must display a metadata comparison table instead of a text diff. The table must show: file size for each side, last-modified timestamp for each side, and MD5 hash for each side.

**REQ-DIFF-11**: **HTML export**: the diff viewer must offer an export action that produces a self-contained HTML file containing the full diff with inlined styling, a metadata header (left path, right path, export timestamp), and no external dependencies. The exported file must be saveable to any writable path including UNC paths.

---

### 2.6 Sync Operations

**REQ-SYNC-01**: For each file in the results grid, the user must be able to trigger one of the following sync actions:
- **Keep left**: copy the left file to the right location (overwriting if present).
- **Keep right**: copy the right file to the left location (overwriting if present).
- **Delete left**: delete the file from the left location.
- **Delete right**: delete the file from the right location.

**REQ-SYNC-02**: Sync actions must not be available in file-pair mode (REQ-INPUT-02); file-pair mode is comparison-only.

**REQ-SYNC-03**: Before executing any sync action that modifies or deletes a file, the utility must create a backup copy of the affected file in a temporary location. Backups must be timestamped to avoid collision.

**REQ-SYNC-04**: A single-level **undo** must be available that restores the most recently completed sync action from its backup. Only the most recent action can be undone; earlier actions are not recoverable via undo.

**REQ-SYNC-05**: The sync engine must create any missing intermediate directories on the destination side as needed (`mkdir -p` semantics).

**REQ-SYNC-06**: Sync operations must work on UNC paths without special handling.

---

### 2.7 Audit Log

**REQ-AUDIT-01**: Every sync action (including undo) must be recorded as an append-only log entry containing: ISO 8601 timestamp, action type, and fully resolved source/destination paths.

**REQ-AUDIT-02**: The audit log must persist across sessions in a user-local data directory (not the compared folders themselves).

**REQ-AUDIT-03**: The audit log format must be machine-readable (one JSON object per line).

---

### 2.8 Saved Comparison Sessions

**REQ-SESSION-01**: The user must be able to save the current comparison configuration as a named session. A session captures: name, left path, right path, recursive flag, exclusion list, active filter, and save timestamp.

**REQ-SESSION-02**: Loading a saved session must repopulate all captured fields and automatically re-run a scan.

**REQ-SESSION-03**: Sessions must be persisted to disk in the user's application data directory so they survive restarts.

**REQ-SESSION-04**: If the disk store is unreachable (e.g., permissions failure), the utility must transparently fall back to local in-process storage for the duration of the session and indicate which storage backend is active.

**REQ-SESSION-05**: The user must be able to export the session list to a JSON file at any path (including UNC paths) and import a session list from such a file. This enables sharing session configurations via a shared network folder.

---

### 2.9 CSV Export

**REQ-CSV-01**: After a scan, the user must be able to export the full results grid as a UTF-8 CSV file (with BOM for Excel compatibility).

**REQ-CSV-02**: Each CSV row must contain: relative path, status, left size in bytes, right size in bytes, left last-modified datetime, right last-modified datetime.

**REQ-CSV-03**: The save dialog must allow the user to choose any writable path including UNC paths.

---

### 2.10 Path Display

**REQ-PATH-01**: Long folder paths displayed in the UI (e.g., in the input fields or column headers) must be condensed to show only the meaningful leading and trailing segments (e.g., `C:\...\parent\target`) rather than truncated with an ellipsis that hides the end.

---

## 3. Non-Functional Requirements

### 3.1 Offline Operation

**REQ-NF-OFFLINE-01**: The utility must function fully with no internet connectivity. All assets (fonts, icons, stylesheets, scripts) must be bundled locally. No runtime requests to external URLs are permitted.

### 3.2 Network Drive Compatibility

**REQ-NF-NET-01**: All file operations — scan, hash, diff, sync, export, session import/export, audit log — must work correctly when the target paths are on Windows UNC shares (`\\server\share\...`). No operation may assume local NTFS path semantics exclusively.

**REQ-NF-NET-02**: The utility must tolerate the higher latency typical of network drives without hanging the UI indefinitely; long-running operations must remain cancellable or at minimum display progress indication.

### 3.3 Security

**REQ-NF-SEC-01**: The utility must guard against path-traversal attacks: any user-supplied relative path used in a file operation must be resolved and validated to remain within the declared base directory before the operation proceeds.

**REQ-NF-SEC-02**: No stack traces or internal implementation details may be surfaced to the UI in error messages.

**REQ-NF-SEC-03**: Read access to arbitrary filesystem locations must not be grantable through indirect means (e.g., asset-loading APIs must be restricted to a known safe directory).

### 3.4 Data Integrity

**REQ-NF-INTEGRITY-01**: The undo mechanism must be transactional: if a backup cannot be created, the sync action must not proceed.

**REQ-NF-INTEGRITY-02**: Backup storage (for undo) is ephemeral and may be cleared on startup and exit. Backups exist solely to support single-level undo within a session.

### 3.5 File Watching (Deprioritized)

**REQ-NF-WATCH-01**: Automatic re-scan triggered by filesystem change events after the initial scan is explicitly **not required**. Implementations may omit this capability entirely. If implemented, it must not degrade performance on network drives and must respect the active exclusion list.

---

## 4. Behavioral Constraints

**REQ-BC-01**: The utility runs as a single-window desktop application. No local HTTP server, no network listener, no external process spawning beyond native OS dialogs.

**REQ-BC-02**: The utility is single-user; no multi-user concurrent access to the same session store or audit log is required to be safe.

**REQ-BC-03**: All user preferences (exclusion list, sort state, last-used paths) must be persisted locally between sessions without requiring user action.

**REQ-BC-04**: The utility must be distributable as a single portable executable on Windows with no installer and no runtime dependencies that require separate installation.

---

## 5. Out of Scope

- macOS, Linux, or any non-Windows platform support
- Three-way merge or three-way diff
- Version control system integration (git, SVN, etc.) beyond ignoring `.git` directories
- Remote/cloud storage backends (S3, SharePoint, OneDrive, etc.)
- Multi-level undo
- Scheduled or background automated comparison
- User authentication or multi-user access control
- Any network call to any external service for any purpose
