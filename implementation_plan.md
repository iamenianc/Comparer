# Implementation Plan - Folder Comparison Tool

We are building a beautiful yet deeply functional comparison tool primarily for contents of folders, optimized for **Windows 11 Enterprise** users.

This plan details the architecture, design guidelines, features, and verification plan using a lightweight **Node.js backend** and a **Vanilla HTML/CSS/JS frontend** running locally.

---

## User Review Required

Please review and approve the finalized implementation plan incorporating the decisions from our functional requirements alignment. Since the tech stack has been narrowed down to a lightweight Node.js script + Vanilla frontend, we can build it with zero build-tool compilation overhead and minimal security permissions.

---

## Technical Architecture

### Backend: Node.js (Local Server)
* **File**: `server.js` (using Express for robust API endpoints).
* **Allowed Libraries**:
  * `express`: Fast, lightweight web framework for routing.
  * `diff`: Fast text-differencing library to compute line-by-line file changes.
  * `mime-types`: Correctly identify file MIME types for text vs. binary treatment.
* **Role**:
  * Serves static frontend assets (HTML, CSS, JS).
  * Exposes API endpoints for:
    * Scanning directory structures recursively (or top-level only).
    * Hashing file contents on-demand or conditionally (MD5/SHA-256) for deep comparisons.
    * Performing Two-Way Merge Sync operations and resolving conflicts.
    * Retrieving computed side-by-side file diff data (using `diff` package).
* **Why it fits prompt/agentic coding**:
  * **Low privilege**: Runs strictly in standard Windows user-space with zero system-level installation requirements.
  * **Highly testable**: Easy to script and execute with predictable outcomes.

### Frontend: Vanilla HTML/CSS/JS (Browser UI)
* **Files**: `public/index.html`, `public/style.css`, `public/app.js` (modular ES6 javascript).
* **Allowed External Resources**:
  * Google Material Symbols (via CDN) for high-performance vector icons.
* **Role**:
  * Interactive dual-pane directory explorer matching Google Antigravity IDE light mode style.
  * Pasted path text inputs with scan trigger.
  * Side-by-side text file diff modal and metadata viewer.
  * Interactive conflict resolution control ("Keep Left", "Keep Right", "View Diff").
* **Why it fits prompt/agentic coding**:
  * **Zero build system friction**: No compilation, bundling (Webpack/Vite), or package version mismatch problems.
  * **High resilience**: Code changes in plain DOM elements and CSS rules are highly predictable and less prone to prompt syntax compilation failures.
  * **Interactive visual checks**: The app will run locally at `http://localhost:3000`. The Antigravity `browser_subagent` will load the page, navigate elements, compare local directories, and visually verify styling compliance.

---

## Design & Aesthetics (Google Antigravity IDE / Gemini Design Cues)

The interface will mimic the clean, high-density, and structured look of Google's AI/developer toolkits:
* **Strict Light Mode**: Crisp white backgrounds (`#ffffff`) combined with light-gray surfaces (`#f8f9fa`, `#f1f3f4`) to distinguish panels. No dark mode.
* **Optimized for 100+ Files (High-Density)**:
  * Compact, tabular rows with minimal padding to avoid scrolling fatigue.
  * Collapsible folder tree nodes so users can collapse giant subdirectories.
  * In-UI real-time filter search bar to find files by extension, name, or status instantly.
* **Newer File Visual Indicators**:
  * When files have matching names but different contents/timestamps, the interface must make the newer version instantly recognizable.
  * Use a directional arrow symbol pointing from the older file to the newer file.
  * Display a clear, color-coded visual indicator tag: `Newer (+2h)` or `Newer (+5d)` in Google Green/Blue text, while the older file is marked as `Older` in muted gray.
* **Antigravity Accents & Palette**:
  * Primary Actions: Google Blue (`#0b57d0` / `#1a73e8`).
  * Dynamic Accents: Very subtle Gemini-style gradient highlights (violet/indigo to soft blue) for active tabs or headers.
  * Diff Status Colors:
    * File added/unique to left: Google Green (`#1f873c` / `#34a853`).
    * File deleted/unique to right: Google Red (`#d93025` / `#ea4335`).
    * File modified (content mismatch): Google Yellow/Orange (`#b06000` / `#fbbc05`).
* **Borders & Typography**:
  * Clean, razor-thin borders (`1px solid #dadce0` or `#e0e0e0`).
  * Sans-serif font family (Inter, Roboto, or standard system UI font) for dashboard navigation.
  * Monospaced typography (`Roboto Mono` or system mono) for path listings, logs, and side-by-side line diffs.

---

## Proposed Features

### Phase 1: Core Comparison Engine & Layout
* **Dual-Pane View**: Side-by-side folder directory trees showing filenames, sizes, and modification timestamps.
* **Folder Inputs**: Plain text input fields for pasting absolute paths manually.
* **Recursion Toggle**: Checkbox to toggle between recursive subfolder scanning (on by default) and top-level files only.
* **Scanning & Hashing**:
  * Compares folders by filename, size, and modified date.
  * Hashing (MD5 or SHA-256) is performed on-demand (e.g., when a file is selected) or automatically only when sizes match but timestamps differ.
* **Filters**:
  * Buttons to show "All Files", "Only Differences", "Only Matches", "Only Left", "Only Right".
  * Synchronized scrolling option for easy visual tracking.

### Phase 2: Synchronization & Conflict Resolution
* **Two-Way Merge Sync**: Preset action to copy new files in both directions.
* **Conflict Detection**:
  * Highlights files with identical relative paths that have changed on both sides.
  * Displays warning icon with interactive resolution buttons ("Keep Left", "Keep Right", "View Diff").
* **Inline File Diff**:
  * Side-by-side line-by-side visual diff modal for comparing text files.
  * Metadata grid viewer for binary files.

### Phase 3: Session Management & Exclusions
* **Named Sessions**: Save folder pairs, custom glob filters, and preferences locally (using browser `localStorage` or backend storage).
* **Glob Ignore Patterns**: Configurable glob list (e.g. `.git`, `node_modules`, `Thumbs.db`) with built-in standard defaults.

---

## Verification Plan

### Automated Tests
* Node.js script tests for directory scanning and diff calculation.
* Hashing verification tests.
* Conflict state calculation tests.

### Manual & Agentic Verification
* Launch the local server on `http://localhost:3000`.
* Run the `browser_subagent` to:
  * Open `http://localhost:3000`.
  * Verify visual alignment, Google/Gemini aesthetic cues, and strict light mode.
  * Execute directory comparisons using mock folders in the workspace.
  * Verify Two-Way Merge Sync simulation, conflict display, and manual selection resolution.
  * Ensure the text diff modal displays changes clearly.
