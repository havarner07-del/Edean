import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Fake GitHub REST API: one repo "me/app" with a main branch.
const blobs = { 'README.md': '# App\n', 'src/index.js': 'console.log(1)\n', 'package.json': '{"dependencies":{"express":"^4.0.0"},"devDependencies":{"jest":"^29"}}' };
const refs = { main: 'c1' };
const commitsById = { c1: { tree: 't1', message: 'init' } };
let lastTree = null;
let lastAnthropic = null;
let lastModels = null;

const gh = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const body = await new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b ? JSON.parse(b) : null)); });
  const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const p = url.pathname;

  // Fake Anthropic Messages API
  if (p === '/v1/messages') {
    lastAnthropic = { headers: req.headers, body };
    return json(200, {
      id: 'msg_1', type: 'message', role: 'assistant', model: body.model, stop_reason: 'end_turn', stop_details: null,
      content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text: 'Use Array.prototype.at(-1).' }],
      usage: { input_tokens: 42, output_tokens: 9 },
    });
  }
  // Fake GitHub Models
  if (p === '/inference/chat/completions') {
    lastModels = { headers: req.headers, body };
    return json(200, { model: body.model, choices: [{ message: { content: 'Use fetch with AbortSignal.timeout().' } }], usage: { prompt_tokens: 30, completion_tokens: 8 } });
  }

  if (req.headers.authorization !== 'Bearer ghp_abcdefghijklmnopqrstuvwxyz0123') return json(401, { message: 'Bad credentials' });
  if (p === '/user') return json(200, { login: 'me', name: 'Me', avatar_url: 'https://avatars.githubusercontent.com/u/1' });
  if (p === '/user/repos') return json(200, [{ owner: { login: 'me' }, name: 'app', full_name: 'me/app', private: true, default_branch: 'main', permissions: { push: true } }]);
  if (p === '/repos/me/app') return json(200, { owner: { login: 'me' }, name: 'app', full_name: 'me/app', private: true, default_branch: 'main', html_url: 'https://github.com/me/app', permissions: { push: true } });
  if (p === '/repos/me/app/branches') return json(200, Object.entries(refs).map(([name, sha]) => ({ name, commit: { sha }, protected: false })));
  let m;
  if ((m = p.match(/^\/repos\/me\/app\/git\/ref\/heads\/(.+)$/))) {
    const name = decodeURIComponent(m[1]);
    return refs[name] ? json(200, { object: { sha: refs[name] } }) : json(404, { message: 'Not Found' });
  }
  if (p === '/repos/me/app/git/refs' && req.method === 'POST') {
    const name = body.ref.replace('refs/heads/', '');
    if (refs[name]) return json(422, { message: 'Reference already exists' });
    refs[name] = body.sha;
    return json(201, {});
  }
  if ((m = p.match(/^\/repos\/me\/app\/git\/refs\/heads\/(.+)$/)) && req.method === 'PATCH') { refs[decodeURIComponent(m[1])] = body.sha; return json(200, {}); }
  if ((m = p.match(/^\/repos\/me\/app\/git\/trees\/(.+)$/)) && req.method === 'GET') {
    return json(200, { truncated: false, tree: [{ path: 'src', type: 'tree', sha: 'd1' }, ...Object.keys(blobs).map((k) => ({ path: k, type: 'blob', size: blobs[k].length, sha: `b-${k}` }))] });
  }
  if ((m = p.match(/^\/repos\/me\/app\/contents\/(.+)$/))) {
    const fp = decodeURIComponent(m[1]);
    if (!(fp in blobs)) return json(404, { message: 'Not Found' });
    return json(200, { type: 'file', sha: `b-${fp}`, size: blobs[fp].length, encoding: 'base64', content: Buffer.from(blobs[fp]).toString('base64') });
  }
  if ((m = p.match(/^\/repos\/me\/app\/git\/commits\/(.+)$/))) return json(200, { sha: m[1], tree: { sha: commitsById[m[1]].tree } });
  if (p === '/repos/me/app/git/trees' && req.method === 'POST') { lastTree = body; return json(201, { sha: 't2' }); }
  if (p === '/repos/me/app/git/commits' && req.method === 'POST') { commitsById.c2 = { tree: body.tree, message: body.message, parents: body.parents }; return json(201, { sha: 'c2', html_url: 'https://github.com/me/app/commit/c2' }); }
  if (p === '/repos/me/app/pulls' && req.method === 'POST') return json(201, { number: 7, html_url: 'https://github.com/me/app/pull/7', ...body });
  if (p === '/repos/me/app/dependency-graph/sbom') return json(404, { message: 'Not Found' });
  return json(404, { message: `unhandled ${req.method} ${p}` });
});

let server, base, dataDir;
const auth = { Authorization: 'Basic ' + Buffer.from('me:0000').toString('base64') };
const call = async (p, method = 'GET', body) => {
  const r = await fetch(base + p, { method, headers: { ...auth, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, data: await r.json().catch(() => null) };
};

before(async () => {
  await new Promise((r) => gh.listen(0, '127.0.0.1', r));
  const g = `http://127.0.0.1:${gh.address().port}`;
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edean-gh-test-'));
  Object.assign(process.env, { EDEAN_DATA_DIR: dataDir, GITHUB_API_BASE: g, ANTHROPIC_BASE_URL: g, GITHUB_MODELS_URL: `${g}/inference/chat/completions` });
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.EDEAN_GITHUB_TOKEN;
  const mod = await import('../server.js');
  server = mod.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); gh.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('GitHub: connect, browse, branch, commit, pull request, dependencies', async () => {
  assert.equal((await call('/api/github/status')).data.connected, false);
  assert.equal((await call('/api/github/connect', 'POST', { token: 'not-a-token' })).status, 400);
  const s = (await call('/api/github/connect', 'POST', { token: 'ghp_abcdefghijklmnopqrstuvwxyz0123' })).data;
  assert.equal(s.login, 'me');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dataDir, 'github.json')).mode & 0o777, 0o600);

  assert.deepEqual((await call('/api/github/repos')).data.repos.map((r) => r.fullName), ['me/app']);
  const tree = (await call('/api/github/tree?owner=me&repo=app&branch=main')).data;
  assert.ok(tree.entries.some((e) => e.path === 'src/index.js' && e.type === 'file'));
  const file = (await call('/api/github/file?owner=me&repo=app&branch=main&path=src/index.js')).data;
  assert.equal(file.content, 'console.log(1)\n');
  assert.equal((await call('/api/github/file?owner=me&repo=app&branch=main&path=../etc/passwd')).status, 400);

  assert.equal((await call('/api/github/branches', 'POST', { owner: 'me', repo: 'app', name: 'bad..name', from: 'main' })).status, 400);
  await call('/api/github/branches', 'POST', { owner: 'me', repo: 'app', name: 'edean/improve', from: 'main' });
  assert.ok((await call('/api/github/branches?owner=me&repo=app')).data.branches.some((b) => b.name === 'edean/improve'));

  const c = await call('/api/github/commit', 'POST', {
    owner: 'me', repo: 'app', branch: 'edean/improve', message: 'Improve logging',
    changes: [{ path: 'src/index.js', content: 'console.log(2)\n' }, { path: 'README.md', delete: true }],
  });
  assert.equal(c.status, 200);
  assert.equal(c.data.sha, 'c2');
  assert.equal(lastTree.base_tree, 't1');
  assert.deepEqual(lastTree.tree, [
    { path: 'src/index.js', mode: '100644', type: 'blob', content: 'console.log(2)\n' },
    { path: 'README.md', mode: '100644', type: 'blob', sha: null },
  ]);
  assert.equal(refs['edean/improve'], 'c2');
  assert.equal(refs.main, 'c1');

  const pr = (await call('/api/github/pulls', 'POST', { owner: 'me', repo: 'app', title: 'Improve logging', head: 'edean/improve', base: 'main' })).data;
  assert.equal(pr.number, 7);

  // No dependency graph → falls back to package.json.
  const deps = (await call('/api/github/dependencies?owner=me&repo=app&branch=main')).data;
  assert.equal(deps.source, 'manifest files');
  assert.deepEqual(deps.packages.map((p) => p.name), ['express', 'jest']);
});

test('advisors: Claude via the Anthropic SDK with fallbacks, Copilot via GitHub Models', async () => {
  let st = (await call('/api/advisors')).data;
  assert.equal(st.claude.configured, false);
  assert.equal(st.claude.model, 'claude-opus-5');
  assert.equal((await call('/api/advisors/ask', 'POST', { advisor: 'claude', question: 'hi' })).status, 409);

  assert.equal((await call('/api/advisors/settings', 'POST', { anthropicKey: 'nope' })).status, 400);
  st = (await call('/api/advisors/settings', 'POST', { anthropicKey: 'sk-ant-api03-testkey1234567890' })).data;
  assert.equal(st.claude.configured, true);

  const a = (await call('/api/advisors/ask', 'POST', { advisor: 'claude', question: 'How do I get the last array element?' })).data;
  assert.equal(a.answer, 'Use Array.prototype.at(-1).');
  assert.deepEqual(a.usage, { input: 42, output: 9 });
  assert.equal(lastAnthropic.headers['x-api-key'], 'sk-ant-api03-testkey1234567890');
  assert.match(lastAnthropic.headers['anthropic-beta'], /server-side-fallback-2026-07-01/);
  assert.equal(lastAnthropic.body.fallbacks, 'default');
  assert.deepEqual(lastAnthropic.body.thinking, { type: 'adaptive' });
  assert.equal(lastAnthropic.body.model, 'claude-opus-5');
  assert.equal(lastAnthropic.body.messages[0].content, 'How do I get the last array element?');

  // Copilot uses the connected GitHub token (set up in the previous test).
  const c = (await call('/api/advisors/ask', 'POST', { advisor: 'copilot', question: 'Timeout a fetch?' })).data;
  assert.equal(c.answer, 'Use fetch with AbortSignal.timeout().');
  assert.equal(lastModels.headers.authorization, 'Bearer ghp_abcdefghijklmnopqrstuvwxyz0123');
  assert.equal(lastModels.body.model, 'openai/gpt-4.1');
});
