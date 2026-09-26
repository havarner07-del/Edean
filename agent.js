// Edean's coding agent: you describe what you want; it creates or opens a GitHub
// repository, writes and edits the files, runs commands and tests, fixes what's
// broken, commits and pushes, and reports back — like a pair programmer at a terminal.
//
// Work happens in a local project folder (~/.edean/projects/<owner>/<repo>) that is
// synced from GitHub; commits go back through the GitHub API, so git isn't required.
// By default Edean asks you before running commands, creating repositories, pushing,
// and opening pull requests; you can let it work fully on its own instead.

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import * as github from './github.js';
import * as advisors from './advisors.js';
import { exec, childEnv } from './runner.js';
import { detectTools } from './toolchains.js';

const WIN = process.platform === 'win32';
const DATA_DIR = () => process.env.EDEAN_DATA_DIR || path.join(os.homedir(), '.edean');
const PROJECTS = () => path.join(DATA_DIR(), 'projects');
const META = () => path.join(PROJECTS(), '.meta');
const MAX_STEPS = 60;
const MAX_FILES = 5000;
const MAX_RESULT = 8000;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

// ---------- projects ----------
const IGNORE_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv', 'venv', '.mypy_cache', '.pytest_cache', '.idea', '.gradle', 'target', '.next']);
const IGNORE_FILES = /(^\.DS_Store$|\.pyc$|^Thumbs\.db$)/;

const metaFile = (id) => path.join(META(), `${id.replace('/', '__')}.json`);
export const projectDir = (id) => path.join(PROJECTS(), ...id.split('/'));

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
      out.push({ id: m.id, branch: m.branch, local: !!m.local, defaultBranch: m.defaultBranch, htmlUrl: m.htmlUrl || '', dir: projectDir(m.id), updatedAt: m.updatedAt || 0 });
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
  const dir = projectDir(meta.id);
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
  const dir = projectDir(meta.id);
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
  const root = projectDir(meta.id);
  const full = path.resolve(root, clean || '.');
  if (full !== root && !full.startsWith(root + path.sep)) throw fail(`${p} is outside the project folder.`);
  if (clean.split('/').includes('.git')) throw fail('The .git folder is off limits.');
  return { full, rel: path.relative(root, full).split(path.sep).join('/') };
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
        await fs.mkdir(projectDir(meta.id), { recursive: true });
        await writeMeta(meta);
        ctx.setProject(meta);
        return `GitHub isn't connected, so I created a local project at ${projectDir(meta.id)}. Connect GitHub in the Workspace to publish it later.`;
      }
      const r = await github.createRepo({ name: a.name, description: a.description, private: a.private });
      const meta = { id: r.fullName, owner: r.owner, repo: r.name, branch: r.defaultBranch, defaultBranch: r.defaultBranch, htmlUrl: r.htmlUrl, base: {} };
      // GitHub needs a moment before a brand-new repository's archive is available.
      for (let i = 0; ; i++) {
        try { await syncFromGithub(meta); break; } catch (err) { if (i >= 5) throw err; await new Promise((res) => setTimeout(res, 1500)); }
      }
      ctx.setProject(meta);
      return `Created ${r.private ? 'private' : 'public'} repository ${r.fullName} (${r.htmlUrl}) and opened it. Branch: ${meta.branch}. Local folder: ${projectDir(meta.id)}`;
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
      if (existing && existing.branch === branch && existsSync(projectDir(meta.id))) {
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
  create_branch: {
    description: 'Create a new branch from the current branch on GitHub and switch the project to it. Uncommitted local changes come along.',
    params: { name: { type: 'string', description: 'e.g. "edean/add-login"' } },
    required: ['name'],
    async run(ctx, a) {
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
      const files = await walk(projectDir(meta.id));
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
      const root = projectDir(meta.id);
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
      const r = await exec(argv, { cwd: projectDir(meta.id), env, timeoutMs: Math.min(600, Math.max(5, a.timeout_seconds || 120)) * 1000, signal: ctx.signal });
      const out = `${r.stdout}${r.stderr ? `${r.stdout ? '\n' : ''}[stderr]\n${r.stderr}` : ''}`.trim();
      ctx.detail = { kind: 'command', command: a.command, output: out.slice(-12000), exitCode: r.exitCode, timedOut: r.timedOut };
      return `${r.timedOut ? 'Timed out' : `Exit code ${r.exitCode}`}${r.truncated ? ' (output truncated)' : ''}\n${clip(out || '(no output)', MAX_RESULT)}`;
    },
  },
  git_status: {
    description: 'Show files changed since the last sync or commit.',
    params: {},
    async run(ctx) {
      const meta = ctx.requireProject();
      const { list } = await changes(meta);
      return list.length ? list.map((c) => `${c.status.padEnd(9)} ${c.path}`).join('\n') : 'No uncommitted changes.';
    },
  },
  commit_and_push: {
    description: 'Commit all changed files and push them to the current branch on GitHub.',
    params: { message: { type: 'string', description: 'Clear, imperative commit message, e.g. "Add CSV export"' } },
    required: ['message'],
    approval: true,
    async run(ctx, a) {
      const meta = ctx.requireProject({ github: true });
      const { list, now } = await changes(meta);
      if (!list.length) return 'Nothing to commit.';
      const root = projectDir(meta.id);
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
      const meta = ctx.requireProject({ github: true });
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
1. Understand the request. If no project is open, either open an existing repository (list_repositories, then open_repository) or create a new one with create_repository (short, lowercase, hyphenated name).
2. Look before you change: list_files, read_file and search_files on the relevant parts.
3. Make changes with write_file (new files or full rewrites) and edit_file (small exact replacements). Write complete, working code: no placeholders or "TODO: implement". Add a README for new projects explaining how to run it.
4. Verify: run the program or its tests with run_command, read the output, and fix problems until it works. Install dependencies with the project's own tools when needed.
5. When the work is done and verified, commit_and_push with a clear message. For an existing repository, work on a new branch (create_branch) and open_pull_request after pushing, unless the user asked you to push directly. For a repository you just created, pushing to its default branch is fine.
6. Finish with a short summary for the user: what you built or changed, how to run it, and anything left to do. Don't call a tool in that final message.

Rules:
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
export async function runAgent(cfg, { task, history = [], project, model, autonomy = 'ask' }, send) {
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

  const context = () => [
    `Environment: ${WIN ? 'Windows (commands run in cmd.exe)' : process.platform === 'darwin' ? 'macOS (bash)' : 'Linux (bash)'}. Installed toolchains: ${toolchains || 'unknown'}.`,
    `GitHub: ${ghStatus.connected ? `connected as ${ghStatus.login}` : 'not connected (only local projects are possible)'}.`,
    meta ? `Current project: ${meta.id} on branch ${meta.branch} (default branch ${meta.defaultBranch})${meta.local ? ', local only' : ''}. Folder: ${projectDir(meta.id)}` : 'No project is open yet.',
  ].join('\n');

  const system = () => [SYSTEM, context(), useNative() ? '' : textProtocol(names)].filter(Boolean).join('\n\n');
  const messages = [{ role: 'system', content: system() }, ...history.slice(-12).map((h) => ({ role: h.role === 'user' ? 'user' : 'assistant', content: String(h.content || '').slice(0, 4000) })), { role: 'user', content: task }];

  const ctx = {
    signal: controller.signal,
    detail: null,
    setProject(m) { meta = m; send({ type: 'project', project: { id: m.id, branch: m.branch, local: !!m.local, htmlUrl: m.htmlUrl || '' } }); },
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

  try {
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
      send({ type: 'done', text: content || 'Done.', project: meta ? { id: meta.id, branch: meta.branch } : null });
      return;
    }
    send({ type: 'done', text: `I stopped after ${MAX_STEPS} steps. Tell me to continue if there's more to do.`, stoppedEarly: true });
  } catch (err) {
    if (controller.signal.aborted) send({ type: 'done', text: 'Stopped.', stopped: true });
    else send({ type: 'error', message: err.message });
  } finally {
    for (const resolve of run.approvals.values()) resolve('deny');
    if (current === run) current = null;
  }
}

export async function projectChanges(id) {
  const meta = await readMeta(id);
  if (!meta) throw fail('Unknown project.', 404);
  return (await changes(meta)).list;
}

// Exposed for tests.
export const _internals = { unzip, gitignoreMatcher, parseTextCall, inProject };
