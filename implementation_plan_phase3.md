# Implementation Plan - Phase 3: Session Management & Exclusions

This phase focuses on persisting recent comparison states, allowing named session reloading, and implementing glob ignore rules (such as skipping `.git` or `node_modules` folders) to optimize performance for large enterprise directories.

---

## Technical Tasks

### 1. Glob Ignore Filtering
* **Backend Glob Parser**:
  * Build a simple pattern-matcher using regular expressions or a lightweight helper to check paths against active glob patterns.
  * Integrate ignore checking into the directory recursion loop in `server.js` so that ignored folders (e.g. `node_modules`, `.git`, `dist`) are skipped immediately before scanning their contents, saving memory and IO operations.
* **Frontend Exclusions Input**:
  * Provide a list UI where users can see default glob excludes (e.g., `**/.git`, `**/node_modules`, `**/Thumbs.db`).
  * Allow users to add or remove custom glob expressions dynamically.

### 2. Session Management & Named Reloading
* **Storage Strategy**:
  * Save session configuration details (folder paths, ignore list, active filters) to browser `localStorage` under named keys.
  * Alternatively, write them to a small `.comparer/sessions.json` configuration file on the backend if multi-device/user persistence is needed (we will stick to standard local storage first for lightness, with an option to write to disk).
* **UI Controls**:
  * Add a "Sessions" panel styled like a collapsible utility sidebar in Google Antigravity.
  * Allow saving the current folder comparison setup with a name (e.g. "Project bananas-and-broccoli Sync").
  * Show a list of saved sessions with instant reload and delete buttons.

### 3. Standalone Executable Packaging & Distribution
* **Auto-Browser Launch**:
  * Configure `server.js` to automatically open the user's default web browser to the local server URL (`http://localhost:3000`) upon launch, utilizing the Node.js `child_process.exec` command (`start http://localhost:3000` on Windows).
* **Executable Compiler (`pkg`)**:
  * Configure the `pkg` packaging tool in `package.json` to compile the backend code and bundle all frontend assets (HTML, CSS, JS inside `public/`) into a single standalone binary.
  * Add a build script: `"build": "pkg . --targets node18-win-x64 --output dist/comparer.exe"`.
* **Distribution Zip**:
  * Build the executable and compress the folder into a single `comparer.zip` file containing only the `comparer.exe` executable, allowing double-click running for staff.

---

## Verification Plan

### Mock Scenario for Exclusions
* Inside `tests/mock_left`, create a folder `node_modules` with a large number of dummy files.
* Inside the glob exclusions list, ensure `**/node_modules` is active.

### Agentic Verification Tasks
* Start the server on `http://localhost:3000`.
* Run a `browser_subagent` task to:
  * Trigger a scan.
  * Verify that the files in `node_modules` are ignored and do not appear in the comparison directory tree.
  * Create a new named session "Test Sync Session".
  * Change paths to random values, then click on the saved "Test Sync Session" to verify paths and exclusions restore correctly.
* **Verify Packaging**:
  * Run the build command to generate `dist/comparer.exe`.
  * Launch `comparer.exe` and verify it automatically launches the web browser and loads the app successfully without manual terminal execution.

