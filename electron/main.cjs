// Electron main process — the trusted host. Replaces the Express server.
//
// Trust boundary: the renderer (public/) is treated as untrusted and runs
// sandboxed with context isolation; preload.cjs is a thin contextBridge; this
// file is the only place with fs/crypto/child access. Every renderer request
// arrives as an ipcMain.handle call on one of the channels in the IPC contract
// (docs/SECURITY.md) — that list is the entire attack surface.

const { app, BrowserWindow, ipcMain, session, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

const scanEngine = require('../engine/scan.cjs');
const diffEngine = require('../engine/diff.cjs');
const syncEngine = require('../engine/sync.cjs');
const sessionsEngine = require('../engine/sessions.cjs');
const watchEngine = require('../engine/watch.cjs');

const publicPath = path.join(__dirname, '..', 'public');

// Content-Security-Policy applied to every response served to the renderer.
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'";

let mainWindow = null;

// ---------------------------------------------------------------------------
// Audit log: append one JSON line per sync/undo under userData.
// ---------------------------------------------------------------------------
function auditLogPath() {
  return path.join(app.getPath('userData'), 'audit.log');
}

function appendAudit(action, resolvedPaths) {
  try {
    const entry = JSON.stringify({ timestamp: new Date().toISOString(), action, resolvedPaths });
    fs.appendFileSync(auditLogPath(), entry + '\n', 'utf8');
  } catch (err) {
    console.error('Failed to write audit log:', err);
  }
}

// ---------------------------------------------------------------------------
// IPC handler helper: wrap each engine call so we never throw a raw error (or a
// stack trace) across the bridge. Returns { ok:true, data } / { ok:false, error }.
// ---------------------------------------------------------------------------
function handle(channel, fn) {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      const data = await fn(...args);
      return { ok: true, data };
    } catch (err) {
      // Only the message crosses the boundary, never the stack.
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  });
}

// Validate that a value is a non-empty string.
function requireString(value, name) {
  if (typeof value !== 'string' || !value) {
    const e = new Error(`${name} must be a non-empty string.`);
    e.status = 400;
    throw e;
  }
  return value;
}

function registerIpc() {
  handle('comparer:scan', (opts) => {
    if (!opts || typeof opts !== 'object') throw new Error('scan options object is required.');
    return scanEngine.scan({
      leftPath: opts.leftPath,
      rightPath: opts.rightPath,
      recursive: opts.recursive !== false,
      ignore: Array.isArray(opts.ignore) ? opts.ignore : [],
    });
  });

  handle('comparer:hash', (opts) => {
    const filePath = requireString(opts && opts.filePath, 'filePath');
    const resolved = path.resolve(filePath);
    if (!fs.existsSync(resolved)) {
      const e = new Error('File not found.');
      e.status = 404;
      throw e;
    }
    const hash = diffEngine.hashFile(resolved);
    if (!hash) throw new Error('Failed to compute hash.');
    return { hash };
  });

  handle('comparer:diff', (opts) => {
    if (!opts || typeof opts !== 'object') throw new Error('diff options object is required.');
    return diffEngine.computeDiff(opts);
  });

  handle('comparer:sync', (opts) => {
    if (!opts || typeof opts !== 'object') throw new Error('sync options object is required.');
    const result = syncEngine.sync(opts);
    appendAudit(opts.action, result.resolvedPaths);
    return { success: true };
  });

  handle('comparer:undo', () => {
    const result = syncEngine.undo();
    appendAudit('undo', result.resolvedPaths);
    return { success: true };
  });

  handle('comparer:ignore-test', (opts) => {
    if (!opts || typeof opts !== 'object') throw new Error('ignore-test options object is required.');
    return scanEngine.ignoreTest(opts);
  });

  handle('comparer:sessions:get', () => sessionsEngine.getSessions());

  handle('comparer:sessions:set', (list) => sessionsEngine.setSessions(list));

  // Export/import preserve the old "team sessions in a shared folder" workflow
  // now that the store lives in userData. Each opens a native file dialog.
  handle('comparer:sessions:export', async () => {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title: 'Export sessions',
      defaultPath: 'comparer-sessions.json',
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return { canceled: true };
    return sessionsEngine.exportSessions(filePath);
  });

  handle('comparer:sessions:import', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title: 'Import sessions',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePaths || !filePaths[0]) return { canceled: true };
    return sessionsEngine.importSessions(filePaths[0]);
  });

  // Read a known static asset (used by the HTML export to inline style.css).
  // Restricted to a basename within public/ — no traversal, no arbitrary read.
  handle('comparer:read-asset', (name) => {
    requireString(name, 'asset name');
    if (path.basename(name) !== name) {
      const e = new Error('Invalid asset name.');
      e.status = 400;
      throw e;
    }
    const target = path.join(publicPath, name);
    return { content: fs.readFileSync(target, 'utf8') };
  });

  handle('comparer:watch:start', async (opts) => {
    if (!opts || typeof opts !== 'object') throw new Error('watch options object is required.');
    const leftPath = requireString(opts.leftPath, 'leftPath');
    const rightPath = requireString(opts.rightPath, 'rightPath');
    const ignore = Array.isArray(opts.ignore) ? opts.ignore : undefined;
    await watchEngine.startWatch(leftPath, rightPath, ignore, (evt) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('comparer:watch:event', evt);
      }
    });
    return { started: true };
  });

  handle('comparer:watch:stop', () => {
    watchEngine.stopWatch();
    return { stopped: true };
  });
}

// ---------------------------------------------------------------------------
// Window + lockdown
// ---------------------------------------------------------------------------
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });

  // Enforce CSP at the network layer (belt-and-suspenders with the <meta> tag).
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [CSP],
      },
    });
  });

  const wc = mainWindow.webContents;

  // Block all in-page navigation away from the bundled app.
  wc.on('will-navigate', (e) => e.preventDefault());

  // Deny popups/new windows; route any external (http/https/mailto) link to the
  // system browser via an allowlist check instead.
  wc.setWindowOpenHandler(({ url }) => {
    openExternalAllowed(url);
    return { action: 'deny' };
  });

  mainWindow.loadFile(path.join(publicPath, 'index.html'));

  mainWindow.on('closed', () => {
    watchEngine.stopWatch();
    mainWindow = null;
  });
}

// Only open vetted external schemes in the system browser.
function openExternalAllowed(url) {
  try {
    const parsed = new URL(url);
    if (['https:', 'mailto:'].includes(parsed.protocol)) {
      shell.openExternal(url);
    }
  } catch {
    /* malformed URL — ignore */
  }
}

// Sandbox must be enabled before the app is ready.
app.enableSandbox();

app.whenReady().then(() => {
  // Point the sessions store at userData (Electron has no meaningful cwd).
  sessionsEngine.setSessionsFile(path.join(app.getPath('userData'), 'sessions.json'));
  syncEngine.clearBackupDir();
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  watchEngine.stopWatch();
  syncEngine.clearBackupDir();
  if (process.platform !== 'darwin') app.quit();
});

app.on('quit', () => syncEngine.clearBackupDir());

// Exposed for the end-to-end probe harness (tests/). Not used by the app itself.
module.exports = { getMainWindow: () => mainWindow };
