// Filesystem watcher engine. Extracted from server.js setupWatchers / the SSE
// /api/watch route.
//
// startWatch() takes an onEvent callback and invokes it with the same event
// object shape the SSE stream emitted ({ event, relativePath, side }) so the
// renderer's watch handler is unchanged. Returns a stop() function. Uses the same
// merged ignore list the scan used, so live events and scans never drift.

const path = require('path');
const { DEFAULT_IGNORES, compileGlobs, isIgnored } = require('./globs.cjs');

// chokidar v5 is ESM-only, so it can't be require()'d from this CommonJS module.
// Load it once via dynamic import() (available in CJS) and cache the promise.
let chokidarPromise = null;
function getChokidar() {
  if (!chokidarPromise) {
    chokidarPromise = import('chokidar').then((m) => m.default || m);
  }
  return chokidarPromise;
}

let activeWatchers = [];

// Close any currently-running watchers.
function stopWatch() {
  for (const watcher of activeWatchers) {
    try {
      watcher.close();
    } catch (e) {
      console.error('Error closing watcher:', e);
    }
  }
  activeWatchers = [];
}

// Start watching both roots. `ignorePatterns` is the merged (default + user)
// glob list. `onEvent({ event, relativePath, side })` is called for every change.
async function startWatch(leftPath, rightPath, ignorePatterns = DEFAULT_IGNORES, onEvent = () => {}) {
  stopWatch();

  const chokidar = await getChokidar();
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
    const baseDir = side === 'left' ? leftPath : rightPath;
    const relPath = path.relative(baseDir, filePath).replace(/\\/g, '/');
    onEvent({ event, relativePath: relPath, side });
  };

  leftWatcher.on('all', (event, filePath) => handleEvent(event, filePath, 'left'));
  rightWatcher.on('all', (event, filePath) => handleEvent(event, filePath, 'right'));

  leftWatcher.on('error', (error) => console.error('Left Watcher Error (ignored):', error.message || error));
  rightWatcher.on('error', (error) => console.error('Right Watcher Error (ignored):', error.message || error));

  activeWatchers.push(leftWatcher, rightWatcher);

  return stopWatch;
}

module.exports = { startWatch, stopWatch };
