import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const NEW_SHA = 'b'.repeat(40);
const OLD_SHA = 'a'.repeat(40);
let payload = Buffer.concat([Buffer.from('MZ'), crypto.randomBytes(50000)]); // looks like a Windows program
let digest = () => `sha256:${crypto.createHash('sha256').update(payload).digest('hex')}`;
let published = '2026-09-26T12:00:00Z';

const gh = http.createServer((req, res) => {
  if (req.url === '/repos/me/Edean/releases/tags/edean-latest') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      target_commitish: NEW_SHA, published_at: published, html_url: 'https://github.com/me/Edean/releases/tag/edean-latest', body: 'Latest build',
      assets: [{ id: 7, name: 'Edean.exe', size: payload.length, digest: digest() }, { id: 8, name: 'edean-linux', size: 1 }],
    }));
  }
  if (req.url === '/repos/me/Edean/releases/assets/7' && req.headers.accept === 'application/octet-stream') {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    return res.end(payload);
  }
  res.writeHead(404); res.end('{}');
});

let updater, dir, exe;
before(async () => {
  await new Promise((r) => gh.listen(0, '127.0.0.1', r));
  Object.assign(process.env, { GITHUB_API_BASE: `http://127.0.0.1:${gh.address().port}`, EDEAN_UPDATE_REPO: 'me/Edean', EDEAN_DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'edean-upd-data-')) });
  delete process.env.EDEAN_GITHUB_TOKEN;
  updater = await import('../updater.js');
});
after(() => gh.close());
beforeEach(() => {
  updater._reset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'edean-upd-'));
  exe = path.join(dir, 'Edean.exe');
  fs.writeFileSync(exe, 'old version');
});

const app = { mode: 'app', build: { sha: OLD_SHA, builtAt: '2026-09-25T10:00:00Z' }, platform: 'win32' };

test('finds a newer build', async () => {
  const r = await updater.check(app);
  assert.equal(r.available, true);
  assert.equal(r.latest.sha, NEW_SHA);
  assert.equal(r.latest.asset.name, 'Edean.exe');
});

test('says up to date when running the latest build', async () => {
  const r = await updater.check({ ...app, build: { sha: NEW_SHA, builtAt: '2026-09-26T12:05:00Z' } });
  assert.equal(r.available, false);
  await assert.rejects(updater.apply({ ...app, build: { sha: NEW_SHA, builtAt: '2026-09-26T12:05:00Z' }, execPath: exe }), /up to date/);
});

test('downloads, verifies, swaps in the new program and restarts', async () => {
  let restartedWith = null;
  await updater.apply({ ...app, execPath: exe, restart: (p) => { restartedWith = p; } });
  assert.deepEqual(fs.readFileSync(exe), payload);
  assert.equal(fs.readFileSync(`${exe}.old`, 'utf8'), 'old version');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(restartedWith, exe);
  assert.equal(updater.status().phase, 'restarting');
  assert.equal(updater.status().progress, 100);
});

test('rejects a corrupted download and keeps the current version', async () => {
  const good = digest;
  digest = () => `sha256:${'0'.repeat(64)}`;
  try {
    await assert.rejects(updater.apply({ ...app, execPath: exe, restart: () => assert.fail('must not restart') }), /checksum/);
    assert.equal(fs.readFileSync(exe, 'utf8'), 'old version');
    assert.equal(fs.existsSync(`${exe}.new`), false);
    assert.equal(updater.status().phase, 'error');
  } finally { digest = good; }
});

test('rejects a download that is not a program for this system', async () => {
  const good = payload;
  payload = Buffer.from('<html>not a program</html>');
  try {
    await assert.rejects(updater.apply({ ...app, execPath: exe, restart: () => assert.fail('must not restart') }), /not a valid Edean program/);
    assert.equal(fs.readFileSync(exe, 'utf8'), 'old version');
  } finally { payload = good; }
});
