import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

// Tiny ZIP writer (deflate) for the fake GitHub zipball.
function makeZip(files) {
  const locals = []; const centrals = []; let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text); const comp = zlib.deflateRawSync(data); const nameBuf = Buffer.from(name);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE((0o100644 << 16) >>> 0, 38); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, comp); centrals.push(ch, nameBuf); offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

// Fake GitHub.
let committed = null;
const gh = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const body = await new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b ? JSON.parse(b) : null)); });
  const json = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const p = url.pathname;
  if (p === '/user') return json(200, { login: 'me' });
  if (p === '/user/repos' && req.method === 'POST') return json(201, { owner: { login: 'me' }, name: body.name, full_name: `me/${body.name}`, private: body.private, default_branch: 'main', html_url: `https://github.com/me/${body.name}` });
  if (p === '/repos/me/hello-app/zipball/main') { res.writeHead(200, { 'Content-Type': 'application/zip' }); return res.end(makeZip({ 'me-hello-app-abc123/README.md': '# hello-app\n' })); }
  if (p === '/repos/me/hello-app/git/ref/heads/main') return json(200, { object: { sha: 'c1' } });
  if (p === '/repos/me/hello-app/git/commits/c1') return json(200, { sha: 'c1', tree: { sha: 't1' } });
  if (p === '/repos/me/hello-app/git/trees' && req.method === 'POST') { committed = body; return json(201, { sha: 't2' }); }
  if (p === '/repos/me/hello-app/git/commits' && req.method === 'POST') return json(201, { sha: 'c2abcdef', html_url: 'https://github.com/me/hello-app/commit/c2' });
  if (p === '/repos/me/hello-app/git/refs/heads/main' && req.method === 'PATCH') return json(200, {});
  json(404, { message: `unhandled ${req.method} ${p}` });
});

// Fake model: follows a fixed script, one tool call per turn, based on how many results it has seen.
let nativeTools = true;
let sawTextProtocol = false;
const script = [
  ['create_repository', { name: 'hello-app', description: 'Says hi' }],
  ['write_file', { path: 'app.js', content: "console.log('hi from hello-app')\n" }],
  ['run_command', { command: 'node app.js' }],
  ['commit_and_push', { message: 'Add app' }],
];
const llm = http.createServer(async (req, res) => {
  let b = ''; for await (const c of req) b += c;
  const body = JSON.parse(b);
  if (body.tools && !nativeTools) { res.writeHead(400); return res.end('{"error":"model does not support tools"}'); }
  if (!body.tools && body.messages[0].content.includes('<tool>')) sawTextProtocol = true;
  const done = body.messages.filter((m) => m.role === 'tool' || (m.role === 'user' && m.content.startsWith('<tool_result>'))).length;
  const step = script[done];
  let message;
  if (!step) message = { role: 'assistant', content: 'Done! Run it with `node app.js`.' };
  else if (body.tools) message = { role: 'assistant', content: done === 0 ? 'Creating the repository.' : '', tool_calls: [{ id: `call${done}`, type: 'function', function: { name: step[0], arguments: JSON.stringify(step[1]) } }] };
  else message = { role: 'assistant', content: `<tool>${JSON.stringify({ name: step[0], arguments: step[1] })}</tool>` };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message }] }));
});

let server, base, dataDir;
const auth = { Authorization: 'Basic ' + Buffer.from('me:0000').toString('base64') };

before(async () => {
  await new Promise((r) => gh.listen(0, '127.0.0.1', r));
  await new Promise((r) => llm.listen(0, '127.0.0.1', r));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edean-agent-test-'));
  Object.assign(process.env, {
    EDEAN_DATA_DIR: dataDir, GITHUB_API_BASE: `http://127.0.0.1:${gh.address().port}`,
    LLM_BASE_URL: `http://127.0.0.1:${llm.address().port}/v1`, EDEAN_GITHUB_TOKEN: 'ghp_abcdefghijklmnopqrstuvwxyz0123',
  });
  const mod = await import('../server.js');
  server = mod.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); gh.close(); llm.close(); fs.rmSync(dataDir, { recursive: true, force: true }); });

// Starts a run and reads its event stream, answering approvals with `decide`.
async function runAgent(body, decide = () => 'allow') {
  const r = await fetch(`${base}/api/agent/run`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(r.status, 200);
  const events = [];
  let buf = '';
  for await (const chunk of r.body) {
    buf += Buffer.from(chunk).toString();
    const parts = buf.split('\n\n'); buf = parts.pop();
    for (const part of parts) {
      const ev = JSON.parse(part.replace(/^data: /, ''));
      events.push(ev);
      if (ev.type === 'approval') {
        await fetch(`${base}/api/agent/approve`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ run: ev.run, id: ev.id, decision: decide(ev) }) });
      }
    }
  }
  return events;
}

test('agent creates a repo, writes a file, runs it (with approval) and pushes', async () => {
  const events = await runAgent({ task: 'Make a hello world app' });
  const tools = events.filter((e) => e.type === 'tool').map((e) => e.name);
  assert.deepEqual(tools, ['create_repository', 'write_file', 'run_command', 'commit_and_push']);
  // Asked before creating the repo, running the command and pushing — not before writing a file.
  assert.deepEqual(events.filter((e) => e.type === 'approval').map((e) => e.name), ['create_repository', 'run_command', 'commit_and_push']);
  const ran = events.find((e) => e.type === 'tool_result' && e.detail?.kind === 'command');
  assert.equal(ran.detail.output, 'hi from hello-app');
  assert.equal(ran.detail.exitCode, 0);
  assert.deepEqual(committed.tree, [{ path: 'app.js', mode: '100644', type: 'blob', content: "console.log('hi from hello-app')\n" }]);
  assert.equal(committed.base_tree, 't1');
  const done = events.at(-1);
  assert.equal(done.type, 'done');
  assert.match(done.text, /node app\.js/);
  assert.equal(fs.readFileSync(path.join(dataDir, 'projects', 'me', 'hello-app', 'README.md'), 'utf8'), '# hello-app\n');
  const projects = await (await fetch(`${base}/api/agent/projects`, { headers: auth })).json();
  assert.deepEqual(projects.projects.map((p) => p.id), ['me/hello-app']);
});

test('declining an action is reported back to the model', async () => {
  committed = null;
  const events = await runAgent({ task: 'Again', project: 'me/hello-app' }, (ev) => (ev.name === 'commit_and_push' ? 'deny' : 'allow'));
  const commitCall = events.find((e) => e.type === 'tool' && e.name === 'commit_and_push');
  const result = events.find((e) => e.type === 'tool_result' && e.id === commitCall.id);
  assert.equal(result.summary, 'Not allowed by you');
  assert.equal(committed, null);
});

test('falls back to text commands when the model has no tool support', async () => {
  nativeTools = false;
  const events = await runAgent({ task: 'Make it again', model: 'plain-model', autonomy: 'auto' });
  assert.ok(sawTextProtocol);
  assert.ok(events.some((e) => e.type === 'status' && /text commands/.test(e.text)));
  assert.deepEqual(events.filter((e) => e.type === 'tool').map((e) => e.name), ['create_repository', 'write_file', 'run_command', 'commit_and_push']);
  assert.equal(events.filter((e) => e.type === 'approval').length, 0); // autonomy: auto
});

test('file tools cannot escape the project folder', async () => {
  const { _internals } = await import('../agent.js');
  const meta = { id: 'me/hello-app' };
  assert.throws(() => _internals.inProject(meta, '../../etc/passwd'), /outside the project/);
  assert.throws(() => _internals.inProject(meta, '.git/config'), /off limits/);
  assert.equal(_internals.inProject(meta, './src/a.js').rel, 'src/a.js');
  const ignore = _internals.gitignoreMatcher('dist/\n*.log\n/secret.txt');
  assert.equal(ignore('dist/app.js'), true);
  assert.equal(ignore('logs/x.log'), true);
  assert.equal(ignore('secret.txt'), true);
  assert.equal(ignore('src/app.js'), false);
});
