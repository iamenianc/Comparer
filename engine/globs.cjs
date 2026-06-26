// Glob ignore filtering (single source of truth for both scan and watch).
//
// Extracted verbatim from server.js (Phase 5 IPC migration). Semantics are
// unchanged: a small glob subset (`*`, `**`, `?`, literal segments) compiled to
// anchored RegExps, matched against forward-slash relative paths.

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

module.exports = { DEFAULT_IGNORES, globToRegExp, compileGlobs, isIgnored };
