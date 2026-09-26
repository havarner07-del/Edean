// In-app updates.
//
// Desktop app (Edean.exe etc.): compares this build's commit with the "Edean (latest build)"
// release of the Edean repository. If a newer build exists, downloads the file for this
// system, verifies it (size, and SHA-256 when GitHub provides it), swaps it in for the
// running executable and restarts Edean.
//
// From source (a git checkout): fetches the upstream branch, and updates with
// `git pull --ff-only` (plus `npm install` when dependencies changed), then restarts.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { githubToken } from './github.js';
import { isSea } from './toolchains.js';

// Filled in by scripts/build-exe.mjs when the executable is built.
/* global __EDEAN_BUILD__ */
const BUILD = typeof __EDEAN_BUILD__ !== 'undefined' ? __EDEAN_BUILD__ : null;
const APP_ROOT = typeof import.meta.url === 'string' ? path.dirname(fileURLToPath(import.meta.url)) : path.dirname(process.execPath);
const API = () => (process.env.GITHUB_API_BASE || 'https://api.github.com').replace(/\/+$/, '');
const TAG = 'edean-latest';
const ASSET = { win32: 'Edean.exe', darwin: 'Edean-macos', linux: 'edean-linux' };

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

export const updateRepo = () => process.env.EDEAN_UPDATE_REPO || BUILD?.repo || 'havarner07-del/Edean';

// What's running right now.
export function mode(opts = {}) {
  if (opts.mode) return opts.mode;
  if (isSea) return 'app';
  if (fs.existsSync('/.dockerenv')) return 'docker';
  if (fs.existsSync(path.join(APP_ROOT, '.git'))) return 'source';
  return 'unknown';
}

const state = { phase: 'idle', progress: 0, error: '', latest: null, checkedAt: 0 };

function git(args, cwd = APP_ROOT) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(fail(err.code === 'ENOENT' ? 'git is not installed.' : (stderr || err.message).trim(), 502));
      else resolve(stdout.trim());
    });
  });
}

export async function currentVersion(opts = {}) {
  const m = mode(opts);
  if (m === 'app') return { mode: m, sha: opts.build?.sha || BUILD?.sha || 'unknown', builtAt: opts.build?.builtAt || BUILD?.builtAt || '' };
  if (m === 'source') {
    try {
      const [sha, branch, date] = await Promise.all([git(['rev-parse', 'HEAD']), git(['rev-parse', '--abbrev-ref', 'HEAD']), git(['log', '-1', '--format=%cI'])]);
      return { mode: m, sha, branch, builtAt: date };
    } catch (err) {
      return { mode: m, sha: 'unknown', builtAt: '', error: err.message };
    }
  }
  return { mode: m, sha: BUILD?.sha || 'unknown', builtAt: BUILD?.builtAt || '' };
}

async function gh(pathname, { accept } = {}) {
  const token = await githubToken().catch(() => '');
  const r = await fetch(`${API()}${pathname}`, {
    headers: {
      Accept: accept || 'application/vnd.github+json', 'User-Agent': 'Edean-updater', 'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(accept ? 30 * 60 * 1000 : 20000),
  });
  if (r.status === 404) {
    throw fail(`No "Edean (latest build)" release found in ${updateRepo()}.${token ? '' : ' If the repository is private, connect GitHub in the Workspace (the token needs Contents: read).'}`, 404);
  }
  if (!r.ok) throw fail(`GitHub responded ${r.status} while checking for updates.`, 502);
  return r;
}

export async function check(opts = {}) {
  const current = await currentVersion(opts);
  state.phase = state.phase === 'error' ? 'idle' : state.phase;
  state.error = '';
  if (current.mode === 'docker') {
    state.latest = null;
    return { current, available: false, note: 'Running in Docker: update with `docker compose pull && docker compose up -d --build`.' };
  }
  if (current.mode === 'source') {
    await git(['fetch', '--quiet']);
    const upstream = await git(['rev-parse', '@{u}']).catch(() => { throw fail('This checkout has no upstream branch to update from.'); });
    const behind = Number(await git(['rev-list', '--count', 'HEAD..@{u}']));
    const subject = behind ? await git(['log', '-1', '--format=%s', '@{u}']) : '';
    state.latest = { sha: upstream, behind, notes: subject };
    state.checkedAt = Date.now();
    return { current, latest: state.latest, available: behind > 0 };
  }
  const [owner, repo] = updateRepo().split('/');
  const release = await (await gh(`/repos/${owner}/${repo}/releases/tags/${TAG}`)).json();
  const name = ASSET[opts.platform || process.platform];
  const asset = (release.assets || []).find((a) => a.name === name);
  const sha = /^[0-9a-f]{40}$/.test(release.target_commitish || '') ? release.target_commitish : '';
  state.latest = {
    sha, publishedAt: release.published_at, notes: (release.body || '').split('\n')[0].slice(0, 300), url: release.html_url,
    asset: asset ? { id: asset.id, name: asset.name, size: asset.size, digest: asset.digest || '' } : null,
  };
  state.checkedAt = Date.now();
  const newer = !current.builtAt || !release.published_at || new Date(release.published_at) > new Date(current.builtAt);
  const available = !!asset && !!sha && sha !== current.sha && newer;
  return { current, latest: state.latest, available, note: asset ? '' : `The latest release has no ${name} yet.` };
}

export function status() {
  return { phase: state.phase, progress: state.progress, error: state.error, latest: state.latest, checkedAt: state.checkedAt };
}

async function download(asset, target) {
  const [owner, repo] = updateRepo().split('/');
  const r = await gh(`/repos/${owner}/${repo}/releases/assets/${asset.id}`, { accept: 'application/octet-stream' });
  const hash = createHash('sha256');
  const out = fs.createWriteStream(target, { mode: 0o755 });
  let got = 0;
  try {
    for await (const chunk of r.body) {
      got += chunk.length;
      hash.update(chunk);
      state.progress = asset.size ? Math.min(99, Math.floor((got / asset.size) * 100)) : 0;
      if (!out.write(chunk)) await new Promise((res) => out.once('drain', res));
    }
  } finally {
    await new Promise((res) => out.end(res));
  }
  if (asset.size && got !== asset.size) throw fail(`The download was incomplete (${got} of ${asset.size} bytes). Try again.`, 502);
  const digest = hash.digest('hex');
  if (asset.digest?.startsWith('sha256:') && asset.digest.slice(7) !== digest) throw fail('The download failed its checksum, so it was not installed.', 502);
  const head = Buffer.alloc(4);
  const fd = await fsp.open(target, 'r');
  await fd.read(head, 0, 4, 0);
  await fd.close();
  const magic = head.toString('hex');
  const looksRight = (opts) => opts === 'win32' ? magic.startsWith('4d5a') : opts === 'darwin' ? ['cffaedfe', 'cefaedfe', 'cafebabe'].includes(magic) : magic === '7f454c46';
  return looksRight;
}

// Downloads and installs the update, then calls restart(newExecutable).
export async function apply({ restart, execPath = process.execPath, platform = process.platform, ...opts } = {}) {
  if (['downloading', 'installing', 'restarting'].includes(state.phase)) throw fail('An update is already in progress.', 409);
  const info = await check({ ...opts, platform });
  if (!info.available) throw fail('Edean is already up to date.', 409);
  state.error = '';
  state.progress = 0;
  try {
    if (info.current.mode === 'source') {
      state.phase = 'installing';
      const before = await git(['rev-parse', 'HEAD:package-lock.json']).catch(() => '');
      await git(['pull', '--ff-only']).catch((err) => { throw fail(`git pull couldn't fast-forward (${err.message}). Commit or stash your local changes first.`, 409); });
      const after = await git(['rev-parse', 'HEAD:package-lock.json']).catch(() => '');
      if (before !== after) {
        await new Promise((resolve, reject) => execFile(platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev'], { cwd: APP_ROOT, windowsHide: true, timeout: 10 * 60 * 1000, shell: platform === 'win32' }, (err, so, se) => (err ? reject(fail(`npm install failed: ${(se || err.message).slice(0, 300)}`, 502)) : resolve())));
      }
      state.phase = 'restarting';
      state.progress = 100;
      setTimeout(() => restart?.(null), 300);
      return { restarting: true };
    }

    // Desktop app: download next to the running executable, then swap.
    state.phase = 'downloading';
    const dir = path.dirname(execPath);
    const incoming = `${execPath}.new`;
    let old = `${execPath}.old`;
    await fsp.rm(incoming, { force: true });
    const isProgram = await download(info.latest.asset, incoming);
    if (!isProgram(platform)) throw fail('The downloaded file is not a valid Edean program for this computer.', 502);
    state.phase = 'installing';
    // If a previous old copy is still locked, use a new name; cleanupOld removes it later.
    await fsp.rm(old, { force: true }).catch(() => { old = `${execPath}.${Date.now()}.old`; });
    // A running program can be renamed (even on Windows), but not overwritten.
    await fsp.rename(execPath, old);
    try {
      await fsp.rename(incoming, execPath);
    } catch (err) {
      await fsp.rename(old, execPath).catch(() => {});
      throw err;
    }
    if (platform !== 'win32') await fsp.chmod(execPath, 0o755);
    state.progress = 100;
    state.phase = 'restarting';
    setTimeout(() => restart?.(execPath), 300);
    return { restarting: true, dir };
  } catch (err) {
    state.phase = 'error';
    state.error = err.message;
    await fsp.rm(`${execPath}.new`, { force: true }).catch(() => {});
    throw err;
  }
}

// Called at startup: remove the previous version left behind by an update.
export async function cleanupOld(execPath = process.execPath) {
  if (!isSea) return;
  const dir = path.dirname(execPath);
  const base = path.basename(execPath);
  for (const f of await fsp.readdir(dir).catch(() => [])) {
    if (f.startsWith(`${base}.`) && (f.endsWith('.old') || f.endsWith('.new'))) await fsp.rm(path.join(dir, f), { force: true }).catch(() => {});
  }
}

export function _reset() { Object.assign(state, { phase: 'idle', progress: 0, error: '', latest: null, checkedAt: 0 }); }
