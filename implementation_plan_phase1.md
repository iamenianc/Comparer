# Implementation Plan - Phase 1: Core Comparison Engine & Layout

This phase focuses on bootstrapping the project, building the backend directory scanner, implementing the high-density dual-pane UI styled after the Google Antigravity IDE, and creating the "Newer/Older" file comparison indicators.

---

## Technical Tasks

### 1. Project Initialization
* Initialize the workspace as a Node.js project.
* Install required dependencies: `express`, `diff`, `mime-types`.
* Configure `package.json` scripts to run the server locally.
* Set up a mock folder structure inside the workspace to simulate left and right directories for testing.

### 2. Backend Engine (`server.js`)
* Create a lightweight Express application.
* Implement a recursive helper function using Node's `fs` to build a map of files in a given directory (collecting path, size, modification time).
* Create the scan endpoint `/api/scan`:
  * Accept POST request containing:
    * `leftPath`: Absolute path to left folder.
    * `rightPath`: Absolute path to right folder.
    * `recursive`: Boolean flag.
  * Compare the file lists to find:
    * Left-only files.
    * Right-only files.
    * Matching paths with identical sizes/timestamps.
    * Matching paths with different sizes/timestamps (flagged as modified).
    * Calculate which matched file is newer based on modification times and compute the relative time difference (e.g., "+3 hours", "+2 days").
  * Return a structured JSON summary.

### 3. Frontend Layout & Aesthetics (`public/`)
* **HTML (`index.html`)**:
  * Semantic high-density header with Gemini-style gradient accents.
  * Text inputs for left/right paths and scan triggers.
  * Search/filter bar to filter by file extension, status, or search term.
  * Scroll-lock toggler.
  * High-density side-by-side comparison grid listing directories.
* **CSS (`style.css`)**:
  * Implement Google Antigravity light mode: white background (`#ffffff`), panels (`#f8f9fa`, `#f1f3f4`), thin gray borders (`1px solid #dadce0`).
  * Add typography rules for Roboto/Inter and Monospace for paths.
  * Design the status tags:
    * Added/Unique Left: Google Green.
    * Deleted/Unique Right: Google Red.
    * Modified: Google Yellow/Orange badge.
    * `Newer (+time)` badge: Green text, clear directional arrow pointing to the newer pane.
* **JavaScript (`app.js`)**:
  * Fetch data from `/api/scan` on scan trigger.
  * Parse and render folders as high-density collapsible tree nodes.
  * Implement scroll synchronization (syncing scrolling between left and right lists).
  * Handle real-time input filtering from the search bar.

---

## Verification Plan

### Mock Folder Setup
Create the following folders for testing:
* `tests/mock_left` (contains `a.txt` [new], `shared.txt` [newer], `binary.jpg`)
* `tests/mock_right` (contains `b.txt` [new], `shared.txt` [older], `binary.jpg`)

### Agentic Verification Tasks
* Propose launching the server on `http://localhost:3000`.
* Launch a `browser_subagent` to:
  * Type mock folders into the path inputs.
  * Trigger a scan.
  * Verify the UI lists files with high density.
  * Verify the `shared.txt` is highlighted with the correct newer arrow and badge.
  * Confirm filters ("Only Differences", "Search") correctly change the list view.
