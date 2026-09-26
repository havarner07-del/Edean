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
  mod = await import('../server.js');
  server = mod.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server.close(); fake.close(); });

const auth = { Authorization: 'Basic ' + Buffer.from('me:secret').toString('base64') };

test('requires the app password when one is set', async () => {
  const r = await fetch(`${base}/api/health`);
  assert.equal(r.status, 401);
  const ok = await fetch(`${base}/api/health`, { headers: auth });
  assert.equal(ok.status, 200);
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
