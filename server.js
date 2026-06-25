import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import os from 'os';
import chokidar from 'chokidar';
import * as diff from 'diff';
import { exec } from 'child_process';


// Detect a packaged build (Node SEA or pkg). In a SEA the `node:sea` module's
// isSea() returns true; pkg sets process.pkg.
let isSea = false;
try { isSea = !!(globalThis.require?.('node:sea')?.isSea?.()); } catch (e) { /* not SEA */ }
const isPackaged = !!process.pkg || isSea;

// `import.meta.url` is empty when this file is bundled to CJS for SEA, so guard
// the conversion. When packaged, assets ship alongside the executable rather
// than next to this source file — resolve `public/` against the binary dir.
const __filename = import.meta.url ? fileURLToPath(import.meta.url) : process.execPath;
const __dirname = path.dirname(__filename);
const assetRoot = isPackaged ? path.dirname(process.execPath) : __dirname;
const publicPath = path.join(assetRoot, 'public');

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Glob ignore filtering (single source of truth for both scan and watch)
// ---------------------------------------------------------------------------

// Default patterns applied on every scan, merged with any user-supplied list.
const DEFAULT_IGNORES = ['**/.git', '**/node_modules', '**/Thumbs.db', '**/.DS_Store', '**/dist'];

// Convert a small glob subset (`*`, `**`, `?`, literal segments) into an
// anchored RegExp. Paths are normalized to forward slashes before matching so
// Windows `\` separators compare correctly. A pattern matches the entry itself
// and any descendant (so `**/node_modules` also ignores everything beneath it).
function globToRegExp(pattern) {
  const normalized = pattern.replace(/\\/g, '/').replace(/\/+$/, '');
  let re = '';
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized[i];
    if (c === '*') {
      if (normalized[i + 1] === '*') {
        // `**` matches across path separators (zero or more segments)
        re += '.*';
        i++;
        // swallow a following slash so `**/foo` also matches a root `foo`
        if (normalized[i + 1] === '/') i++;
      } else {
        // single `*` matches within one path segment
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  // Anchor: match the whole path, or the path followed by `/...` (descendants).
  return new RegExp(`^(?:${re})(?:/.*)?$`);
}

function compileGlobs(patterns) {
  return (patterns || []).filter(Boolean).map(globToRegExp);
}

// Test a forward-slash relative path against compiled patterns.
function isIgnored(relativePath, compiledPatterns) {
  const rel = relativePath.replace(/\\/g, '/');
  return compiledPatterns.some((re) => re.test(rel));
}

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

// Helper to manage watchers. `ignorePatterns` is the merged (default + user)
// glob list — the same list fed to the scan, so live events and scans never drift.
function setupWatchers(leftPath, rightPath, ignorePatterns = DEFAULT_IGNORES) {
  // Clear previous watchers
  for (const watcher of activeWatchers) {
    try {
      watcher.close();
    } catch (e) {
      console.error('Error closing watcher:', e);
    }
  }
  activeWatchers = [];

  const compiled = compileGlobs(ignorePatterns);

  // chokidar passes absolute paths; convert to a base-relative path before
  // testing against the same isIgnored() the scan uses.
  const makeIgnoreFn = (baseDir) => (testPath) => {
    const rel = path.relative(baseDir, testPath).replace(/\\/g, '/');
    if (!rel || rel.startsWith('..')) return false; // never ignore the root itself
    return isIgnored(rel, compiled);
  };

  const leftWatcher = chokidar.watch(leftPath, {
    ignored: makeIgnoreFn(leftPath),
    persistent: true,
    ignoreInitial: true,
  });
  const rightWatcher = chokidar.watch(rightPath, {
    ignored: makeIgnoreFn(rightPath),
    persistent: true,
    ignoreInitial: true,
  });

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

// Helper: Safely join a user-supplied relativePath onto a resolved base dir,
// rejecting any `..` traversal that would escape the base. Returns the absolute
// path, or null if the result falls outside `baseDir`.
function safeJoin(baseDir, relativePath) {
  const resolvedBase = path.resolve(baseDir);
  const target = path.resolve(resolvedBase, relativePath);
  const rel = path.relative(resolvedBase, target);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    return target;
  }
  return null;
}

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

// Helper: Recursively scan a folder and gather file details.
// `compiledIgnores` is a list of compiled glob RegExps; entries (and their
// subtrees) matching any of them are skipped before any stat / MD5 work,
// which is the main performance win for large trees like node_modules.
function scanDirectory(dirPath, recursive = true, baseDir = dirPath, compiledIgnores = []) {
  let results = {};
  if (!fs.existsSync(dirPath)) return results;

  const stats = fs.statSync(dirPath);
  if (!stats.isDirectory()) return results;

  const files = fs.readdirSync(dirPath);
  for (const file of files) {
    const fullPath = path.join(dirPath, file);
    const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');

    // Skip ignored entries (and their subtrees) before stat-ing or recursing.
    if (isIgnored(relativePath, compiledIgnores)) continue;

    const fileStats = fs.statSync(fullPath);

    if (fileStats.isDirectory()) {
      if (recursive) {
        const subFiles = scanDirectory(fullPath, recursive, baseDir, compiledIgnores);
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
  const { leftPath, rightPath, recursive = true, ignore = [] } = req.body;

  // Merge user globs with server defaults; dedupe to keep the compiled list lean.
  const mergedIgnores = [...new Set([...DEFAULT_IGNORES, ...(Array.isArray(ignore) ? ignore : [])])];
  const compiledIgnores = compileGlobs(mergedIgnores);

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
    const leftFiles = scanDirectory(resolvedLeft, recursive, resolvedLeft, compiledIgnores);
    const rightFiles = scanDirectory(resolvedRight, recursive, resolvedRight, compiledIgnores);

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

    // Set up file watchers with the same merged ignore list (no scan/watch drift)
    setupWatchers(resolvedLeft, resolvedRight, mergedIgnores);

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
  const fullLeft = safeJoin(leftPath, relativePath);
  const fullRight = safeJoin(rightPath, relativePath);
  if (!fullLeft || !fullRight) {
    return res.status(400).json({ error: 'Invalid relativePath: path traversal is not allowed.' });
  }

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
  const fileLeft = safeJoin(resolvedLeft, relativePath);
  const fileRight = safeJoin(resolvedRight, relativePath);
  if (!fileLeft || !fileRight) {
    return res.status(400).json({ error: 'Invalid relativePath: path traversal is not allowed.' });
  }

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
  const url = `http://localhost:${PORT}`;
  console.log(`Comparer Server running locally at ${url}`);

  // Auto-open the default browser so non-technical staff can just double-click
  // the packaged exe. Suppress with COMPARER_NO_OPEN=1 for dev runs. The empty
  // "" title arg keeps Windows `start` from mis-parsing the URL as a window title.
  if (!process.env.COMPARER_NO_OPEN) {
    const opener =
      process.platform === 'win32' ? `start "" "${url}"`
      : process.platform === 'darwin' ? `open "${url}"`
      : `xdg-open "${url}"`;
    exec(opener, (err) => {
      if (err) console.warn('Could not auto-open browser:', err.message);
    });
  }
});
