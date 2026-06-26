// Comparer Frontend Logic

let scanResult = null;
let currentFilter = 'all';
let searchQuery = '';
const collapsedFolders = new Set();
let lastScanParams = null;

// IPC adapter: the renderer talks to the Electron main process exclusively
// through window.comparer (exposed by preload.cjs). Each method returns the
// unwrapped response data or throws an Error — the same contract the old
// fetch()+JSON code expected. No HTTP, no localhost listener.
const comparer = window.comparer;

// Active filesystem-watch subscription (replaces the SSE EventSource).
let watchUnsub = null;

// --- Exclusions (ignored globs) state ---
const DEFAULT_IGNORE_GLOBS = ['**/.git', '**/node_modules', '**/Thumbs.db', '**/.DS_Store', '**/dist'];
const IGNORE_STORAGE_KEY = 'comparer_ignore_globs';
const SESSIONS_STORAGE_KEY = 'comparer_sessions';

let ignoreGlobs = loadIgnoreGlobs();

function loadIgnoreGlobs() {
  try {
    const raw = localStorage.getItem(IGNORE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) { /* fall through to defaults */ }
  return [...DEFAULT_IGNORE_GLOBS];
}

function saveIgnoreGlobs() {
  localStorage.setItem(IGNORE_STORAGE_KEY, JSON.stringify(ignoreGlobs));
}

// DOM elements
const leftPathInput = document.getElementById('left-path');
const rightPathInput = document.getElementById('right-path');
const scanBtn = document.getElementById('scan-btn');
const recursiveCheckbox = document.getElementById('option-recursive');
const scrollLockCheckbox = document.getElementById('option-scrolllock');
const searchInput = document.getElementById('search-input');
const filterTabs = document.querySelectorAll('.filter-tab');
const gridBody = document.getElementById('comparison-grid-body');
const countAll = document.getElementById('count-all');
const countDiff = document.getElementById('count-diff');
const countModified = document.getElementById('count-modified');
const countLeft = document.getElementById('count-left');
const countRight = document.getElementById('count-right');
const countIdentical = document.getElementById('count-identical');
const statusText = document.getElementById('status-text');
const summaryText = document.getElementById('scan-summary-text');

// Undo banner elements
const undoBanner = document.getElementById('undo-banner');
const undoBannerMessage = document.getElementById('undo-banner-message');
const undoBtn = document.getElementById('undo-btn');
const closeUndoBannerBtn = document.getElementById('close-undo-banner-btn');
const statusLight = document.getElementById('status-indicator-light');

function setStatusLight(state) {
  if (!statusLight) return;
  statusLight.className = 'status-indicator-light' + (state ? ` state-${state}` : '');
}

// Diff Modal elements
const diffModal = document.getElementById('diff-modal');
const diffModalTitle = document.getElementById('diff-modal-title');
const diffModalSubtitle = document.getElementById('diff-modal-subtitle');
const closeDiffModalBtn = document.getElementById('close-diff-modal-btn');
const diffTextContainer = document.getElementById('diff-text-container');
const diffLeftCode = document.getElementById('diff-left-code');
const diffRightCode = document.getElementById('diff-right-code');
const diffBinaryContainer = document.getElementById('diff-binary-container');
const binaryLeftHeader = document.getElementById('binary-left-header');
const binaryRightHeader = document.getElementById('binary-right-header');
const binaryLeftSize = document.getElementById('binary-left-size');
const binaryRightSize = document.getElementById('binary-right-size');
const binaryLeftMtime = document.getElementById('binary-left-mtime');
const binaryRightMtime = document.getElementById('binary-right-mtime');
const binaryLeftHash = document.getElementById('binary-left-hash');
const binaryRightHash = document.getElementById('binary-right-hash');
const diffModalKeepLeft = document.getElementById('diff-modal-keep-left');
const diffModalKeepRight = document.getElementById('diff-modal-keep-right');
const closeDiffModalFooterBtn = document.getElementById('close-diff-modal-footer-btn');

// Helper: Format bytes to human readable string
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// Helper: Format date. Time (h:mm AM/PM) is shown only when both sides fall on
// the same calendar day. Seconds are appended only when both sides share the
// same minute but differ at the second level.
function formatDate(dateStr, compareStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const pad = (num) => String(num).padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const dateOnly = `${year}-${month}-${day}`;

  if (!compareStr) return dateOnly;

  const other = new Date(compareStr);
  const sameDay =
    date.getFullYear() === other.getFullYear() &&
    date.getMonth() === other.getMonth() &&
    date.getDate() === other.getDate();

  if (!sameDay) return dateOnly;

  const rawHours = date.getHours();
  const ampm = rawHours >= 12 ? 'PM' : 'AM';
  const hours = rawHours % 12 || 12;
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());

  const sameMinute =
    date.getHours() === other.getHours() &&
    date.getMinutes() === other.getMinutes();
  const showSeconds = sameMinute && date.getSeconds() !== other.getSeconds();

  const timePart = showSeconds
    ? `${hours}:${minutes}:${seconds} ${ampm}`
    : `${hours}:${minutes} ${ampm}`;
  return `${dateOnly} ${timePart}`;
}

// Run comparison folder scan
async function runScan() {
  const leftPath = leftPathInput.value.trim();
  const rightPath = rightPathInput.value.trim();

  if (!leftPath || !rightPath) {
    alert('Please enter paths for both the Left and Right folders.');
    return;
  }

  lastScanParams = {
    leftPath,
    rightPath,
    recursive: recursiveCheckbox.checked,
    ignore: ignoreGlobs
  };

  // Set scanning UI state
  setStatusLight('scanning');
  scanBtn.disabled = true;
  scanBtn.querySelector('span:last-child').textContent = 'Scanning...';
  statusText.textContent = 'Comparing directories...';
  gridBody.innerHTML = `
    <div class="empty-state">
      <span class="material-symbols-outlined empty-icon loading-spin">sync</span>
      <h3>Scanning directories...</h3>
      <p>Reading file lists and performing hashing. Please wait.</p>
    </div>
  `;

  try {
    const data = await comparer.scan(lastScanParams);

    scanResult = data;
    leftPathInput.value = data.leftPath;
    rightPathInput.value = data.rightPath;
    
    // Save paths to localStorage for user convenience
    localStorage.setItem('comparer_left_path', data.leftPath);
    localStorage.setItem('comparer_right_path', data.rightPath);

    collapsedFolders.clear();
    updateTabCounts();
    updateHeaders();
    renderGrid();
    setupSSEWatcher();
    setStatusLight('done');
    statusText.textContent = 'Scan Completed';
    if (exportCsvBtn) exportCsvBtn.disabled = false;

    // File-pair mode: the user pointed at two files directly — auto-open the
    // side-by-side diff for the single synthesized row.
    if (data.filePairMode && data.files.length === 1) {
      openDiffWindow(data.files[0]);
    }
  } catch (error) {
    console.error('Scan error:', error);
    setStatusLight('error');
    gridBody.innerHTML = `
      <div class="empty-state">
        <span class="material-symbols-outlined empty-icon" style="color:var(--color-right-only)">error</span>
        <h3>Comparison Failed</h3>
        <p>${error.message}</p>
      </div>
    `;
    statusText.textContent = 'Scan Failed';
    summaryText.textContent = 'Error occurred during scan';
    if (exportCsvBtn) exportCsvBtn.disabled = true;
  } finally {
    scanBtn.disabled = false;
    scanBtn.querySelector('span:last-child').textContent = 'Compare';
  }
}

// Helper: condensation algorithm for folder paths
function condensePaths(left, right) {
  const pathA = left.replace(/\//g, '\\');
  const pathB = right.replace(/\//g, '\\');

  const partsA = pathA.split('\\');
  const partsB = pathB.split('\\');

  const driveA = partsA[0] || '';
  const driveB = partsB[0] || '';

  const nameA = partsA[partsA.length - 1] || '';
  const nameB = partsB[partsB.length - 1] || '';

  if (nameA !== nameB) {
    return {
      left: partsA.length > 1 ? `${driveA}\\...\\${nameA}` : pathA,
      right: partsB.length > 1 ? `${driveB}\\...\\${nameB}` : pathB
    };
  }

  // If identical head names, backtrack until a naming difference is found
  let diffIdx = 1;
  while (diffIdx < partsA.length && diffIdx < partsB.length) {
    const subA = partsA[partsA.length - 1 - diffIdx];
    const subB = partsB[partsB.length - 1 - diffIdx];
    if (subA !== subB) {
      break;
    }
    diffIdx++;
  }

  const suffixA = partsA.slice(partsA.length - 1 - diffIdx).join('\\');
  const suffixB = partsB.slice(partsB.length - 1 - diffIdx).join('\\');

  return {
    left: partsA.length > diffIdx + 1 ? `${driveA}\\...\\${suffixA}` : pathA,
    right: partsB.length > diffIdx + 1 ? `${driveB}\\...\\${suffixB}` : pathB
  };
}

// Condense a single path into the same `drive\...\last\segments` style used by
// condensePaths(), keeping the drive and the deepest `tailSegments` folders.
function condenseSinglePath(fullPath, tailSegments = 2) {
  const normalized = fullPath.replace(/\//g, '\\');
  const parts = normalized.split('\\').filter(Boolean);
  if (parts.length <= tailSegments + 1) return normalized;
  const drive = parts[0];
  const tail = parts.slice(parts.length - tailSegments).join('\\');
  return `${drive}\\...\\${tail}`;
}

// Update the grid super-headers with condensed paths
function updateHeaders() {
  if (!scanResult) return;

  const leftSuper = document.getElementById('super-header-left');
  const rightSuper = document.getElementById('super-header-right');

  if (leftSuper) {
    leftSuper.querySelector('span').textContent = condenseSinglePath(scanResult.leftPath, 1);
    leftSuper.title = scanResult.leftPath;
  }
  if (rightSuper) {
    rightSuper.querySelector('span').textContent = condenseSinglePath(scanResult.rightPath, 1);
    rightSuper.title = scanResult.rightPath;
  }
}

// Start the live filesystem watcher over IPC (replaces the SSE EventSource).
// The main process pushes events with the same { event, relativePath, side }
// shape the SSE stream emitted, so the refresh logic is unchanged.
function setupSSEWatcher() {
  if (!scanResult) return;

  // Tear down any previous subscription + watcher before starting a new one.
  stopWatcher();

  const ignore = lastScanParams ? lastScanParams.ignore : ignoreGlobs;
  comparer
    .startWatch({ leftPath: scanResult.leftPath, rightPath: scanResult.rightPath, ignore })
    .catch((err) => console.warn('Watch start failed:', err.message));

  watchUnsub = comparer.onWatch((data) => {
    console.log('Real-time watch event:', data);
    refreshScanSilent();
  });
}

// Unsubscribe from watch events and stop the main-process watchers.
function stopWatcher() {
  if (watchUnsub) {
    watchUnsub();
    watchUnsub = null;
  }
  comparer.stopWatch().catch(() => {});
}

// Ensure watchers are torn down when the window unloads.
window.addEventListener('beforeunload', () => {
  if (watchUnsub) watchUnsub();
});

// Silent scan refresh keeping scroll and folders
async function refreshScanSilent() {
  if (!lastScanParams) return;
  try {
    const data = await comparer.scan(lastScanParams);
    scanResult = data;
    updateTabCounts();
    updateHeaders();

    const scrollParent = document.querySelector('.grid-scroll-container');
    const scrollTop = scrollParent ? scrollParent.scrollTop : 0;
    const scrollLeft = scrollParent ? scrollParent.scrollLeft : 0;
    renderGrid();
    if (scrollParent) {
      scrollParent.scrollTop = scrollTop;
      scrollParent.scrollLeft = scrollLeft;
    }
  } catch (error) {
    console.error('Silent refresh failed:', error);
  }
}

// Helper: check if file is binary
function isBinaryFile(filename) {
  const binaryExtensions = new Set([
    // Images
    'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'tif', 'tiff', 'heic', 'raw', 'psd', 'ai',
    // Archives
    'zip', 'tar', 'gz', 'rar', '7z', 'bz2', 'xz', 'cab', 'iso', 'dmg', 'pkg',
    // MS Office (all binary — not human-readable as text)
    'doc', 'docx', 'docm', 'dot', 'dotx', 'dotm',
    'xls', 'xlsx', 'xlsm', 'xlsb', 'xlt', 'xltx', 'xltm',
    'ppt', 'pptx', 'pptm', 'pot', 'potx', 'potm', 'pps', 'ppsx',
    'pub', 'accdb', 'accdt', 'mpp', 'vsd', 'vsdx',
    // OpenDocument (binary zip containers)
    'odt', 'ods', 'odp', 'odg', 'odf',
    // PDF & ebook
    'pdf', 'epub', 'mobi',
    // Executables & compiled
    'exe', 'dll', 'so', 'dylib', 'bin', 'class', 'jar', 'war', 'apk', 'ipa',
    // Media
    'mp3', 'mp4', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'webm',
    'wav', 'flac', 'aac', 'm4a', 'ogg',
    // Databases
    'db', 'sqlite', 'mdb', 'dbf',
    // Fonts
    'ttf', 'otf', 'woff', 'woff2', 'eot',
  ]);
  const ext = filename.split('.').pop().toLowerCase();
  return binaryExtensions.has(ext);
}

// Helper: request MD5 hash of a file
async function getFileHashFromServer(filePath) {
  try {
    const data = await comparer.hash({ filePath });
    return data.hash || 'Unavailable';
  } catch (e) {
    console.error('Failed to get file hash:', e);
    return 'Error';
  }
}

// Sync file API handler
async function performSyncAction(relativePath, action) {
  if (!scanResult) return;
  try {
    await comparer.sync({
      leftPath: scanResult.leftPath,
      rightPath: scanResult.rightPath,
      relativePath,
      action
    });

    // Show Google-styled Undo toast banner
    showUndoToast(relativePath, action);
    
    // Perform silent refresh
    await refreshScanSilent();
  } catch (error) {
    alert(error.message);
  }
}

// Undo API handler
async function undoLastAction() {
  try {
    await comparer.undo();
    hideUndoToast();
    statusText.textContent = 'Undo completed';
    await refreshScanSilent();
  } catch (error) {
    alert(error.message);
  }
}

// Toast Banner controls
function showUndoToast(relativePath, action) {
  let actionStr = '';
  if (action === 'keepLeft') actionStr = 'Left version kept';
  else if (action === 'keepRight') actionStr = 'Right version kept';

  undoBannerMessage.innerHTML = `Sync completed: <strong>${relativePath}</strong> (${actionStr}).`;
  undoBanner.classList.remove('hidden');
}

// Hide Undo toast
function hideUndoToast() {
  undoBanner.classList.add('hidden');
}

// Track open diff popup windows so they can be re-focused / closed on rescan.
const openDiffWindows = new Map();

// Build the /api/diff request body. File-pair mode (two explicit, possibly
// differently-named files) sends leftFile/rightFile; folder mode sends the
// shared relativePath joined to each scan root.
function diffRequestBody(file) {
  if (file.leftFile || file.rightFile) {
    return { leftFile: file.leftFile, rightFile: file.rightFile };
  }
  return { leftPath: scanResult.leftPath, rightPath: scanResult.rightPath, relativePath: file.relativePath };
}

// Cache the app stylesheet text so exports can inline it (self-contained file).
let _styleCssText = null;
async function getStyleCssText() {
  if (_styleCssText !== null) return _styleCssText;
  try {
    const data = await comparer.readAsset('style.css');
    _styleCssText = data.content;
  } catch {
    _styleCssText = '';
  }
  return _styleCssText;
}

// Export the diff window's current view as a standalone, self-contained HTML
// file: inlines all CSS and strips the interactive controls (buttons/footer).
async function exportDiffHtml(win, wd, file) {
  const cssApp = await getStyleCssText();
  const cssInline = [...wd.querySelectorAll('style')].map(s => s.textContent).join('\n');

  // Clone the body and remove interactive bits that don't belong in a report.
  const body = wd.body.cloneNode(true);
  body.querySelector('.diff-win-actions')?.remove();
  body.querySelector('.diff-win-footer')?.remove();
  body.querySelectorAll('.nav-target').forEach(el => el.classList.remove('nav-target'));

  const title = `Diff: ${file.name}${file.rightName && file.rightName !== file.name ? ' ↔ ' + file.rightName : ''}`;
  const generated = new Date().toLocaleString();

  // Resolve the absolute left/right paths for the metadata header. File-pair mode
  // carries explicit paths; folder mode joins the scan roots with the relativePath.
  const leftFull = file.leftFile || (scanResult ? `${scanResult.leftPath}/${file.relativePath}` : '');
  const rightFull = file.rightFile || (scanResult ? `${scanResult.rightPath}/${file.relativePath}` : '');

  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
${cssApp}
${cssInline}
.diff-win-body { overflow: visible !important; }
.diff-code { overflow: visible !important; height: auto !important; }
.export-meta { padding: 6px 16px; font-size: 11px; color: var(--text-secondary);
  border-bottom: 1px solid var(--google-gray-border); background: var(--google-gray-surface); }
.export-meta-header { padding: 10px 16px; font-size: 12px; color: var(--text-secondary);
  border-bottom: 1px solid var(--google-gray-border); background: var(--google-gray-surface);
  display: grid; grid-template-columns: auto 1fr; gap: 2px 12px; }
.export-meta-header .label { font-weight: 600; color: var(--text-primary); }
.export-meta-header .val { font-family: var(--font-mono); word-break: break-all; }
</style>
</head>
<body>
<div class="export-meta-header">
  <span class="label">Left path</span><span class="val">${escapeHtml(leftFull)}</span>
  <span class="label">Right path</span><span class="val">${escapeHtml(rightFull)}</span>
  <span class="label">Exported</span><span class="val">${escapeHtml(generated)}</span>
</div>
${body.innerHTML}
<div class="export-meta">Generated ${escapeHtml(generated)} · FolderCompare</div>
</body>
</html>`;

  const blob = new Blob([html], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const a = wd.createElement('a');
  const safeName = file.name.replace(/[^a-z0-9._-]/gi, '_');
  a.href = url;
  a.download = `diff-${safeName}.html`;
  wd.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Open a diff in a real, separately resizable OS window (popup).
// Falls back to the in-page modal if the popup is blocked.
async function openDiffWindow(file) {
  if (!scanResult) return;
  const relativePath = file.relativePath;

  // Re-focus an already-open window for this file instead of duplicating.
  const existing = openDiffWindows.get(relativePath);
  if (existing && !existing.closed) {
    existing.focus();
    return;
  }

  const win = window.open('', `diff_${relativePath.replace(/[^a-z0-9]/gi, '_')}`,
    'width=1200,height=800,resizable=yes,scrollbars=yes');
  if (!win) {
    // Popup blocked — fall back to the in-page modal.
    showDiffModal(file);
    return;
  }
  openDiffWindows.set(relativePath, win);

  const condensed = condensePaths(scanResult.leftPath, scanResult.rightPath);
  const binary = isBinaryFile(file.name);
  // File-pair mode: two explicit files (names may differ). Sync is disabled —
  // this view is for comparison only.
  const filePair = !!(file.leftFile || file.rightFile);

  // Build a self-contained document that reuses the app stylesheet so the
  // popup matches the main UI.
  const leftIsNewer = file.newerSide === 'left';
  const rightIsNewer = file.newerSide === 'right';
  const leftLabel = leftIsNewer ? `${condensed.left} · New` : rightIsNewer ? `${condensed.left} · Old` : condensed.left;
  const rightLabel = rightIsNewer ? `${condensed.right} · New` : leftIsNewer ? `${condensed.right} · Old` : condensed.right;
  const leftHeaderClass = `diff-pane-header${leftIsNewer ? ' pane-newer' : rightIsNewer ? ' pane-older' : ''}`;
  const rightHeaderClass = `diff-pane-header${rightIsNewer ? ' pane-newer' : leftIsNewer ? ' pane-older' : ''}`;

  const keepLeftLabel = leftIsNewer ? 'Replace with Old' : rightIsNewer ? 'Replace with New' : 'Replace with Right';
  const keepRightLabel = rightIsNewer ? 'Replace with Old' : leftIsNewer ? 'Replace with New' : 'Replace with Left';

  const origin = window.location.origin;
  win.document.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Diff: ${escapeHtml(file.name)}</title>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined">
  <link rel="stylesheet" href="${origin}/style.css">
  <style>
    html, body { height: 100%; margin: 0; }
    body { display: flex; flex-direction: column; background: var(--google-gray-bg); }
    .diff-win-header { display: flex; align-items: center; justify-content: space-between;
      padding: 10px 16px; border-bottom: 1px solid var(--google-gray-border);
      background: var(--google-gray-surface); gap: 12px; }
    .diff-win-title { display: flex; flex-direction: column; min-width: 0; }
    .diff-win-title h3 { margin: 0; font-size: 14px; }
    .diff-win-title .modal-subtitle { font-size: 11px; color: var(--text-secondary);
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .diff-win-actions { display: flex; gap: 8px; flex-shrink: 0; align-items: center; }
    .diff-win-body { flex: 1; padding: 16px; overflow: hidden; }
    .diff-win-footer { display: flex; gap: 12px; padding: 12px 16px;
      border-top: 1px solid var(--google-gray-border); background: var(--google-gray-surface); }
    .diff-stats { display: flex; gap: 10px; font-size: 12px; font-weight: 600;
      margin-right: 4px; white-space: nowrap; }
    .diff-stats .stat-added { color: #137333; }
    .diff-stats .stat-removed { color: #c5221f; }
    .diff-line-num { cursor: pointer; }
    .diff-line-num:hover { text-decoration: underline; }
    /* Change-block highlight when navigating */
    .diff-line.nav-target { outline: 2px solid var(--google-blue); outline-offset: -2px; }
    /* Word-wrap toggle */
    .diff-code.wrap { white-space: pre-wrap; word-break: break-word; }
    .diff-code.wrap .diff-line { width: auto; }
    /* Unified (git-style) view */
    #win-unified-container { height: 100%; overflow: hidden;
      border: 1px solid var(--google-gray-border); border-radius: 8px; }
    #win-unified-code { height: 100%; overflow: auto; margin: 0; padding: 12px;
      font-family: var(--font-mono); font-size: 12px; line-height: 1.5;
      background: var(--google-gray-bg); white-space: pre; }
    #win-unified-code.wrap { white-space: pre-wrap; word-break: break-word; }
    .u-line { display: block; }
    .u-line.added { background: #e6f4ea; color: #137333; }
    .u-line.removed { background: #fce8e6; color: #c5221f; }
    .u-line.hunk { color: var(--google-blue); background: var(--google-gray-surface);
      font-weight: 600; }
  </style>
</head>
<body>
  <header class="diff-win-header">
    <div class="diff-win-title">
      <h3>Comparing File: ${escapeHtml(file.name)}</h3>
      <span class="modal-subtitle">${escapeHtml(relativePath)}</span>
    </div>
    <div class="diff-win-actions">
      <span id="win-stats" class="diff-stats"${binary ? ' style="display:none"' : ''}></span>
      <button id="win-prev" class="modal-action-btn"${binary ? ' style="display:none"' : ''} title="Previous change (N)">
        <span class="material-symbols-outlined">keyboard_arrow_up</span>
      </button>
      <button id="win-next" class="modal-action-btn"${binary ? ' style="display:none"' : ''} title="Next change (n)">
        <span class="material-symbols-outlined">keyboard_arrow_down</span>
      </button>
      <button id="win-wrap" class="modal-action-btn"${binary ? ' style="display:none"' : ''} title="Toggle word wrap (w)">
        <span class="material-symbols-outlined">wrap_text</span>
      </button>
      <button id="win-copy-left" class="modal-action-btn"${binary ? ' style="display:none"' : ''} title="Copy left text">
        <span class="material-symbols-outlined">content_copy</span>
        <span class="modal-action-label">L</span>
      </button>
      <button id="win-copy-right" class="modal-action-btn"${binary ? ' style="display:none"' : ''} title="Copy right text">
        <span class="material-symbols-outlined">content_copy</span>
        <span class="modal-action-label">R</span>
      </button>
      <button id="win-view-toggle" class="modal-action-btn"${binary ? ' style="display:none"' : ''} title="Toggle unified / side-by-side (u)">
        <span class="material-symbols-outlined">view_agenda</span>
        <span class="modal-action-label">Unified</span>
      </button>
      <button id="win-diffs-only" class="modal-action-btn"${binary ? ' style="display:none"' : ''} title="Show diffs only (d)">
        <span class="material-symbols-outlined">format_list_bulleted</span>
        <span class="modal-action-label">Diffs only</span>
      </button>
      <button id="win-export" class="modal-action-btn" title="Export this diff as a standalone HTML file">
        <span class="material-symbols-outlined">download</span>
        <span class="modal-action-label">Export</span>
      </button>
    </div>
  </header>
  <div class="diff-win-body">
    <div id="win-text-container" class="diff-split-container${binary ? ' hidden' : ''}">
      <div class="diff-pane">
        <div class="${leftHeaderClass}">${escapeHtml(leftLabel)}</div>
        <pre class="diff-code" id="win-left-code">Loading diff...</pre>
      </div>
      <div class="diff-pane">
        <div class="${rightHeaderClass}">${escapeHtml(rightLabel)}</div>
        <pre class="diff-code" id="win-right-code">Loading diff...</pre>
      </div>
    </div>
    <div id="win-unified-container" class="hidden" style="height:100%;overflow:hidden;border:1px solid var(--google-gray-border);border-radius:8px;">
      <pre id="win-unified-code"></pre>
    </div>
    <div id="win-binary-container" class="diff-binary-container${binary ? '' : ' hidden'}">
      <div class="binary-grid">
        <div class="binary-header-col">Property</div>
        <div class="binary-header-col">${escapeHtml(leftLabel)}</div>
        <div class="binary-header-col">${escapeHtml(rightLabel)}</div>
        <div class="binary-row">
          <div class="binary-label">File Size</div>
          <div class="binary-val">${file.left ? formatBytes(file.left.size) : 'Absent'}</div>
          <div class="binary-val">${file.right ? formatBytes(file.right.size) : 'Absent'}</div>
        </div>
        <div class="binary-row">
          <div class="binary-label">Modified Time</div>
          <div class="binary-val">${file.left ? formatDate(file.left.mtime, file.right?.mtime) : 'Absent'}</div>
          <div class="binary-val">${file.right ? formatDate(file.right.mtime, file.left?.mtime) : 'Absent'}</div>
        </div>
        <div class="binary-row">
          <div class="binary-label">MD5 Hash</div>
          <div class="binary-val" id="win-left-hash">${file.left ? 'Calculating...' : '-'}</div>
          <div class="binary-val" id="win-right-hash">${file.right ? 'Calculating...' : '-'}</div>
        </div>
      </div>
    </div>
  </div>
  <footer class="diff-win-footer">
    ${filePair ? '' : `
    <button id="win-keep-left" class="primary-btn flex-btn btn-keep-new-modal"${file.right ? '' : ' disabled'}>
      <span class="material-symbols-outlined">arrow_back</span><span> ${escapeHtml(keepLeftLabel)}</span>
    </button>
    <button id="win-keep-right" class="primary-btn flex-btn btn-keep-old-modal"${file.left ? '' : ' disabled'}>
      <span class="material-symbols-outlined">arrow_forward</span><span> ${escapeHtml(keepRightLabel)}</span>
    </button>`}
    <button id="win-close" class="secondary-btn">Close</button>
  </footer>
</body>
</html>`);
  win.document.close();

  const wd = win.document;

  // Clean up our reference when the window is closed.
  win.addEventListener('beforeunload', () => openDiffWindows.delete(relativePath));

  // Footer actions delegate back to the opener so sync uses the same code path.
  wd.getElementById('win-close').onclick = () => win.close();
  // Esc closes the window (works in both binary and text modes).
  wd.addEventListener('keydown', (e) => { if (e.key === 'Escape') win.close(); });

  // Export the current diff view as a self-contained HTML file.
  wd.getElementById('win-export').onclick = () => exportDiffHtml(win, wd, file);
  if (!filePair) {
    wd.getElementById('win-keep-left').onclick = () => {
      performSyncAction(relativePath, 'keepRight');
      win.close();
    };
    wd.getElementById('win-keep-right').onclick = () => {
      performSyncAction(relativePath, 'keepLeft');
      win.close();
    };
  }

  if (binary) {
    // File-pair mode carries explicit full paths; folder mode joins root + rel.
    const leftFull = file.leftFile || (scanResult.leftPath + '/' + relativePath);
    const rightFull = file.rightFile || (scanResult.rightPath + '/' + relativePath);
    if (file.left) {
      getFileHashFromServer(leftFull)
        .then(hash => { if (!win.closed) wd.getElementById('win-left-hash').textContent = hash; });
    }
    if (file.right) {
      getFileHashFromServer(rightFull)
        .then(hash => { if (!win.closed) wd.getElementById('win-right-hash').textContent = hash; });
    }
    return;
  }

  // Text diff: fetch and render rows.
  const leftCode = wd.getElementById('win-left-code');
  const rightCode = wd.getElementById('win-right-code');
  const textContainer = wd.getElementById('win-text-container');

  // Diffs-only toggle (local to this window).
  const diffsOnlyBtn = wd.getElementById('win-diffs-only');
  const toggleDiffsOnly = () => {
    const isActive = textContainer.classList.toggle('diffs-only');
    diffsOnlyBtn.classList.toggle('active', isActive);
  };
  diffsOnlyBtn.onclick = toggleDiffsOnly;

  // Unified / split toggle.
  const viewToggleBtn = wd.getElementById('win-view-toggle');
  const unifiedContainer = wd.getElementById('win-unified-container');
  const unifiedCode = wd.getElementById('win-unified-code');
  let isUnified = false;
  const toggleUnified = () => {
    isUnified = !isUnified;
    textContainer.classList.toggle('hidden', isUnified);
    unifiedContainer.classList.toggle('hidden', !isUnified);
    viewToggleBtn.classList.toggle('active', isUnified);
    const label = viewToggleBtn.querySelector('.modal-action-label');
    label.textContent = isUnified ? 'Split' : 'Unified';
  };
  viewToggleBtn.onclick = toggleUnified;

  // Word-wrap toggle.
  const wrapBtn = wd.getElementById('win-wrap');
  const toggleWrap = () => {
    const on = leftCode.classList.toggle('wrap');
    rightCode.classList.toggle('wrap', on);
    unifiedCode.classList.toggle('wrap', on);
    wrapBtn.classList.toggle('active', on);
  };
  wrapBtn.onclick = toggleWrap;

  // Copy each side's full text to the clipboard.
  const copyText = async (codeEl, btn) => {
    const text = [...codeEl.querySelectorAll('.diff-line-content')].map(n => n.textContent).join('\n');
    try { await win.navigator.clipboard.writeText(text); } catch { /* clipboard may be blocked */ }
    const label = btn.querySelector('.modal-action-label');
    const orig = label.textContent;
    label.textContent = '✓';
    setTimeout(() => { label.textContent = orig; }, 900);
  };
  wd.getElementById('win-copy-left').onclick = (e) => copyText(leftCode, e.currentTarget);
  wd.getElementById('win-copy-right').onclick = (e) => copyText(rightCode, e.currentTarget);

  // Scroll-sync the two panes (respects the main window's scroll-lock checkbox).
  let syncingLeft = false, syncingRight = false;
  leftCode.addEventListener('scroll', () => {
    if (!scrollLockCheckbox.checked || syncingLeft) return;
    syncingRight = true;
    rightCode.scrollTop = leftCode.scrollTop;
    rightCode.scrollLeft = leftCode.scrollLeft;
    syncingRight = false;
  });
  rightCode.addEventListener('scroll', () => {
    if (!scrollLockCheckbox.checked || syncingRight) return;
    syncingLeft = true;
    leftCode.scrollTop = rightCode.scrollTop;
    leftCode.scrollLeft = rightCode.scrollLeft;
    syncingLeft = false;
  });

  try {
    const data = await comparer.diff(diffRequestBody(file));
    if (win.closed) return;

    leftCode.innerHTML = '';
    rightCode.innerHTML = '';

    let added = 0, removed = 0;
    const changeRows = [];     // left-pane elements that start a change block
    let prevChanged = false;

    const leftName = file.name;
    const rightName = file.rightName || file.name;
    // Click a line number to copy a "name:line" reference.
    const copyRef = (name, lineNum) => {
      win.navigator.clipboard?.writeText(`${name}:${lineNum}`).catch(() => {});
    };

    data.rows.forEach(row => {
      const l = wd.createElement('div');
      l.className = 'diff-line';
      if (row.left === null) {
        l.classList.add('type-empty');
        l.innerHTML = `<span class="diff-line-num"></span><span class="diff-line-content"></span>`;
      } else {
        l.classList.add(`type-${row.left.type}`);
        l.innerHTML = `<span class="diff-line-num">${row.left.lineNum}</span><span class="diff-line-content">${escapeHtml(row.left.text)}</span>`;
        if (row.left.type === 'removed') removed++;
        l.querySelector('.diff-line-num').onclick = () => copyRef(leftName, row.left.lineNum);
      }
      leftCode.appendChild(l);

      const r = wd.createElement('div');
      r.className = 'diff-line';
      if (row.right === null) {
        r.classList.add('type-empty');
        r.innerHTML = `<span class="diff-line-num"></span><span class="diff-line-content"></span>`;
      } else {
        r.classList.add(`type-${row.right.type}`);
        r.innerHTML = `<span class="diff-line-num">${row.right.lineNum}</span><span class="diff-line-content">${escapeHtml(row.right.text)}</span>`;
        if (row.right.type === 'added') added++;
        r.querySelector('.diff-line-num').onclick = () => copyRef(rightName, row.right.lineNum);
      }
      rightCode.appendChild(r);

      // A "change block" is a run of consecutive non-unchanged rows; record the
      // first row of each block for prev/next navigation.
      const changed = (row.left && row.left.type !== 'unchanged') || (row.right && row.right.type !== 'unchanged');
      if (changed && !prevChanged) changeRows.push(l);
      prevChanged = changed;
    });

    // Populate unified view.
    unifiedCode.innerHTML = '';
    (data.unified || []).forEach(line => {
      const el = wd.createElement('span');
      el.className = `u-line ${line.type}`;
      el.textContent = line.text;
      unifiedCode.appendChild(el);
      unifiedCode.appendChild(wd.createTextNode('\n'));
    });

    // Header stats.
    wd.getElementById('win-stats').innerHTML =
      `<span class="stat-added">+${added}</span><span class="stat-removed">−${removed}</span>`;

    // Prev/next change navigation.
    let navIdx = -1;
    const gotoChange = (idx) => {
      if (!changeRows.length) return;
      navIdx = (idx + changeRows.length) % changeRows.length;
      const target = changeRows[navIdx];
      changeRows.forEach(el => el.classList.remove('nav-target'));
      target.classList.add('nav-target');
      target.scrollIntoView({ block: 'center' });
    };
    wd.getElementById('win-next').onclick = () => gotoChange(navIdx + 1);
    wd.getElementById('win-prev').onclick = () => gotoChange(navIdx - 1);

    // Keyboard shortcuts: n/N next/prev change · w wrap · d diffs-only.
    // (Esc-to-close is wired once above, for both binary and text modes.)
    wd.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'n') gotoChange(navIdx + 1);
      else if (e.key === 'N') gotoChange(navIdx - 1);
      else if (e.key === 'w') toggleWrap();
      else if (e.key === 'd') toggleDiffsOnly();
      else if (e.key === 'u') toggleUnified();
    });
  } catch (err) {
    if (win.closed) return;
    leftCode.textContent = `Error loading diff: ${err.message}`;
    rightCode.textContent = `Error loading diff: ${err.message}`;
  }
}

// Show Diff Modal side-by-side
async function showDiffModal(file) {
  if (!scanResult) return;
  const relativePath = file.relativePath;
  diffModalSubtitle.textContent = relativePath;
  diffModalTitle.textContent = `Comparing File: ${file.name}`;
  
  // Set headers in the binary or text container to reflect exact folders
  const condensed = condensePaths(scanResult.leftPath, scanResult.rightPath);
  
  if (isBinaryFile(file.name)) {
    // Show binary
    diffTextContainer.classList.add('hidden');
    diffBinaryContainer.classList.remove('hidden');
    
    binaryLeftHeader.textContent = file.newerSide === 'left' ? `${condensed.left} · New` : file.newerSide === 'right' ? `${condensed.left} · Old` : condensed.left;
    binaryRightHeader.textContent = file.newerSide === 'right' ? `${condensed.right} · New` : file.newerSide === 'left' ? `${condensed.right} · Old` : condensed.right;
    
    // Set basic metadata
    binaryLeftSize.textContent = file.left ? formatBytes(file.left.size) : 'Absent';
    binaryRightSize.textContent = file.right ? formatBytes(file.right.size) : 'Absent';
    
    binaryLeftMtime.textContent = file.left ? formatDate(file.left.mtime, file.right?.mtime) : 'Absent';
    binaryRightMtime.textContent = file.right ? formatDate(file.right.mtime, file.left?.mtime) : 'Absent';
    
    binaryLeftHash.textContent = 'Calculating...';
    binaryRightHash.textContent = 'Calculating...';
    
    // Open modal first to make UI feel snappy
    diffModal.classList.remove('hidden');
    
    // Calculate hashes on-demand
    if (file.left) {
      const leftFull = scanResult.leftPath + '/' + relativePath;
      getFileHashFromServer(leftFull).then(hash => {
        binaryLeftHash.textContent = hash;
      });
    } else {
      binaryLeftHash.textContent = '-';
    }
    
    if (file.right) {
      const rightFull = scanResult.rightPath + '/' + relativePath;
      getFileHashFromServer(rightFull).then(hash => {
        binaryRightHash.textContent = hash;
      });
    } else {
      binaryRightHash.textContent = '-';
    }
    
  } else {
    // Show text diff
    diffBinaryContainer.classList.add('hidden');
    diffTextContainer.classList.remove('hidden');
    
    const leftHeaderEl = document.getElementById('diff-left-header');
    const rightHeaderEl = document.getElementById('diff-right-header');
    const leftLabel = file.newerSide === 'left' ? `${condensed.left} · New` : file.newerSide === 'right' ? `${condensed.left} · Old` : condensed.left;
    const rightLabel = file.newerSide === 'right' ? `${condensed.right} · New` : file.newerSide === 'left' ? `${condensed.right} · Old` : condensed.right;
    leftHeaderEl.textContent = leftLabel;
    rightHeaderEl.textContent = rightLabel;
    leftHeaderEl.className = `diff-pane-header${file.newerSide === 'left' ? ' pane-newer' : file.newerSide === 'right' ? ' pane-older' : ''}`;
    rightHeaderEl.className = `diff-pane-header${file.newerSide === 'right' ? ' pane-newer' : file.newerSide === 'left' ? ' pane-older' : ''}`;

    
    diffLeftCode.innerHTML = 'Loading diff...';
    diffRightCode.innerHTML = 'Loading diff...';
    
    diffModal.classList.remove('hidden');
    
    try {
      const data = await comparer.diff({
        leftPath: scanResult.leftPath,
        rightPath: scanResult.rightPath,
        relativePath
      });

      // Render side-by-side lines
      diffLeftCode.innerHTML = '';
      diffRightCode.innerHTML = '';
      
      data.rows.forEach(row => {
        // Left pane rendering
        const leftLineDiv = document.createElement('div');
        leftLineDiv.className = 'diff-line';
        if (row.left === null) {
          leftLineDiv.classList.add('type-empty');
          leftLineDiv.innerHTML = `<span class="diff-line-num"></span><span class="diff-line-content"></span>`;
        } else {
          leftLineDiv.classList.add(`type-${row.left.type}`);
          leftLineDiv.innerHTML = `<span class="diff-line-num">${row.left.lineNum}</span><span class="diff-line-content">${escapeHtml(row.left.text)}</span>`;
        }
        diffLeftCode.appendChild(leftLineDiv);
        
        // Right pane rendering
        const rightLineDiv = document.createElement('div');
        rightLineDiv.className = 'diff-line';
        if (row.right === null) {
          rightLineDiv.classList.add('type-empty');
          rightLineDiv.innerHTML = `<span class="diff-line-num"></span><span class="diff-line-content"></span>`;
        } else {
          rightLineDiv.classList.add(`type-${row.right.type}`);
          rightLineDiv.innerHTML = `<span class="diff-line-num">${row.right.lineNum}</span><span class="diff-line-content">${escapeHtml(row.right.text)}</span>`;
        }
        diffRightCode.appendChild(rightLineDiv);
      });
      
    } catch (err) {
      diffLeftCode.textContent = `Error loading diff: ${err.message}`;
      diffRightCode.textContent = `Error loading diff: ${err.message}`;
    }
  }
  
  // Modal buttons: each button replaces THAT side's file with the other side's version.
  // Newer side shows "Replace with Old"; older side shows "Replace with New".
  const leftIsNewer = file.newerSide === 'left';
  const rightIsNewer = file.newerSide === 'right';
  const leftLabel = leftIsNewer ? 'Replace with Old' : rightIsNewer ? 'Replace with New' : 'Replace with Right';
  const rightLabel = rightIsNewer ? 'Replace with Old' : leftIsNewer ? 'Replace with New' : 'Replace with Left';

  diffModalKeepLeft.querySelector('span:last-child').textContent = ` ${leftLabel}`;
  diffModalKeepRight.querySelector('span:last-child').textContent = ` ${rightLabel}`;

  // Left button replaces left file with right version; right button replaces right file with left version.
  diffModalKeepLeft.onclick = () => {
    performSyncAction(relativePath, 'keepRight');
    diffModal.classList.add('hidden');
  };
  diffModalKeepRight.onclick = () => {
    performSyncAction(relativePath, 'keepLeft');
    diffModal.classList.add('hidden');
  };

  diffModalKeepLeft.disabled = !file.right;
  diffModalKeepRight.disabled = !file.left;
}

// Simple HTML escaper
function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Helper: Extract file type/extension
function getFileType(filename) {
  const parts = filename.split('.');
  if (parts.length > 1) {
    return '.' + parts.pop().toLowerCase();
  }
  return '';
}

// Helper: Return icon URL for a filename, falling back to blank.svg
const FILE_ICON_ALIASES = {
  jpeg: 'jpg', yml: 'yaml', ts: 'ts', tsx: 'jsx',
  htm: 'html', rb: 'rb', sh: 'sh', bash: 'bash', zsh: 'zsh',
  bat: 'bat', cmd: 'cmd', ps1: 'ps1', lock: 'lock',
  log: 'log', conf: 'conf', cfg: 'cfg', ini: 'ini',
  toml: 'conf', env: 'conf', gitignore: 'gitignore', npmignore: 'npmignore',
};
const FILE_ICON_AVAILABLE = new Set([
  '7z','ai','apk','app','avi','bak','bash','bat','bin','bmp','bz2',
  'c','cab','cfg','class','cmd','coffee','conf','cpp','crt','cs','css','csv',
  'db','dbf','deb','dll','dmg','doc','docm','docx','dot','dotx',
  'editorconfig','eot','eps','epub','exe',
  'flac','flv','gif','gitattributes','gitignore',
  'go','gz','h','hbs','htm','html','ico','img','ini','iso',
  'jar','java','jpeg','jpg','js','json','jsx','key',
  'less','lock','log','lua',
  'm4a','md','mdb','mid','mkv','mov','mp3','mp4','msi',
  'npmignore','odt','ogg','otf','pdf','pem','php','pkg','pl','png','po',
  'ppt','pptm','pptx','ps','ps1','psd','pub','py','pyc',
  'rar','rb','rss','rtf','sass','scss','sh','sln','sql','sqlite','svg',
  'tar','tex','tgz','tif','tiff','tmp','torrent','ts','tsv','ttf','txt',
  'vb','vbs','vsd','war','wav','webm','webp','wma','wmv','woff','woff2',
  'xls','xlsm','xlsx','xml','xsd','yaml','yml','zip','zsh',
]);
function getFileIconUrl(filename) {
  const parts = filename.split('.');
  const raw = parts.length > 1 ? parts.pop().toLowerCase() : '';
  const ext = FILE_ICON_ALIASES[raw] || raw;
  const name = FILE_ICON_AVAILABLE.has(ext) ? ext : 'blank';
  return `/icons/${name}.svg`;
}

// Update filter counts badge numbers
function updateTabCounts() {
  if (!scanResult) return;

  const files = scanResult.files;
  const all = files.length;
  const diff = files.filter(f => f.status === 'modified' || f.status === 'left-only' || f.status === 'right-only').length;
  const modified = files.filter(f => f.status === 'modified').length;
  const match = files.filter(f => f.status === 'identical').length;
  const left = files.filter(f => f.status === 'left-only').length;
  const right = files.filter(f => f.status === 'right-only').length;

  countAll.textContent = all;
  countDiff.textContent = diff;
  countModified.textContent = modified;
  countLeft.textContent = left;
  countRight.textContent = right;
  if (countIdentical) countIdentical.textContent = match;

  summaryText.textContent = `Scanned ${all} files | ${diff} Differences | ${match} Matches`;

  updateSummaryBar({ modified, left, right, identical: match });
}

// --- Summary Bar -----------------------------------------------------------
// Live counts for the four statuses plus a proportional color bar. Driven from
// the same counts as the filter tabs so the two never drift.
const summaryBar = document.getElementById('summary-bar');
const summaryEls = {
  modified: { count: document.getElementById('summary-count-modified'), seg: document.getElementById('summary-seg-modified') },
  left:     { count: document.getElementById('summary-count-left'),     seg: document.getElementById('summary-seg-left') },
  right:    { count: document.getElementById('summary-count-right'),    seg: document.getElementById('summary-seg-right') },
  identical:{ count: document.getElementById('summary-count-identical'),seg: document.getElementById('summary-seg-identical') },
};

function updateSummaryBar(counts) {
  if (!summaryBar) return;
  const total = counts.modified + counts.left + counts.right + counts.identical;
  // Hide the whole bar when there's nothing to show.
  summaryBar.classList.toggle('hidden', total === 0);
  for (const key of Object.keys(summaryEls)) {
    const n = counts[key] || 0;
    const { count, seg } = summaryEls[key];
    if (count) count.textContent = n;
    if (seg) {
      // Zero-count segments collapse so the bar stays clean.
      seg.style.flexGrow = String(n);
      seg.style.display = n === 0 ? 'none' : '';
    }
  }
}

// Group files by parent directories to build folder rows
function groupFilesByDirectory(files) {
  const groups = {};
  
  files.forEach(file => {
    const parts = file.relativePath.split('/');
    const folderPath = parts.slice(0, -1).join('/');
    
    if (!groups[folderPath]) {
      groups[folderPath] = [];
    }
    groups[folderPath].push(file);
  });
  
  return groups;
}

// --- Column sort state -----------------------------------------------------
// Tri-state per column: asc -> desc -> original (col=null). Persisted so the
// chosen order survives reloads. Default is Status/asc so diffs float to the top.
const SORT_STORAGE_KEY = 'comparer_sort';
// Rank used when sorting by Status — lower ranks (diffs) sort first in asc.
const STATUS_RANK = { 'modified': 0, 'left-only': 1, 'right-only': 2, 'identical': 3 };

function loadSortState() {
  try {
    const raw = localStorage.getItem(SORT_STORAGE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      const colOk = p.col === null || typeof p.col === 'string';
      if (p && colOk && (p.dir === 'asc' || p.dir === 'desc')) return { col: p.col, dir: p.dir };
    }
  } catch (e) { /* fall through to default */ }
  return { col: 'status', dir: 'asc' };
}
let sortState = loadSortState();

function saveSortState() {
  localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(sortState));
}

// Extract the comparable key for a file under a given column.
function sortKey(file, col) {
  switch (col) {
    case 'status':     return STATUS_RANK[file.status] ?? 99;
    case 'left-date':  return file.left ? file.left.mtimeMs : -Infinity;
    case 'left-size':  return file.left ? file.left.size : -Infinity;
    case 'right-date': return file.right ? file.right.mtimeMs : -Infinity;
    case 'right-size': return file.right ? file.right.size : -Infinity;
    case 'filename':
    default:           return file.relativePath.toLowerCase();
  }
}

// Return a new array sorted by the given column/direction, with relativePath as
// a stable tiebreaker so equal keys keep a deterministic order.
function getSortedFiles(files, col, dir) {
  const sorted = [...files].sort((a, b) => {
    const ka = sortKey(a, col), kb = sortKey(b, col);
    let cmp;
    if (typeof ka === 'number' && typeof kb === 'number') cmp = ka - kb;
    else cmp = String(ka).localeCompare(String(kb));
    if (cmp === 0) cmp = a.relativePath.localeCompare(b.relativePath);
    return dir === 'desc' ? -cmp : cmp;
  });
  return sorted;
}

// Reflect the active sort on the header carets.
function updateSortIndicators() {
  document.querySelectorAll('.header-col.sortable').forEach((h) => {
    const col = h.getAttribute('data-sort');
    const caret = h.querySelector('.sort-caret');
    const active = sortState.col === col;
    h.classList.toggle('sort-active', active);
    if (caret) caret.textContent = active ? (sortState.dir === 'asc' ? 'arrow_upward' : 'arrow_downward') : '';
  });
}

// Cycle a column through asc -> desc -> original on each header click.
function cycleSort(col) {
  if (sortState.col !== col) {
    sortState = { col, dir: 'asc' };
  } else if (sortState.dir === 'asc') {
    sortState = { col, dir: 'desc' };
  } else {
    sortState = { col: null, dir: 'asc' }; // back to original (folder-grouped)
  }
  saveSortState();
  updateSortIndicators();
  if (scanResult) renderGrid();
}

function initSortableHeaders() {
  document.querySelectorAll('.header-col.sortable').forEach((header) => {
    header.addEventListener('click', (e) => {
      // Ignore clicks that start on the resize grip — that's a resize, not a sort.
      if (e.target.closest('.resize-handle')) return;
      cycleSort(header.getAttribute('data-sort'));
    });
  });
  updateSortIndicators();
}

// Build a single file row. `depth` controls indentation; `showFullPath` shows the
// full relativePath in the filename cell (used in flat/sorted views where there
// are no folder rows to provide context).
function buildFileRow(file, depth, showFullPath) {
  const row = document.createElement('div');
  const newerClass = file.status === 'modified' && file.newerSide ? ` newer-${file.newerSide}` : '';
  row.className = `grid-row status-${file.status}${newerClass}`;

  const indentHtml = `<span class="file-indent" style="width: ${depth * 10}px"></span>`;

  // 1. Filename Cell
  const filenameCell = document.createElement('div');
  filenameCell.className = 'grid-cell col-filename';
  const displayFile = file.left || file.right;
  // Show the diff button for modified files, and for any file-pair row
  // (two explicit files) regardless of status so it can be re-opened.
  const isFilePair = !!(file.leftFile || file.rightFile);
  const diffBtnHtml = (file.status === 'modified' || isFilePair)
    ? `<button class="icon-btn grid-action-btn btn-view-diff filename-diff-btn" data-action="viewDiff" data-path="${file.relativePath}" title="View Diff"><span class="material-symbols-outlined">difference</span></button>`
    : '';
  const iconUrl = getFileIconUrl(file.name);
  // When two paired files have different names, show "left ↔ right". In flat
  // views show the full relativePath so the folder context isn't lost.
  const nameLabel = (isFilePair && file.rightName && file.rightName !== file.name)
    ? `${file.name} ↔ ${file.rightName}`
    : (showFullPath ? file.relativePath : file.name);
  if (displayFile) {
    filenameCell.innerHTML = `
      <div class="file-cell">
        ${indentHtml}
        <img class="file-type-icon" src="${iconUrl}" alt="" aria-hidden="true">
        <span class="file-name" title="${file.relativePath}">${nameLabel}</span>
        ${diffBtnHtml}
      </div>
    `;
  } else {
    filenameCell.innerHTML = `
      <div class="file-cell ghost-placeholder">
        ${indentHtml}
        <img class="file-type-icon" src="/icons/blank.svg" alt="" aria-hidden="true">
        <span class="file-name">(Unknown)</span>
      </div>
    `;
  }
  row.appendChild(filenameCell);

  // 2. Type Cell
  const typeCell = document.createElement('div');
  typeCell.className = 'grid-cell col-type';
  typeCell.textContent = getFileType(file.name);
  row.appendChild(typeCell);

  // 3. Status Cell
  const statusCell = document.createElement('div');
  statusCell.className = 'grid-cell col-status';
  statusCell.innerHTML = getStatusCellHtml(file);
  row.appendChild(statusCell);

  // 4. Left Date
  const leftDateCell = document.createElement('div');
  leftDateCell.className = 'grid-cell col-left-date';
  if (file.left) {
    const leftCompareMtime = file.status === 'modified' ? file.right?.mtime : null;
    const leftDateStr = formatDate(file.left.mtime, leftCompareMtime);
    if (file.status === 'modified' && file.newerSide === 'left' && file.timeDiffStr) {
      leftDateCell.innerHTML = `<span class="newer-indicator" title="Left is newer by ${file.timeDiffStr}">◄ ${file.timeDiffStr}</span><span class="date-text">${leftDateStr}</span>`;
    } else {
      leftDateCell.innerHTML = `<span class="date-text">${leftDateStr}</span>`;
    }
    leftDateCell.title = file.left.mtime;
  } else {
    leftDateCell.innerHTML = `<span class="ghost-placeholder">-</span>`;
  }
  row.appendChild(leftDateCell);

  // 5. Left Size
  const leftSizeCell = document.createElement('div');
  leftSizeCell.className = 'grid-cell col-left-size';
  if (file.left) {
    leftSizeCell.textContent = formatBytes(file.left.size);
  } else {
    leftSizeCell.innerHTML = `<span class="ghost-placeholder">-</span>`;
  }
  row.appendChild(leftSizeCell);

  // 6. Left Action
  const leftActionCell = document.createElement('div');
  leftActionCell.className = 'grid-cell col-left-action';
  leftActionCell.innerHTML = getLeftActionHtml(file);
  row.appendChild(leftActionCell);

  // 7. Right Date
  const rightDateCell = document.createElement('div');
  rightDateCell.className = 'grid-cell col-right-date';
  if (file.right) {
    const rightCompareMtime = file.status === 'modified' ? file.left?.mtime : null;
    const rightDateStr = formatDate(file.right.mtime, rightCompareMtime);
    if (file.status === 'modified' && file.newerSide === 'right' && file.timeDiffStr) {
      rightDateCell.innerHTML = `<span class="newer-indicator right-side-newer" title="Right is newer by ${file.timeDiffStr}">► ${file.timeDiffStr}</span><span class="date-text">${rightDateStr}</span>`;
    } else {
      rightDateCell.innerHTML = `<span class="date-text">${rightDateStr}</span>`;
    }
    rightDateCell.title = file.right.mtime;
  } else {
    rightDateCell.innerHTML = `<span class="ghost-placeholder">-</span>`;
  }
  row.appendChild(rightDateCell);

  // 8. Right Size
  const rightSizeCell = document.createElement('div');
  rightSizeCell.className = 'grid-cell col-right-size';
  if (file.right) {
    rightSizeCell.textContent = formatBytes(file.right.size);
  } else {
    rightSizeCell.innerHTML = `<span class="ghost-placeholder">-</span>`;
  }
  row.appendChild(rightSizeCell);

  // 9. Right Action
  const rightActionCell = document.createElement('div');
  rightActionCell.className = 'grid-cell col-right-action';
  rightActionCell.innerHTML = getRightActionHtml(file);
  row.appendChild(rightActionCell);

  // Missing-side reminder: show the folder directory path (light text) on
  // the side where the file is absent. The overlay is anchored inside that
  // side's date cell and overflows across the empty size/action cells, so
  // it never disturbs the grid's column alignment.
  if (!file.left || !file.right) {
    const missingSide = !file.left ? 'left' : 'right';
    const rootPath = missingSide === 'left' ? scanResult.leftPath : scanResult.rightPath;
    const dir = file.relativePath.includes('/')
      ? file.relativePath.slice(0, file.relativePath.lastIndexOf('/'))
      : '';
    const folderPathText = dir ? `${rootPath}/${dir}` : rootPath;
    // Anchor the display at the scan root (e.g. ...\leftRoot) and keep the
    // file's relative subfolder in full, so it's clear which side's folder
    // the file is missing from.
    const condensedRoot = condenseSinglePath(rootPath, 1);
    const displayText = dir ? `${condensedRoot}\\${dir.replace(/\//g, '\\')}` : condensedRoot;
    const overlay = document.createElement('div');
    overlay.className = `missing-side-overlay missing-${missingSide}`;
    overlay.textContent = displayText;
    overlay.title = `File missing in ${folderPathText}`;
    const anchorCell = missingSide === 'left' ? leftDateCell : rightDateCell;
    anchorCell.appendChild(overlay);
  }

  return row;
}

// Render folder comparison table
function renderGrid() {
  if (!scanResult) return;
  updateSortIndicators();

  let filteredFiles = scanResult.files;

  // 1. Filter by Search Query
  if (searchQuery) {
    filteredFiles = filteredFiles.filter(f => f.relativePath.toLowerCase().includes(searchQuery));
  }

  // 2. Filter by Active Tab
  if (currentFilter === 'diff') {
    filteredFiles = filteredFiles.filter(f => f.status === 'modified' || f.status === 'left-only' || f.status === 'right-only');
  } else if (currentFilter === 'modified') {
    filteredFiles = filteredFiles.filter(f => f.status === 'modified');
  } else if (currentFilter === 'left') {
    filteredFiles = filteredFiles.filter(f => f.status === 'left-only');
  } else if (currentFilter === 'right') {
    filteredFiles = filteredFiles.filter(f => f.status === 'right-only');
  } else if (currentFilter === 'identical') {
    filteredFiles = filteredFiles.filter(f => f.status === 'identical');
  }

  if (filteredFiles.length === 0) {
    gridBody.innerHTML = `
      <div class="empty-state">
        <span class="material-symbols-outlined empty-icon">find_in_page</span>
        <h3>No files found</h3>
        <p>No files match the active filters or search terms.</p>
      </div>
    `;
    return;
  }

  // Flat mode: any sort other than by path (Filename / original) flattens the
  // folder grouping into one clean sorted list.
  const flat = sortState.col && sortState.col !== 'filename';

  if (flat) {
    const sorted = getSortedFiles(filteredFiles, sortState.col, sortState.dir);
    gridBody.innerHTML = '';
    sorted.forEach(file => gridBody.appendChild(buildFileRow(file, 0, true)));
    return;
  }

  // Grouped (path) mode. The Filename column toggles ascending/descending
  // grouping; 'original' (col === null) is plain ascending.
  const dir = sortState.col === 'filename' ? sortState.dir : 'asc';
  const collate = (a, b) => (dir === 'desc' ? b.localeCompare(a) : a.localeCompare(b));
  filteredFiles = [...filteredFiles].sort((a, b) => collate(a.relativePath, b.relativePath));

  // Group files by folder path
  const directoryGroups = groupFilesByDirectory(filteredFiles);

  // Sort folder paths (keys), keeping root files ('') at top
  const sortedFolders = Object.keys(directoryGroups).sort((a, b) => {
    if (a === '') return -1;
    if (b === '') return 1;
    return collate(a, b);
  });

  gridBody.innerHTML = '';

  sortedFolders.forEach(folderPath => {
    // Check if parent directory is collapsed
    let isParentCollapsed = false;
    if (folderPath !== '') {
      const parts = folderPath.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const ancestor = parts.slice(0, i).join('/');
        if (collapsedFolders.has(ancestor)) {
          isParentCollapsed = true;
          break;
        }
      }
    }

    // Render Folder Row (unless it's the root directory files group)
    if (folderPath !== '') {
      if (!isParentCollapsed) {
        const isCollapsed = collapsedFolders.has(folderPath);
        const folderRow = document.createElement('div');
        folderRow.className = `grid-row folder-row ${isCollapsed ? 'collapsed' : ''}`;

        // Calculate indentation
        const depth = folderPath.split('/').length - 1;
        const indentHtml = `<span class="file-indent" style="width: ${depth * 10}px"></span>`;

        folderRow.innerHTML = `
          <div class="folder-cell">
            ${indentHtml}
            <span class="material-symbols-outlined folder-toggle-icon">arrow_drop_down</span>
            <span class="material-symbols-outlined folder-icon">folder</span>
            <span>${folderPath}</span>
          </div>
        `;

        folderRow.addEventListener('click', () => {
          if (collapsedFolders.has(folderPath)) {
            collapsedFolders.delete(folderPath);
          } else {
            collapsedFolders.add(folderPath);
          }
          renderGrid();
        });

        gridBody.appendChild(folderRow);
      }
    }

    // Render Files under this folder
    if (!isParentCollapsed && !collapsedFolders.has(folderPath)) {
      const depth = folderPath === '' ? 0 : folderPath.split('/').length;
      directoryGroups[folderPath].forEach(file => {
        gridBody.appendChild(buildFileRow(file, depth, false));
      });
    }
  });
}

// Helper: Build Status Badge HTML (no action buttons)
function getStatusCellHtml(file) {
  if (file.status === 'left-only') {
    return `<span class="status-badge badge-left-only">Left Only</span>`;
  }
  if (file.status === 'right-only') {
    return `<span class="status-badge badge-right-only">Right Only</span>`;
  }
  if (file.status === 'identical') {
    return `<span class="status-badge badge-identical">Identical</span>`;
  }
  
  if (file.status === 'modified') {
    return `<span class="status-badge badge-modified">Modified</span>`;
  }
  return '';
}

// Helper: Left action cell HTML
function getLeftActionHtml(file) {
  if (file.status === 'left-only') {
    return `<button class="icon-btn grid-action-btn btn-sync-right" data-action="keepLeft" data-path="${file.relativePath}" title="Copy to Right folder"><span class="material-symbols-outlined">arrow_forward</span></button>`;
  }
  if (file.status === 'modified') {
    // Left column: button replaces THIS (left) file with the other side's version.
    // Newer side shows "Replace with Old"; older side shows "Replace with New".
    const isLeftNewer = file.newerSide === 'left';
    const isRightNewer = file.newerSide === 'right';
    const label = isLeftNewer ? 'Replace with Old' : isRightNewer ? 'Replace with New' : 'Replace with Right';
    const btnClass = isLeftNewer ? 'btn-keep-old' : 'btn-keep-new';
    const title = isLeftNewer
      ? `Replace this (newer) Left with the older Right (${file.timeDiffStr})`
      : isRightNewer
        ? `Replace this (older) Left with the newer Right (${file.timeDiffStr})`
        : 'Replace Left with Right';
    return `<button class="text-action-btn ${btnClass}" data-action="keepRight" data-path="${file.relativePath}" title="${title}">${label}</button>`;
  }
  return '';
}

// Helper: Right action cell HTML
function getRightActionHtml(file) {
  if (file.status === 'right-only') {
    return `<button class="icon-btn grid-action-btn btn-sync-left" data-action="keepRight" data-path="${file.relativePath}" title="Copy to Left folder"><span class="material-symbols-outlined">arrow_back</span></button>`;
  }
  if (file.status === 'modified') {
    // Right column: button replaces THIS (right) file with the other side's version.
    // Newer side shows "Replace with Old"; older side shows "Replace with New".
    const isRightNewer = file.newerSide === 'right';
    const isLeftNewer = file.newerSide === 'left';
    const label = isRightNewer ? 'Replace with Old' : isLeftNewer ? 'Replace with New' : 'Replace with Left';
    const btnClass = isRightNewer ? 'btn-keep-old' : 'btn-keep-new';
    const title = isRightNewer
      ? `Replace this (newer) Right with the older Left (${file.timeDiffStr})`
      : isLeftNewer
        ? `Replace this (older) Right with the newer Left (${file.timeDiffStr})`
        : 'Replace Right with Left';
    return `<button class="text-action-btn ${btnClass}" data-action="keepLeft" data-path="${file.relativePath}" title="${title}">${label}</button>`;
  }
  return '';
}

// Event Listeners
scanBtn.addEventListener('click', runScan);

searchInput.addEventListener('input', (e) => {
  searchQuery = e.target.value.toLowerCase();
  renderGrid();
});

// Single source of truth for the active filter. Keeps the filter tabs and the
// summary-bar chips in sync (both call this), then re-renders.
const summaryChips = document.querySelectorAll('.summary-chip');
function setFilter(filter) {
  currentFilter = filter;
  filterTabs.forEach(t => t.classList.toggle('active', t.getAttribute('data-filter') === filter));
  summaryChips.forEach(c => c.classList.toggle('active', c.getAttribute('data-filter') === filter));
  renderGrid();
}

filterTabs.forEach(tab => {
  tab.addEventListener('click', () => setFilter(tab.getAttribute('data-filter')));
});

summaryChips.forEach(chip => {
  chip.addEventListener('click', () => setFilter(chip.getAttribute('data-filter')));
});

// Event Delegation for Grid Action buttons
gridBody.addEventListener('click', (e) => {
  const button = e.target.closest('.grid-action-btn, .text-action-btn');
  if (!button) return;

  const action = button.getAttribute('data-action');
  const relativePath = button.getAttribute('data-path');
  if (!action || !relativePath) return;

  const fileObj = scanResult.files.find(f => f.relativePath === relativePath);
  if (!fileObj) return;

  if (action === 'viewDiff') {
    openDiffWindow(fileObj);
  } else {
    performSyncAction(relativePath, action);
  }
});

// Undo Banner action
undoBtn.addEventListener('click', undoLastAction);
closeUndoBannerBtn.addEventListener('click', hideUndoToast);

// --- Export full scan results as CSV ---------------------------------------
// Enabled only after a successful scan. Dumps every file (full results, not the
// active filter) with path, status, sizes and dates — useful for audit / Excel.
const exportCsvBtn = document.getElementById('export-csv-btn');

function escapeCsv(value) {
  const s = value == null ? '' : String(value);
  // Quote fields containing a comma, quote or newline; double embedded quotes.
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function exportResultsCsv() {
  if (!scanResult || !Array.isArray(scanResult.files)) return;
  const headers = ['Path', 'Status', 'Left Size', 'Right Size', 'Left Modified', 'Right Modified'];
  const lines = [headers.join(',')];

  scanResult.files.forEach((f) => {
    lines.push([
      escapeCsv(f.relativePath),
      escapeCsv(f.status),
      escapeCsv(f.left ? f.left.size : ''),
      escapeCsv(f.right ? f.right.size : ''),
      escapeCsv(f.left ? f.left.mtime : ''),
      escapeCsv(f.right ? f.right.mtime : ''),
    ].join(','));
  });

  // Prefix a UTF-8 BOM so Excel reads non-ASCII paths correctly.
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const a = document.createElement('a');
  a.href = url;
  a.download = `comparer-${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

if (exportCsvBtn) {
  exportCsvBtn.addEventListener('click', exportResultsCsv);
}

// Maximize toggle
const diffMaximizeBtn = document.getElementById('diff-maximize-btn');
const diffMaximizeIcon = diffMaximizeBtn.querySelector('.material-symbols-outlined');
diffMaximizeBtn.addEventListener('click', () => {
  const isMax = diffModal.classList.toggle('maximized');
  diffMaximizeIcon.textContent = isMax ? 'close_fullscreen' : 'open_in_full';
  diffMaximizeBtn.title = isMax ? 'Restore' : 'Maximize';
});

// Diffs-only toggle
const diffDiffsOnlyBtn = document.getElementById('diff-diffs-only-btn');
diffDiffsOnlyBtn.addEventListener('click', () => {
  const isActive = diffTextContainer.classList.toggle('diffs-only');
  diffDiffsOnlyBtn.classList.toggle('active', isActive);
});

// Modal Closing controls
const closeModal = () => {
  diffModal.classList.add('hidden');
  diffModal.classList.remove('maximized');
  diffMaximizeIcon.textContent = 'open_in_full';
  diffMaximizeBtn.title = 'Maximize';
};
closeDiffModalBtn.addEventListener('click', closeModal);
closeDiffModalFooterBtn.addEventListener('click', closeModal);

// Double-Scroll sync lock for text diff code panes
let isSyncingLeftScroll = false;
let isSyncingRightScroll = false;

diffLeftCode.addEventListener('scroll', () => {
  if (!scrollLockCheckbox.checked) return;
  if (!isSyncingLeftScroll) {
    isSyncingRightScroll = true;
    diffRightCode.scrollTop = diffLeftCode.scrollTop;
    diffRightCode.scrollLeft = diffLeftCode.scrollLeft;
    isSyncingRightScroll = false;
  }
});

diffRightCode.addEventListener('scroll', () => {
  if (!scrollLockCheckbox.checked) return;
  if (!isSyncingRightScroll) {
    isSyncingLeftScroll = true;
    diffLeftCode.scrollTop = diffRightCode.scrollTop;
    diffLeftCode.scrollLeft = diffRightCode.scrollLeft;
    isSyncingLeftScroll = false;
  }
});

// Load previously saved paths on start
document.addEventListener('DOMContentLoaded', () => {
  // Match window width to app width (works when opened as a popup; no-ops in normal tabs)
  const appWidth = Math.round(1240 * 1.1);
  const appHeight = window.outerHeight || 900;
  try { window.resizeTo(appWidth, appHeight); } catch (e) { /* sandboxed */ }

  const cachedLeft = localStorage.getItem('comparer_left_path');
  const cachedRight = localStorage.getItem('comparer_right_path');
  
  if (cachedLeft) leftPathInput.value = cachedLeft;
  if (cachedRight) rightPathInput.value = cachedRight;

  // Clear any previously persisted column widths — columns always reset to defaults
  localStorage.removeItem('comparer_col_widths');
  localStorage.removeItem('comparer_col_widths_ver');

  initResizableColumns();
  initSortableHeaders();
});

// Per-column min/max constraints (px). Filename max keeps fixed cols always visible.
// Fixed cols total = 841px; app content = 1240px; filename max = 1240 - 841 = 399px.
const COL_CONSTRAINTS = {
  filename:       { min: 160, max: 560 },
  type:           { min: 40,  max: 100 },
  status:         { min: 80,  max: 180 },
  'left-date':    { min: 100, max: 180 },
  'left-size':    { min: 50,  max: 110 },
  'left-action':  { min: 90,  max: 160 },
  'right-date':   { min: 100, max: 180 },
  'right-size':   { min: 50,  max: 110 },
  'right-action': { min: 90,  max: 160 },
};

// Resizable Columns Logic
function initResizableColumns() {
  const gridPanel = document.querySelector('.grid-panel');
  const headers = document.querySelectorAll('.header-col');

  headers.forEach(header => {
    const handle = header.querySelector('.resize-handle');
    if (!handle) return;

    const colName = handle.getAttribute('data-col');
    const constraints = COL_CONSTRAINTS[colName] || { min: 50, max: 800 };

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();

      handle.classList.add('active');
      document.body.style.cursor = 'col-resize';

      const startX = e.clientX;
      const startWidth = header.getBoundingClientRect().width;

      const onMouseMove = (moveEvent) => {
        const dx = moveEvent.clientX - startX;
        const newWidth = Math.min(constraints.max, Math.max(constraints.min, startWidth + dx));
        gridPanel.style.setProperty(`--col-width-${colName}`, `${newWidth}px`);
      };

      const onMouseUp = () => {
        handle.classList.remove('active');
        document.body.style.cursor = '';
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  });
}

// ===========================================================================
// Phase 3: Exclusions (ignored globs) panel
// ===========================================================================
const exclusionsOverlay = document.getElementById('exclusions-overlay');
const exclusionsListEl = document.getElementById('exclusions-list');
const exclusionInput = document.getElementById('exclusion-input');
const addExclusionForm = document.getElementById('add-exclusion-form');
const exclusionsCount = document.getElementById('exclusions-count');

function renderExclusions() {
  exclusionsCount.textContent = ignoreGlobs.length;
  exclusionsListEl.innerHTML = '';
  ignoreGlobs.forEach((glob, idx) => {
    const li = document.createElement('li');
    li.className = 'side-panel-item';
    li.innerHTML = `
      <div class="side-panel-item-main">
        <div class="side-panel-item-glob"></div>
        <div class="exclusion-test-results hidden"></div>
      </div>
      <div class="side-panel-item-actions">
        <button class="side-panel-mini-btn btn-test" title="Test: preview which files this pattern excludes">
          <span class="material-symbols-outlined">search</span>
        </button>
        <button class="side-panel-mini-btn danger btn-remove" title="Remove pattern">
          <span class="material-symbols-outlined">delete</span>
        </button>
      </div>
    `;
    li.querySelector('.side-panel-item-glob').textContent = glob;
    li.querySelector('.btn-remove').addEventListener('click', () => {
      ignoreGlobs.splice(idx, 1);
      saveIgnoreGlobs();
      renderExclusions();
      triggerRescanForIgnoreChange();
    });
    const resultsEl = li.querySelector('.exclusion-test-results');
    li.querySelector('.btn-test').addEventListener('click', () => testIgnorePattern(glob, resultsEl));
    exclusionsListEl.appendChild(li);
  });
}

// Preview which files a single glob would exclude from the current scan paths.
// Calls POST /api/ignore-test (read-only — no scan, no mutation) and renders the
// matches inline beneath the pattern. Toggling again collapses the results.
async function testIgnorePattern(glob, resultsEl) {
  // Toggle off if already showing results for this pattern.
  if (!resultsEl.classList.contains('hidden')) {
    resultsEl.classList.add('hidden');
    resultsEl.innerHTML = '';
    return;
  }

  // Use the active scan paths if present, else the current input values.
  const leftPath = (lastScanParams?.leftPath || leftPathInput.value).trim();
  const rightPath = (lastScanParams?.rightPath || rightPathInput.value).trim();
  const recursive = lastScanParams ? lastScanParams.recursive : recursiveCheckbox.checked;

  resultsEl.classList.remove('hidden');
  if (!leftPath || !rightPath) {
    resultsEl.innerHTML = `<div class="exclusion-test-hint">Enter both folder paths (or run a scan) first.</div>`;
    return;
  }

  resultsEl.innerHTML = `<div class="exclusion-test-hint">Testing…</div>`;
  try {
    const data = await comparer.ignoreTest({ leftPath, rightPath, recursive, pattern: glob });

    if (data.count === 0) {
      resultsEl.innerHTML = `<div class="exclusion-test-hint">No files match this pattern in the current paths.</div>`;
      return;
    }

    const header = `<div class="exclusion-test-header">Excludes ${data.count} file${data.count === 1 ? '' : 's'}${data.truncated ? ` (showing first ${data.matches.length})` : ''}</div>`;
    const ul = document.createElement('ul');
    ul.className = 'exclusion-test-list';
    data.matches.forEach((m) => {
      const row = document.createElement('li');
      row.innerHTML = `<span class="exclusion-test-side side-${m.side}">${m.side === 'left' ? 'L' : 'R'}</span><span class="exclusion-test-path"></span>`;
      row.querySelector('.exclusion-test-path').textContent = m.relativePath;
      ul.appendChild(row);
    });
    resultsEl.innerHTML = header;
    resultsEl.appendChild(ul);
  } catch (err) {
    resultsEl.innerHTML = `<div class="exclusion-test-hint">Error: ${escapeHtml(err.message)}</div>`;
  }
}

// Re-scan when the ignore list changes — but only if a scan is already active.
function triggerRescanForIgnoreChange() {
  if (!lastScanParams) return;
  lastScanParams.ignore = ignoreGlobs;
  refreshScanSilent();
}

addExclusionForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const value = exclusionInput.value.trim();
  if (!value) return;
  if (ignoreGlobs.includes(value)) {
    exclusionInput.value = '';
    return;
  }
  ignoreGlobs.push(value);
  saveIgnoreGlobs();
  exclusionInput.value = '';
  renderExclusions();
  triggerRescanForIgnoreChange();
});

document.getElementById('reset-exclusions-btn').addEventListener('click', () => {
  ignoreGlobs = [...DEFAULT_IGNORE_GLOBS];
  saveIgnoreGlobs();
  renderExclusions();
  triggerRescanForIgnoreChange();
});

document.getElementById('open-exclusions-btn').addEventListener('click', () => {
  renderExclusions();
  exclusionsOverlay.classList.remove('hidden');
});
document.getElementById('close-exclusions-btn').addEventListener('click', () => {
  exclusionsOverlay.classList.add('hidden');
});
exclusionsOverlay.addEventListener('click', (e) => {
  if (e.target === exclusionsOverlay) exclusionsOverlay.classList.add('hidden');
});

// ===========================================================================
// Phase 3: Session management panel
// ===========================================================================
const sessionsOverlay = document.getElementById('sessions-overlay');
const sessionsListEl = document.getElementById('sessions-list');

// Which backend the last load/save actually used: 'disk' (shared team file via
// the API) or 'local' (browser localStorage fallback). Drives the panel badge.
let sessionsBackend = 'local';
const sessionsBackendBadge = document.getElementById('sessions-backend-badge');

function updateSessionsBadge() {
  if (!sessionsBackendBadge) return;
  const disk = sessionsBackend === 'disk';
  sessionsBackendBadge.textContent = disk ? 'Team (disk)' : 'Local (browser)';
  sessionsBackendBadge.classList.toggle('badge-disk', disk);
  sessionsBackendBadge.classList.toggle('badge-local', !disk);
}

// Read the local cache (also kept in sync with the disk store as a fallback).
function loadSessionsLocal() {
  try {
    const raw = localStorage.getItem(SESSIONS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) { /* fall through */ }
  return [];
}

// Load sessions, preferring the shared disk store and falling back to the local
// cache if the API is unreachable. Sets `sessionsBackend` to whichever was used.
async function loadSessions() {
  try {
    const data = await comparer.getSessions();
    const sessions = Array.isArray(data.sessions) ? data.sessions : [];
    sessionsBackend = 'disk';
    // Mirror to the local cache so an offline reload still shows the list.
    localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(sessions));
    return sessions;
  } catch (e) {
    sessionsBackend = 'local';
    return loadSessionsLocal();
  }
}

// Persist sessions to the shared disk store; on failure fall back to local only.
// Always mirrors to the local cache regardless of backend.
async function saveSessions(sessions) {
  localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(sessions));
  try {
    await comparer.setSessions(sessions);
    sessionsBackend = 'disk';
  } catch (e) {
    sessionsBackend = 'local';
  }
}

async function renderSessions() {
  const sessions = await loadSessions();
  updateSessionsBadge();
  sessionsListEl.innerHTML = '';
  sessions.forEach((session) => {
    const li = document.createElement('li');
    li.className = 'side-panel-item';
    li.innerHTML = `
      <div class="side-panel-item-main">
        <div class="side-panel-item-title"></div>
        <div class="side-panel-item-meta"></div>
      </div>
      <div class="side-panel-item-actions">
        <button class="side-panel-mini-btn btn-reload" title="Reload this session">
          <span class="material-symbols-outlined">restart_alt</span>Reload
        </button>
        <button class="side-panel-mini-btn danger btn-delete" title="Delete session">
          <span class="material-symbols-outlined">delete</span>
        </button>
      </div>
    `;
    li.querySelector('.side-panel-item-title').textContent = session.name;
    const date = session.savedAt ? new Date(session.savedAt).toLocaleString() : '';
    li.querySelector('.side-panel-item-meta').textContent =
      `${(session.leftPath || '').split(/[\\/]/).pop()} ↔ ${(session.rightPath || '').split(/[\\/]/).pop()} · ${date}`;
    li.querySelector('.side-panel-item-meta').title = `${session.leftPath}\n${session.rightPath}`;

    li.querySelector('.btn-reload').addEventListener('click', () => reloadSession(session));
    li.querySelector('.btn-delete').addEventListener('click', async () => {
      if (!confirm(`Delete session "${session.name}"?`)) return;
      const remaining = (await loadSessions()).filter((s) => s.name !== session.name);
      await saveSessions(remaining);
      await renderSessions();
    });
    sessionsListEl.appendChild(li);
  });
}

async function saveCurrentSession() {
  const leftPath = leftPathInput.value.trim();
  const rightPath = rightPathInput.value.trim();
  if (!leftPath || !rightPath) {
    alert('Enter both folder paths before saving a session.');
    return;
  }
  let name = prompt('Name this session:');
  if (name === null) return;
  name = name.trim();
  if (!name) {
    alert('Session name cannot be empty.');
    return;
  }

  const sessions = await loadSessions();
  const existingIdx = sessions.findIndex((s) => s.name === name);
  if (existingIdx !== -1 && !confirm(`A session named "${name}" already exists. Overwrite it?`)) {
    return;
  }

  const session = {
    name,
    leftPath,
    rightPath,
    recursive: recursiveCheckbox.checked,
    ignore: [...ignoreGlobs],
    activeFilter: currentFilter,
    savedAt: new Date().toISOString(),
  };

  if (existingIdx !== -1) {
    sessions[existingIdx] = session;
  } else {
    sessions.push(session);
  }
  await saveSessions(sessions);
  await renderSessions();
}

function reloadSession(session) {
  leftPathInput.value = session.leftPath || '';
  rightPathInput.value = session.rightPath || '';
  recursiveCheckbox.checked = !!session.recursive;

  // Restore the ignore list
  ignoreGlobs = Array.isArray(session.ignore) ? [...session.ignore] : [...DEFAULT_IGNORE_GLOBS];
  saveIgnoreGlobs();
  renderExclusions();

  // Restore the active filter tab
  if (session.activeFilter) {
    currentFilter = session.activeFilter;
    filterTabs.forEach((t) => {
      t.classList.toggle('active', t.getAttribute('data-filter') === currentFilter);
    });
  }

  sessionsOverlay.classList.add('hidden');
  runScan();
}

document.getElementById('save-session-btn').addEventListener('click', saveCurrentSession);
document.getElementById('open-sessions-btn').addEventListener('click', () => {
  renderSessions();
  sessionsOverlay.classList.remove('hidden');
});
document.getElementById('close-sessions-btn').addEventListener('click', () => {
  sessionsOverlay.classList.add('hidden');
});

// Import/export the shared session list to/from a JSON file. This preserves the
// old "team sessions in a shared folder" workflow now that the store lives in
// the per-user app data directory. Both open a native file dialog in the main
// process.
document.getElementById('export-sessions-btn').addEventListener('click', async () => {
  try {
    const res = await comparer.exportSessions();
    if (!res.canceled) statusText.textContent = `Exported ${res.count} session(s)`;
  } catch (err) {
    alert(`Export failed: ${err.message}`);
  }
});
document.getElementById('import-sessions-btn').addEventListener('click', async () => {
  try {
    const res = await comparer.importSessions();
    if (res.canceled) return;
    localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(res.sessions));
    await renderSessions();
    statusText.textContent = `Imported ${res.sessions.length} session(s)`;
  } catch (err) {
    alert(`Import failed: ${err.message}`);
  }
});
sessionsOverlay.addEventListener('click', (e) => {
  if (e.target === sessionsOverlay) sessionsOverlay.classList.add('hidden');
});

// Close any open side panel on Escape
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    exclusionsOverlay.classList.add('hidden');
    sessionsOverlay.classList.add('hidden');
  }
});

// Initialize the exclusions count badge on load
renderExclusions();
