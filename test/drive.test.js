import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A small fake of Google's OAuth + Drive v3 endpoints.
const files = new Map(); // id -> { id, name, mimeType, parents, appProperties, trashed, content }
let nextId = 1;
let revoked = false;
const google = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const body = await new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
  const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (url.pathname === '/token') {
    const p = new URLSearchParams(body);
    if (p.get('grant_type') === 'authorization_code') {
      assert.equal(p.get('code'), 'good-code');
      assert.ok(p.get('code_verifier'));
      return json(200, { access_token: 'at1', refresh_token: 'rt1', expires_in: 3600 });
    }
    return json(200, { access_token: 'at2', expires_in: 3600 });
  }
  if (url.pathname === '/revoke') { revoked = true; return json(200, {}); }
  if (req.headers.authorization?.startsWith('Bearer ') !== true) return json(401, { error: { message: 'no auth' } });
  if (url.pathname === '/drive/v3/about') return json(200, { user: { emailAddress: 'me@example.com' } });
  const m = url.pathname.match(/^\/(upload\/)?drive\/v3\/files(?:\/([^/]+))?$/);
  if (!m) return json(404, { error: { message: 'nope' } });
  const [, upload, id] = m;
  const parseMultipart = () => {
    const boundary = req.headers['content-type'].split('boundary=')[1];
    const parts = body.split(`--${boundary}`).slice(1, 3).map((p) => p.split('\r\n\r\n').slice(1).join('\r\n\r\n').replace(/\r\n$/, ''));
    return { meta: JSON.parse(parts[0]), content: parts[1] };
  };
  if (req.method === 'GET' && !id) {
    const q = url.searchParams.get('q');
    let list = [...files.values()].filter((f) => !f.trashed);
    if (q.includes("mimeType='application/vnd.google-apps.folder'")) list = list.filter((f) => f.mimeType === 'application/vnd.google-apps.folder');
    const parent = q.match(/'([^']+)' in parents/);
    if (parent) list = list.filter((f) => f.parents?.includes(parent[1]));
    const app = q.match(/value='([^']+)'/);
    if (app) list = list.filter((f) => f.appProperties?.edeanChatId === app[1]);
    return json(200, { files: list.map(({ content, ...f }) => f) });
  }
  if (req.method === 'GET' && id) {
    const f = files.get(id);
    if (!f) return json(404, { error: { message: 'File not found' } });
    if (url.searchParams.get('alt') === 'media') { res.writeHead(200); return res.end(f.content); }
    const { content, ...meta } = f;
    return json(200, meta);
  }
  if (req.method === 'POST' && !upload) {
    const meta = JSON.parse(body);
    const f = { id: `f${nextId++}`, ...meta };
    files.set(f.id, f);
    return json(200, { id: f.id, name: f.name });
  }
  if (req.method === 'POST' && upload) {
    const { meta, content } = parseMultipart();
    const f = { id: `f${nextId++}`, ...meta, content };
    files.set(f.id, f);
    return json(200, { id: f.id });
  }
  if (req.method === 'PATCH' && upload) {
    const f = files.get(id);
    if (!f) return json(404, { error: { message: 'File not found' } });
    const { meta, content } = parseMultipart();
    Object.assign(f, meta, { content });
    return json(200, { id });
  }
  if (req.method === 'PATCH') {
    Object.assign(files.get(id), JSON.parse(body));
    return json(200, { id });
  }
  json(400, { error: { message: 'unhandled' } });
});

let server, base, dataDir;
before(async () => {
  await new Promise((r) => google.listen(0, '127.0.0.1', r));
  const g = `http://127.0.0.1:${google.address().port}`;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edean-drive-test-'));
  Object.assign(process.env, {
    EDEAN_DATA_DIR: dataDir, GOOGLE_AUTH_URL: `${g}/auth`, GOOGLE_TOKEN_URL: `${g}/token`,
    GOOGLE_REVOKE_URL: `${g}/revoke`, GOOGLE_API_BASE: g,
  });
  const mod = await import('../server.js');
  server = mod.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); google.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

const call = async (p, opts = {}) => {
  const headers = { Authorization: 'Basic ' + Buffer.from('me:0000').toString('base64'), ...(opts.body ? { 'Content-Type': 'application/json' } : {}) };
  const r = await fetch(base + p, { redirect: 'manual', ...opts, headers });
  return { status: r.status, location: r.headers.get('location'), data: await r.json().catch(() => null) };
};

test('full Google Drive flow: connect, pick folder, save/load/delete chats, disconnect', async () => {
  let s = (await call('/api/drive/status')).data;
  assert.equal(s.configured, false);

  assert.equal((await call('/api/drive/credentials', { method: 'POST', body: JSON.stringify({ clientId: 'nope', clientSecret: 'x' }) })).status, 400);
  s = (await call('/api/drive/credentials', { method: 'POST', body: JSON.stringify({ clientId: '123-abc.apps.googleusercontent.com', clientSecret: 'GOCSPX-secret' }) })).data;
  assert.equal(s.configured, true);
  assert.equal(s.connected, false);

  // Sign-in redirects to Google with PKCE and a loopback redirect URI.
  const auth = await call('/api/drive/auth');
  assert.equal(auth.status, 302);
  const authUrl = new URL(auth.location);
  assert.equal(authUrl.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.file');
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.match(authUrl.searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/api\/drive\/callback$/);

  // A callback with a forged state is rejected.
  const bad = await call('/api/drive/callback?code=good-code&state=forged');
  assert.match(bad.location, /drive=error/);

  const cb = await call(`/api/drive/callback?code=good-code&state=${authUrl.searchParams.get('state')}`);
  assert.equal(cb.location, '/?drive=connected');
  s = (await call('/api/drive/status')).data;
  assert.equal(s.connected, true);
  assert.equal(s.email, 'me@example.com');
  assert.equal(s.folder, null);

  // The token file is private to the user.
  const stat = fs.statSync(path.join(dataDir, 'google-drive.json'));
  if (process.platform !== 'win32') assert.equal(stat.mode & 0o777, 0o600);

  // Saving before choosing a folder fails clearly.
  assert.equal((await call('/api/drive/chats')).status, 409);

  const folder = (await call('/api/drive/folder', { method: 'POST', body: JSON.stringify({ name: 'Edean Chats' }) })).data.folder;
  assert.equal(folder.name, 'Edean Chats');
  assert.deepEqual((await call('/api/drive/folders')).data.folders.map((f) => f.name), ['Edean Chats']);

  const chat = { id: 'chat-1', title: 'Fix: my/bad*title', createdAt: Date.UTC(2026, 8, 26), updatedAt: 1, messages: [{ role: 'user', content: 'hi' }] };
  assert.equal((await call('/api/drive/chats/chat-1', { method: 'PUT', body: JSON.stringify(chat) })).status, 200);
  const stored = [...files.values()].find((f) => f.appProperties?.edeanChatId === 'chat-1');
  assert.equal(stored.name, '2026-09-26 Fix- my-bad-title.json');
  assert.deepEqual(stored.parents, [folder.id]);

  // Updating replaces the same file instead of creating another.
  chat.title = 'Renamed';
  chat.messages.push({ role: 'assistant', content: 'hello' });
  await call('/api/drive/chats/chat-1', { method: 'PUT', body: JSON.stringify(chat) });
  assert.equal([...files.values()].filter((f) => f.appProperties?.edeanChatId).length, 1);
  assert.equal(stored.name, '2026-09-26 Renamed.json');

  const loaded = (await call('/api/drive/chats')).data.chats;
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].messages.length, 2);

  await call('/api/drive/chats/chat-1', { method: 'DELETE' });
  assert.equal(stored.trashed, true);
  assert.equal((await call('/api/drive/chats')).data.chats.length, 0);

  await call('/api/drive/disconnect', { method: 'POST', body: '{}' });
  assert.equal(revoked, true);
  s = (await call('/api/drive/status')).data;
  assert.equal(s.connected, false);
  assert.equal(s.configured, true);
});
