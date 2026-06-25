// Comparer Frontend Logic

let scanResult = null;
let currentFilter = 'all';
let searchQuery = '';
const collapsedFolders = new Set();
let lastScanParams = null;
let eventSource = null;

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
const diffModalKeepNew = document.getElementById('diff-modal-keep-new');
const diffModalKeepOld = document.getElementById('diff-modal-keep-old');
const closeDiffModalFooterBtn = document.getElementById('close-diff-modal-footer-btn');

// Helper: Format bytes to human readable string
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// Helper: Format ISO date string to clean local date time
function formatDate(dateStr) {
  if (!dateStr) return '';
  const date = new Date(dateStr);
  const pad = (num) => String(num).padStart(2, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
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
    recursive: recursiveCheckbox.checked
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
  const binaryExtensions = [
    'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'ico', 'svg',
    'zip', 'tar', 'gz', 'rar', '7z', 'bz2',
    'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
    'exe', 'dll', 'so', 'dylib', 'bin', 'class', 'jar', 'war',
    'mp3', 'mp4', 'mkv', 'avi', 'mov', 'wav', 'flac',
    'db', 'sqlite', 'mdb'
  ];
  const ext = filename.split('.').pop().toLowerCase();
  return binaryExtensions.includes(ext);
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
    
    binaryLeftMtime.textContent = file.left ? formatDate(file.left.mtime) : 'Absent';
    binaryRightMtime.textContent = file.right ? formatDate(file.right.mtime) : 'Absent';
    
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
  
  // Wire up keep version modal action buttons
  // "Keep New" = keep the newer side; "Keep Old" = keep the older side
  const keepNewAction = file.newerSide === 'right' ? 'keepRight' : 'keepLeft';
  const keepOldAction = file.newerSide === 'right' ? 'keepLeft' : 'keepRight';

  diffModalKeepNew.onclick = () => {
    performSyncAction(relativePath, keepNewAction);
    diffModal.classList.add('hidden');
  };
  diffModalKeepOld.onclick = () => {
    performSyncAction(relativePath, keepOldAction);
    diffModal.classList.add('hidden');
  };

  // Enable/disable based on file existence; if no newerSide, "Keep New" maps to keepLeft
  diffModalKeepNew.disabled = keepNewAction === 'keepLeft' ? !file.left : !file.right;
  diffModalKeepOld.disabled = keepOldAction === 'keepLeft' ? !file.left : !file.right;
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

        // 4. Left Action
        const leftActionCell = document.createElement('div');
        leftActionCell.className = 'grid-cell col-left-action';
        leftActionCell.innerHTML = getLeftActionHtml(file);
        row.appendChild(leftActionCell);

        // 5. Left Date
        const leftDateCell = document.createElement('div');
        leftDateCell.className = 'grid-cell col-left-date';
        if (file.left) {
          leftDateCell.textContent = formatDate(file.left.mtime);
          leftDateCell.title = file.left.mtime;
        } else {
          leftDateCell.innerHTML = `<span class="ghost-placeholder">-</span>`;
        }
        row.appendChild(leftDateCell);

        // 6. Left Size
        const leftSizeCell = document.createElement('div');
        leftSizeCell.className = 'grid-cell col-left-size';
        if (file.left) {
          leftSizeCell.textContent = formatBytes(file.left.size);
        } else {
          leftSizeCell.innerHTML = `<span class="ghost-placeholder">-</span>`;
        }
        row.appendChild(leftSizeCell);

        // 7. Right Action
        const rightActionCell = document.createElement('div');
        rightActionCell.className = 'grid-cell col-right-action';
        rightActionCell.innerHTML = getRightActionHtml(file);
        row.appendChild(rightActionCell);

        // 8. Right Date
        const rightDateCell = document.createElement('div');
        rightDateCell.className = 'grid-cell col-right-date';
        if (file.right) {
          rightDateCell.textContent = formatDate(file.right.mtime);
          rightDateCell.title = file.right.mtime;
        } else {
          rightDateCell.innerHTML = `<span class="ghost-placeholder">-</span>`;
        }
        row.appendChild(rightDateCell);

        // 9. Right Size
        const rightSizeCell = document.createElement('div');
        rightSizeCell.className = 'grid-cell col-right-size';
        if (file.right) {
          rightSizeCell.textContent = formatBytes(file.right.size);
        } else {
          rightSizeCell.innerHTML = `<span class="ghost-placeholder">-</span>`;
        }
        row.appendChild(rightSizeCell);

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
    let newerBadgeHtml = '';
    if (file.newerSide) {
      const isLeft = file.newerSide === 'left';
      newerBadgeHtml = `
        <span class="newer-indicator ${isLeft ? '' : 'right-side-newer'}" title="${isLeft ? 'Left' : 'Right'} is newer by ${file.timeDiffStr}">
          ${isLeft ? '◄' : '►'} ${file.timeDiffStr}
        </span>
      `;
    }
    return `
      <span class="status-badge badge-modified">Modified</span>
      ${newerBadgeHtml}
    `;
  }
  return '';
}

// Helper: Left action cell HTML
function getLeftActionHtml(file) {
  if (file.status === 'left-only') {
    return `<button class="icon-btn grid-action-btn btn-sync-right" data-action="keepLeft" data-path="${file.relativePath}" title="Copy to Right folder"><span class="material-symbols-outlined">arrow_forward</span></button>`;
  }
  if (file.status === 'modified') {
    const newerSide = file.newerSide;
    const isLeftNewer = newerSide === 'left' || !newerSide;
    const action = isLeftNewer ? 'keepLeft' : 'keepLeft';
    const label = isLeftNewer ? 'Keep New' : 'Keep Old';
    const btnClass = isLeftNewer ? 'btn-keep-new' : 'btn-keep-old';
    const title = newerSide === 'left'
      ? `Keep Left (newer by ${file.timeDiffStr})`
      : newerSide === 'right'
        ? `Keep Left (older by ${file.timeDiffStr})`
        : 'Keep Left version';
    return `<button class="text-action-btn ${btnClass}" data-action="keepLeft" data-path="${file.relativePath}" title="${title}">${label}</button>`;
  }
  return '';
}

// Helper: Right action cell HTML
function getRightActionHtml(file) {
  if (file.status === 'right-only') {
    return `<button class="icon-btn grid-action-btn btn-sync-left" data-action="keepRight" data-path="${file.relativePath}" title="Copy to Left folder"><span class="material-symbols-outlined">arrow_back</span></button>`;
  }
  if (file.status === 'modified') {
    const newerSide = file.newerSide;
    const isRightNewer = newerSide === 'right';
    const label = isRightNewer ? 'Keep New' : 'Keep Old';
    const btnClass = isRightNewer ? 'btn-keep-new' : 'btn-keep-old';
    const title = newerSide === 'right'
      ? `Keep Right (newer by ${file.timeDiffStr})`
      : newerSide === 'left'
        ? `Keep Right (older by ${file.timeDiffStr})`
        : 'Keep Right version';
    return `<button class="text-action-btn ${btnClass}" data-action="keepRight" data-path="${file.relativePath}" title="${title}">${label}</button>`;
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

// Modal Closing controls
const closeModal = () => diffModal.classList.add('hidden');
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
// Fixed cols total = 785px; app content = 1408px; filename max = 1408 - 785 = 623px.
const COL_CONSTRAINTS = {
  filename:      { min: 160, max: 623 },
  type:          { min: 40,  max: 100 },
  status:        { min: 80,  max: 180 },
  'left-action':  { min: 60,  max: 140 },
  'left-date':    { min: 100, max: 200 },
  'left-size':    { min: 55,  max: 130 },
  'right-action': { min: 60,  max: 140 },
  'right-date':   { min: 100, max: 200 },
  'right-size':   { min: 55,  max: 130 },
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
