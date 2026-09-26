// Builds a double-clickable Edean executable for the current OS using Node's
// "single executable application" feature:
//   Windows → dist/Edean.exe    macOS → dist/Edean    Linux → dist/edean
// Run on each OS you want a build for:  npm run build:exe
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const platform = process.platform;
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 3)) {
  console.error(`Building the executable needs Node.js 22.3 or newer (you have ${process.versions.node}).`);
  process.exit(1);
}

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT });
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

// 1. Bundle the launcher + server into one CommonJS file.
console.log('• Bundling…');
await build({
  entryPoints: [path.join(ROOT, 'launcher.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: `node${major}`,
  outfile: path.join(DIST, 'edean.cjs'),
  logLevel: 'warning',
  logOverride: { 'empty-import-meta': 'silent' },
});

// 2. Embed the web app, libraries and fonts as assets.
const { STATIC, MONACO_DIR } = await import('../server.js');
const assets = {};
for (const [, [rel]] of Object.entries(STATIC)) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) throw new Error(`Missing ${rel} — run npm install first.`);
  assets[rel] = file;
}
// Monaco (the Workspace editor) is a whole folder of files.
const walk = (dir) => fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((d) => {
  const rel = `${dir}/${d.name}`;
  return d.isDirectory() ? walk(rel) : [rel];
});
for (const rel of walk(MONACO_DIR)) assets[rel] = path.join(ROOT, rel);
const seaConfig = path.join(DIST, 'sea-config.json');
fs.writeFileSync(seaConfig, JSON.stringify({
  main: path.join(DIST, 'edean.cjs'),
  output: path.join(DIST, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  useSnapshot: false,
  assets,
}, null, 2));
console.log('• Creating the app blob…');
run(process.execPath, ['--experimental-sea-config', seaConfig]);

// 3. Copy this Node binary and inject the blob into it.
const exeName = platform === 'win32' ? 'Edean.exe' : platform === 'darwin' ? 'Edean' : 'edean';
const exe = path.join(DIST, exeName);
fs.copyFileSync(process.execPath, exe);
fs.chmodSync(exe, 0o755);
if (platform === 'darwin') run('codesign', ['--remove-signature', exe]);
console.log('• Injecting…');
const postject = path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js');
run(process.execPath, [postject, exe, 'NODE_SEA_BLOB', path.join(DIST, 'sea-prep.blob'),
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : [])]);
if (platform === 'darwin') run('codesign', ['--sign', '-', exe]);

// 4. Ship an example settings file next to it and clean up.
fs.copyFileSync(path.join(ROOT, '.env.example'), path.join(DIST, 'edean.env.example'));
for (const f of ['edean.cjs', 'sea-prep.blob', 'sea-config.json']) fs.rmSync(path.join(DIST, f));
const mb = (fs.statSync(exe).size / 1024 / 1024).toFixed(0);
console.log(`\n✔ Built ${path.relative(ROOT, exe)} (${mb} MB). Double-click it to start Edean.`);
