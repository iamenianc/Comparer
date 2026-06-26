// Team sessions store (disk-backed). Extracted from server.js routes
// GET/POST /api/sessions.
//
// Under Electron there is no meaningful cwd, so the storage location is injected
// by the main process (app.getPath('userData')). setSessionsFile() must be called
// once at startup; until then it falls back to a cwd-relative path so the module
// stays runnable standalone (e.g. in tests).

const fs = require('fs');
const path = require('path');

let sessionsDir = path.join(process.cwd(), '.comparer');
let sessionsFile = path.join(sessionsDir, 'sessions.json');

// Point the store at an explicit file (main process passes a userData path).
function setSessionsFile(filePath) {
  sessionsFile = filePath;
  sessionsDir = path.dirname(filePath);
}

// Read the shared session list (empty array if the file is absent).
function getSessions() {
  if (!fs.existsSync(sessionsFile)) return { sessions: [] };
  const raw = fs.readFileSync(sessionsFile, 'utf8');
  const parsed = JSON.parse(raw);
  return { sessions: Array.isArray(parsed) ? parsed : [] };
}

// Overwrite the shared session list with the given array.
function setSessions(sessions) {
  if (!Array.isArray(sessions)) {
    const e = new Error('sessions must be an array.');
    e.status = 400;
    throw e;
  }
  fs.mkdirSync(sessionsDir, { recursive: true });
  fs.writeFileSync(sessionsFile, JSON.stringify(sessions, null, 2), 'utf8');
  return { success: true, count: sessions.length };
}

// Export the current list to an arbitrary file (preserves the shared-folder
// team workflow that the project-relative location used to provide).
function exportSessions(targetPath) {
  const { sessions } = getSessions();
  fs.writeFileSync(targetPath, JSON.stringify(sessions, null, 2), 'utf8');
  return { success: true, count: sessions.length };
}

// Import a session list from an arbitrary file and make it the active store.
function importSessions(sourcePath) {
  const raw = fs.readFileSync(sourcePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    const e = new Error('Imported file must contain a JSON array of sessions.');
    e.status = 400;
    throw e;
  }
  setSessions(parsed);
  return { sessions: parsed };
}

module.exports = { setSessionsFile, getSessions, setSessions, exportSessions, importSessions };
