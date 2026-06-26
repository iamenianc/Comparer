// Diff + hashing engine. Extracted from server.js routes /api/diff and /api/hash.
//
// computeDiff() returns the same { rows, unified } shape the HTTP route produced,
// so the renderer's rendering code is unchanged. The path-traversal guard from
// the route is re-validated here regardless of caller (defense in depth).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const diff = require('diff');

// Safely join a user-supplied relativePath onto a resolved base dir, rejecting
// any `..` traversal that would escape the base. Returns the absolute path, or
// null if the result falls outside `baseDir`.
function safeJoin(baseDir, relativePath) {
  const resolvedBase = path.resolve(baseDir);
  const target = path.resolve(resolvedBase, relativePath);
  const rel = path.relative(resolvedBase, target);
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    return target;
  }
  return null;
}

// MD5 hash of file content. Returns null on error (matches server.js semantics).
function hashFile(filePath) {
  try {
    const fileBuffer = fs.readFileSync(filePath);
    return crypto.createHash('md5').update(fileBuffer).digest('hex');
  } catch (error) {
    console.error(`Error hashing file: ${filePath}`, error);
    return null;
  }
}

// Compute side-by-side and unified diffs for a file pair. Accepts either:
//   - file-pair mode: { leftFile, rightFile } absolute paths, or
//   - folder mode:    { leftPath, rightPath, relativePath } joined under each root.
// Throws an Error with a `.status` hint for the IPC handler to surface.
function computeDiff({ leftPath, rightPath, relativePath, leftFile, rightFile }) {
  let fullLeft, fullRight;

  // File-pair mode: two explicit (possibly differently-named) file paths.
  if (leftFile || rightFile) {
    if (!leftFile || !rightFile) {
      const e = new Error('Both leftFile and rightFile are required in file-pair mode.');
      e.status = 400;
      throw e;
    }
    fullLeft = path.resolve(leftFile);
    fullRight = path.resolve(rightFile);
  } else {
    // Folder mode: a shared relativePath joined to each root.
    if (!leftPath || !rightPath || !relativePath) {
      const e = new Error('leftPath, rightPath and relativePath are required.');
      e.status = 400;
      throw e;
    }
    fullLeft = safeJoin(leftPath, relativePath);
    fullRight = safeJoin(rightPath, relativePath);
    if (!fullLeft || !fullRight) {
      const e = new Error('Invalid relativePath: path traversal is not allowed.');
      e.status = 400;
      throw e;
    }
  }

  let leftText = '';
  let rightText = '';

  if (fs.existsSync(fullLeft)) {
    leftText = fs.readFileSync(fullLeft, 'utf8');
  }
  if (fs.existsSync(fullRight)) {
    rightText = fs.readFileSync(fullRight, 'utf8');
  }

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

  // Unified-diff view (git-style), generated with the same `diff` library.
  // structuredPatch gives correct @@ hunk headers and context grouping.
  const leftLabel = path.basename(fullLeft);
  const rightLabel = path.basename(fullRight);
  const patch = diff.structuredPatch(leftLabel, rightLabel, leftText, rightText, '', '', { context: 3 });
  const unified = [];
  for (const hunk of patch.hunks) {
    unified.push({ type: 'hunk', text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@` });
    for (const line of hunk.lines) {
      const c = line[0];
      const type = c === '+' ? 'added' : c === '-' ? 'removed' : 'context';
      unified.push({ type, text: line });
    }
  }

  return { rows, unified };
}

module.exports = { computeDiff, hashFile, safeJoin };
