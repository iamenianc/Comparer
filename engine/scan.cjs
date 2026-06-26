// Scan + compare engine. Extracted from server.js route /api/scan.
//
// scan() returns the same JSON shape the HTTP route produced (folder mode:
// { leftPath, rightPath, files }, file-pair mode adds filePairMode:true), so the
// renderer's grid code is unchanged. No watchers are started here — the caller
// (main process) owns watcher lifecycle via engine/watch.cjs.

const fs = require('fs');
const path = require('path');
const { DEFAULT_IGNORES, compileGlobs, isIgnored } = require('./globs.cjs');
const { hashFile } = require('./diff.cjs');

// Format millisecond difference to a concise tag (e.g. +2h, +3d, +5s).
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

// Recursively scan a folder and gather file details. `compiledIgnores` is a list
// of compiled glob RegExps; matching entries (and their subtrees) are skipped
// before any stat / MD5 work.
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

// Build a file-stat object (same shape scanDirectory produces) for one file.
function statFile(fullPath) {
  const s = fs.statSync(fullPath);
  return {
    relativePath: path.basename(fullPath),
    name: path.basename(fullPath),
    fullPath,
    size: s.size,
    mtimeMs: s.mtimeMs,
    mtime: s.mtime.toISOString(),
    isDirectory: false,
  };
}

// Compare two explicit files (possibly with different names), paired by side.
function compareTwoFiles(leftFull, rightFull) {
  const left = statFile(leftFull);
  const right = statFile(rightFull);

  let status = 'identical';
  let newerSide = null;
  let timeDiffStr = '';

  const timeDiffMs = left.mtimeMs - right.mtimeMs;
  if (timeDiffMs > 0) { newerSide = 'left'; timeDiffStr = formatDuration(timeDiffMs); }
  else if (timeDiffMs < 0) { newerSide = 'right'; timeDiffStr = formatDuration(-timeDiffMs); }

  if (left.size !== right.size) {
    status = 'modified';
  } else if (hashFile(leftFull) !== hashFile(rightFull)) {
    status = 'modified';
  }

  const pairId = `${left.name} ↔ ${right.name}`;

  return {
    leftPath: leftFull,
    rightPath: rightFull,
    filePairMode: true,
    files: [{
      relativePath: pairId,
      name: left.name,
      rightName: right.name,
      isDirectory: false,
      status,
      newerSide,
      timeDiffStr,
      left,
      right,
      leftFile: leftFull,
      rightFile: rightFull,
    }],
  };
}

// Classify a path: 'folder' | 'file' | 'missing'.
function classify(p) {
  if (!fs.existsSync(p)) return 'missing';
  return fs.statSync(p).isDirectory() ? 'folder' : 'file';
}

// Scan + compare two paths. Throws Error with `.status` hint on invalid input.
// Returns { leftPath, rightPath, files, mergedIgnores } in folder mode (the
// caller uses mergedIgnores to set up watchers with the identical list), or the
// compareTwoFiles shape in file-pair mode.
function scan({ leftPath, rightPath, recursive = true, ignore = [] }) {
  const mergedIgnores = [...new Set([...DEFAULT_IGNORES, ...(Array.isArray(ignore) ? ignore : [])])];
  const compiledIgnores = compileGlobs(mergedIgnores);

  if (!leftPath || !rightPath) {
    const e = new Error('Both leftPath and rightPath are required.');
    e.status = 400;
    throw e;
  }

  const resolvedLeft = path.resolve(leftPath);
  const resolvedRight = path.resolve(rightPath);

  const leftKind = classify(resolvedLeft);
  const rightKind = classify(resolvedRight);

  if (leftKind === 'missing') {
    const e = new Error(`Left path does not exist: ${leftPath}`);
    e.status = 400;
    throw e;
  }
  if (rightKind === 'missing') {
    const e = new Error(`Right path does not exist: ${rightPath}`);
    e.status = 400;
    throw e;
  }

  // Mixed (one file, one folder) is ambiguous — reject with a clear message.
  if (leftKind !== rightKind) {
    const fileSide = leftKind === 'file' ? 'Left' : 'Right';
    const folderSide = leftKind === 'folder' ? 'Left' : 'Right';
    const e = new Error(`${fileSide} is a file and ${folderSide} is a folder. Point both to folders, or both to files.`);
    e.status = 400;
    throw e;
  }

  // Both sides are files — return a single file-vs-file comparison row.
  if (leftKind === 'file') {
    return compareTwoFiles(resolvedLeft, resolvedRight);
  }

  const leftFiles = scanDirectory(resolvedLeft, recursive, resolvedLeft, compiledIgnores);
  const rightFiles = scanDirectory(resolvedRight, recursive, resolvedRight, compiledIgnores);

  const allPaths = new Set([...Object.keys(leftFiles), ...Object.keys(rightFiles)]);
  const compared = [];

  for (const relPath of allPaths) {
    const leftFile = leftFiles[relPath];
    const rightFile = rightFiles[relPath];

    if (leftFile && !rightFile) {
      compared.push({
        relativePath: relPath,
        name: leftFile.name,
        isDirectory: leftFile.isDirectory,
        status: 'left-only',
        left: leftFile,
        right: null,
      });
    } else if (!leftFile && rightFile) {
      compared.push({
        relativePath: relPath,
        name: rightFile.name,
        isDirectory: rightFile.isDirectory,
        status: 'right-only',
        left: null,
        right: rightFile,
      });
    } else if (leftFile.isDirectory && rightFile.isDirectory) {
      compared.push({
        relativePath: relPath,
        name: leftFile.name,
        isDirectory: true,
        status: 'identical',
        left: leftFile,
        right: rightFile,
      });
    } else {
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

      if (leftFile.size !== rightFile.size) {
        status = 'modified';
      } else {
        if (timeDiffMs !== 0) {
          const leftFullPath = path.join(resolvedLeft, relPath);
          const rightFullPath = path.join(resolvedRight, relPath);

          const leftHash = hashFile(leftFullPath);
          const rightHash = hashFile(rightFullPath);

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

  return {
    leftPath: resolvedLeft,
    rightPath: resolvedRight,
    files: compared,
    mergedIgnores,
  };
}

// Preview which files a single ignore pattern would exclude. Read-only.
function ignoreTest({ leftPath, rightPath, recursive = true, pattern }) {
  if (!pattern || typeof pattern !== 'string' || !pattern.trim()) {
    const e = new Error('A non-empty pattern is required.');
    e.status = 400;
    throw e;
  }
  if (!leftPath || !rightPath) {
    const e = new Error('Both leftPath and rightPath are required.');
    e.status = 400;
    throw e;
  }

  const compiled = compileGlobs([pattern.trim()]);
  const MAX_MATCHES = 500;
  const matches = [];
  let total = 0;

  const collect = (rootPath, side) => {
    const resolved = path.resolve(rootPath);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return;
    const entries = scanDirectory(resolved, recursive, resolved, []);
    for (const relativePath of Object.keys(entries)) {
      if (isIgnored(relativePath, compiled)) {
        total++;
        if (matches.length < MAX_MATCHES) matches.push({ side, relativePath });
      }
    }
  };

  collect(leftPath, 'left');
  collect(rightPath, 'right');

  return {
    pattern: pattern.trim(),
    count: total,
    matches,
    truncated: total > matches.length,
  };
}

module.exports = { scan, scanDirectory, classify, ignoreTest, compareTwoFiles, formatDuration };
