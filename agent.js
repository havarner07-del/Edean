// Edean's coding agent: you describe what you want; it creates or opens a GitHub
// repository or a folder on your computer, writes and edits the files, runs commands
// and tests, fixes what's broken, commits and pushes, and reports back — like a pair
// programmer at a terminal.
//
// Before writing code it asks Claude (or Copilot) HOW to do the job and follows that
// plan; optionally Claude reviews the finished changes and the agent fixes what it finds.
//
// Projects are either GitHub repositories, worked on in a local copy
// (~/.edean/projects/<owner>/<repo>, synced from GitHub; commits go through the GitHub
// API, so git isn't required), or folders on your computer, edited in place (commits use
// your own git). Every file the agent writes, edits or deletes is backed up first, so a
// whole task can be undone. By default Edean asks you before running commands, opening
// folders, creating repositories, pushing, and opening pull requests; you can let it work
// fully on its own instead.

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import * as github from './github.js';
import * as advisors from './advisors.js';
import { execFile } from 'node:child_process';
import { exec, childEnv } from './runner.js';
import { detectTools } from './toolchains.js';

const WIN = process.platform === 'win32';
const DATA_DIR = () => process.env.EDEAN_DATA_DIR || path.join(os.homedir(), '.edean');
const PROJECTS = () => path.join(DATA_DIR(), 'projects');
const META = () => path.join(PROJECTS(), '.meta');
const BACKUPS = () => path.join(DATA_DIR(), 'backups');
const KEEP_BACKUPS = 20;
const MAX_STEPS = 60;
const MAX_FILES = 5000;
const MAX_RESULT = 8000;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

// ---------- projects ----------
const IGNORE_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache', '.idea', '.gradle', 'target', '.next']);
const IGNORE_FILES = /(^\.DS_Store$|\.pyc$|^Thumbs\.db$)/;

const metaFile = (id) => path.join(META(), id.startsWith('folder:') ? `folder__${hash(id).slice(0, 20)}.json` : `${id.replace('/', '__')}.json`);
export const projectDir = (id) => path.join(PROJECTS(), ...id.split('/'));
// Where a project's files are: a folder on the computer, or Edean's copy of a repository.
const dirOf = (meta) => meta.dir || projectDir(meta.id);
const isFolder = (meta) => meta?.kind === 'folder';
const label = (meta) => (isFolder(meta) ? meta.dir : meta.id);

async function readMeta(id) {
  try { return JSON.parse(await fs.readFile(metaFile(id), 'utf8')); } catch { return null; }
}
async function writeMeta(meta) {
  await fs.mkdir(META(), { recursive: true });
  await fs.writeFile(metaFile(meta.id), JSON.stringify(meta, null, 2));
}

export async function listProjects() {
  let files = [];
  try { files = await fs.readdir(META()); } catch { return []; }
  const out = [];
  for (const f of files) {
    try {
      const m = JSON.parse(await fs.readFile(path.join(META(), f), 'utf8'));
      out.push({ id: m.id, kind: m.kind || 'repo', name: m.name || m.id, branch: m.branch || '', git: m.kind === 'folder' ? !!m.git : true, local: !!m.local, defaultBranch: m.defaultBranch, htmlUrl: m.htmlUrl || '', dir: dirOf(m), updatedAt: m.updatedAt || 0 });
    } catch { /* skip broken */ }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

function gitignoreMatcher(text) {
  const rules = (text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('!'));
  const res = rules.map((r) => {
    const dirOnly = r.endsWith('/');
    const body = r.replace(/^\/|\/$/g, '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*');
    return { re: new RegExp(r.includes('/') && !r.endsWith('/') ? `^${body}$` : `(^|/)${body}${dirOnly ? '(/|$)' : '(/.*)?$'}`), dirOnly };
  });
  return (rel) => res.some(({ re }) => re.test(rel));
}

// All project files (relative paths, "/" separators), minus ignored ones.
async function walk(root) {
  let ignored = () => false;
  try { ignored = gitignoreMatcher(await fs.readFile(path.join(root, '.gitignore'), 'utf8')); } catch { /* none */ }
  const out = [];
  const visit = async (dir, rel) => {
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (IGNORE_DIRS.has(e.name) || ignored(r)) continue;
        await visit(path.join(dir, e.name), r);
      } else if (e.isFile()) {
        if (IGNORE_FILES.test(e.name) || ignored(r)) continue;
        out.push(r);
      }
    }
  };
  await visit(root, '');
  return out.sort();
}

const hash = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

async function snapshot(root) {
  const files = await walk(root);
  const map = {};
  for (const f of files) map[f] = hash(await fs.readFile(path.join(root, f)));
  return map;
}

// Minimal ZIP reader for GitHub's zipball (stored + deflate entries).
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw fail('The repository archive is not a valid ZIP file.', 502);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const mode = buf.readUInt32LE(p + 38) >>> 16;
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    files.push({ name, mode, data: method === 8 ? zlib.inflateRawSync(raw) : raw });
  }
  return files;
}

// Replace the local copy with the branch from GitHub.
async function syncFromGithub(meta) {
  const dir = dirOf(meta);
  const res = await github.zipball(meta.owner, meta.repo, meta.branch);
  const files = unzip(Buffer.from(await res.arrayBuffer()));
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  for (const f of files) {
    const rel = f.name.split('/').slice(1).join('/'); // drop GitHub's "owner-repo-sha/" folder
    if (!rel || rel.split('/').some((s) => s === '..')) continue;
    const target = path.join(dir, ...rel.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, f.data, { mode: f.mode & 0o111 ? 0o755 : 0o644 });
  }
  meta.base = await snapshot(dir);
  meta.updatedAt = Date.now();
  await writeMeta(meta);
}

async function changes(meta) {
  const dir = dirOf(meta);
  if (isFolder(meta) && meta.git) return { list: await gitChanges(dir), now: null };
  const now = await snapshot(dir);
  const out = [];
  for (const [p, h] of Object.entries(now)) if (meta.base[p] !== h) out.push({ path: p, status: meta.base[p] ? 'modified' : 'added' });
  for (const p of Object.keys(meta.base)) if (!(p in now)) out.push({ path: p, status: 'deleted' });
  return { list: out.sort((a, b) => a.path.localeCompare(b.path)), now };
}

// Resolve a path inside the project; refuse anything that escapes it.
function inProject(meta, p) {
  if (typeof p !== 'string') throw fail('A file path is required.');
  const clean = p.replace(/\\/g, '/').replace(/^\.?\//, '');
  const root = dirOf(meta);
  const full = path.resolve(root, clean || '.');
  if (full !== root && !full.startsWith(root + path.sep)) throw fail(`${p} is outside the project folder.`);
  if (clean.split('/').includes('.git')) throw fail('The .git folder is off limits.');
  return { full, rel: path.relative(root, full).split(path.sep).join('/') };
}

// ---------- folders on this computer ----------
function git(dir, args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', args, {
      cwd: dir, windowsHide: true, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    }, (err, stdout, stderr) => {
      if (err) reject(fail(err.code === 'ENOENT' ? 'git is not installed on this computer.' : `git ${args[0]} failed: ${(stderr || stdout || err.message).trim().slice(0, 1500)}`, 400));
      else resolve(stdout.replace(/\s+$/, ''));
    });
  });
}

async function gitChanges(dir) {
  const out = await git(dir, ['status', '--porcelain=v1', '-uall', '-z']);
  const parts = out.split('\0').filter(Boolean);
  const list = [];
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].slice(0, 2);
    const file = parts[i].slice(3);
    if (code[0] === 'R' || code[0] === 'C') i++; // the next entry is the original name
    list.push({ path: file, status: code === '??' || code.includes('A') ? 'added' : code.includes('D') ? 'deleted' : 'modified' });
  }
  return list.sort((a, b) => a.path.localeCompare(b.path));
}

// Folders the agent must never be pointed at as a whole.
function forbiddenFolder(dir) {
  const norm = (p) => (WIN ? p.toLowerCase() : p).replace(/[\\/]+$/, '');
  const d = norm(dir);
  if (path.parse(dir).root.replace(/[\\/]+$/, '') === dir.replace(/[\\/]+$/, '')) return 'a whole drive';
  if (d === norm(os.homedir())) return 'your whole home folder';
  const data = norm(path.resolve(DATA_DIR()));
  if (d === data || d.startsWith(data + path.sep)) return 'Edean\'s own data folder';
  if (data.startsWith(d + path.sep)) return 'a folder that contains Edean\'s data';
  const system = WIN
    ? [process.env.SystemRoot || 'C:\\Windows', process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.ProgramData].filter(Boolean)
    : ['/bin', '/boot', '/dev', '/etc', '/lib', '/lib64', '/proc', '/sbin', '/sys', '/usr', '/var', '/System', '/Library', '/Applications', '/private', '/opt'];
  for (const sys of system.map((p) => norm(path.resolve(p)))) if (d === sys || d.startsWith(sys + path.sep)) return 'a system folder';
  return '';
}

function githubRemote(url) {
  const m = (url || '').match(/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

// Opens a folder on this computer as a project; the agent edits the files in place.
export async function openFolder(input) {
  if (typeof input !== 'string' || !input.trim()) throw fail('Choose a folder.');
  let dir = input.trim();
  if (dir === '~' || dir.startsWith('~/') || dir.startsWith('~\\')) dir = path.join(os.homedir(), dir.slice(1));
  if (!path.isAbsolute(dir)) throw fail('Use the full path of the folder, e.g. C:\\Users\\you\\code\\my-app or /home/you/code/my-app.');
  dir = path.resolve(dir);
  const st = await fs.stat(dir).catch(() => null);
  if (!st?.isDirectory()) throw fail(`${dir} is not a folder that exists.`);
  dir = await fs.realpath(dir);
  const bad = forbiddenFolder(dir);
  if (bad) throw fail(`For safety, Edean won't work directly in ${bad}. Pick the project's own folder.`, 403);
  const id = `folder:${dir}`;
  const existing = await readMeta(id);
  const meta = { ...(existing || {}), id, kind: 'folder', dir, name: path.basename(dir), updatedAt: Date.now() };
  meta.git = existsSync(path.join(dir, '.git'));
  delete meta.owner; delete meta.repo; delete meta.htmlUrl;
  if (meta.git) {
    meta.branch = await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => 'main');
    const remote = githubRemote(await git(dir, ['remote', 'get-url', 'origin']).catch(() => ''));
    if (remote) Object.assign(meta, remote, { htmlUrl: `https://github.com/${remote.owner}/${remote.repo}` });
    const head = await git(dir, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD']).catch(() => '');
    meta.defaultBranch = head.replace(/^origin\//, '') || existing?.defaultBranch || meta.branch;
    meta.base = {};
  } else {
    meta.branch = '';
    if (!existing?.base) meta.base = await snapshot(dir);
  }
  await writeMeta(meta);
  return meta;
}

// Lists sub-folders, for the folder picker in the app.
export async function browse(input) {
  if (!input) {
    const home = os.homedir();
    const roots = [];
    if (WIN) {
      for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') if (existsSync(`${letter}:\\`)) roots.push({ name: `${letter}:\\`, path: `${letter}:\\` });
    } else roots.push({ name: '/', path: '/' });
    const common = ['Documents', 'Desktop', 'source', 'repos', 'code', 'Code', 'projects', 'Projects', 'dev', 'src', 'GitHub'].map((n) => path.join(home, n)).filter((p) => existsSync(p));
    const listing = await browse(home);
    return { ...listing, roots, shortcuts: [{ name: 'Home', path: home }, ...common.map((p) => ({ name: path.basename(p), path: p }))] };
  }
  const dir = path.resolve(String(input));
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { throw fail(`Can't open ${dir}.`, 404); }
  const folders = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !['node_modules', '__pycache__', '$RECYCLE.BIN', 'System Volume Information'].includes(e.name))
    .map((e) => ({ name: e.name, path: path.join(dir, e.name), git: existsSync(path.join(dir, e.name, '.git')) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })).slice(0, 500);
  const parent = path.dirname(dir);
  return { path: dir, parent: parent !== dir ? parent : null, git: existsSync(path.join(dir, '.git')), folders, blocked: forbiddenFolder(dir) || '' };
}

// ---------- backups (undo) ----------
// Before the agent first changes a file during a task, its previous content is saved
// under ~/.edean/backups/<task id>/ so the whole task can be undone.
function makeBackups(runId, task) {
  const root = path.join(BACKUPS(), runId);
  const manifest = { run: runId, task: task.slice(0, 300), createdAt: Date.now(), files: [] };
  const seen = new Set();
  let chain = Promise.resolve();
  return {
    manifest,
    get count() { return manifest.files.length; },
    // Saves the file's current state once per task. Serialized so the manifest stays consistent.
    save(meta, rel, full) {
      const key = `${dirOf(meta)}\0${rel}`;
      if (seen.has(key)) return chain;
      seen.add(key);
      chain = chain.then(async () => {
        await fs.mkdir(path.join(root, 'files'), { recursive: true });
        const blob = String(manifest.files.length);
        let existed = false;
        try { await fs.copyFile(full, path.join(root, 'files', blob)); existed = true; } catch { /* new file */ }
        manifest.files.push({ dir: dirOf(meta), rel, existed, blob: existed ? blob : null, project: meta.id });
        await fs.writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
      });
      return chain;
    },
  };
}

async function pruneBackups() {
  let dirs = [];
  try { dirs = await fs.readdir(BACKUPS()); } catch { return; }
  const stats = await Promise.all(dirs.map(async (d) => ({ d, t: (await fs.stat(path.join(BACKUPS(), d)).catch(() => ({ mtimeMs: 0 }))).mtimeMs })));
  for (const { d } of stats.sort((a, b) => b.t - a.t).slice(KEEP_BACKUPS)) await fs.rm(path.join(BACKUPS(), d), { recursive: true, force: true }).catch(() => {});
}

async function readManifest(runId) {
  if (!/^[0-9a-f-]{36}$/.test(runId || '')) throw fail('Unknown task.', 404);
  try { return JSON.parse(await fs.readFile(path.join(BACKUPS(), runId, 'manifest.json'), 'utf8')); } catch { throw fail('There is nothing to undo for that task (or it is too old).', 404); }
}

// Puts every file the task changed back the way it was.
export async function undoRun(runId) {
  if (current?.id === runId) throw fail('Stop the agent before undoing its changes.', 409);
  const manifest = await readManifest(runId);
  const restored = [];
  for (const f of manifest.files) {
    const full = path.resolve(f.dir, ...f.rel.split('/'));
    if (!full.startsWith(path.resolve(f.dir) + path.sep)) continue;
    if (f.existed) {
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.copyFile(path.join(BACKUPS(), runId, 'files', f.blob), full);
      restored.push({ path: f.rel, action: 'restored' });
    } else {
      await fs.rm(full, { force: true });
      restored.push({ path: f.rel, action: 'removed' });
    }
  }
  await fs.rm(path.join(BACKUPS(), runId), { recursive: true, force: true });
  return { files: restored };
}

// ---------- diffs (for Claude's review) ----------
function lineDiff(a, b, context = 3) {
  const A = a.split('\n');
  const B = b.split('\n');
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a2 = A.slice(pre, A.length - suf);
  const b2 = B.slice(pre, B.length - suf);
  const ops = [];
  if (a2.length * b2.length > 4_000_000) {
    for (const l of a2) ops.push(['-', l]);
    for (const l of b2) ops.push(['+', l]);
  } else {
    // Longest common subsequence on the part that differs.
    const n = a2.length; const m = b2.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a2[i] === b2[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    let i = 0; let j = 0;
    while (i < n && j < m) {
      if (a2[i] === b2[j]) { ops.push([' ', a2[i]]); i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push(['-', a2[i++]]); else ops.push(['+', b2[j++]]);
    }
    while (i < n) ops.push(['-', a2[i++]]);
    while (j < m) ops.push(['+', b2[j++]]);
  }
  const all = [...A.slice(Math.max(0, pre - context), pre).map((l) => [' ', l]), ...ops, ...A.slice(A.length - suf, A.length - suf + context).map((l) => [' ', l])];
  // Drop long unchanged runs in the middle.
  const out = [];
  let run = [];
  const flush = (end) => {
    if (run.length > context * 2 + 1 && !end) { out.push(...run.slice(0, context), ['', '…'], ...run.slice(-context)); } else out.push(...run);
    run = [];
  };
  for (const op of all) { if (op[0] === ' ') run.push(op); else { flush(false); out.push(op); } }
  flush(true);
  return `@@ from line ${Math.max(1, pre - context + 1)} @@\n${out.map(([k, l]) => (k === '' ? l : `${k}${l}`)).join('\n')}`;
}

async function diffForRun(backups, limit = 40000) {
  const parts = [];
  for (const f of backups.manifest.files) {
    const full = path.resolve(f.dir, ...f.rel.split('/'));
    const before = f.existed ? await fs.readFile(path.join(BACKUPS(), backups.manifest.run, 'files', f.blob), 'utf8').catch(() => '') : null;
    const after = await fs.readFile(full, 'utf8').catch(() => null);
    if (before === after) continue;
    if (after === null) parts.push(`### Deleted ${f.rel}`);
    else if (before === null) parts.push(`### New file ${f.rel}\n\`\`\`\n${clip(after, 12000)}\n\`\`\``);
    else parts.push(`### Changed ${f.rel}\n\`\`\`diff\n${clip(lineDiff(before, after), 12000)}\n\`\`\``);
  }
  return clip(parts.join('\n\n'), limit);
}

// ---------- planning context ----------
// A compact picture of the project for the advisor that writes the plan.
async function planContext(meta, task) {
  if (!meta) return 'No project is open yet; the agent will create a new repository (or open one the user names).';
  const dir = dirOf(meta);
  const files = await walk(dir);
  const parts = [`Project: ${label(meta)}${meta.branch ? ` (branch ${meta.branch})` : ''}. ${files.length} files.`];
  parts.push(`## Files\n${files.slice(0, 300).join('\n')}${files.length > 300 ? `\n… and ${files.length - 300} more` : ''}`);
  const wanted = new Set();
  for (const f of files) {
    const base = f.split('/').pop().toLowerCase();
    if (!f.includes('/') && (/^readme(\.|$)/.test(base) || ['package.json', 'pyproject.toml', 'requirements.txt', 'cargo.toml', 'go.mod', 'pom.xml', 'build.gradle', 'composer.json', 'gemfile', 'makefile', 'dockerfile'].includes(base))) wanted.add(f);
  }
  const lower = task.toLowerCase();
  const mentioned = files.filter((f) => lower.includes(f.toLowerCase()) || (f.split('/').pop().length > 4 && lower.includes(f.split('/').pop().toLowerCase()))).slice(0, 5);
  let budget = 45000 - parts.join('\n').length;
  for (const f of [...wanted, ...mentioned]) {
    if (budget < 1000) break;
    const buf = await fs.readFile(path.join(dir, f)).catch(() => null);
    if (!buf || buf.subarray(0, 8000).includes(0)) continue;
    const text = clip(buf.toString('utf8'), mentioned.includes(f) ? Math.min(8000, budget) : Math.min(3000, budget));
    parts.push(`## ${f}\n\`\`\`\n${text}\n\`\`\``);
    budget -= text.length + f.length + 12;
  }
  return parts.join('\n\n');
}

// ---------- tools ----------
const TOOLS = {
  list_repositories: {
    description: 'List the GitHub repositories you can use.',
    params: {},
    async run(ctx) {
      const repos = await github.listRepos();
      return repos.slice(0, 60).map((r) => `${r.fullName}${r.private ? ' (private)' : ''} — default branch ${r.defaultBranch}${r.description ? ` — ${r.description}` : ''}`).join('\n') || 'No repositories.';
    },
  },
  create_repository: {
    description: 'Create a new GitHub repository (private by default) and open it as the current project. If GitHub isn\'t connected, creates a local-only project instead.',
    params: { name: { type: 'string', description: 'Short, lowercase, hyphenated name, e.g. "todo-cli"' }, description: { type: 'string' }, private: { type: 'boolean', description: 'Default true' } },
    required: ['name'],
    approval: true,
    async run(ctx, a) {
      if (!(await github.status()).connected) {
        if (!/^[A-Za-z0-9_.-]{1,100}$/.test(a.name || '')) throw fail('Invalid project name.');
        const meta = { id: `local/${a.name}`, owner: 'local', repo: a.name, branch: 'main', defaultBranch: 'main', local: true, base: {}, updatedAt: Date.now() };
        await fs.mkdir(dirOf(meta), { recursive: true });
        await writeMeta(meta);
        ctx.setProject(meta);
        return `GitHub isn't connected, so I created a local project at ${dirOf(meta)}. Connect GitHub in the Workspace to publish it later.`;
      }
      const r = await github.createRepo({ name: a.name, description: a.description, private: a.private });
      const meta = { id: r.fullName, owner: r.owner, repo: r.name, branch: r.defaultBranch, defaultBranch: r.defaultBranch, htmlUrl: r.htmlUrl, base: {} };
      // GitHub needs a moment before a brand-new repository's archive is available.
      for (let i = 0; ; i++) {
        try { await syncFromGithub(meta); break; } catch (err) { if (i >= 5) throw err; await new Promise((res) => setTimeout(res, 1500)); }
      }
      ctx.setProject(meta);
      return `Created ${r.private ? 'private' : 'public'} repository ${r.fullName} (${r.htmlUrl}) and opened it. Branch: ${meta.branch}. Local folder: ${dirOf(meta)}`;
    },
  },
  open_repository: {
    description: 'Open an existing GitHub repository (downloads its files into the local project folder) and make it the current project.',
    params: { full_name: { type: 'string', description: 'owner/name' }, branch: { type: 'string', description: 'Defaults to the default branch' } },
    required: ['full_name'],
    async run(ctx, a) {
      const [owner, repo] = String(a.full_name || '').split('/');
      const info = await github.repoInfo(owner, repo);
      const existing = await readMeta(info.fullName);
      const branch = a.branch || existing?.branch || info.defaultBranch;
      const meta = { id: info.fullName, owner: info.owner, repo: info.name, branch, defaultBranch: info.defaultBranch, htmlUrl: info.htmlUrl, base: {} };
      if (existing && existing.branch === branch && existsSync(dirOf(meta))) {
        const pending = (await changes(existing)).list;
        if (pending.length) {
          ctx.setProject(existing);
          return `Opened ${info.fullName} (${branch}). Kept the local folder because it has ${pending.length} uncommitted change(s): ${pending.map((c) => c.path).join(', ')}`;
        }
      }
      await syncFromGithub(meta);
      ctx.setProject(meta);
      return `Opened ${info.fullName} on branch ${branch}: ${Object.keys(meta.base).length} files. Default branch: ${info.defaultBranch}.`;
    },
  },
  open_folder: {
    description: 'Open a folder on the user\'s computer (full path) as the current project. You then read and edit its files directly, in place.',
    params: { path: { type: 'string', description: 'Full path, e.g. C:\\Users\\me\\code\\my-app or /home/me/code/my-app' } },
    required: ['path'],
    approval: true,
    async run(ctx, a) {
      const meta = await openFolder(a.path);
      ctx.setProject(meta);
      const count = (await walk(meta.dir)).length;
      return `Opened the folder ${meta.dir} (${count} files)${meta.git ? `. It is a git repository on branch ${meta.branch}${meta.owner ? `, linked to GitHub ${meta.owner}/${meta.repo}` : ''}` : '. It is not a git repository'}. Changes you make are written straight into this folder.`;
    },
  },
  create_branch: {
    description: 'Create a new branch from the current branch and switch the project to it. Uncommitted changes come along.',
    params: { name: { type: 'string', description: 'e.g. "edean/add-login"' } },
    required: ['name'],
    async run(ctx, a) {
      if (isFolder(ctx.requireProject())) {
        const meta = ctx.requireProject();
        if (!meta.git) throw fail('This folder is not a git repository, so it has no branches. Just edit the files.');
        await git(meta.dir, ['checkout', '-b', a.name]);
        meta.branch = a.name;
        await writeMeta(meta);
        ctx.setProject(meta);
        return `Created branch ${a.name} with git and switched to it.`;
      }
      const meta = ctx.requireProject({ github: true });
      await github.createBranch(meta.owner, meta.repo, a.name, meta.branch);
      meta.branch = a.name;
      await writeMeta(meta);
      ctx.setProject(meta);
      return `Created branch ${a.name} and switched to it.`;
    },
  },
  list_files: {
    description: 'List files in the project (or in a folder of it).',
    params: { path: { type: 'string', description: 'Folder, default: project root' } },
    async run(ctx, a) {
      const meta = ctx.requireProject();
      const files = await walk(dirOf(meta));
      const prefix = a.path ? inProject(meta, a.path).rel.replace(/\/?$/, '/') : '';
      const list = files.filter((f) => !prefix || prefix === './' || f.startsWith(prefix));
      if (!list.length) return a.path ? `No files under ${a.path}.` : 'The project has no files yet.';
      return `${list.length} file(s)${list.length > 400 ? ', first 400' : ''}:\n${list.slice(0, 400).join('\n')}`;
    },
  },
  read_file: {
    description: 'Read a file. Returns numbered lines. For big files, read a range.',
    params: { path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } },
    required: ['path'],
    async run(ctx, a) {
      const meta = ctx.requireProject();
      const { full, rel } = inProject(meta, a.path);
      const buf = await fs.readFile(full).catch(() => { throw fail(`${rel} doesn't exist.`); });
      if (buf.subarray(0, 8000).includes(0)) return `${rel} is a binary file (${buf.length} bytes).`;
      const lines = buf.toString('utf8').split('\n');
      const start = Math.max(1, a.start_line || 1);
      const end = Math.min(lines.length, a.end_line || start + 399);
      const body = lines.slice(start - 1, end).map((l, i) => `${String(start + i).padStart(5)}  ${l}`).join('\n');
      return `${rel} (lines ${start}-${end} of ${lines.length})\n${body}`;
    },
  },
  write_file: {
    description: 'Create a file, or replace its whole content. Creates folders as needed. Write complete content, never placeholders.',
    params: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content'],
    async run(ctx, a) {
      const meta = ctx.requireProject();
      const { full, rel } = inProject(meta, a.path);
      if (typeof a.content !== 'string') throw fail('content must be a string.');
      const existed = existsSync(full);
      await ctx.backup(meta, rel, full);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, a.content);
      ctx.detail = { kind: 'file', path: rel, content: a.content.slice(0, 20000) };
      return `${existed ? 'Updated' : 'Created'} ${rel} (${a.content.split('\n').length} lines).`;
    },
  },
  edit_file: {
    description: 'Replace an exact piece of text in a file. old_text must match exactly (including indentation) and be unique unless replace_all is true.',
    params: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' }, replace_all: { type: 'boolean' } },
    required: ['path', 'old_text', 'new_text'],
    async run(ctx, a) {
      const meta = ctx.requireProject();
      const { full, rel } = inProject(meta, a.path);
      const text = await fs.readFile(full, 'utf8').catch(() => { throw fail(`${rel} doesn't exist.`); });
      if (!a.old_text) throw fail('old_text is empty.');
      const count = text.split(a.old_text).length - 1;
      if (!count) throw fail(`old_text was not found in ${rel}. Read the file again and copy the text exactly.`);
      if (count > 1 && !a.replace_all) throw fail(`old_text appears ${count} times in ${rel}. Include more surrounding lines to make it unique, or set replace_all.`);
      await ctx.backup(meta, rel, full);
      await fs.writeFile(full, a.replace_all ? text.split(a.old_text).join(a.new_text) : text.replace(a.old_text, () => a.new_text));
      ctx.detail = { kind: 'edit', path: rel, old: a.old_text.slice(0, 6000), new: a.new_text.slice(0, 6000) };
      return `Edited ${rel}${count > 1 ? ` (${count} places)` : ''}.`;
    },
  },
  delete_file: {
    description: 'Delete a file from the project.',
    params: { path: { type: 'string' } },
    required: ['path'],
    async run(ctx, a) {
      const meta = ctx.requireProject();
      const { full, rel } = inProject(meta, a.path);
      if (!existsSync(full)) throw fail(`${rel} doesn't exist.`);
      await ctx.backup(meta, rel, full);
      await fs.rm(full).catch(() => { throw fail(`${rel} doesn't exist.`); });
      return `Deleted ${rel}.`;
    },
  },
  search_files: {
    description: 'Search file contents with a regular expression. Returns matching lines as path:line: text.',
    params: { pattern: { type: 'string' }, path: { type: 'string', description: 'Optional folder to limit the search' } },
    required: ['pattern'],
    async run(ctx, a) {
      const meta = ctx.requireProject();
      let re;
      try { re = new RegExp(a.pattern, 'i'); } catch { throw fail('Invalid regular expression.'); }
      const root = dirOf(meta);
      const prefix = a.path ? inProject(meta, a.path).rel : '';
      const hits = [];
      for (const f of await walk(root)) {
        if (prefix && !f.startsWith(prefix)) continue;
        const buf = await fs.readFile(path.join(root, f));
        if (buf.length > 2_000_000 || buf.subarray(0, 8000).includes(0)) continue;
        buf.toString('utf8').split('\n').forEach((line, i) => { if (hits.length < 100 && re.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 200)}`); });
        if (hits.length >= 100) break;
      }
      return hits.length ? hits.join('\n') : 'No matches.';
    },
  },
  run_command: {
    description: 'Run a shell command in the project folder (install dependencies, run the program or its tests, build). Returns exit code and output.',
    params: { command: { type: 'string' }, timeout_seconds: { type: 'integer', description: 'Default 120, max 600' } },
    required: ['command'],
    approval: true,
    async run(ctx, a) {
      const meta = ctx.requireProject();
      if (!a.command?.trim()) throw fail('Empty command.');
      const argv = WIN ? ['cmd.exe', '/d', '/s', '/c', a.command] : [existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh', '-c', a.command];
      const env = { ...childEnv(os.tmpdir()), CI: '1', PYTHONUNBUFFERED: '1' };
      const r = await exec(argv, { cwd: dirOf(meta), env, timeoutMs: Math.min(600, Math.max(5, a.timeout_seconds || 120)) * 1000, signal: ctx.signal });
      const out = `${r.stdout}${r.stderr ? `${r.stdout ? '\n' : ''}[stderr]\n${r.stderr}` : ''}`.trim();
      ctx.detail = { kind: 'command', command: a.command, output: out.slice(-12000), exitCode: r.exitCode, timedOut: r.timedOut };
      return `${r.timedOut ? 'Timed out' : `Exit code ${r.exitCode}`}${r.truncated ? ' (output truncated)' : ''}\n${clip(out || '(no output)', MAX_RESULT)}`;
    },
  },
  git_status: {
    description: 'Show files changed since the last commit (or, for a folder without git, since it was opened).',
    params: {},
    async run(ctx) {
      const meta = ctx.requireProject();
      const { list } = await changes(meta);
      return list.length ? list.map((c) => `${c.status.padEnd(9)} ${c.path}`).join('\n') : 'No uncommitted changes.';
    },
  },
  commit_and_push: {
    description: 'Commit all changed files and push them to the current branch on GitHub (for a folder: git commit, then git push if it has a remote).',
    params: { message: { type: 'string', description: 'Clear, imperative commit message, e.g. "Add CSV export"' } },
    required: ['message'],
    approval: true,
    async run(ctx, a) {
      if (isFolder(ctx.requireProject())) return commitFolder(ctx.requireProject(), a.message);
      const meta = ctx.requireProject({ github: true });
      const { list, now } = await changes(meta);
      if (!list.length) return 'Nothing to commit.';
      const root = dirOf(meta);
      const payload = [];
      for (const c of list) {
        if (c.status === 'deleted') { payload.push({ path: c.path, delete: true }); continue; }
        const full = path.join(root, c.path);
        const buf = await fs.readFile(full);
        const executable = !WIN && ((await fs.stat(full)).mode & 0o111) !== 0;
        const text = !buf.subarray(0, 8000).includes(0) && Buffer.from(buf.toString('utf8'), 'utf8').equals(buf);
        payload.push(text ? { path: c.path, content: buf.toString('utf8'), executable } : { path: c.path, base64: buf.toString('base64'), executable });
      }
      const res = await github.commit(meta.owner, meta.repo, meta.branch, a.message, payload);
      meta.base = now;
      meta.updatedAt = Date.now();
      await writeMeta(meta);
      return `Pushed commit ${res.sha.slice(0, 7)} to ${meta.id}@${meta.branch} with ${list.length} file(s): ${list.map((c) => `${c.status} ${c.path}`).join(', ')}. ${res.url}`;
    },
  },
  open_pull_request: {
    description: 'Open a pull request from the current branch into the default branch (push first).',
    params: { title: { type: 'string' }, body: { type: 'string' } },
    required: ['title'],
    approval: true,
    async run(ctx, a) {
      const meta = ctx.requireProject();
      if (isFolder(meta) && !meta.owner) throw fail('This folder is not linked to a GitHub repository (no GitHub "origin" remote), so there is nothing to open a pull request on.');
      if (!isFolder(meta)) ctx.requireProject({ github: true });
      if (meta.branch === meta.defaultBranch) throw fail('You are on the default branch. Create a branch, commit_and_push, then open the pull request.');
      const pr = await github.createPull(meta.owner, meta.repo, { title: a.title, body: a.body || '', head: meta.branch, base: meta.defaultBranch });
      return `Opened pull request #${pr.number}: ${pr.url}`;
    },
  },
  ask_advisor: {
    description: 'Ask a stronger model (claude or copilot) ONE short, self-contained question when you are genuinely unsure. Costs money; use sparingly.',
    params: { advisor: { type: 'string', enum: ['claude', 'copilot'] }, question: { type: 'string' } },
    required: ['advisor', 'question'],
    async run(ctx, a) {
      const r = await advisors.ask({ advisor: a.advisor, question: a.question });
      ctx.detail = { kind: 'advisor', advisor: a.advisor, question: a.question, answer: r.answer, usage: r.usage };
      return r.answer;
    },
  },
};

async function commitFolder(meta, message) {
  if (!meta.git) throw fail('This folder is not a git repository, so there is nothing to commit to. The changes are already saved in the folder; tell the user that instead.');
  if (!(await gitChanges(meta.dir)).length) return 'Nothing to commit.';
  await git(meta.dir, ['add', '-A']);
  try {
    await git(meta.dir, ['commit', '-m', message]);
  } catch (err) {
    if (/user\.(name|email)|Please tell me who you are/i.test(err.message)) throw fail('git doesn\'t know who you are yet. Ask the user to run: git config --global user.name "Their Name" and git config --global user.email "them@example.com"');
    throw err;
  }
  const sha = await git(meta.dir, ['rev-parse', '--short', 'HEAD']);
  const stat = await git(meta.dir, ['show', '--stat', '--format=', 'HEAD']).catch(() => '');
  meta.updatedAt = Date.now();
  await writeMeta(meta);
  const remote = await git(meta.dir, ['remote']).catch(() => '');
  if (!remote.split('\n').includes('origin')) return `Committed ${sha} on ${meta.branch}. The folder has no "origin" remote, so nothing was pushed.\n${stat}`;
  try {
    await git(meta.dir, ['push', '-u', 'origin', 'HEAD'], { timeoutMs: 180000 });
  } catch (err) {
    return `Committed ${sha} on ${meta.branch}, but pushing failed: ${err.message}\nThe commit is safe locally; the user can push it themselves.`;
  }
  return `Committed ${sha} and pushed ${meta.branch} to origin.\n${stat}`;
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n / 2)}\n… [${s.length - n} characters trimmed] …\n${s.slice(-n / 2)}` : s);

function toolSchemas(names) {
  return names.map((name) => {
    const t = TOOLS[name];
    return {
      type: 'function',
      function: { name, description: t.description, parameters: { type: 'object', properties: t.params, required: t.required || [] } },
    };
  });
}

// One-line summary of a tool call, for the transcript and approval prompts.
export function describeCall(name, a = {}) {
  switch (name) {
    case 'create_repository': return `Create ${a.private === false ? 'public' : 'private'} repository "${a.name}"`;
    case 'open_folder': return `Open the folder ${a.path}`;
    case 'open_repository': return `Open ${a.full_name}${a.branch ? ` (${a.branch})` : ''}`;
    case 'create_branch': return `Create branch ${a.name}`;
    case 'list_files': return `List files${a.path ? ` in ${a.path}` : ''}`;
    case 'read_file': return `Read ${a.path}`;
    case 'write_file': return `Write ${a.path}`;
    case 'edit_file': return `Edit ${a.path}`;
    case 'delete_file': return `Delete ${a.path}`;
    case 'search_files': return `Search for /${a.pattern}/`;
    case 'run_command': return `Run: ${a.command}`;
    case 'git_status': return 'Check changes';
    case 'commit_and_push': return `Commit & push: "${a.message}"`;
    case 'open_pull_request': return `Open pull request "${a.title}"`;
    case 'ask_advisor': return `Ask ${a.advisor === 'copilot' ? 'Copilot' : 'Claude'}: ${a.question}`;
    case 'list_repositories': return 'List repositories';
    default: return name;
  }
}

// ---------- prompts ----------
const SYSTEM = `You are Edean's coding agent. The user tells you what they want; you do the work yourself with tools, the way an experienced engineer works in an editor and terminal.

How you work:
1. Understand the request. If no project is open: for code on the user's computer, open_folder with its full path; for a GitHub repository, list_repositories then open_repository; for something new, create_repository (short, lowercase, hyphenated name).
2. Look before you change: list_files, read_file and search_files on the relevant parts.
3. Make changes with write_file (new files or full rewrites) and edit_file (small exact replacements). Write complete, working code: no placeholders or "TODO: implement". Add a README for new projects explaining how to run it.
4. Verify: run the program or its tests with run_command, read the output, and fix problems until it works. Install dependencies with the project's own tools when needed.
5. When the work is done and verified, commit_and_push with a clear message. For an existing GitHub repository, work on a new branch (create_branch) and open_pull_request after pushing, unless the user asked you to push directly. For a repository you just created, pushing to its default branch is fine. For a folder on the user's computer, your edits are already saved in place: only commit if the user asked you to, and never push unless they asked.
6. Finish with a short summary for the user: what you built or changed, how to run it, and anything left to do. Don't call a tool in that final message.

Rules:
- If you were given an implementation plan, follow it step by step. If a step turns out to be wrong, adapt sensibly and mention it in your summary.
- One tool call at a time; wait for each result. Never invent results.
- If a tool fails, read the error and adapt; don't repeat the same failing call.
- Paths are relative to the project root.
- Don't ask the user for permission for normal steps; Edean asks them itself when needed. Only ask the user a question if the request is genuinely ambiguous, then stop and wait.
- Keep messages between tool calls to a sentence or two.`;

function textProtocol(names) {
  const lines = names.map((n) => {
    const t = TOOLS[n];
    const args = Object.entries(t.params).map(([k, v]) => `${k}${(t.required || []).includes(k) ? '' : '?'}: ${v.type}`).join(', ');
    return `- ${n}(${args}): ${t.description}`;
  });
  return `To use a tool, reply with ONE block like this and nothing after it:
<tool>{"name": "write_file", "arguments": {"path": "app.py", "content": "print('hi')\\n"}}</tool>
The arguments must be valid JSON (escape newlines in strings as \\n). You'll get the result back, then continue.
Tools:
${lines.join('\n')}`;
}

function parseTextCall(content) {
  const tagged = content.match(/<tool>\s*([\s\S]*?)\s*<\/tool>/);
  let raw = tagged?.[1];
  if (!raw) {
    const trimmed = content.trim().replace(/^```(?:json)?\s*|\s*```$/g, '');
    if (trimmed.startsWith('{') && /"name"\s*:/.test(trimmed)) raw = trimmed;
  }
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, ''));
    if (typeof obj.name !== 'string') return null;
    const args = typeof obj.arguments === 'string' ? JSON.parse(obj.arguments) : obj.arguments || obj.parameters || {};
    return { name: obj.name, args, before: tagged ? content.slice(0, tagged.index).trim() : '' };
  } catch {
    return { name: '__invalid__', args: {}, before: '' };
  }
}

// ---------- model ----------
const noNativeTools = new Set(); // models whose backend rejected the tools parameter

async function callModel(cfg, { model, messages, tools, signal }) {
  const clean = messages.map((m) => ({
    role: m.role, content: m.content ?? '',
    ...(m.tool_calls ? { tool_calls: m.tool_calls } : {}), ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
  }));
  const body = { model, messages: clean, temperature: 0.2, stream: false };
  if (tools) body.tools = tools;
  const r = await fetch(`${cfg.llmBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cfg.llmApiKey ? { Authorization: `Bearer ${cfg.llmApiKey}` } : {}) },
    body: JSON.stringify(body),
    signal,
  }).catch((err) => {
    if (signal?.aborted) throw err;
    throw fail(`Couldn't reach the AI model at ${cfg.llmBaseUrl}. Is it running? (Check System check.)`, 502);
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    const err = fail(`Model backend error ${r.status}: ${text.slice(0, 300)}`, 502);
    if (tools && /tool/i.test(text)) err.toolsUnsupported = true;
    throw err;
  }
  const data = await r.json();
  return data.choices?.[0]?.message || { content: '' };
}

function compact(messages) {
  // Keep long sessions within a local model's context: trim old tool output first.
  const size = () => messages.reduce((n, m) => n + (m.content?.length || 0) + JSON.stringify(m.tool_calls || '').length, 0);
  for (let i = 1; i < messages.length - 8 && size() > 60000; i++) {
    const m = messages[i];
    if ((m.role === 'tool' || m.toolResult) && m.content.length > 400) m.content = `${m.content.slice(0, 300)}\n… [older output trimmed]`;
    if (m.role === 'assistant' && m.tool_calls) {
      for (const tc of m.tool_calls) if (tc.function.arguments.length > 2000) tc.function.arguments = JSON.stringify({ note: 'trimmed', path: safeJson(tc.function.arguments).path });
    }
  }
}
const safeJson = (s) => { try { return JSON.parse(s); } catch { return {}; } };

// ---------- run ----------
let current = null; // { id, controller, approvals: Map }

export function activeRun() { return current ? { id: current.id } : null; }

export function stopRun(id) {
  if (current && (!id || current.id === id)) current.controller.abort();
}

export function answerApproval(runId, approvalId, decision) {
  if (!current || current.id !== runId) return false;
  const resolve = current.approvals.get(approvalId);
  if (!resolve) return false;
  current.approvals.delete(approvalId);
  resolve(decision);
  return true;
}

// Runs one instruction to completion. `send(event)` streams progress to the browser.
export async function runAgent(cfg, { task, history = [], project, model, autonomy = 'ask', plan = true, review = false }, send) {
  if (current) throw fail('The agent is already working. Stop it first.', 409);
  const controller = new AbortController();
  const run = { id: crypto.randomUUID(), controller, approvals: new Map() };
  current = run;
  let meta = project ? await readMeta(project) : null;
  let allowAll = autonomy === 'auto';
  const ghStatus = await github.status().catch(() => ({ connected: false }));
  const adv = await advisors.advisorStatus().catch(() => null);

  const names = Object.keys(TOOLS).filter((n) => n !== 'ask_advisor' || adv?.claude?.configured || adv?.copilot?.configured);
  const tools = await detectTools().catch(() => ({}));
  const toolchains = Object.entries(tools).filter(([, t]) => t.found).map(([id, t]) => `${id} (${t.version})`).join(', ');
  const useNative = () => !noNativeTools.has(model);
  const backups = makeBackups(run.id, task);
  let planText = '';

  const context = () => [
    `Environment: ${WIN ? 'Windows (commands run in cmd.exe)' : process.platform === 'darwin' ? 'macOS (bash)' : 'Linux (bash)'}. Installed toolchains: ${toolchains || 'unknown'}.`,
    `GitHub: ${ghStatus.connected ? `connected as ${ghStatus.login}` : 'not connected (only local projects are possible)'}.`,
    !meta ? 'No project is open yet.'
      : isFolder(meta) ? `Current project: the folder ${meta.dir} on the user's computer (edited in place)${meta.git ? `; git repository on branch ${meta.branch}${meta.owner ? `, GitHub ${meta.owner}/${meta.repo}` : ', no GitHub remote'}` : '; not a git repository'}.`
        : `Current project: ${meta.id} on branch ${meta.branch} (default branch ${meta.defaultBranch})${meta.local ? ', local only' : ''}. Folder: ${dirOf(meta)}`,
  ].join('\n');

  const system = () => [SYSTEM, context(), useNative() ? '' : textProtocol(names)].filter(Boolean).join('\n\n');
  const messages = [{ role: 'system', content: system() }, ...history.slice(-12).map((h) => ({ role: h.role === 'user' ? 'user' : 'assistant', content: String(h.content || '').slice(0, 4000) })), { role: 'user', content: task }];

  const ctx = {
    signal: controller.signal,
    detail: null,
    setProject(m) { meta = m; send({ type: 'project', project: projectInfo(m) }); },
    backup: (m, rel, full) => backups.save(m, rel, full),
    requireProject({ github: needsGithub = false } = {}) {
      if (!meta) throw fail('No project is open. Use create_repository or open_repository first.');
      if (needsGithub && meta.local) throw fail('This is a local-only project. Connect GitHub and create a repository to publish it.');
      return meta;
    },
  };

  async function approve(name, args) {
    if (allowAll || !TOOLS[name].approval) return true;
    const id = crypto.randomUUID();
    send({ type: 'approval', id, name, text: describeCall(name, args), args: name === 'run_command' ? { command: args.command } : args });
    const decision = await new Promise((resolve) => {
      run.approvals.set(id, resolve);
      controller.signal.addEventListener('abort', () => resolve('deny'), { once: true });
    });
    if (decision === 'allow_all') allowAll = true;
    send({ type: 'approval_done', id, decision });
    return decision !== 'deny';
  }

  async function execute(name, args) {
    const tool = TOOLS[name];
    const id = crypto.randomUUID();
    if (!tool || !names.includes(name)) return { id, text: `Unknown tool "${name}". Available: ${names.join(', ')}` };
    send({ type: 'tool', id, name, text: describeCall(name, args) });
    if (!(await approve(name, args))) {
      send({ type: 'tool_result', id, ok: false, summary: 'Not allowed by you' });
      return { id, text: 'The user declined this action. Do not try it again; continue another way or ask the user.' };
    }
    ctx.detail = null;
    try {
      const out = await tool.run(ctx, args || {});
      send({ type: 'tool_result', id, ok: true, summary: out.split('\n')[0].slice(0, 200), detail: ctx.detail || { kind: 'text', text: clip(out, 6000) } });
      return { id, text: clip(out, MAX_RESULT) };
    } catch (err) {
      if (controller.signal.aborted) throw err;
      send({ type: 'tool_result', id, ok: false, summary: err.message.slice(0, 300) });
      return { id, text: `Error: ${err.message}` };
    }
  }

  // Ask the advisor HOW to do the job before writing any code.
  async function makePlan() {
    const who = await advisors.plannerAvailable().catch(() => null);
    if (!who) { send({ type: 'status', text: 'Planning skipped: add an Anthropic API key (or connect GitHub for Copilot) in Settings → Advisors.' }); return; }
    const name = who === 'claude' ? 'Claude' : 'Copilot';
    send({ type: 'status', text: `Asking ${name} how to do this…` });
    try {
      const r = await Promise.race([
        advisors.plan({ task: planTask(), context: await planContext(meta, task) }),
        new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(fail('Stopped.')), { once: true })),
      ]);
      planText = r.answer;
      send({ type: 'plan', advisor: who, model: r.model, text: planText, usage: r.usage });
      messages.push({ role: 'user', content: `Here is the implementation plan from ${name}, a senior engineer. Follow it step by step, doing the work yourself with the tools, then verify and summarize.\n\n${planText}` });
    } catch (err) {
      if (controller.signal.aborted) throw err;
      send({ type: 'status', text: `${name} couldn't make a plan (${err.message}). Working without one.` });
    }
  }

  // Ask the advisor to check the finished changes. Returns problems to fix, or ''.
  async function getReview() {
    if (!backups.count || !(await advisors.plannerAvailable().catch(() => null))) return '';
    const diff = await diffForRun(backups);
    if (!diff.trim()) return '';
    send({ type: 'status', text: 'Asking for a review of the changes…' });
    try {
      const r = await advisors.review({ task, planText, diff });
      const ok = /^\s*\**LGTM\b/i.test(r.answer);
      send({ type: 'review', advisor: r.advisor, model: r.model, text: r.answer, ok, usage: r.usage });
      return ok ? '' : r.answer;
    } catch (err) {
      if (controller.signal.aborted) throw err;
      send({ type: 'status', text: `The review didn't work (${err.message}).` });
      return '';
    }
  }
  let reviewed = false;
  // A follow-up like "now add tests" needs the earlier turns to make sense.
  const planTask = () => {
    const recent = history.slice(-4).map((h) => `${h.role === 'user' ? 'User' : 'Agent'}: ${String(h.content || '').slice(0, 1500)}`);
    return recent.length ? `${task}\n\n(Earlier in this conversation:\n${recent.join('\n')})` : task;
  };

  try {
    if (plan) await makePlan();
    for (let step = 0; step < MAX_STEPS; step++) {
      messages[0].content = system();
      compact(messages);
      let msg;
      try {
        msg = await callModel(cfg, { model, messages, tools: useNative() ? toolSchemas(names) : null, signal: controller.signal });
      } catch (err) {
        if (err.toolsUnsupported && useNative()) {
          noNativeTools.add(model);
          send({ type: 'status', text: 'This model has no built-in tool support; switching to text commands.' });
          step--;
          continue;
        }
        throw err;
      }
      const content = (msg.content || '').trim();

      if (msg.tool_calls?.length) {
        if (content) send({ type: 'assistant', text: content });
        messages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
        for (const tc of msg.tool_calls) {
          const args = typeof tc.function.arguments === 'string' ? safeJson(tc.function.arguments) : tc.function.arguments || {};
          const res = await execute(tc.function.name, args);
          messages.push({ role: 'tool', tool_call_id: tc.id, content: res.text });
        }
        continue;
      }

      const call = parseTextCall(content);
      if (call) {
        if (call.before) send({ type: 'assistant', text: call.before });
        messages.push({ role: 'assistant', content });
        const res = call.name === '__invalid__'
          ? { text: 'Your <tool> block was not valid JSON. Send it again with valid JSON (escape newlines as \\n).' }
          : await execute(call.name, call.args);
        messages.push({ role: 'user', content: `<tool_result>\n${res.text}\n</tool_result>`, toolResult: true });
        noNativeTools.add(model); // the model prefers text commands; stay consistent with them
        continue;
      }

      // No tool call: this is the agent's answer for this instruction.
      if (review && !reviewed) {
        reviewed = true;
        const problems = await getReview();
        if (problems) {
          if (content) send({ type: 'assistant', text: content });
          messages.push({ role: 'assistant', content: content || 'Done.' });
          messages.push({ role: 'user', content: `A senior engineer reviewed your changes and found these problems. Fix them, verify, then give your final summary:\n\n${problems}` });
          continue;
        }
      }
      send({ type: 'done', text: content || 'Done.', project: meta ? projectInfo(meta) : null, changed: backups.count });
      return;
    }
    send({ type: 'done', text: `I stopped after ${MAX_STEPS} steps. Tell me to continue if there's more to do.`, stoppedEarly: true, changed: backups.count });
  } catch (err) {
    if (controller.signal.aborted) send({ type: 'done', text: 'Stopped.', stopped: true, changed: backups.count });
    else send({ type: 'error', message: err.message, changed: backups.count });
  } finally {
    pruneBackups().catch(() => {});
    for (const resolve of run.approvals.values()) resolve('deny');
    if (current === run) current = null;
  }
}

const projectInfo = (m) => ({ id: m.id, kind: m.kind || 'repo', name: m.name || m.id, dir: dirOf(m), branch: m.branch || '', local: !!m.local, git: isFolder(m) ? !!m.git : true, htmlUrl: m.htmlUrl || '' });

export async function projectInfoFor(id) {
  const meta = await readMeta(id);
  if (!meta) throw fail('Unknown project.', 404);
  return projectInfo(meta);
}

export async function projectChanges(id) {
  const meta = await readMeta(id);
  if (!meta) throw fail('Unknown project.', 404);
  return (await changes(meta)).list;
}

// Exposed for tests.
export const _internals = { unzip, gitignoreMatcher, parseTextCall, inProject, lineDiff, forbiddenFolder };
