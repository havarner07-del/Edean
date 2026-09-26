// Login for Edean: a password screen plus session cookies.
//
// The password comes from APP_PASSWORD if set, otherwise from ~/.edean/auth.json
// (a salted scrypt hash, changeable in Settings), otherwise the default "0000".
// API clients may also send the password with HTTP Basic auth.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_PASSWORD = '0000';
const COOKIE = 'edean_session';
const SESSION_DAYS = 30;
const DATA_DIR = () => process.env.EDEAN_DATA_DIR || path.join(os.homedir(), '.edean');
const FILE = () => path.join(DATA_DIR(), 'auth.json');

let store = null; // { password?: { salt, hash }, sessions: { [sha256(token)]: expiresAt } }
let envPassword = () => process.env.APP_PASSWORD || '';

// server.js passes its config so tests can change the password at runtime.
export function useConfig(config) { envPassword = () => config.appPassword || ''; }

function load() {
  if (store) return store;
  try { store = JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch { store = {}; }
  store.sessions ||= {};
  return store;
}

function persist() {
  fs.mkdirSync(DATA_DIR(), { recursive: true, mode: 0o700 });
  fs.writeFileSync(FILE(), JSON.stringify(store, null, 2), { mode: 0o600 });
  try { fs.chmodSync(FILE(), 0o600); } catch { /* not supported */ }
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const scrypt = (password, salt) => crypto.scryptSync(password, Buffer.from(salt, 'hex'), 32).toString('hex');
const same = (a, b) => {
  const x = Buffer.from(sha(a)); const y = Buffer.from(sha(b));
  return crypto.timingSafeEqual(x, y);
};

export function checkPassword(password) {
  if (typeof password !== 'string') return false;
  if (envPassword()) return same(password, envPassword());
  const s = load();
  if (s.password) return same(scrypt(password, s.password.salt), s.password.hash);
  return same(password, DEFAULT_PASSWORD);
}

// True once the user has picked their own password (or set APP_PASSWORD).
export function hasCustomPassword() {
  return !!envPassword() || !!load().password;
}

export function passwordFromEnv() { return !!envPassword(); }

export function changePassword(current, next) {
  if (envPassword()) throw Object.assign(new Error('The password is set by APP_PASSWORD; change it there.'), { status: 400 });
  if (!checkPassword(current)) throw Object.assign(new Error('Current password is wrong.'), { status: 403 });
  if (typeof next !== 'string' || next.length < 4) throw Object.assign(new Error('Use at least 4 characters.'), { status: 400 });
  const s = load();
  const salt = crypto.randomBytes(16).toString('hex');
  s.password = { salt, hash: scrypt(next, salt) };
  s.sessions = {}; // sign out everywhere else
  persist();
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function createSession() {
  const s = load();
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  for (const [k, exp] of Object.entries(s.sessions)) if (exp < now) delete s.sessions[k];
  s.sessions[sha(token)] = now + SESSION_DAYS * 86400000;
  persist();
  return `${COOKIE}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}`;
}

export function endSession(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) { delete load().sessions[sha(token)]; persist(); }
  return `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

export function isAuthenticated(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) {
    const exp = load().sessions[sha(token)];
    if (exp && exp > Date.now()) return true;
  }
  const header = req.headers.authorization || '';
  if (header.startsWith('Basic ')) {
    const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
    return checkPassword(decoded.slice(decoded.indexOf(':') + 1));
  }
  return false;
}

// Slow down password guessing: at most 10 failures per 5 minutes per address.
const failures = new Map();
export function tooManyAttempts(ip) {
  const now = Date.now();
  const list = (failures.get(ip) || []).filter((t) => now - t < 5 * 60000);
  failures.set(ip, list);
  return list.length >= 10;
}
export function recordFailure(ip) {
  failures.set(ip, [...(failures.get(ip) || []), Date.now()]);
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// A self-contained page (no scripts) so it works before anything else loads.
export function loginPage(error = '') {
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Edean · Sign in</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    display: flex; align-items: center; justify-content: center; padding: 16px;
    font: 14px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #cccccc;
    background: linear-gradient(180deg, #081021 0%, #060708 50%, #040405 100%) fixed, #070809;
  }
  .card { width: min(360px, 100%); background: #141518; border: 1px solid #26282e; border-radius: 6px; padding: 28px 26px 24px; }
  .logo { display: flex; align-items: center; gap: 12px; margin-bottom: 22px; }
  .logo svg { width: 38px; height: 38px; }
  .logo strong { display: block; font-size: 18px; color: #e6e6e6; }
  .logo span { font-size: 12px; color: #858891; }
  label { display: block; font-size: 12px; font-weight: 600; margin-bottom: 6px; }
  input {
    width: 100%; padding: 9px 11px; font: inherit; font-size: 16px; letter-spacing: .15em; color: #e6e6e6;
    background: #1b1c20; border: 1px solid #2f3238; border-radius: 4px; outline: none;
  }
  input:focus { border-color: #007fd4; }
  button {
    width: 100%; margin-top: 14px; padding: 9px 12px; font: inherit; font-weight: 600; color: #fff; cursor: pointer;
    background: linear-gradient(180deg, #0b54a0 0%, #083f7a 100%); border: 1px solid transparent; border-radius: 4px;
  }
  button:hover { filter: brightness(1.15); }
  .error { margin: 0 0 14px; padding: 8px 10px; font-size: 13px; color: #f14c4c; border: 1px solid rgba(241, 76, 76, .45); border-radius: 4px; }
  .foot { margin: 16px 0 0; font-size: 11.5px; color: #6b6f78; text-align: center; }
</style></head>
<body>
  <form class="card" method="post" action="/login">
    <div class="logo">
      <svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="46" fill="none" stroke="#3794ff" stroke-width="2" stroke-dasharray="1.5 5" opacity=".5"/><circle cx="50" cy="50" r="38" fill="none" stroke="#1f6fcc" stroke-width="2.5" stroke-dasharray="34 10 6 10"/><circle cx="50" cy="50" r="22" fill="#0f2340" stroke="#3794ff" stroke-width="2"/><path transform="translate(34 34)" d="M11 9 4 16l7 7M21 9l7 7-7 7M18 6l-4 20" fill="none" stroke="#e6f0ff" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
      <div><strong>Edean</strong><span>Private coding AI</span></div>
    </div>
    ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
    <button type="submit">Unlock</button>
    <p class="foot">Your chats and code stay private to you.</p>
  </form>
</body></html>`;
}

// For tests.
export function _reset() { store = null; failures.clear(); }
