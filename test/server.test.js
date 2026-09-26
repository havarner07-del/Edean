import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// A fake OpenAI-compatible backend that streams a canned reply.
let lastBody = null;
const fake = http.createServer((req, res) => {
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ data: [{ id: 'qwen2.5-coder:7b' }, { id: 'deepseek-coder-v2' }] }));
  }
  if (req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      lastBody = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const piece of ['Hello', ' world']) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
      }
      res.end('data: [DONE]\n\n');
    });
    return;
  }
  res.writeHead(404).end();
});

let server, base, mod;

before(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  process.env.LLM_BASE_URL = `http://127.0.0.1:${fake.address().port}/v1`;
  process.env.APP_PASSWORD = 'secret';
  process.env.EDEAN_DATA_DIR = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'edean-test-'));
  mod = await import('../server.js');
  server = mod.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server.close(); fake.close(); });

const auth = { Authorization: 'Basic ' + Buffer.from('me:secret').toString('base64') };
// With no APP_PASSWORD and no saved password, the default password is 0000.
const defaultAuth = { Authorization: 'Basic ' + Buffer.from('me:0000').toString('base64') };

test('requires signing in', async () => {
  assert.equal((await fetch(`${base}/api/models`)).status, 401);
  const page = await fetch(`${base}/`, { redirect: 'manual' });
  assert.equal(page.status, 302);
  assert.equal(page.headers.get('location'), '/login');
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  assert.equal((await fetch(`${base}/api/models`, { headers: auth })).status, 200);
});

test('login form sets a session cookie; wrong passwords are rejected', async () => {
  const bad = await fetch(`${base}/login`, { method: 'POST', body: 'password=nope', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
  assert.equal(bad.status, 401);
  const good = await fetch(`${base}/login`, { method: 'POST', body: 'password=secret', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, redirect: 'manual' });
  assert.equal(good.status, 303);
  const cookie = good.headers.get('set-cookie').split(';')[0];
  assert.match(good.headers.get('set-cookie'), /HttpOnly/);
  assert.equal((await fetch(`${base}/api/models`, { headers: { cookie } })).status, 200);
  await fetch(`${base}/api/logout`, { method: 'POST', headers: { cookie } });
  assert.equal((await fetch(`${base}/api/models`, { headers: { cookie } })).status, 401);
});

test('serves the app and vendored libraries locally', async () => {
  for (const p of ['/', '/app.js', '/prompts.js', '/styles.css', '/vendor/marked.esm.js', '/vendor/purify.es.mjs', '/vendor/highlight.min.js']) {
    const r = await fetch(base + p, { headers: auth });
    assert.equal(r.status, 200, p);
  }
  const r = await fetch(`${base}/../server.js`, { headers: auth });
  assert.equal(r.status, 404);
});

test('lists models from the backend', async () => {
  const data = await (await fetch(`${base}/api/models`, { headers: auth })).json();
  assert.equal(data.online, true);
  assert.deepEqual(data.models, ['deepseek-coder-v2', 'qwen2.5-coder:7b']);
});

test('streams chat completions through and strips unknown fields', async () => {
  const r = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-coder-v2', temperature: 9, evil: true, messages: [{ role: 'user', content: 'hi', extra: 1 }] }),
  });
  assert.equal(r.status, 200);
  const text = await r.text();
  assert.match(text, /Hello/);
  assert.match(text, /\[DONE\]/);
  assert.equal(lastBody.model, 'deepseek-coder-v2');
  assert.equal(lastBody.temperature, 2);
  assert.equal(lastBody.stream, true);
  assert.equal(lastBody.evil, undefined);
  assert.deepEqual(lastBody.messages, [{ role: 'user', content: 'hi' }]);
});

test('rejects malformed chat requests', async () => {
  const r = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'tool', content: 'x' }] }),
  });
  assert.equal(r.status, 400);
});

const run = (body) => fetch(`${base}/api/run`, {
  method: 'POST',
  headers: { ...auth, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

test('lists runnable languages', async () => {
  const data = await (await fetch(`${base}/api/run/languages`, { headers: auth })).json();
  assert.equal(data.enabled, true);
  const js = data.languages.find((l) => l.id === 'javascript');
  assert.equal(js.available, true);
  for (const id of ['python', 'java', 'c', 'cpp', 'go', 'rust']) assert.ok(data.languages.some((l) => l.id === id), id);
});

test('runs JavaScript with stdin', async () => {
  const r = await run({ language: 'javascript', code: 'const s = require("fs").readFileSync(0, "utf8"); console.log(s.trim().toUpperCase()); console.error("warn")', stdin: 'edean\n' });
  assert.equal(r.status, 200);
  const data = await r.json();
  assert.equal(data.exitCode, 0);
  assert.equal(data.stdout, 'EDEAN\n');
  assert.equal(data.stderr, 'warn\n');
});

test('reports a non-zero exit code', async () => {
  const data = await (await run({ language: 'javascript', code: 'process.exit(3)' })).json();
  assert.equal(data.phase, 'run');
  assert.equal(data.exitCode, 3);
});

test('does not pass secrets to programs', async () => {
  process.env.SOME_API_KEY = 'leak';
  const data = await (await run({ language: 'javascript', code: 'console.log(JSON.stringify(Object.keys(process.env).filter(k => /KEY|PASSWORD/.test(k))))' })).json();
  delete process.env.SOME_API_KEY;
  assert.equal(data.stdout.trim(), '[]');
});

test('reports compile errors separately', async (t) => {
  const langs = (await (await fetch(`${base}/api/run/languages`, { headers: auth })).json()).languages;
  if (!langs.find((l) => l.id === 'c')?.available) return t.skip('gcc not installed');
  const data = await (await run({ language: 'c', code: 'int main(void) { return missing; }' })).json();
  assert.equal(data.phase, 'compile');
  assert.notEqual(data.exitCode, 0);
  assert.match(data.stderr, /missing/);
});

test('rejects unknown languages and empty code', async () => {
  assert.equal((await run({ language: 'cobol', code: 'x' })).status, 400);
  assert.equal((await run({ language: 'javascript', code: '   ' })).status, 400);
});

test('refuses to run code when reachable from the network without a password', async () => {
  const saved = { host: mod.config.host, appPassword: mod.config.appPassword };
  Object.assign(mod.config, { host: '0.0.0.0', appPassword: '' });
  try {
    const langs = await (await fetch(`${base}/api/run/languages`, { headers: defaultAuth })).json();
    assert.equal(langs.enabled, false);
    const r = await fetch(`${base}/api/run`, { method: 'POST', headers: defaultAuth, body: JSON.stringify({ language: 'javascript', code: 'console.log(1)' }) });
    assert.equal(r.status, 403);
  } finally {
    Object.assign(mod.config, saved);
  }
});

test('reports system status with a light for every dependency', async () => {
  const data = await (await fetch(`${base}/api/setup/status`, { headers: auth })).json();
  const ids = data.checks.map((c) => c.id);
  for (const id of ['ollama', 'engine', 'model', 'node', 'python', 'java', 'gcc', 'gpp', 'go', 'rustc', 'ruby', 'php', 'bash']) {
    assert.ok(ids.includes(id), id);
  }
  // The fake backend is up and serves the default model.
  assert.equal(data.checks.find((c) => c.id === 'engine').ok, true);
  assert.equal(data.checks.find((c) => c.id === 'model').ok, true);
  assert.equal(data.checks.find((c) => c.id === 'node').ok, true);
  assert.equal(data.canInstall, true);
});

test('refuses to install when reachable from the network without a password', async () => {
  const saved = { host: mod.config.host, appPassword: mod.config.appPassword };
  Object.assign(mod.config, { host: '0.0.0.0', appPassword: '' });
  try {
    const r = await fetch(`${base}/api/setup/install`, { method: 'POST', body: '{}', headers: defaultAuth });
    assert.equal(r.status, 403);
  } finally {
    Object.assign(mod.config, saved);
  }
});
