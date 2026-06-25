# Phase 1 Checklist: Core Comparison Engine & Layout

- [x] Project Setup
  - [x] Initialize Node.js project (`npm init -y`)
  - [x] Install dependencies (`express`, `diff`, `mime-types`)
  - [x] Configure `package.json` with running scripts
  - [x] Create mock folders (`tests/mock_left` and `tests/mock_right`) with dummy test files

- [x] Backend Implementation (`server.js`)
  - [x] Initialize Express app and static asset server configuration
  - [x] Implement directory recursion engine that maps filenames, sizes, and timestamps
  - [x] Create `/api/scan` endpoint with comparison calculations and relative-time calculations
  - [x] Verify endpoint response logic using unit or script tests

- [x] Frontend Setup (`public/`)
  - [x] Create semantic HTML structure (`public/index.html`)
  - [x] Implement Google Antigravity-inspired light-mode UI design system in CSS (`public/style.css`)
  - [x] Build layout modules: path inputs, search filter bar, scroll-lock button, split pane grids
  - [x] Write dynamic rendering logic in JS (`public/app.js`) to display folder comparison data
  - [x] Wire up scroll synchronization for left and right pane displays
  - [x] Enable real-time file search/filtering

- [x] Verification
  - [x] Run the application locally
  - [x] Launch `browser_subagent` to visually verify styling, layout, filters, and compared folders
