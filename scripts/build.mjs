// Build orchestration for the standalone Windows executable (Node SEA).
//
// Pipeline:
//   1. Bundle server.js (+ deps) into a single CJS file with esbuild.
//   2. Generate the SEA blob from that bundle (node --experimental-sea-config).
//   3. Copy the local `node` binary to dist/comparer.exe.
//   4. Inject the blob into the copied binary with postject.
//   5. Stage public/ next to the exe and produce dist/comparer.zip.
//
// Run via `npm run build`. Requires devDependencies: esbuild, postject.

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dist = path.join(root, 'dist');

function log(step) { console.log(`\n→ ${step}`); }

// 0. Clean dist
log('Preparing dist/');
fs.rmSync(dist, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });

// 1. Bundle with esbuild into a single CommonJS file.
log('Bundling server.js with esbuild');
const esbuild = require('esbuild');
await esbuild.build({
  entryPoints: [path.join(root, 'server.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: path.join(dist, 'bundle.cjs'),
  // chokidar pulls in optional fsevents (macOS only) — mark external so the
  // Windows build doesn't fail trying to resolve it.
  external: ['fsevents'],
});

// 2. Generate the SEA blob.
log('Generating SEA blob');
execFileSync(process.execPath, ['--experimental-sea-config', path.join(root, 'sea-config.json')], {
  stdio: 'inherit',
});

// 3. Copy the node binary.
log('Copying node runtime to dist/comparer.exe');
const exePath = path.join(dist, 'comparer.exe');
fs.copyFileSync(process.execPath, exePath);

// 4. Inject the blob with postject.
log('Injecting SEA blob with postject');
const postjectBin = require.resolve('postject/dist/cli.js');
execFileSync(process.execPath, [
  postjectBin,
  exePath,
  'NODE_SEA_BLOB',
  path.join(dist, 'sea-prep.blob'),
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
], { stdio: 'inherit' });

// 5. Stage public/ next to the exe.
log('Staging public/ assets');
fs.cpSync(path.join(root, 'public'), path.join(dist, 'public'), { recursive: true });

// 6. Zip comparer.exe + public/ into dist/comparer.zip (PowerShell Compress-Archive).
log('Creating dist/comparer.zip');
const zipPath = path.join(dist, 'comparer.zip');
try {
  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Path '${exePath}','${path.join(dist, 'public')}' -DestinationPath '${zipPath}' -Force"`,
    { stdio: 'inherit' }
  );
} catch (e) {
  console.warn('Could not create zip automatically (Compress-Archive unavailable):', e.message);
}

// Cleanup intermediate artifacts.
fs.rmSync(path.join(dist, 'bundle.cjs'), { force: true });
fs.rmSync(path.join(dist, 'sea-prep.blob'), { force: true });

log('Build complete. Artifacts in dist/:');
console.log('  comparer.exe   (standalone, no Node.js required)');
console.log('  public/        (static assets served by the exe)');
console.log('  comparer.zip   (distributable bundle)');
