// Edean server: serves the web app and relays chat requests to an
// OpenAI-compatible LLM backend (Ollama, llama.cpp, LM Studio, vLLM, ...).
// Nothing is logged or stored here — conversations live only in the browser.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { listLanguages, runCode } from './runner.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

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

const STATIC = {
  '/': ['public/index.html', 'text/html; charset=utf-8'],
  '/app.js': ['public/app.js', 'text/javascript; charset=utf-8'],
  '/prompts.js': ['public/prompts.js', 'text/javascript; charset=utf-8'],
  '/lib.js': ['public/lib.js', 'text/javascript; charset=utf-8'],
  '/compiler.js': ['public/compiler.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['public/styles.css', 'text/css; charset=utf-8'],
  '/favicon.svg': ['public/favicon.svg', 'image/svg+xml'],
  // Libraries are served from node_modules so the browser never calls a CDN.
  '/vendor/marked.esm.js': ['node_modules/marked/lib/marked.esm.js', 'text/javascript; charset=utf-8'],
  '/vendor/purify.es.mjs': ['node_modules/dompurify/dist/purify.es.mjs', 'text/javascript; charset=utf-8'],
  '/vendor/highlight.min.js': ['node_modules/@highlightjs/cdn-assets/highlight.min.js', 'text/javascript; charset=utf-8'],
  '/vendor/hl-dark.css': ['node_modules/@highlightjs/cdn-assets/styles/github-dark.min.css', 'text/css; charset=utf-8'],
  '/vendor/hl-light.css': ['node_modules/@highlightjs/cdn-assets/styles/github.min.css', 'text/css; charset=utf-8'],
};

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
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

function isAuthorized(req) {
  if (!config.appPassword) return true;
  const header = req.headers.authorization || '';
  if (!header.startsWith('Basic ')) return false;
  const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
  const password = decoded.slice(decoded.indexOf(':') + 1);
  const a = crypto.createHash('sha256').update(password).digest();
  const b = crypto.createHash('sha256').update(config.appPassword).digest();
  return crypto.timingSafeEqual(a, b);
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
  if (!isLoopback(config.host) && !config.appPassword) {
    return 'The code runner is disabled because Edean is reachable from your network without APP_PASSWORD. Set APP_PASSWORD (or CODE_RUNNER=on if you know it is safe).';
  }
  return null;
}

function handleLanguages(res) {
  const blocked = runnerBlockedReason();
  sendJson(res, 200, { enabled: !blocked, reason: blocked || '', languages: listLanguages() });
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

function serveStatic(req, res, pathname) {
  const entry = STATIC[pathname];
  if (!entry) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
  fs.readFile(path.join(ROOT, entry[0]), (err, data) => {
    if (err) return send(res, 500, 'Missing file: ' + entry[0], { 'Content-Type': 'text/plain' });
    send(res, 200, data, { 'Content-Type': entry[1], 'Cache-Control': 'no-cache' });
  });
}

export function createServer() {
  return http.createServer(async (req, res) => {
    if (!isAuthorized(req)) {
      return send(res, 401, 'Authentication required', { 'WWW-Authenticate': 'Basic realm="Edean", charset="UTF-8"' });
    }
    const { pathname } = new URL(req.url, 'http://localhost');
    try {
      if (pathname === '/api/health') return sendJson(res, 200, { ok: true });
      if (pathname === '/api/models' && req.method === 'GET') return await handleModels(res);
      if (pathname === '/api/chat' && req.method === 'POST') return await handleChat(req, res);
      if (pathname === '/api/run/languages' && req.method === 'GET') return handleLanguages(res);
      if (pathname === '/api/run' && req.method === 'POST') return await handleRun(req, res);
      if (req.method === 'GET') return serveStatic(req, res, pathname);
      send(res, 405, 'Method not allowed', { 'Content-Type': 'text/plain' });
    } catch (err) {
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' });
      else res.end();
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createServer().listen(config.port, config.host, () => {
    console.log(`Edean running at http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}`);
    console.log(`Model backend: ${config.llmBaseUrl}  (default model: ${config.defaultModel})`);
    if (config.host !== '127.0.0.1' && config.host !== 'localhost' && !config.appPassword) {
      console.warn('Warning: Edean is listening beyond localhost without APP_PASSWORD set.');
    }
    const blocked = runnerBlockedReason();
    const langs = listLanguages().filter((l) => l.available).map((l) => l.id);
    console.log(blocked ? `Code runner: disabled — ${blocked}` : `Code runner: ${langs.join(', ') || 'no toolchains found'}`);
  });
}
