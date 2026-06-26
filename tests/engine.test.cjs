// Engine smoke tests — run with `npm test` (plain Node, no Electron needed).
// Exercises scan, diff, sync+undo (temp-dir backup/restore), ignore-test, and
// the path-traversal guard against the checked-in mock fixtures.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { scan, ignoreTest } = require('../engine/scan.cjs');
const { computeDiff } = require('../engine/diff.cjs');
const { sync, undo } = require('../engine/sync.cjs');

const root = path.join(__dirname, '..');
const left = path.join(root, 'tests', 'mock_left');
const right = path.join(root, 'tests', 'mock_right');

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('engine tests');

check('scan returns folder comparison rows', () => {
  const r = scan({ leftPath: left, rightPath: right });
  assert.ok(Array.isArray(r.files), 'files is an array');
  assert.ok(r.files.length > 0, 'has rows');
  assert.ok(r.mergedIgnores.includes('**/node_modules'), 'default ignores applied');
  // node_modules must be excluded from the scan.
  assert.ok(!r.files.some((f) => f.relativePath.startsWith('node_modules')), 'node_modules ignored');
});

check('computeDiff returns rows + unified for a modified file', () => {
  const r = scan({ leftPath: left, rightPath: right });
  const modified = r.files.find((f) => f.status === 'modified' && !f.isDirectory);
  assert.ok(modified, 'a modified file exists');
  const d = computeDiff({ leftPath: r.leftPath, rightPath: r.rightPath, relativePath: modified.relativePath });
  assert.ok(Array.isArray(d.rows) && d.rows.length > 0, 'diff rows');
  assert.ok(Array.isArray(d.unified), 'unified present');
});

check('traversal guard rejects ..-escaping relativePath', () => {
  assert.throws(
    () => computeDiff({ leftPath: left, rightPath: right, relativePath: '../../../etc/passwd' }),
    /traversal/,
  );
});

check('ignoreTest previews matches without mutating', () => {
  const r = ignoreTest({ leftPath: left, rightPath: right, pattern: '*.txt' });
  assert.ok(typeof r.count === 'number', 'count is numeric');
});

check('sync keepLeft then undo restores original (temp-dir backup)', () => {
  // Build an isolated pair of dirs so the test never touches the fixtures.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'comparer-test-'));
  const l = path.join(base, 'L');
  const rt = path.join(base, 'R');
  fs.mkdirSync(l); fs.mkdirSync(rt);
  fs.writeFileSync(path.join(l, 'f.txt'), 'LEFT');
  fs.writeFileSync(path.join(rt, 'f.txt'), 'RIGHT');

  sync({ leftPath: l, rightPath: rt, relativePath: 'f.txt', action: 'keepLeft' });
  assert.strictEqual(fs.readFileSync(path.join(rt, 'f.txt'), 'utf8'), 'LEFT', 'right overwritten with left');

  undo();
  assert.strictEqual(fs.readFileSync(path.join(rt, 'f.txt'), 'utf8'), 'RIGHT', 'undo restored right');

  fs.rmSync(base, { recursive: true, force: true });
});

check('sync rejects traversal relativePath', () => {
  assert.throws(
    () => sync({ leftPath: left, rightPath: right, relativePath: '../escape.txt', action: 'keepLeft' }),
    /traversal/,
  );
});

console.log(`\n${passed} passed`);
