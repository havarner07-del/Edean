// The agent working in a folder on this computer: Claude plans first, the agent edits
// files in place, Claude reviews, the agent fixes, and the whole task can be undone.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Fake Anthropic API: plans and reviews.
const claudeCalls = [];
let reviewAnswer = '1. fix.txt is missing: create it with the text "fixed".';
const anthropic = http.createServer(async (req, res) => {
  let b = ''; for await (const c of req) b += c;
  const body = JSON.parse(b);
  const system = typeof body.system === 'string' ? body.system : body.system.map((s) => s.text).join('');
  const kind = /planning work/.test(system) ? 'plan' : /You review changes/.test(system) ? 'review' : 'ask';
  claudeCalls.push({ kind, prompt: body.messages[0].content, model: body.model });
  const text = kind === 'plan' ? '## Approach\nChange greet.js to say "hi".\n## Steps\n1. Edit greet.js.' : kind === 'review' ? reviewAnswer : 'ok';
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 50 } }));
});

// Fake local model: a fixed script; null means "give the final answer".
let script = [];
let lastMessages = [];
const llm = http.createServer(async (req, res) => {
  let b = ''; for await (const c of req) b += c;
  const body = JSON.parse(b);
  lastMessages = body.messages;
  const idx = body.messages.filter((m) => m.role === 'tool' || (m.role === 'assistant' && !m.tool_calls)).length;
  const step = script[idx];
  const message = step
    ? { role: 'assistant', content: '', tool_calls: [{ id: `call${idx}`, type: 'function', function: { name: step[0], arguments: JSON.stringify(step[1]) } }] }
    : { role: 'assistant', content: `Finished step ${idx}.` };
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message }] }));
});

let server, base, dataDir, work;
const auth = { Authorization: 'Basic ' + Buffer.from('me:0000').toString('base64') };
const post = (p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

before(async () => {
  await new Promise((r) => anthropic.listen(0, '127.0.0.1', r));
  await new Promise((r) => llm.listen(0, '127.0.0.1', r));
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edean-folder-data-'));
  work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'edean-folder-work-')));
  Object.assign(process.env, {
    EDEAN_DATA_DIR: dataDir, LLM_BASE_URL: `http://127.0.0.1:${llm.address().port}/v1`,
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${anthropic.address().port}`, ANTHROPIC_API_KEY: 'sk-ant-test-0123456789abcdef',
    GITHUB_API_BASE: 'http://127.0.0.1:9', EDEAN_GITHUB_TOKEN: '',
  });
  const mod = await import('../server.js');
  server = mod.createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close(); anthropic.close(); llm.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

async function run(body) {
  const r = await post('/api/agent/run', body);
  assert.equal(r.status, 200);
  const events = [];
  let buf = '';
  for await (const chunk of r.body) {
    buf += Buffer.from(chunk).toString();
    const parts = buf.split('\n\n'); buf = parts.pop();
    for (const part of parts) {
      const ev = JSON.parse(part.replace(/^data: /, ''));
      events.push(ev);
      if (ev.type === 'approval') await post('/api/agent/approve', { run: ev.run, id: ev.id, decision: 'allow' });
    }
  }
  return events;
}

test('refuses to open whole drives, the home folder and Edean\'s data', async () => {
  for (const p of ['/', os.homedir(), dataDir, path.join(dataDir, 'x', '..')]) {
    const r = await post('/api/agent/open-folder', { path: p });
    assert.equal(r.status, 403, p);
  }
  assert.equal((await post('/api/agent/open-folder', { path: 'relative/path' })).status, 400);
  assert.equal((await post('/api/agent/open-folder', { path: path.join(work, 'missing') })).status, 400);
});

test('plans with Claude, edits a folder in place, gets reviewed, fixes, and can undo it all', async () => {
  const dir = path.join(work, 'app');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'greet.js'), "console.log('hello')\n");
  fs.writeFileSync(path.join(dir, 'old.txt'), 'old\n');

  const listing = await (await fetch(`${base}/api/agent/browse?path=${encodeURIComponent(work)}`, { headers: auth })).json();
  assert.deepEqual(listing.folders.map((f) => f.name), ['app']);

  const opened = await (await post('/api/agent/open-folder', { path: dir })).json();
  assert.equal(opened.project.kind, 'folder');
  assert.equal(opened.project.dir, dir);
  const id = opened.project.id;

  script = [
    ['edit_file', { path: 'greet.js', old_text: 'hello', new_text: 'hi' }],
    ['write_file', { path: 'src/new.txt', content: 'new\n' }],
    ['delete_file', { path: 'old.txt' }],
    null, // first "done" → Claude's review finds a problem
    ['write_file', { path: 'fix.txt', content: 'fixed\n' }],
    ['edit_file', { path: 'greet.js', old_text: 'hi', new_text: 'hi there' }],
    null,
  ];
  const events = await run({ task: 'Make greet.js say hi', project: id, plan: true, review: true });
  const types = events.map((e) => e.type);

  // Claude planned first, and the plan was handed to the local model.
  assert.equal(claudeCalls[0].kind, 'plan');
  assert.match(claudeCalls[0].prompt, /Make greet\.js say hi/);
  assert.match(claudeCalls[0].prompt, /greet\.js/);
  assert.equal(claudeCalls[0].model, 'claude-opus-5');
  const plan = events.find((e) => e.type === 'plan');
  assert.equal(plan.advisor, 'claude');
  assert.match(plan.text, /Approach/);
  assert.ok(types.indexOf('plan') < types.indexOf('tool'));
  assert.ok(lastMessages.some((m) => m.role === 'user' && /implementation plan from Claude/.test(m.content)));

  // Claude reviewed the diff, the agent fixed what it found.
  assert.equal(claudeCalls[1].kind, 'review');
  assert.match(claudeCalls[1].prompt, /-console\.log\('hello'\)/);
  assert.match(claudeCalls[1].prompt, /\+console\.log\('hi'\)/);
  assert.match(claudeCalls[1].prompt, /Deleted old\.txt/);
  assert.equal(claudeCalls.length, 2); // one review round only
  const review = events.find((e) => e.type === 'review');
  assert.equal(review.ok, false);
  assert.ok(lastMessages.some((m) => m.role === 'user' && /reviewed your changes/.test(m.content)));

  // Files changed in place.
  assert.equal(fs.readFileSync(path.join(dir, 'greet.js'), 'utf8'), "console.log('hi there')\n");
  assert.equal(fs.readFileSync(path.join(dir, 'fix.txt'), 'utf8'), 'fixed\n');
  assert.ok(!fs.existsSync(path.join(dir, 'old.txt')));
  const done = events.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.changed, 4); // greet.js, src/new.txt, old.txt, fix.txt

  const changes = await (await fetch(`${base}/api/agent/changes?project=${encodeURIComponent(id)}`, { headers: auth })).json();
  assert.deepEqual(changes.changes.map((c) => `${c.status} ${c.path}`), ['added fix.txt', 'modified greet.js', 'deleted old.txt', 'added src/new.txt']);

  // Undo puts everything back.
  const undo = await (await post('/api/agent/undo', { run: done.run })).json();
  assert.equal(undo.files.length, 4);
  assert.equal(fs.readFileSync(path.join(dir, 'greet.js'), 'utf8'), "console.log('hello')\n");
  assert.equal(fs.readFileSync(path.join(dir, 'old.txt'), 'utf8'), 'old\n');
  assert.ok(!fs.existsSync(path.join(dir, 'fix.txt')));
  assert.ok(!fs.existsSync(path.join(dir, 'src', 'new.txt')));
  assert.equal((await post('/api/agent/undo', { run: done.run })).status, 404);
});

test('commits in a git folder with the user\'s own git', async () => {
  const dir = path.join(work, 'repo');
  fs.mkdirSync(dir);
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git('add', '-A');
  git('commit', '-qm', 'init');

  const { project } = await (await post('/api/agent/open-folder', { path: dir })).json();
  assert.equal(project.git, true);
  assert.equal(project.branch, 'main');

  claudeCalls.length = 0;
  script = [
    ['create_branch', { name: 'edean/b' }],
    ['write_file', { path: 'b.txt', content: 'b\n' }],
    ['git_status', {}],
    ['commit_and_push', { message: 'Add b' }],
    null,
  ];
  const events = await run({ task: 'Add b.txt and commit', project: project.id, plan: false, autonomy: 'auto' });
  assert.equal(claudeCalls.length, 0); // planning was off
  const results = events.filter((e) => e.type === 'tool_result');
  assert.ok(results.every((r) => r.ok), JSON.stringify(results));
  assert.match(results[2].detail.text, /added\s+b\.txt/);
  assert.match(results[3].summary, /Committed \w+ on edean\/b\. The folder has no "origin" remote/);
  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD'), 'edean/b');
  assert.equal(git('log', '-1', '--format=%s'), 'Add b');
  assert.equal(git('status', '--porcelain'), '');
});

test('line diff shows only what changed', async () => {
  const { _internals } = await import('../agent.js');
  const before = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
  const after = before.replace('line 5', 'line five').replace('line 25', 'line twenty-five');
  const d = _internals.lineDiff(before, after);
  assert.match(d, /-line 5\n\+line five/);
  assert.match(d, /-line 25\n\+line twenty-five/);
  assert.match(d, /…/); // the unchanged middle is skipped
  assert.doesNotMatch(d, /line 15/);
});
