// Edean server: serves the web app and relays chat requests to an
// OpenAI-compatible LLM backend (Ollama, llama.cpp, LM Studio, vLLM, ...).
// Nothing is logged or stored here — conversations live only in the browser.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listLanguages, runCode } from './runner.js';
import { getStatus, startInstall, installLog, startOllama } from './setup.js';
import { isSea } from './toolchains.js';
import * as drive from './drive.js';
import * as auth from './auth.js';
import * as github from './github.js';
import * as advisors from './advisors.js';
import * as agent from './agent.js';

// import.meta.url is undefined once bundled into the Edean executable.
const HERE = typeof import.meta.url === 'string' ? fileURLToPath(import.meta.url) : '';
const ROOT = HERE ? path.dirname(HERE) : path.dirname(process.execPath);

export const config = {
  port: Number(process.env.PORT || 3000),
  // Bind to localhost by default so the app is private unless you opt in.
  host: process.env.HOST || '127.0.0.1',
  llmBaseUrl: (process.env.LLM_BASE_URL || 'http://127.0.0.1:11434/v1').replace(/\/+$/, ''),
  llmApiKey: process.env.LLM_API_KEY || '',
  defaultModel: process.env.DEFAULT_MODEL || 'qwen2.5-coder:7b',
  // Optional shared password (HTTP Basic auth) for when you expose Edean on a network.
  appPassword: process.env.APP_PASSWORD || '',
  // Code runner: "auto" (on unless reachable from the network without a password), "on", or "off".
  codeRunner: (process.env.CODE_RUNNER || 'auto').toLowerCase(),
  maxBodyBytes: 8 * 1024 * 1024,
};

const JS = 'text/javascript; charset=utf-8';
const CSS = 'text/css; charset=utf-8';
// Set by the desktop launcher (Edean.exe): lets the app offer "Quit Edean" and lets
// the launcher notice when no window has been open for a while.
export const desktop = { enabled: false, quit: null, lastActivity: Date.now() };

export const STATIC = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['public/app.js', JS],
  '/prompts.js': ['public/prompts.js', JS],
  '/lib.js': ['public/lib.js', JS],
  '/compiler.js': ['public/compiler.js', JS],
  '/systems.js': ['public/systems.js', JS],
  '/drive.js': ['public/drive.js', JS],
  '/workspace.js': ['public/workspace.js', JS],
  '/agent-ui.js': ['public/agent-ui.js', JS],
  '/styles.css': ['public/styles.css', CSS],
  '/favicon.svg': ['public/favicon.svg', 'image/svg+xml'],
  // Libraries are served from node_modules so the browser never calls a CDN.
  '/vendor/marked.esm.js': ['node_modules/marked/lib/marked.esm.js', JS],
  '/vendor/purify.es.mjs': ['node_modules/dompurify/dist/purify.es.mjs', JS],
  '/vendor/highlight.min.js': ['node_modules/@highlightjs/cdn-assets/highlight.min.js', JS],
  '/vendor/hl-dark.css': ['node_modules/@highlightjs/cdn-assets/styles/vs2015.min.css', CSS],
  '/vendor/hl-light.css': ['node_modules/@highlightjs/cdn-assets/styles/vs.min.css', CSS],
};

// Inside the packaged executable, static files are embedded as SEA assets.
const sea = isSea ? process.getBuiltinModule('node:sea') : null;
function readAsset(rel, cb) {
  if (sea) {
    try { return cb(null, Buffer.from(sea.getAsset(rel))); } catch (err) { return cb(err); }
  }
  fs.readFile(path.join(ROOT, rel), cb);
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data: https://avatars.githubusercontent.com; style-src 'self' 'unsafe-inline'; font-src 'self' data:; worker-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...headers });
  res.end(body);
}

function sendJson(res, status, obj) {
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
}

function upstreamHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (config.llmApiKey) h.Authorization = `Bearer ${config.llmApiKey}`;
  return h;
}


function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > config.maxBodyBytes) {
        reject(Object.assign(new Error('Request too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// Only forward fields we understand, so the browser can't smuggle arbitrary options upstream.
export function buildChatPayload(input) {
  if (!input || !Array.isArray(input.messages) || input.messages.length === 0) {
    throw Object.assign(new Error('messages must be a non-empty array'), { status: 400 });
  }
  const messages = input.messages.map((m) => {
    if (!m || !['system', 'user', 'assistant'].includes(m.role) || typeof m.content !== 'string') {
      throw Object.assign(new Error('each message needs a role (system|user|assistant) and string content'), { status: 400 });
    }
    return { role: m.role, content: m.content };
  });
  const payload = { model: typeof input.model === 'string' && input.model ? input.model : config.defaultModel, messages, stream: true };
  const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined);
  const temperature = num(input.temperature, 0, 2);
  const topP = num(input.top_p, 0, 1);
  const maxTokens = num(input.max_tokens, 1, 262144);
  if (temperature !== undefined) payload.temperature = temperature;
  if (topP !== undefined) payload.top_p = topP;
  if (maxTokens !== undefined) payload.max_tokens = Math.round(maxTokens);
  return payload;
}

const isLoopback = (host) => ['127.0.0.1', 'localhost', '::1'].includes(host);

// Running code is powerful, so refuse it when anyone on the network could reach it.
export function runnerBlockedReason() {
  if (config.codeRunner === 'off') return 'The code runner is turned off (CODE_RUNNER=off).';
  if (config.codeRunner === 'on') return null;
  if (!isLoopback(config.host) && !auth.hasCustomPassword()) {
    return 'The code runner is disabled because Edean is reachable from your network and still uses the default password. Change the password in Settings (or set CODE_RUNNER=on if you know it is safe).';
  }
  return null;
}

async function handleLanguages(req, res) {
  const blocked = runnerBlockedReason();
  const fresh = new URL(req.url, 'http://x').searchParams.has('fresh');
  sendJson(res, 200, { enabled: !blocked, reason: blocked || '', languages: await listLanguages({ fresh }) });
}

// Installing software is only allowed from this machine, or behind the app password.
export function setupBlockedReason() {
  if (!isLoopback(config.host) && !auth.hasCustomPassword()) {
    return 'Installing is disabled because Edean is reachable from your network and still uses the default password. Change it in Settings first.';
  }
  return null;
}

async function handleSetup(req, res, pathname) {
  const params = new URL(req.url, 'http://x').searchParams;
  if (pathname === '/api/setup/status' && req.method === 'GET') {
    const status = await getStatus(config, { fresh: params.has('fresh') });
    const blocked = setupBlockedReason();
    return sendJson(res, 200, { ...status, canInstall: !blocked, installBlockedReason: blocked || '' });
  }
  if (pathname === '/api/setup/log' && req.method === 'GET') {
    return sendJson(res, 200, installLog(Number(params.get('since')) || 0));
  }
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
  const blocked = setupBlockedReason();
  if (blocked) return sendJson(res, 403, { error: blocked });
  if (pathname === '/api/setup/install') {
    let body = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { /* install everything */ }
    const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string') : null;
    if (!startInstall(config, ids)) return sendJson(res, 409, { error: 'An install is already running' });
    return sendJson(res, 202, { started: true });
  }
  if (pathname === '/api/setup/start-engine') {
    return sendJson(res, 200, { started: startOllama() });
  }
  return sendJson(res, 404, { error: 'Not found' });
}

async function handleRun(req, res) {
  const blocked = runnerBlockedReason();
  if (blocked) return sendJson(res, 403, { error: blocked });
  let input;
  try {
    input = JSON.parse(await readBody(req));
  } catch (err) {
    return sendJson(res, err.status || 400, { error: err.message || 'Invalid request' });
  }
  const abort = new AbortController();
  res.on('close', () => { if (!res.writableFinished) abort.abort(); });
  try {
    const result = await runCode({ language: input?.language, code: input?.code, stdin: input?.stdin }, { signal: abort.signal });
    if (!abort.signal.aborted) sendJson(res, 200, result);
  } catch (err) {
    if (!abort.signal.aborted) sendJson(res, err.status || 500, { error: err.status ? err.message : 'Could not run the program' });
  }
}

// The coding agent. Runs stream their progress as server-sent events.
async function handleAgent(req, res, pathname) {
  const blocked = setupBlockedReason() || runnerBlockedReason();
  if (blocked) return sendJson(res, 403, { error: blocked.replace(/^(Installing is|The code runner is)/, 'The agent is') });
  try {
    if (pathname === '/api/agent/projects' && req.method === 'GET') return sendJson(res, 200, { projects: await agent.listProjects(), active: agent.activeRun() });
    if (pathname === '/api/agent/changes' && req.method === 'GET') return sendJson(res, 200, { changes: await agent.projectChanges(new URL(req.url, 'http://x').searchParams.get('project')) });
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
    const body = JSON.parse((await readBody(req)) || '{}');
    if (pathname === '/api/agent/stop') { agent.stopRun(body.run); return sendJson(res, 200, { ok: true }); }
    if (pathname === '/api/agent/approve') return sendJson(res, agent.answerApproval(body.run, body.id, body.decision) ? 200 : 404, { ok: true });
    if (pathname === '/api/agent/run') {
      if (typeof body.task !== 'string' || !body.task.trim()) return sendJson(res, 400, { error: 'Tell the agent what to do.' });
      if (agent.activeRun()) return sendJson(res, 409, { error: 'The agent is already working. Stop it first.' });
      res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
      let runId = null;
      const send = (event) => { if (!res.writableEnded) res.write(`data: ${JSON.stringify({ ...event, run: runId })}\n\n`); };
      res.on('close', () => { if (!res.writableFinished) agent.stopRun(runId); });
      const started = agent.runAgent(config, {
        task: body.task.trim().slice(0, 20000),
        history: Array.isArray(body.history) ? body.history : [],
        project: typeof body.project === 'string' ? body.project : null,
        model: typeof body.model === 'string' && body.model ? body.model : config.defaultModel,
        autonomy: body.autonomy === 'auto' ? 'auto' : 'ask',
      }, send);
      runId = agent.activeRun()?.id || null;
      send({ type: 'start' });
      await started;
      return res.end();
    }
    return sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    if (res.headersSent) return res.end();
    return sendJson(res, err.status || 500, { error: err.status ? err.message : `Agent error: ${err.message}` });
  }
}

// GitHub (Workspace) and advisors (Claude / GitHub Models).
async function handleGithub(req, res, pathname) {
  const blocked = setupBlockedReason();
  if (blocked) return sendJson(res, 403, { error: blocked.replace('Installing is', 'GitHub access is') });
  const q = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
  const body = async () => { try { return JSON.parse((await readBody(req)) || '{}'); } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); } };
  const route = `${req.method} ${pathname.slice('/api/github'.length)}`;
  try {
    switch (route) {
      case 'GET /status': return sendJson(res, 200, await github.status());
      case 'POST /connect': return sendJson(res, 200, await github.connect((await body()).token));
      case 'POST /disconnect': await github.disconnect(); return sendJson(res, 200, { ok: true });
      case 'GET /repos': return sendJson(res, 200, { repos: await github.listRepos() });
      case 'GET /repo': return sendJson(res, 200, await github.repoInfo(q.owner, q.repo));
      case 'GET /branches': return sendJson(res, 200, { branches: await github.branches(q.owner, q.repo) });
      case 'POST /branches': { const b = await body(); return sendJson(res, 200, await github.createBranch(b.owner, b.repo, b.name, b.from)); }
      case 'GET /tree': return sendJson(res, 200, await github.tree(q.owner, q.repo, q.branch));
      case 'GET /file': return sendJson(res, 200, await github.readFile(q.owner, q.repo, q.path, q.branch));
      case 'POST /commit': { const b = await body(); return sendJson(res, 200, await github.commit(b.owner, b.repo, b.branch, b.message, b.changes)); }
      case 'GET /commits': return sendJson(res, 200, { commits: await github.commits(q.owner, q.repo, q.branch) });
      case 'GET /pulls': return sendJson(res, 200, { pulls: await github.pulls(q.owner, q.repo) });
      case 'POST /pulls': { const b = await body(); return sendJson(res, 200, await github.createPull(b.owner, b.repo, b)); }
      case 'GET /dependencies': return sendJson(res, 200, await github.dependencies(q.owner, q.repo, q.branch));
      case 'GET /zip': {
        const upstream = await github.zipball(q.owner, q.repo, q.branch);
        const name = `${q.repo}-${String(q.branch).replace(/[^\w.-]+/g, '-')}.zip`;
        res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${name}"` });
        for await (const chunk of upstream.body) res.write(chunk);
        return res.end();
      }
      default: return sendJson(res, 404, { error: 'Not found' });
    }
  } catch (err) {
    if (res.headersSent) return res.end();
    return sendJson(res, err.status || 500, { error: err.status ? err.message : `GitHub request failed: ${err.message}` });
  }
}

async function handleAdvisors(req, res, pathname) {
  const blocked = setupBlockedReason();
  if (blocked) return sendJson(res, 403, { error: blocked.replace('Installing is', 'Advisors are') });
  try {
    if (pathname === '/api/advisors' && req.method === 'GET') return sendJson(res, 200, await advisors.advisorStatus());
    if (pathname === '/api/advisors/settings' && req.method === 'POST') return sendJson(res, 200, await advisors.updateAdvisors(JSON.parse((await readBody(req)) || '{}')));
    if (pathname === '/api/advisors/ask' && req.method === 'POST') return sendJson(res, 200, await advisors.ask(JSON.parse((await readBody(req)) || '{}')));
    return sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    return sendJson(res, err.status || 500, { error: err.status ? err.message : `Advisor request failed: ${err.message}` });
  }
}

// Google Drive chat storage. Tokens stay on this server; the browser only sees chats.
async function handleDrive(req, res, pathname) {
  const blocked = setupBlockedReason();
  if (blocked) return sendJson(res, 403, { error: blocked.replace('Installing is', 'Google Drive is') });
  const url = new URL(req.url, 'http://x');
  const method = req.method;
  const body = async () => { try { return JSON.parse((await readBody(req)) || '{}'); } catch { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); } };
  try {
    if (pathname === '/api/drive/status' && method === 'GET') return sendJson(res, 200, await drive.driveStatus());
    if (pathname === '/api/drive/credentials' && method === 'POST') {
      await drive.setCredentials(await body());
      return sendJson(res, 200, await drive.driveStatus());
    }
    if (pathname === '/api/drive/auth' && method === 'GET') {
      // Google only redirects desktop-app sign-ins back to loopback addresses.
      const host = req.headers.host || '';
      if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
        return send(res, 400, 'Open Edean at http://127.0.0.1 on this computer to connect Google Drive.', { 'Content-Type': 'text/plain; charset=utf-8' });
      }
      const target = await drive.authUrl(`http://${host}/api/drive/callback`);
      return send(res, 302, '', { Location: target, 'Cache-Control': 'no-store' });
    }
    if (pathname === '/api/drive/callback' && method === 'GET') {
      try {
        await drive.handleCallback(Object.fromEntries(url.searchParams));
        return send(res, 302, '', { Location: '/?drive=connected' });
      } catch (err) {
        return send(res, 302, '', { Location: `/?drive=error&message=${encodeURIComponent(err.message)}` });
      }
    }
    if (pathname === '/api/drive/disconnect' && method === 'POST') { await drive.disconnect(); return sendJson(res, 200, { ok: true }); }
    if (pathname === '/api/drive/folders' && method === 'GET') return sendJson(res, 200, { folders: await drive.listFolders() });
    if (pathname === '/api/drive/folder' && method === 'POST') return sendJson(res, 200, { folder: await drive.chooseFolder(await body()) });
    if (pathname === '/api/drive/chats' && method === 'GET') return sendJson(res, 200, { chats: await drive.listChats() });
    const m = pathname.match(/^\/api\/drive\/chats\/([\w-]{1,64})$/);
    if (m && method === 'PUT') { await drive.saveChat(m[1], await body()); return sendJson(res, 200, { ok: true }); }
    if (m && method === 'DELETE') { await drive.deleteChat(m[1]); return sendJson(res, 200, { ok: true }); }
    return sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    return sendJson(res, err.status || 500, { error: err.status ? err.message : `Google Drive request failed: ${err.message}` });
  }
}

async function handleModels(res) {
  try {
    const r = await fetch(`${config.llmBaseUrl}/models`, { headers: upstreamHeaders(), signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`backend responded ${r.status}`);
    const data = await r.json();
    const models = (data.data || []).map((m) => m.id).filter(Boolean).sort();
    sendJson(res, 200, { models, defaultModel: config.defaultModel, online: true });
  } catch (err) {
    sendJson(res, 200, { models: [], defaultModel: config.defaultModel, online: false, error: String(err.message || err) });
  }
}

async function handleChat(req, res) {
  let payload;
  try {
    payload = buildChatPayload(JSON.parse(await readBody(req)));
  } catch (err) {
    return sendJson(res, err.status || 400, { error: err.message || 'Invalid request' });
  }

  const abort = new AbortController();
  res.on('close', () => abort.abort());

  let upstream;
  try {
    upstream = await fetch(`${config.llmBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: upstreamHeaders(),
      body: JSON.stringify(payload),
      signal: abort.signal,
    });
  } catch (err) {
    if (abort.signal.aborted) return;
    return sendJson(res, 502, { error: `Could not reach the model backend at ${config.llmBaseUrl}. Is it running? (${err.message})` });
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '');
    return sendJson(res, 502, { error: `Model backend error ${upstream.status}: ${text.slice(0, 500)}` });
  }

  res.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  try {
    for await (const chunk of upstream.body) {
      if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
    }
  } catch {
    // Client hung up or backend dropped; either way just end the stream.
  }
  res.end();
}

// Monaco (VS Code's editor) is served as a whole directory of files.
export const MONACO_DIR = 'node_modules/monaco-editor/min';
const MIME = { '.js': JS, '.css': CSS, '.ttf': 'font/ttf', '.json': 'application/json', '.svg': 'image/svg+xml' };

function serveMonaco(res, pathname) {
  const rel = decodeURIComponent(pathname.slice('/vendor/monaco/'.length));
  if (!rel || rel.includes('..') || rel.includes('\\') || !/^[\w./-]+$/.test(rel)) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  readAsset(`${MONACO_DIR}/${rel}`, (err, data) => {
    if (err) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
    send(res, 200, data, { 'Content-Type': MIME[path.extname(rel)] || 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' });
  });
}

function serveStatic(req, res, pathname) {
  if (pathname.startsWith('/vendor/monaco/')) return serveMonaco(res, pathname);
  const entry = STATIC[pathname];
  if (!entry) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  readAsset(entry[0], (err, data) => {
    if (err) return send(res, 500, 'Missing file: ' + entry[0], { 'Content-Type': 'text/plain' });
    send(res, 200, data, { 'Content-Type': entry[1], 'Cache-Control': 'no-cache' });
  });
}

export function createServer() {
  auth.useConfig(config);
  return http.createServer(async (req, res) => {
    const { pathname, searchParams } = new URL(req.url, 'http://localhost');
    try {
      // Public: health check, the login page and its icon.
      if (pathname === '/api/health') return sendJson(res, 200, { ok: true, app: 'edean' });
      if (pathname === '/favicon.svg') return serveStatic(req, res, pathname);
      if (pathname === '/login') { desktop.lastActivity = Date.now(); return await handleLogin(req, res, searchParams); }
      if (!auth.isAuthenticated(req)) {
        if (pathname.startsWith('/api/')) {
          return send(res, 401, JSON.stringify({ error: 'Sign in required' }), { 'Content-Type': 'application/json', 'X-Edean-Auth': 'required' });
        }
        return send(res, 302, '', { Location: '/login', 'Cache-Control': 'no-store' });
      }
      desktop.lastActivity = Date.now();
      if (pathname === '/api/ping') return sendJson(res, 200, { ok: true, desktop: desktop.enabled });
      if (pathname === '/api/quit' && req.method === 'POST') {
        if (!desktop.enabled || !desktop.quit) return sendJson(res, 400, { error: 'Edean is not running as the desktop app.' });
        sendJson(res, 200, { ok: true });
        setTimeout(desktop.quit, 200);
        return;
      }
      if (pathname === '/api/logout' && req.method === 'POST') {
        return send(res, 200, JSON.stringify({ ok: true }), { 'Set-Cookie': auth.endSession(req), 'Content-Type': 'application/json' });
      }
      if (pathname === '/api/password' && req.method === 'POST') {
        const { current, next } = JSON.parse((await readBody(req)) || '{}');
        try { auth.changePassword(current, next); } catch (err) { return sendJson(res, err.status || 400, { error: err.message }); }
        return send(res, 200, JSON.stringify({ ok: true }), { 'Set-Cookie': auth.createSession(), 'Content-Type': 'application/json' });
      }
      if (pathname === '/api/account' && req.method === 'GET') {
        return sendJson(res, 200, { customPassword: auth.hasCustomPassword(), passwordFromEnv: auth.passwordFromEnv() });
      }
      if (pathname.startsWith('/api/setup/')) return await handleSetup(req, res, pathname);
      if (pathname.startsWith('/api/drive/')) return await handleDrive(req, res, pathname);
      if (pathname.startsWith('/api/github/')) return await handleGithub(req, res, pathname);
      if (pathname.startsWith('/api/agent/')) return await handleAgent(req, res, pathname);
      if (pathname === '/api/advisors' || pathname.startsWith('/api/advisors/')) return await handleAdvisors(req, res, pathname);
      if (pathname === '/api/models' && req.method === 'GET') return await handleModels(res);
      if (pathname === '/api/chat' && req.method === 'POST') return await handleChat(req, res);
      if (pathname === '/api/run/languages' && req.method === 'GET') return await handleLanguages(req, res);
      if (pathname === '/api/run' && req.method === 'POST') return await handleRun(req, res);
      if (req.method === 'GET') return serveStatic(req, res, pathname);
      send(res, 405, 'Method not allowed', { 'Content-Type': 'text/plain' });
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' });
      else res.end();
    }
  });
}

async function handleLogin(req, res, params) {
  const page = (error, status = 200) => send(res, status, auth.loginPage(error), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  if (req.method === 'GET') return auth.isAuthenticated(req) ? send(res, 302, '', { Location: '/' }) : page(params.get('error') ? 'Wrong password.' : '');
  if (req.method !== 'POST') return send(res, 405, 'Method not allowed');
  const ip = req.socket.remoteAddress || '';
  if (auth.tooManyAttempts(ip)) return page('Too many attempts. Wait a few minutes and try again.', 429);
  const password = new URLSearchParams(await readBody(req)).get('password') || '';
  if (!auth.checkPassword(password)) {
    auth.recordFailure(ip);
    return page('Wrong password.', 401);
  }
  return send(res, 303, '', { Location: '/', 'Set-Cookie': auth.createSession(), 'Cache-Control': 'no-store' });
}

export async function startServer({ port = config.port, host = config.host } = {}) {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  console.log(`Edean running at http://${shown}:${server.address().port}`);
  console.log(`Model backend: ${config.llmBaseUrl}  (default model: ${config.defaultModel})`);
  if (!isLoopback(host) && !auth.hasCustomPassword()) {
    console.warn('Warning: Edean is reachable from your network and still uses the default password 0000. Change it in Settings.');
  }
  const blocked = runnerBlockedReason();
  listLanguages().then((all) => {
    const langs = all.filter((l) => l.available).map((l) => l.id);
    console.log(blocked ? `Code runner: disabled — ${blocked}` : `Code runner: ${langs.join(', ') || 'no toolchains found'}`);
  });
  return server;
}

if (HERE && process.argv[1] && path.resolve(process.argv[1]) === HERE) {
  startServer().catch((err) => {
    console.error(err.code === 'EADDRINUSE' ? `Port ${config.port} is already in use. Set PORT to use another one.` : err);
    process.exit(1);
  });
}
