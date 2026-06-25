import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import os from 'os';
import chokidar from 'chokidar';
import * as diff from 'diff';


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicPath = path.join(__dirname, 'public');

const app = express();
const PORT = process.env.PORT || 3000;

// Backup and Watcher global state
let lastTransaction = null;
let activeWatchers = [];
const sseClients = new Set();
const BACKUP_DIR = path.join(os.tmpdir(), '.comparer-backups');

// Helper: Clean backup directory
function clearBackupDir() {
  try {
    if (fs.existsSync(BACKUP_DIR)) {
      fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
    }
  } catch (err) {
    console.error('Failed to clear backup directory:', err);
  }
}

// Clear on startup
clearBackupDir();

// Clean up backups on process exit
process.on('exit', clearBackupDir);
process.on('SIGINT', () => {
  clearBackupDir();
  process.exit(0);
});
process.on('SIGTERM', () => {
  clearBackupDir();
  process.exit(0);
});

// Helper to manage watchers
function setupWatchers(leftPath, rightPath) {
  // Clear previous watchers
  for (const watcher of activeWatchers) {
    try {
      watcher.close();
    } catch (e) {
      console.error('Error closing watcher:', e);
    }
  }
  activeWatchers = [];

  const watcherOptions = {
    ignored: [
      /(^|[\/\\])\../, // ignore dotfiles (e.g. .git, .DS_Store)
      '**/node_modules/**',
      '**/.git/**'
    ],
    persistent: true,
    ignoreInitial: true,
  };

  const leftWatcher = chokidar.watch(leftPath, watcherOptions);
  const rightWatcher = chokidar.watch(rightPath, watcherOptions);

  const handleEvent = (event, filePath, side) => {
    // Calculate relative path for matching on client side
    const baseDir = side === 'left' ? leftPath : rightPath;
    const relPath = path.relative(baseDir, filePath).replace(/\\/g, '/');

    const data = JSON.stringify({ event, relativePath: relPath, side });
    for (const client of sseClients) {
      client.write(`data: ${data}\n\n`);
    }
  };

  leftWatcher.on('all', (event, filePath) => handleEvent(event, filePath, 'left'));
  rightWatcher.on('all', (event, filePath) => handleEvent(event, filePath, 'right'));

  leftWatcher.on('error', error => console.error('Left Watcher Error (ignored):', error.message || error));
  rightWatcher.on('error', error => console.error('Right Watcher Error (ignored):', error.message || error));

  activeWatchers.push(leftWatcher, rightWatcher);
}

app.use(express.json());
app.use(express.static(publicPath));

// Helper: Format millisecond difference to a concise Google-style tag (e.g. +2h, +3d, +5s)
function formatDuration(ms) {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `+${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `+${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `+${hours}h`;
  const days = Math.floor(hours / 24);
  return `+${days}d`;
}

// Helper: MD5 Hashing for content comparison
function getFileHash(filePath) {
  try {
    const fileBuffer = fs.readFileSync(filePath);
    return crypto.createHash('md5').update(fileBuffer).digest('hex');
  } catch (error) {
    console.error(`Error hashing file: ${filePath}`, error);
    return null;
  }
}

// Helper: Recursively scan a folder and gather file details
function scanDirectory(dirPath, recursive = true, baseDir = dirPath) {
  let results = {};
  if (!fs.existsSync(dirPath)) return results;
  
  const stats = fs.statSync(dirPath);
  if (!stats.isDirectory()) return results;

  const files = fs.readdirSync(dirPath);
  for (const file of files) {
    const fullPath = path.join(dirPath, file);
    const fileStats = fs.statSync(fullPath);
    const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');

    if (fileStats.isDirectory()) {
      if (recursive) {
        const subFiles = scanDirectory(fullPath, recursive, baseDir);
        results = { ...results, ...subFiles };
      } else {
        // Track empty folders or folders in non-recursive mode
        results[relativePath] = {
          relativePath,
          name: file,
          size: 0,
          mtimeMs: fileStats.mtimeMs,
          mtime: fileStats.mtime.toISOString(),
          isDirectory: true,
        };
      }
    } else {
      results[relativePath] = {
        relativePath,
        name: file,
        size: fileStats.size,
        mtimeMs: fileStats.mtimeMs,
        mtime: fileStats.mtime.toISOString(),
        isDirectory: false,
      };
    }
  }
  return results;
}

// API Route: Scan and compare left and right folders
app.post('/api/scan', (req, res) => {
  const { leftPath, rightPath, recursive = true } = req.body;

  if (!leftPath || !rightPath) {
    return res.status(400).json({ error: 'Both leftPath and rightPath are required.' });
  }

  const resolvedLeft = path.resolve(leftPath);
  const resolvedRight = path.resolve(rightPath);

  if (!fs.existsSync(resolvedLeft) || !fs.statSync(resolvedLeft).isDirectory()) {
    return res.status(400).json({ error: `Left path does not exist or is not a directory: ${leftPath}` });
  }
  if (!fs.existsSync(resolvedRight) || !fs.statSync(resolvedRight).isDirectory()) {
    return res.status(400).json({ error: `Right path does not exist or is not a directory: ${rightPath}` });
  }

  try {
    const leftFiles = scanDirectory(resolvedLeft, recursive);
    const rightFiles = scanDirectory(resolvedRight, recursive);

    const allPaths = new Set([...Object.keys(leftFiles), ...Object.keys(rightFiles)]);
    const compared = [];

    for (const relPath of allPaths) {
      const leftFile = leftFiles[relPath];
      const rightFile = rightFiles[relPath];

      // File only exists on the left
      if (leftFile && !rightFile) {
        compared.push({
          relativePath: relPath,
          name: leftFile.name,
          isDirectory: leftFile.isDirectory,
          status: 'left-only',
          left: leftFile,
          right: null,
        });
      }
      // File only exists on the right
      else if (!leftFile && rightFile) {
        compared.push({
          relativePath: relPath,
          name: rightFile.name,
          isDirectory: rightFile.isDirectory,
          status: 'right-only',
          left: null,
          right: rightFile,
        });
      }
      // Directory vs Directory (should only occur in non-recursive scans)
      else if (leftFile.isDirectory && rightFile.isDirectory) {
        compared.push({
          relativePath: relPath,
          name: leftFile.name,
          isDirectory: true,
          status: 'identical',
          left: leftFile,
          right: rightFile,
        });
      }
      // File vs File
      else {
        let status = 'identical';
        let newerSide = null;
        let timeDiffStr = '';

        const timeDiffMs = leftFile.mtimeMs - rightFile.mtimeMs;
        if (timeDiffMs > 0) {
          newerSide = 'left';
          timeDiffStr = formatDuration(timeDiffMs);
        } else if (timeDiffMs < 0) {
          newerSide = 'right';
          timeDiffStr = formatDuration(-timeDiffMs);
        }

        // Compare sizes first
        if (leftFile.size !== rightFile.size) {
          status = 'modified';
        } else {
          // If sizes match but modification dates differ, calculate MD5 hashes
          if (timeDiffMs !== 0) {
            const leftFullPath = path.join(resolvedLeft, relPath);
            const rightFullPath = path.join(resolvedRight, relPath);
            
            const leftHash = getFileHash(leftFullPath);
            const rightHash = getFileHash(rightFullPath);

            if (leftHash !== rightHash) {
              status = 'modified';
            }
          }
        }

        compared.push({
          relativePath: relPath,
          name: leftFile.name,
          isDirectory: false,
          status,
          newerSide,
          timeDiffStr,
          left: leftFile,
          right: rightFile,
        });
      }
    }

    // Set up file watchers
    setupWatchers(resolvedLeft, resolvedRight);

    res.json({
      leftPath: resolvedLeft,
      rightPath: resolvedRight,
      files: compared,
    });
  } catch (error) {
    console.error('Error during comparison scan:', error);
    res.status(500).json({ error: 'Internal server error scanning folders.' });
  }
});

// API Route: Hashing file content on-demand
app.post('/api/hash', (req, res) => {
  const { filePath } = req.body;
  if (!filePath) {
    return res.status(400).json({ error: 'filePath is required.' });
  }
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    return res.status(404).json({ error: 'File not found.' });
  }
  const hash = getFileHash(resolved);
  if (!hash) {
    return res.status(500).json({ error: 'Failed to compute hash.' });
  }
  res.json({ hash });
});

// API Route: Compute differences for text files side-by-side
app.post('/api/diff', (req, res) => {
  const { leftPath, rightPath, relativePath } = req.body;
  if (!leftPath || !rightPath || !relativePath) {
    return res.status(400).json({ error: 'leftPath, rightPath and relativePath are required.' });
  }
  const fullLeft = path.resolve(path.join(leftPath, relativePath));
  const fullRight = path.resolve(path.join(rightPath, relativePath));

  let leftText = '';
  let rightText = '';

  try {
    if (fs.existsSync(fullLeft)) {
      leftText = fs.readFileSync(fullLeft, 'utf8');
    }
  } catch (err) {
    return res.status(500).json({ error: `Failed to read left file: ${err.message}` });
  }

  try {
    if (fs.existsSync(fullRight)) {
      rightText = fs.readFileSync(fullRight, 'utf8');
    }
  } catch (err) {
    return res.status(500).json({ error: `Failed to read right file: ${err.message}` });
  }

  try {
    const chunks = diff.diffLines(leftText, rightText);
    const rows = [];
    let leftLineNum = 1;
    let rightLineNum = 1;

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const lines = chunk.value.split(/\r?\n/);
      if (lines[lines.length - 1] === '') {
        lines.pop();
      }

      if (!chunk.added && !chunk.removed) {
        for (const line of lines) {
          rows.push({
            left: { lineNum: leftLineNum++, text: line, type: 'unchanged' },
            right: { lineNum: rightLineNum++, text: line, type: 'unchanged' }
          });
        }
      } else if (chunk.removed) {
        const nextChunk = chunks[i + 1];
        if (nextChunk && nextChunk.added) {
          const addedLines = nextChunk.value.split(/\r?\n/);
          if (addedLines[addedLines.length - 1] === '') {
            addedLines.pop();
          }
          const maxLines = Math.max(lines.length, addedLines.length);
          for (let j = 0; j < maxLines; j++) {
            rows.push({
              left: j < lines.length ? { lineNum: leftLineNum++, text: lines[j], type: 'removed' } : null,
              right: j < addedLines.length ? { lineNum: rightLineNum++, text: addedLines[j], type: 'added' } : null
            });
          }
          i++; // skip added chunk
        } else {
          for (const line of lines) {
            rows.push({
              left: { lineNum: leftLineNum++, text: line, type: 'removed' },
              right: null
            });
          }
        }
      } else if (chunk.added) {
        for (const line of lines) {
          rows.push({
            left: null,
            right: { lineNum: rightLineNum++, text: line, type: 'added' }
          });
        }
      }
    }

    res.json({ rows });
  } catch (err) {
    console.error('Diff error:', err);
    res.status(500).json({ error: 'Failed to compute diff' });
  }
});

// API Route: Manual file synchronization
app.post('/api/sync', (req, res) => {
  const { leftPath, rightPath, relativePath, action } = req.body;
  if (!leftPath || !rightPath || !relativePath || !action) {
    return res.status(400).json({ error: 'leftPath, rightPath, relativePath, and action are required.' });
  }

  const resolvedLeft = path.resolve(leftPath);
  const resolvedRight = path.resolve(rightPath);
  const fileLeft = path.join(resolvedLeft, relativePath);
  const fileRight = path.join(resolvedRight, relativePath);

  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    
    // Initialize transaction details
    const tx = {
      action,
      relativePath,
      leftPath: resolvedLeft,
      rightPath: resolvedRight,
      backups: []
    };

    if (action === 'keepLeft') {
      if (!fs.existsSync(fileLeft)) {
        return res.status(400).json({ error: 'Left file does not exist to sync.' });
      }
      
      if (fs.existsSync(fileRight)) {
        const backupName = crypto.randomBytes(16).toString('hex');
        const backupPath = path.join(BACKUP_DIR, backupName);
        fs.copyFileSync(fileRight, backupPath);
        tx.backups.push({ path: fileRight, backupPath, type: 'overwrite' });
      } else {
        tx.backups.push({ path: fileRight, type: 'create' });
      }

      fs.mkdirSync(path.dirname(fileRight), { recursive: true });
      fs.copyFileSync(fileLeft, fileRight);

    } else if (action === 'keepRight') {
      if (!fs.existsSync(fileRight)) {
        return res.status(400).json({ error: 'Right file does not exist to sync.' });
      }

      if (fs.existsSync(fileLeft)) {
        const backupName = crypto.randomBytes(16).toString('hex');
        const backupPath = path.join(BACKUP_DIR, backupName);
        fs.copyFileSync(fileLeft, backupPath);
        tx.backups.push({ path: fileLeft, backupPath, type: 'overwrite' });
      } else {
        tx.backups.push({ path: fileLeft, type: 'create' });
      }

      fs.mkdirSync(path.dirname(fileLeft), { recursive: true });
      fs.copyFileSync(fileRight, fileLeft);

    } else if (action === 'deleteLeft') {
      if (fs.existsSync(fileLeft)) {
        const backupName = crypto.randomBytes(16).toString('hex');
        const backupPath = path.join(BACKUP_DIR, backupName);
        fs.copyFileSync(fileLeft, backupPath);
        tx.backups.push({ path: fileLeft, backupPath, type: 'delete' });
        fs.unlinkSync(fileLeft);
      }

    } else if (action === 'deleteRight') {
      if (fs.existsSync(fileRight)) {
        const backupName = crypto.randomBytes(16).toString('hex');
        const backupPath = path.join(BACKUP_DIR, backupName);
        fs.copyFileSync(fileRight, backupPath);
        tx.backups.push({ path: fileRight, backupPath, type: 'delete' });
        fs.unlinkSync(fileRight);
      }
    } else {
      return res.status(400).json({ error: `Invalid action: ${action}` });
    }

    lastTransaction = tx;
    res.json({ success: true });
  } catch (error) {
    console.error('Sync action error:', error);
    res.status(500).json({ error: `Failed to execute sync action: ${error.message}` });
  }
});

// API Route: Undo last transaction
app.post('/api/undo', (req, res) => {
  if (!lastTransaction) {
    return res.status(400).json({ error: 'No transaction available to undo.' });
  }

  try {
    // Process backups in reverse order
    for (const backup of [...lastTransaction.backups].reverse()) {
      if (backup.type === 'overwrite' || backup.type === 'delete') {
        fs.mkdirSync(path.dirname(backup.path), { recursive: true });
        fs.copyFileSync(backup.backupPath, backup.path);
        try {
          fs.unlinkSync(backup.backupPath);
        } catch (e) {
          console.warn(`Could not delete backup file ${backup.backupPath}:`, e);
        }
      } else if (backup.type === 'create') {
        if (fs.existsSync(backup.path)) {
          fs.unlinkSync(backup.path);
        }
      }
    }

    lastTransaction = null;
    res.json({ success: true });
  } catch (error) {
    console.error('Undo action error:', error);
    res.status(500).json({ error: `Failed to undo transaction: ${error.message}` });
  }
});

// API Route: SSE Watcher
app.get('/api/watch', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });
  res.write('\n'); // keep-alive comment

  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
});

app.listen(PORT, () => {
  console.log(`Comparer Server running locally at http://localhost:${PORT}`);
});
