// GitHub access for the Workspace: browse repos, branches and files, commit
// changes, open pull requests, and list dependencies. Uses a personal access
// token kept in ~/.edean/github.json (readable only by you); the browser never sees it.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DATA_DIR = () => process.env.EDEAN_DATA_DIR || path.join(os.homedir(), '.edean');
const FILE = () => path.join(DATA_DIR(), 'github.json');
const API = () => (process.env.GITHUB_API_BASE || 'https://api.github.com').replace(/\/+$/, '');

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
let settings = null;

async function load() {
  if (settings) return settings;
  try { settings = JSON.parse(await fs.readFile(FILE(), 'utf8')); } catch { settings = {}; }
  return settings;
}

async function persist() {
  await fs.mkdir(DATA_DIR(), { recursive: true, mode: 0o700 });
  await fs.writeFile(FILE(), JSON.stringify(settings, null, 2), { mode: 0o600 });
  await fs.chmod(FILE(), 0o600).catch(() => {});
}

export async function githubToken() {
  await load();
  return process.env.EDEAN_GITHUB_TOKEN || settings.token || '';
}

async function gh(method, pathname, { json, token, raw = false, accept } = {}) {
  token ||= await githubToken();
  if (!token) throw fail('Connect GitHub first.', 409);
  const r = await fetch(`${API()}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: accept || 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'Edean',
      ...(json ? { 'Content-Type': 'application/json' } : {}),
    },
    body: json ? JSON.stringify(json) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  if (raw) {
    if (!r.ok) throw fail(`GitHub error ${r.status}`, r.status === 404 ? 404 : 502);
    return r;
  }
  const data = r.status === 204 ? null : await r.json().catch(() => null);
  if (!r.ok) {
    const msg = data?.message || r.statusText;
    if (r.status === 401) throw fail('GitHub rejected the token. Reconnect GitHub with a valid token.', 401);
    if (r.status === 403 && /rate limit/i.test(msg)) throw fail('GitHub rate limit reached. Try again in a little while.', 429);
    if (r.status === 404) throw fail(`Not found on GitHub (or the token can't access it): ${pathname.split('?')[0]}`, 404);
    throw fail(`GitHub: ${msg}${data?.errors ? ` (${data.errors.map((e) => e.message || e.code).join(', ')})` : ''}`, r.status === 409 || r.status === 422 ? 409 : 502);
  }
  return data;
}

// ---------- validation ----------
const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
function repoPath(owner, repo) {
  if (!NAME.test(owner || '') || !NAME.test(repo || '')) throw fail('Invalid repository name.');
  return `/repos/${owner}/${repo}`;
}
export function validBranch(name) {
  return typeof name === 'string' && name.length <= 200 && /^[A-Za-z0-9._\/-]+$/.test(name) &&
    !name.includes('..') && !name.startsWith('/') && !name.endsWith('/') && !name.endsWith('.lock') && !name.startsWith('-');
}
function ref(name) {
  if (!validBranch(name)) throw fail(`Invalid branch name "${name}".`);
  return name.split('/').map(encodeURIComponent).join('/');
}
function filePath(p) {
  if (typeof p !== 'string' || !p || p.startsWith('/') || p.split('/').some((s) => !s || s === '.' || s === '..')) throw fail(`Invalid file path "${p}".`);
  return p;
}
const encPath = (p) => p.split('/').map(encodeURIComponent).join('/');

// ---------- connection ----------
export async function status() {
  await load();
  const token = await githubToken();
  if (!token) return { connected: false };
  return { connected: true, login: settings.login || '', name: settings.name || '', avatar: settings.avatar || '', fromEnv: !!process.env.EDEAN_GITHUB_TOKEN };
}

export async function connect(token) {
  await load();
  token = String(token || '').trim();
  if (!/^(gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}$/.test(token)) throw fail('That doesn\'t look like a GitHub token (it starts with github_pat_ or ghp_).');
  const user = await gh('GET', '/user', { token });
  Object.assign(settings, { token, login: user.login, name: user.name || '', avatar: user.avatar_url || '' });
  await persist();
  return status();
}

export async function disconnect() {
  await load();
  settings = {};
  await persist();
}

// ---------- repos ----------
export async function listRepos() {
  const repos = await gh('GET', '/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member');
  return repos.map((r) => ({
    owner: r.owner.login, name: r.name, fullName: r.full_name, private: r.private, description: r.description || '',
    defaultBranch: r.default_branch, pushedAt: r.pushed_at, canPush: !!r.permissions?.push, language: r.language || '',
  }));
}

export async function repoInfo(owner, repo) {
  const r = await gh('GET', repoPath(owner, repo));
  return {
    owner: r.owner.login, name: r.name, fullName: r.full_name, private: r.private, description: r.description || '',
    defaultBranch: r.default_branch, htmlUrl: r.html_url, canPush: !!r.permissions?.push, language: r.language || '',
  };
}

export async function branches(owner, repo) {
  const list = await gh('GET', `${repoPath(owner, repo)}/branches?per_page=100`);
  return list.map((b) => ({ name: b.name, sha: b.commit.sha, protected: !!b.protected }));
}

export async function createBranch(owner, repo, name, from) {
  if (!validBranch(name)) throw fail(`"${name}" isn't a valid branch name.`);
  const base = await gh('GET', `${repoPath(owner, repo)}/git/ref/heads/${ref(from)}`);
  await gh('POST', `${repoPath(owner, repo)}/git/refs`, { json: { ref: `refs/heads/${name}`, sha: base.object.sha } });
  return { name, sha: base.object.sha };
}

export async function tree(owner, repo, branch) {
  const data = await gh('GET', `${repoPath(owner, repo)}/git/trees/${ref(branch)}?recursive=1`);
  return {
    truncated: !!data.truncated,
    entries: data.tree.filter((e) => e.type === 'blob' || e.type === 'tree')
      .map((e) => ({ path: e.path, type: e.type === 'tree' ? 'dir' : 'file', size: e.size || 0, sha: e.sha })),
  };
}

export async function readFile(owner, repo, p, branch) {
  filePath(p);
  const meta = await gh('GET', `${repoPath(owner, repo)}/contents/${encPath(p)}?ref=${encodeURIComponent(branch)}`);
  if (Array.isArray(meta) || meta.type !== 'file') throw fail(`${p} is not a file.`);
  let buf;
  if (meta.content && meta.encoding === 'base64') buf = Buffer.from(meta.content, 'base64');
  else {
    // Files over 1 MB come back without content; fetch the blob instead.
    const blob = await gh('GET', `${repoPath(owner, repo)}/git/blobs/${meta.sha}`);
    buf = Buffer.from(blob.content, 'base64');
  }
  const binary = buf.subarray(0, 8000).includes(0);
  return { path: p, sha: meta.sha, size: meta.size, binary, content: binary ? '' : buf.toString('utf8') };
}

// One commit with any number of file changes: { path, content } writes, { path, delete: true } removes.
export async function commit(owner, repo, branch, message, changes) {
  if (!message?.trim()) throw fail('Write a commit message.');
  if (!Array.isArray(changes) || !changes.length) throw fail('There are no changes to commit.');
  const rp = repoPath(owner, repo);
  const head = await gh('GET', `${rp}/git/ref/heads/${ref(branch)}`);
  const parent = await gh('GET', `${rp}/git/commits/${head.object.sha}`);
  const entries = changes.map((c) => {
    filePath(c.path);
    if (c.delete) return { path: c.path, mode: '100644', type: 'blob', sha: null };
    if (typeof c.content !== 'string') throw fail(`No content for ${c.path}.`);
    return { path: c.path, mode: '100644', type: 'blob', content: c.content };
  });
  const newTree = await gh('POST', `${rp}/git/trees`, { json: { base_tree: parent.tree.sha, tree: entries } });
  const created = await gh('POST', `${rp}/git/commits`, { json: { message: message.trim(), tree: newTree.sha, parents: [head.object.sha] } });
  await gh('PATCH', `${rp}/git/refs/heads/${ref(branch)}`, { json: { sha: created.sha } });
  return { sha: created.sha, url: created.html_url || '' };
}

export async function commits(owner, repo, branch) {
  const list = await gh('GET', `${repoPath(owner, repo)}/commits?sha=${encodeURIComponent(branch)}&per_page=20`);
  return list.map((c) => ({
    sha: c.sha, message: c.commit.message.split('\n')[0], author: c.commit.author?.name || c.author?.login || '',
    date: c.commit.author?.date || '', url: c.html_url,
  }));
}

export async function pulls(owner, repo) {
  const list = await gh('GET', `${repoPath(owner, repo)}/pulls?state=open&per_page=30`);
  return list.map((p) => ({ number: p.number, title: p.title, head: p.head.ref, base: p.base.ref, url: p.html_url, draft: !!p.draft, author: p.user?.login || '' }));
}

export async function createPull(owner, repo, { title, head, base, body }) {
  if (!title?.trim()) throw fail('Give the pull request a title.');
  if (!validBranch(head) || !validBranch(base)) throw fail('Invalid branch.');
  const p = await gh('POST', `${repoPath(owner, repo)}/pulls`, { json: { title: title.trim(), head, base, body: body || '' } });
  return { number: p.number, url: p.html_url };
}

// Dependencies from GitHub's dependency graph, or from common manifest files if that's unavailable.
export async function dependencies(owner, repo, branch) {
  try {
    const data = await gh('GET', `${repoPath(owner, repo)}/dependency-graph/sbom`);
    const self = `${owner}/${repo}`.toLowerCase();
    const packages = (data.sbom?.packages || [])
      .map((p) => {
        const purl = p.externalRefs?.find((r) => r.referenceType === 'purl')?.referenceLocator || '';
        const ecosystem = (purl.match(/^pkg:([^/]+)/) || [])[1] || '';
        return { name: p.name, version: p.versionInfo || '', ecosystem };
      })
      .filter((p) => p.name && !p.name.toLowerCase().endsWith(self) && p.ecosystem !== 'github');
    if (packages.length) return { source: 'GitHub dependency graph', packages };
  } catch { /* fall back to manifests */ }
  const packages = [];
  const tryFile = async (p) => { try { return (await readFile(owner, repo, p, branch)).content; } catch { return null; } };
  const pkg = await tryFile('package.json');
  if (pkg) {
    try {
      const j = JSON.parse(pkg);
      for (const [section, dev] of [['dependencies', false], ['devDependencies', true]]) {
        for (const [name, version] of Object.entries(j[section] || {})) packages.push({ name, version, ecosystem: 'npm', dev });
      }
    } catch { /* invalid JSON */ }
  }
  const req = await tryFile('requirements.txt');
  if (req) {
    for (const line of req.split('\n')) {
      const m = line.trim().match(/^([A-Za-z0-9_.\-\[\]]+)\s*([=<>!~].*)?$/);
      if (m && !line.trim().startsWith('#')) packages.push({ name: m[1], version: (m[2] || '').trim(), ecosystem: 'pypi' });
    }
  }
  const gomod = await tryFile('go.mod');
  if (gomod) {
    for (const m of gomod.matchAll(/^\s*([\w./-]+\.[\w./-]+)\s+(v[\w.+-]+)/gm)) packages.push({ name: m[1], version: m[2], ecosystem: 'golang' });
  }
  const cargo = await tryFile('Cargo.toml');
  if (cargo) {
    const section = cargo.split(/^\[dependencies\]\s*$/m)[1]?.split(/^\[/m)[0] || '';
    for (const m of section.matchAll(/^([\w-]+)\s*=\s*(?:"([^"]+)"|\{[^}]*version\s*=\s*"([^"]+)")/gm)) packages.push({ name: m[1], version: m[2] || m[3] || '', ecosystem: 'cargo' });
  }
  return { source: packages.length ? 'manifest files' : 'none found', packages };
}

// Streams a ZIP of the branch (GitHub's archive), for "Download repository".
export async function zipball(owner, repo, branch) {
  return gh('GET', `${repoPath(owner, repo)}/zipball/${ref(branch)}`, { raw: true });
}

export function _reset() { settings = null; }
