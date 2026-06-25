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
    statusText.textContent = 'Scan Completed';
  } catch (error) {
    console.error('Scan error:', error);
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

// Update the grid headers with condensed paths
function updateHeaders() {
  if (!scanResult) return;
  
  // Set title tooltip on all left and right headers using nth-child
  const leftHeaders = document.querySelectorAll('.header-col:nth-child(-n+4)');
  const rightHeaders = document.querySelectorAll('.header-col:nth-child(n+6)');
  
  leftHeaders.forEach(col => {
    col.title = `Left Folder: ${scanResult.leftPath}`;
  });
  rightHeaders.forEach(col => {
    col.title = `Right Folder: ${scanResult.rightPath}`;
  });
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

      const scrollParent = document.querySelector('.grid-body-wrapper');
      const scrollTop = scrollParent.scrollTop;
      renderGrid();
      scrollParent.scrollTop = scrollTop;
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
  if (action === 'keepLeft') actionStr = 'Left copied to Right';
  else if (action === 'keepRight') actionStr = 'Right copied to Left';
  else if (action === 'deleteLeft') actionStr = 'Left deleted';
  else if (action === 'deleteRight') actionStr = 'Right deleted';

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
    
    binaryLeftHeader.textContent = condensed.left;
    binaryRightHeader.textContent = condensed.right;
    
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
    leftHeaderEl.textContent = `${condensed.left} (Left)`;
    rightHeaderEl.textContent = `${condensed.right} (Right)`;
    
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
  diffModalKeepLeft.onclick = () => {
    performSyncAction(relativePath, 'keepLeft');
    diffModal.classList.add('hidden');
  };
  diffModalKeepRight.onclick = () => {
    performSyncAction(relativePath, 'keepRight');
    diffModal.classList.add('hidden');
  };
  
  // Enable or disable buttons depending on existence
  diffModalKeepLeft.disabled = !file.left;
  diffModalKeepRight.disabled = !file.right;
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
        row.className = `grid-row status-${file.status}`;

        // Indent subfolder files
        const depth = folderPath === '' ? 0 : folderPath.split('/').length;
        const indentHtml = `<span class="file-indent" style="width: ${depth * 16}px"></span>`;

        // 1. Render Left Path Cell
        const pathCell = document.createElement('div');
        pathCell.className = 'grid-cell col-path';
        if (file.left) {
          pathCell.innerHTML = `
            <div class="file-cell">
              ${indentHtml}
              <span class="material-symbols-outlined file-icon">description</span>
              <span class="file-name" title="${file.relativePath}">${file.name}</span>
            </div>
          `;
        } else {
          pathCell.innerHTML = `
            <div class="file-cell ghost-placeholder">
              ${indentHtml}
              <span class="material-symbols-outlined file-icon">description</span>
              <span class="file-name" title="${file.relativePath}">(Absent)</span>
            </div>
          `;
        }
        row.appendChild(pathCell);

        // 2. Render Left Size Cell
        const leftSizeCell = document.createElement('div');
        leftSizeCell.className = 'grid-cell col-size';
        if (file.left) {
          leftSizeCell.textContent = formatBytes(file.left.size);
        } else {
          leftSizeCell.innerHTML = `<span class="ghost-placeholder">(Absent)</span>`;
        }
        row.appendChild(leftSizeCell);

        // 3. Render Left Date Cell
        const leftDateCell = document.createElement('div');
        leftDateCell.className = 'grid-cell col-date';
        if (file.left) {
          leftDateCell.textContent = formatDate(file.left.mtime);
          leftDateCell.title = file.left.mtime;
        } else {
          leftDateCell.innerHTML = `<span class="ghost-placeholder">-</span>`;
        }
        row.appendChild(leftDateCell);

        // 4. Render Left Actions Cell
        const leftActionsCell = document.createElement('div');
        leftActionsCell.className = 'grid-cell col-actions';
        if (file.left) {
          if (file.status === 'left-only') {
            leftActionsCell.innerHTML = `
              <button class="icon-btn grid-action-btn btn-sync-right" data-action="keepLeft" data-path="${file.relativePath}" title="Sync to Right">
                <span class="material-symbols-outlined">arrow_forward</span>
              </button>
              <button class="icon-btn grid-action-btn btn-delete" data-action="deleteLeft" data-path="${file.relativePath}" title="Delete from Left">
                <span class="material-symbols-outlined">delete</span>
              </button>
            `;
          } else if (file.status === 'modified') {
            leftActionsCell.innerHTML = `
              <button class="icon-btn grid-action-btn btn-sync-right" data-action="keepLeft" data-path="${file.relativePath}" title="Keep Left version (Sync Right)">
                <span class="material-symbols-outlined">arrow_forward</span>
              </button>
            `;
          }
        }
        row.appendChild(leftActionsCell);

        // 5. Render Comparison / Status Cell
        const comparisonCell = document.createElement('div');
        comparisonCell.className = 'grid-cell col-status';
        comparisonCell.innerHTML = getStatusCellHtml(file);
        row.appendChild(comparisonCell);

        // 6. Render Right Actions Cell
        const rightActionsCell = document.createElement('div');
        rightActionsCell.className = 'grid-cell col-actions';
        if (file.right) {
          if (file.status === 'right-only') {
            rightActionsCell.innerHTML = `
              <button class="icon-btn grid-action-btn btn-sync-left" data-action="keepRight" data-path="${file.relativePath}" title="Sync to Left">
                <span class="material-symbols-outlined">arrow_back</span>
              </button>
              <button class="icon-btn grid-action-btn btn-delete" data-action="deleteRight" data-path="${file.relativePath}" title="Delete from Right">
                <span class="material-symbols-outlined">delete</span>
              </button>
            `;
          } else if (file.status === 'modified') {
            rightActionsCell.innerHTML = `
              <button class="icon-btn grid-action-btn btn-sync-left" data-action="keepRight" data-path="${file.relativePath}" title="Keep Right version (Sync Left)">
                <span class="material-symbols-outlined">arrow_back</span>
              </button>
            `;
          }
        }
        row.appendChild(rightActionsCell);

        // 7. Render Right Date Cell
        const rightDateCell = document.createElement('div');
        rightDateCell.className = 'grid-cell col-date';
        if (file.right) {
          rightDateCell.textContent = formatDate(file.right.mtime);
          rightDateCell.title = file.right.mtime;
        } else {
          rightDateCell.innerHTML = `<span class="ghost-placeholder">-</span>`;
        }
        row.appendChild(rightDateCell);

        // 8. Render Right Size Cell
        const rightSizeCell = document.createElement('div');
        rightSizeCell.className = 'grid-cell col-size';
        if (file.right) {
          rightSizeCell.textContent = formatBytes(file.right.size);
        } else {
          rightSizeCell.innerHTML = `<span class="ghost-placeholder">(Absent)</span>`;
        }
        row.appendChild(rightSizeCell);

        // 9. Render Right Path Cell
        const rightPathCell = document.createElement('div');
        rightPathCell.className = 'grid-cell col-path';
        if (file.right) {
          rightPathCell.innerHTML = `
            <div class="file-cell">
              ${indentHtml}
              <span class="material-symbols-outlined file-icon">description</span>
              <span class="file-name" title="${file.relativePath}">${file.name}</span>
            </div>
          `;
        } else {
          rightPathCell.innerHTML = `
            <div class="file-cell ghost-placeholder">
              ${indentHtml}
              <span class="material-symbols-outlined file-icon">description</span>
              <span class="file-name" title="${file.relativePath}">(Absent)</span>
            </div>
          `;
        }
        row.appendChild(rightPathCell);

        gridBody.appendChild(row);
      });
    }
  });
}

// Helper: Build Status / Newer Badge HTML
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
          ${isLeft ? 'Left' : 'Right'} Newer (${file.timeDiffStr})
        </span>
      `;
    }
    return `
      <span class="status-badge badge-modified">Modified</span>
      ${newerBadgeHtml}
      <button class="icon-btn grid-action-btn btn-view-diff" data-action="viewDiff" data-path="${file.relativePath}" title="View side-by-side diff">
        <span class="material-symbols-outlined">difference</span>
      </button>
    `;
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
  const button = e.target.closest('.grid-action-btn');
  if (!button) return;

  const action = button.getAttribute('data-action');
  const relativePath = button.getAttribute('data-path');
  if (!action || !relativePath) return;

  const fileObj = scanResult.files.find(f => f.relativePath === relativePath);
  if (!fileObj) return;

  if (action === 'viewDiff') {
    showDiffModal(fileObj);
  } else {
    // Confirm deletes for safety, keep syncs seamless
    if (action.startsWith('delete')) {
      if (!confirm(`Are you sure you want to delete ${relativePath} from the ${action === 'deleteLeft' ? 'Left' : 'Right'} folder?`)) {
        return;
      }
    }
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

  // Initialize resizable columns behavior
  initResizableColumns();
});

// Resizable Columns Logic
function initResizableColumns() {
  const gridPanel = document.querySelector('.grid-panel');
  const headers = document.querySelectorAll('.header-col');
  
  // Load saved column widths from localStorage
  const savedWidths = localStorage.getItem('comparer_col_widths');
  if (savedWidths) {
    try {
      const widths = JSON.parse(savedWidths);
      Object.keys(widths).forEach(col => {
        gridPanel.style.setProperty(`--col-width-${col}`, widths[col]);
      });
    } catch (e) {
      console.error('Error loading column widths:', e);
    }
  }

  headers.forEach(header => {
    const handle = header.querySelector('.resize-handle');
    if (!handle) return;

    const colName = handle.getAttribute('data-col');

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      
      handle.classList.add('active');
      document.body.style.cursor = 'col-resize';
      
      const startX = e.clientX;
      const startWidth = header.getBoundingClientRect().width;

      const onMouseMove = (moveEvent) => {
        const dx = moveEvent.clientX - startX;
        const newWidth = Math.max(50, startWidth + dx); // Enforce min width of 50px
        
        gridPanel.style.setProperty(`--col-width-${colName}`, `${newWidth}px`);
      };

      const onMouseUp = () => {
        handle.classList.remove('active');
        document.body.style.cursor = '';
        
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);

        // Save widths to localStorage
        const currentWidths = {};
        const colNames = ['path', 'size', 'date', 'actions', 'status'];
        colNames.forEach(col => {
          const val = gridPanel.style.getPropertyValue(`--col-width-${col}`);
          if (val) {
            currentWidths[col] = val.trim();
          }
        });
        localStorage.setItem('comparer_col_widths', JSON.stringify(currentWidths));
      };

      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
    });
  });
}
