// Comparer Frontend Logic

let scanResult = null;
let currentFilter = 'all';
let searchQuery = '';
const collapsedFolders = new Set();

// DOM elements
const leftPathInput = document.getElementById('left-path');
const rightPathInput = document.getElementById('right-path');
const scanBtn = document.getElementById('scan-btn');
const recursiveCheckbox = document.getElementById('option-recursive');
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
      body: JSON.stringify({
        leftPath,
        rightPath,
        recursive: recursiveCheckbox.checked
      })
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
    renderGrid();
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
          <div class="grid-cell col-path">
            <div class="folder-cell">
              ${indentHtml}
              <span class="material-symbols-outlined folder-toggle-icon">arrow_drop_down</span>
              <span class="material-symbols-outlined folder-icon">folder</span>
              <span>${folderPath}</span>
            </div>
          </div>
          <div class="grid-cell col-pane-left"></div>
          <div class="grid-cell col-comparison"></div>
          <div class="grid-cell col-pane-right"></div>
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

        // Render File Relative Path Cell
        const pathCell = document.createElement('div');
        pathCell.className = 'grid-cell col-path';
        pathCell.innerHTML = `
          <div class="file-cell">
            ${indentHtml}
            <span class="material-symbols-outlined file-icon">description</span>
            <span class="file-name" title="${file.relativePath}">${file.name}</span>
          </div>
        `;
        row.appendChild(pathCell);

        // Render Left Pane Cell
        const leftCell = document.createElement('div');
        leftCell.className = 'grid-cell col-pane-left';
        if (file.left) {
          leftCell.innerHTML = `
            <div class="pane-details">
              <span class="file-size">${formatBytes(file.left.size)}</span>
              <span class="file-mtime" title="${file.left.mtime}">${formatDate(file.left.mtime)}</span>
            </div>
          `;
        }
        row.appendChild(leftCell);

        // Render Status / Newer Arrow Cell
        const comparisonCell = document.createElement('div');
        comparisonCell.className = 'grid-cell col-comparison status-cell';
        comparisonCell.innerHTML = getStatusCellHtml(file);
        row.appendChild(comparisonCell);

        // Render Right Pane Cell
        const rightCell = document.createElement('div');
        rightCell.className = 'grid-cell col-pane-right';
        if (file.right) {
          rightCell.innerHTML = `
            <div class="pane-details">
              <span class="file-size">${formatBytes(file.right.size)}</span>
              <span class="file-mtime" title="${file.right.mtime}">${formatDate(file.right.mtime)}</span>
            </div>
          `;
        }
        row.appendChild(rightCell);

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
  
  // Modified File Layout
  if (file.status === 'modified') {
    let arrowHtml = '';
    
    if (file.newerSide === 'left') {
      arrowHtml = `
        <div class="newer-arrow-wrapper" title="Left version is newer by ${file.timeDiffStr}">
          <span class="newer-indicator">Newer (${file.timeDiffStr})</span>
          <span class="material-symbols-outlined arrow-icon">arrow_forward</span>
        </div>
      `;
    } else if (file.newerSide === 'right') {
      arrowHtml = `
        <div class="newer-arrow-wrapper" title="Right version is newer by ${file.timeDiffStr}">
          <span class="material-symbols-outlined arrow-icon">arrow_back</span>
          <span class="newer-indicator right-side-newer">Newer (${file.timeDiffStr})</span>
        </div>
      `;
    }

    return `
      <div style="display:flex; flex-direction:column; align-items:center; gap:2px;">
        <span class="status-badge badge-modified">Diff</span>
        ${arrowHtml}
      </div>
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

// Load previously saved paths on start
document.addEventListener('DOMContentLoaded', () => {
  const cachedLeft = localStorage.getItem('comparer_left_path');
  const cachedRight = localStorage.getItem('comparer_right_path');
  
  if (cachedLeft) leftPathInput.value = cachedLeft;
  if (cachedRight) rightPathInput.value = cachedRight;
});
