// Preload — the thin bridge. Runs with contextIsolation, so the renderer never
// sees Node. It exposes exactly the methods in the IPC contract as
// ipcRenderer.invoke wrappers and nothing else (no fs, no child_process, no raw
// ipcRenderer). Each invoke returns the main process's { ok, data } / { ok, error }
// envelope; the unwrap() helper turns failures back into thrown Errors so the
// renderer's existing try/catch logic is unchanged.

const { contextBridge, ipcRenderer } = require('electron');

async function invoke(channel, ...args) {
  const res = await ipcRenderer.invoke(channel, ...args);
  if (res && res.ok) return res.data;
  throw new Error((res && res.error) || 'Unknown error');
}

contextBridge.exposeInMainWorld('comparer', {
  scan: (opts) => invoke('comparer:scan', opts),
  hash: (opts) => invoke('comparer:hash', opts),
  diff: (opts) => invoke('comparer:diff', opts),
  sync: (opts) => invoke('comparer:sync', opts),
  undo: () => invoke('comparer:undo'),
  ignoreTest: (opts) => invoke('comparer:ignore-test', opts),

  getSessions: () => invoke('comparer:sessions:get'),
  setSessions: (list) => invoke('comparer:sessions:set', list),
  exportSessions: () => invoke('comparer:sessions:export'),
  importSessions: () => invoke('comparer:sessions:import'),

  readAsset: (name) => invoke('comparer:read-asset', name),

  startWatch: (opts) => invoke('comparer:watch:start', opts),
  stopWatch: () => invoke('comparer:watch:stop'),

  // Subscribe to pushed watch events. Returns an unsubscribe function. The
  // payload shape matches the old SSE event ({ event, relativePath, side }).
  onWatch: (cb) => {
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on('comparer:watch:event', listener);
    return () => ipcRenderer.removeListener('comparer:watch:event', listener);
  },
});
