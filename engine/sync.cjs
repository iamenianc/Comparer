// Sync + undo engine. Extracted from server.js routes /api/sync and /api/undo.
//
// lastTransaction lives here in the main process: a single window means a single
// in-memory transaction with the same "undo most recent" semantics as the
// server had. Backups go to a temp dir, cleared on startup and process exit.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { safeJoin } = require('./diff.cjs');

const BACKUP_DIR = path.join(os.tmpdir(), '.comparer-backups');

// Single in-memory transaction (most recent sync), used by undo().
let lastTransaction = null;

function clearBackupDir() {
  try {
    if (fs.existsSync(BACKUP_DIR)) {
      fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
    }
  } catch (err) {
    console.error('Failed to clear backup directory:', err);
  }
}

// Apply a sync action for one file pair. Throws Error with `.status` on bad
// input. Returns the resolved paths touched (for the caller's audit log).
function sync({ leftPath, rightPath, relativePath, action }) {
  if (!leftPath || !rightPath || !relativePath || !action) {
    const e = new Error('leftPath, rightPath, relativePath, and action are required.');
    e.status = 400;
    throw e;
  }

  const resolvedLeft = path.resolve(leftPath);
  const resolvedRight = path.resolve(rightPath);
  const fileLeft = safeJoin(resolvedLeft, relativePath);
  const fileRight = safeJoin(resolvedRight, relativePath);
  if (!fileLeft || !fileRight) {
    const e = new Error('Invalid relativePath: path traversal is not allowed.');
    e.status = 400;
    throw e;
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const tx = {
    action,
    relativePath,
    leftPath: resolvedLeft,
    rightPath: resolvedRight,
    backups: [],
  };

  if (action === 'keepLeft') {
    if (!fs.existsSync(fileLeft)) {
      const e = new Error('Left file does not exist to sync.');
      e.status = 400;
      throw e;
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
      const e = new Error('Right file does not exist to sync.');
      e.status = 400;
      throw e;
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
    const e = new Error(`Invalid action: ${action}`);
    e.status = 400;
    throw e;
  }

  lastTransaction = tx;

  return {
    success: true,
    resolvedPaths: tx.backups.map((b) => b.path),
  };
}

// Reverse the most recent sync. Throws Error with `.status` if none exists.
function undo() {
  if (!lastTransaction) {
    const e = new Error('No transaction available to undo.');
    e.status = 400;
    throw e;
  }

  const restored = [];

  // Process backups in reverse order.
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
    restored.push(backup.path);
  }

  lastTransaction = null;

  return { success: true, resolvedPaths: restored };
}

module.exports = { sync, undo, clearBackupDir, BACKUP_DIR };
