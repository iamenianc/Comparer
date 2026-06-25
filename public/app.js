// Comparer Frontend Logic

let scanResult = null;
let currentFilter = 'all';
let searchQuery = '';
const collapsedFolders = new Set();
let lastScanParams = null;
let eventSource = null;

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
const countMatch = document.getElementById('count-match');
const countLeft = document.getElementById('count-left');
const countRight = document.getElementById('count-right');
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
    const response = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lastScanParams)
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Server error comparing folders.');
    }

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

// Update the grid super-headers with condensed paths
function updateHeaders() {
  if (!scanResult) return;
  const condensed = condensePaths(scanResult.leftPath, scanResult.rightPath);
  
  const leftSuper = document.getElementById('super-header-left');
  const rightSuper = document.getElementById('super-header-right');
  
  if (leftSuper) {
    leftSuper.querySelector('span').textContent = condensed.left;
    leftSuper.title = scanResult.leftPath;
  }
  if (rightSuper) {
    rightSuper.querySelector('span').textContent = condensed.right;
    rightSuper.title = scanResult.rightPath;
  }
}

// Setup EventSource for SSE watcher connection
function setupSSEWatcher() {
  if (eventSource) {
    eventSource.close();
  }
  eventSource = new EventSource('/api/watch');
  eventSource.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      console.log('Real-time SSE event:', data);
      refreshScanSilent();
    } catch (e) {
      console.error('Error parsing SSE event:', e);
    }
  };
  eventSource.onerror = (err) => {
    console.warn('SSE connection interrupted, retrying...', err);
  };
}

// Silent scan refresh keeping scroll and folders
async function refreshScanSilent() {
  if (!lastScanParams) return;
  try {
    const response = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(lastScanParams)
    });
    const data = await response.json();
    if (response.ok) {
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
    const res = await fetch('/api/hash', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filePath })
    });
    const data = await res.json();
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
    const response = await fetch('/api/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        leftPath: scanResult.leftPath,
        rightPath: scanResult.rightPath,
        relativePath,
        action
      })
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Failed to complete sync operation.');
    }
    
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
    const response = await fetch('/api/undo', { method: 'POST' });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'Failed to undo action.');
    }
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
      const res = await fetch('/api/diff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          leftPath: scanResult.leftPath,
          rightPath: scanResult.rightPath,
          relativePath
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      
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
  const match = files.filter(f => f.status === 'identical').length;
  const left = files.filter(f => f.status === 'left-only').length;
  const right = files.filter(f => f.status === 'right-only').length;

  countAll.textContent = all;
  countDiff.textContent = diff;
  countMatch.textContent = match;
  countLeft.textContent = left;
  countRight.textContent = right;

  summaryText.textContent = `Scanned ${all} files | ${diff} Differences | ${match} Matches`;
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

// Render folder comparison table
function renderGrid() {
  if (!scanResult) return;

  let filteredFiles = scanResult.files;

  // 1. Filter by Search Query
  if (searchQuery) {
    filteredFiles = filteredFiles.filter(f => f.relativePath.toLowerCase().includes(searchQuery));
  }

  // 2. Filter by Active Tab
  if (currentFilter === 'diff') {
    filteredFiles = filteredFiles.filter(f => f.status === 'modified' || f.status === 'left-only' || f.status === 'right-only');
  } else if (currentFilter === 'match') {
    filteredFiles = filteredFiles.filter(f => f.status === 'identical');
  } else if (currentFilter === 'left') {
    filteredFiles = filteredFiles.filter(f => f.status === 'left-only');
  } else if (currentFilter === 'right') {
    filteredFiles = filteredFiles.filter(f => f.status === 'right-only');
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

  // Sort files alphabetically by relative path
  filteredFiles.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  // Group files by folder path
  const directoryGroups = groupFilesByDirectory(filteredFiles);
  
  // Sort folder paths (keys) alphabetically, keeping root files ('') at top
  const sortedFolders = Object.keys(directoryGroups).sort((a, b) => {
    if (a === '') return -1;
    if (b === '') return 1;
    return a.localeCompare(b);
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
        const indentHtml = `<span class="file-indent" style="width: ${depth * 16}px"></span>`;
        
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
      directoryGroups[folderPath].forEach(file => {
        const row = document.createElement('div');
        const newerClass = file.status === 'modified' && file.newerSide ? ` newer-${file.newerSide}` : '';
        row.className = `grid-row status-${file.status}${newerClass}`;

        // Indent subfolder files
        const depth = folderPath === '' ? 0 : folderPath.split('/').length;
        const indentHtml = `<span class="file-indent" style="width: ${depth * 16}px"></span>`;

        // 1. Filename Cell
        const filenameCell = document.createElement('div');
        filenameCell.className = 'grid-cell col-filename';
        const displayFile = file.left || file.right;
        const diffBtnHtml = file.status === 'modified'
          ? `<button class="icon-btn grid-action-btn btn-view-diff filename-diff-btn" data-action="viewDiff" data-path="${file.relativePath}" title="View Diff"><span class="material-symbols-outlined">difference</span></button>`
          : '';
        const iconUrl = getFileIconUrl(file.name);
        if (displayFile) {
          filenameCell.innerHTML = `
            <div class="file-cell">
              ${indentHtml}
              <img class="file-type-icon" src="${iconUrl}" alt="" aria-hidden="true">
              <span class="file-name" title="${file.relativePath}">${file.name}</span>
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

        gridBody.appendChild(row);
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

filterTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    filterTabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentFilter = tab.getAttribute('data-filter');
    renderGrid();
  });
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
    showDiffModal(fileObj);
  } else {
    performSyncAction(relativePath, action);
  }
});

// Undo Banner action
undoBtn.addEventListener('click', undoLastAction);
closeUndoBannerBtn.addEventListener('click', hideUndoToast);

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
      </div>
      <div class="side-panel-item-actions">
        <button class="side-panel-mini-btn danger" title="Remove pattern">
          <span class="material-symbols-outlined">delete</span>
        </button>
      </div>
    `;
    li.querySelector('.side-panel-item-glob').textContent = glob;
    li.querySelector('.side-panel-mini-btn').addEventListener('click', () => {
      ignoreGlobs.splice(idx, 1);
      saveIgnoreGlobs();
      renderExclusions();
      triggerRescanForIgnoreChange();
    });
    exclusionsListEl.appendChild(li);
  });
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

function loadSessions() {
  try {
    const raw = localStorage.getItem(SESSIONS_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch (e) { /* fall through */ }
  return [];
}

function saveSessions(sessions) {
  localStorage.setItem(SESSIONS_STORAGE_KEY, JSON.stringify(sessions));
}

function renderSessions() {
  const sessions = loadSessions();
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
    li.querySelector('.btn-delete').addEventListener('click', () => {
      if (!confirm(`Delete session "${session.name}"?`)) return;
      const remaining = loadSessions().filter((s) => s.name !== session.name);
      saveSessions(remaining);
      renderSessions();
    });
    sessionsListEl.appendChild(li);
  });
}

function saveCurrentSession() {
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

  const sessions = loadSessions();
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
  saveSessions(sessions);
  renderSessions();
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
