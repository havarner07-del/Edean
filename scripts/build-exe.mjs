// Builds a double-clickable Edean app as a single executable (Node "single executable
// application" with the whole web app embedded):
//
//   npm run build:exe                     → for this computer
//   npm run build:exe -- --target=win-x64 → Edean.exe for Windows, from any OS
//
// Outputs: Windows → dist/Edean.exe (with icon, no console window)
//          macOS   → dist/Edean        Linux → dist/edean
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 3)) {
  console.error(`Building the executable needs Node.js 22.3 or newer (you have ${process.versions.node}).`);
  process.exit(1);
}
const hostTarget = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
const target = (process.argv.find((a) => a.startsWith('--target=')) || `--target=${hostTarget}`).split('=')[1];
const isWin = target.startsWith('win');
if (target !== hostTarget && target !== 'win-x64' && target !== 'win-arm64') {
  console.error(`Cross-building is supported for win-x64 and win-arm64. Build ${target} on that platform instead.`);
  process.exit(1);
}

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit', cwd: ROOT });
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });

function buildInfo() {
  let sha = process.env.GITHUB_SHA || '';
  if (!sha) { try { sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { sha = 'dev'; } }
  let repo = process.env.GITHUB_REPOSITORY || '';
  if (!repo) {
    try {
      const url = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: ROOT, encoding: 'utf8' }).trim();
      repo = (url.match(/github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?$/) || [])[1] || (url.match(/\/git\/([^/]+\/[^/.]+?)(?:\.git)?$/) || [])[1] || '';
    } catch { /* no git */ }
  }
  return { sha, builtAt: new Date().toISOString(), repo: repo || 'havarner07-del/Edean' };
}

// 1. Bundle the launcher + server into one CommonJS file.
console.log(`• Bundling for ${target}…`);
await build({
  entryPoints: [path.join(ROOT, 'launcher.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: `node${major}`,
  outfile: path.join(DIST, 'edean.cjs'),
  logLevel: 'warning',
  logOverride: { 'empty-import-meta': 'silent' },
  // Lets the in-app updater know which build this is.
  define: { __EDEAN_BUILD__: JSON.stringify(buildInfo()) },
});

// 2. Embed the web app, libraries and the Monaco editor as assets.
const { STATIC, MONACO_DIR } = await import('../server.js');
const assets = {};
for (const [, [rel]] of Object.entries(STATIC)) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) throw new Error(`Missing ${rel} — run npm install first.`);
  assets[rel] = file;
}
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
  useCodeCache: false, // keeps the blob portable across platforms
  useSnapshot: false,
  assets,
}, null, 2));
console.log('• Creating the app blob…');
run(process.execPath, ['--experimental-sea-config', seaConfig]);

// 3. Get the Node.js binary for the target (this one, or the official download).
async function officialNode() {
  const version = `v${process.versions.node}`;
  const arch = target.split('-')[1];
  const cacheDir = path.join(os.homedir(), '.cache', 'edean-build');
  const cached = path.join(cacheDir, `node-${version}-win-${arch}.exe`);
  if (fs.existsSync(cached)) return cached;
  const base = `https://nodejs.org/dist/${version}`;
  console.log(`• Downloading Node.js ${version} for Windows (${arch})…`);
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const expected = sums.split('\n').find((l) => l.endsWith(`  win-${arch}/node.exe`))?.split(/\s+/)[0];
  if (!expected) throw new Error(`No official win-${arch} build of Node ${version}.`);
  const r = await fetch(`${base}/win-${arch}/node.exe`);
  if (!r.ok) throw new Error(`Download failed (${r.status}).`);
  const buf = Buffer.from(await r.arrayBuffer());
  const actual = crypto.createHash('sha256').update(buf).digest('hex');
  if (actual !== expected) throw new Error('Downloaded node.exe failed its checksum; not using it.');
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(cached, buf);
  return cached;
}
const nodeBinary = target === hostTarget ? process.execPath : await officialNode();

const exeName = isWin ? 'Edean.exe' : process.platform === 'darwin' ? 'Edean' : 'edean';
const exe = path.join(DIST, exeName);
fs.copyFileSync(nodeBinary, exe);
fs.chmodSync(exe, 0o755);

// 4. Inject the app into the binary.
if (target === hostTarget && process.platform === 'darwin') run('codesign', ['--remove-signature', exe]);
console.log('• Injecting…');
const postject = path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js');
run(process.execPath, [postject, exe, 'NODE_SEA_BLOB', path.join(DIST, 'sea-prep.blob'),
  '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ...(target.startsWith('darwin') ? ['--macho-segment-name', 'NODE_SEA'] : [])]);
if (target === hostTarget && process.platform === 'darwin') run('codesign', ['--sign', '-', exe]);

// 5. Windows: Edean icon and version info. Done after injection: rewriting the
//    resource section first confuses postject's PE parser.
if (isWin) {
  console.log('• Adding the Edean icon and version info…');
  const ResEdit = await import('resedit');
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const bin = ResEdit.NtExecutable.from(fs.readFileSync(exe), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(bin);
  const icon = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(ROOT, 'assets', 'edean.ico')));
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const groupId = groups[0]?.id ?? 1;
  const lang = groups[0]?.lang ?? 1033;
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, groupId, lang, icon.icons.map((i) => i.data));
  const [vi] = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  const [a, b, c] = pkg.version.split('.').map(Number);
  vi.setFileVersion(a, b, c, 0, 1033);
  vi.setProductVersion(a, b, c, 0, 1033);
  const strings = { ProductName: 'Edean', FileDescription: 'Edean — private coding AI', CompanyName: 'Edean', InternalName: 'Edean', OriginalFilename: 'Edean.exe', LegalCopyright: '', FileVersion: pkg.version, ProductVersion: pkg.version };
  for (const l of vi.getAllLanguagesForStringValues()) vi.setStringValues(l, strings);
  vi.outputToResourceEntries(res.entries);
  res.outputResource(bin);
  fs.writeFileSync(exe, Buffer.from(bin.generate()));
  // Make sure the embedded app is still there.
  const check = ResEdit.NtExecutableResource.from(ResEdit.NtExecutable.from(fs.readFileSync(exe), { ignoreCert: true }));
  if (!check.entries.some((e) => e.type === 10 && e.id === 'NODE_SEA_BLOB')) throw new Error('The app blob was lost while adding the icon.');
}

// 6. Windows: make it a windowed app, so double-clicking doesn't open a console.
if (isWin) {
  const fd = fs.openSync(exe, 'r+');
  const head = Buffer.alloc(4096);
  fs.readSync(fd, head, 0, head.length, 0);
  const pe = head.readUInt32LE(0x3c);
  if (head.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('Not a PE executable.');
  const subsystemOffset = pe + 24 + 68; // optional header → Subsystem (same for PE32 and PE32+)
  const sub = Buffer.alloc(2);
  sub.writeUInt16LE(2); // IMAGE_SUBSYSTEM_WINDOWS_GUI
  fs.writeSync(fd, sub, 0, 2, subsystemOffset);
  fs.closeSync(fd);
}

// 7. Ship an example settings file next to it and clean up.
fs.copyFileSync(path.join(ROOT, '.env.example'), path.join(DIST, 'edean.env.example'));
for (const f of ['edean.cjs', 'sea-prep.blob', 'sea-config.json']) fs.rmSync(path.join(DIST, f));
const mb = (fs.statSync(exe).size / 1024 / 1024).toFixed(0);
console.log(`\n✔ Built ${path.relative(ROOT, exe)} (${mb} MB). Double-click it to start Edean.`);
