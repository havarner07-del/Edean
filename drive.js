// Google Drive chat storage. When connected, every chat is saved as a JSON file
// in a Drive folder you choose, instead of in this browser.
//
// Sign-in uses Google's OAuth flow for desktop apps (loopback redirect + PKCE)
// with your own OAuth client. The browser never sees Google tokens: this server
// keeps the refresh token in ~/.edean/google-drive.json (readable only by you)
// and talks to Drive itself. Only the drive.file scope is requested, so Edean
// can see and change only the files and folders it created — nothing else in your Drive.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const DATA_DIR = process.env.EDEAN_DATA_DIR || path.join(os.homedir(), '.edean');
const FILE = path.join(DATA_DIR, 'google-drive.json');
const URLS = {
  auth: process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
  token: process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
  revoke: process.env.GOOGLE_REVOKE_URL || 'https://oauth2.googleapis.com/revoke',
  api: process.env.GOOGLE_API_BASE || 'https://www.googleapis.com',
};
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const CHAT_ID = /^[\w-]{1,64}$/;

const fail = (message, status = 400) => Object.assign(new Error(message), { status });

let settings = null;         // persisted: clientId, clientSecret, refreshToken, email, folder
let access = null;           // { token, expiresAt }
const pendingAuth = new Map(); // state -> { verifier, redirectUri, createdAt }
const fileIds = new Map();   // chat id -> Drive file id

async function load() {
  if (settings) return settings;
  try { settings = JSON.parse(await fs.readFile(FILE, 'utf8')); } catch { settings = {}; }
  return settings;
}

async function persist() {
  await fs.mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await fs.writeFile(FILE, JSON.stringify(settings, null, 2), { mode: 0o600 });
  await fs.chmod(FILE, 0o600).catch(() => {});
}

function credentials() {
  return {
    clientId: process.env.GOOGLE_CLIENT_ID || settings.clientId || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || settings.clientSecret || '',
    fromEnv: !!process.env.GOOGLE_CLIENT_ID,
  };
}

export async function driveStatus() {
  await load();
  const { clientId, clientSecret, fromEnv } = credentials();
  return {
    configured: !!(clientId && clientSecret),
    credentialsFromEnv: fromEnv,
    clientId: clientId ? `${clientId.slice(0, 12)}…` : '',
    connected: !!settings.refreshToken,
    email: settings.email || '',
    folder: settings.folder || null,
  };
}

export async function setCredentials({ clientId, clientSecret }) {
  await load();
  clientId = String(clientId || '').trim();
  clientSecret = String(clientSecret || '').trim();
  if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId)) throw fail('That doesn\'t look like a Google OAuth client ID (it ends in .apps.googleusercontent.com).');
  if (clientSecret.length < 8) throw fail('Paste the client secret too.');
  if (clientId !== settings.clientId) { delete settings.refreshToken; delete settings.email; access = null; }
  Object.assign(settings, { clientId, clientSecret });
  await persist();
}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function authUrl(redirectUri) {
  await load();
  const { clientId, clientSecret } = credentials();
  if (!clientId || !clientSecret) throw fail('Add your Google OAuth client first.');
  for (const [k, v] of pendingAuth) if (Date.now() - v.createdAt > 10 * 60 * 1000) pendingAuth.delete(k);
  const state = b64url(crypto.randomBytes(24));
  const verifier = b64url(crypto.randomBytes(48));
  pendingAuth.set(state, { verifier, redirectUri, createdAt: Date.now() });
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
    code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
  });
  return `${URLS.auth}?${params}`;
}

async function tokenRequest(params) {
  const { clientId, clientSecret } = credentials();
  const r = await fetch(URLS.token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }),
    signal: AbortSignal.timeout(15000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw fail(`Google sign-in failed: ${data.error_description || data.error || r.status}`, 502);
  return data;
}

export async function handleCallback({ code, state, error }) {
  await load();
  if (error) throw fail(error === 'access_denied' ? 'Google access was not granted.' : `Google returned an error: ${error}`);
  const pending = pendingAuth.get(state);
  pendingAuth.delete(state);
  if (!pending) throw fail('This sign-in link expired. Please try connecting again.');
  const data = await tokenRequest({ code, code_verifier: pending.verifier, grant_type: 'authorization_code', redirect_uri: pending.redirectUri });
  if (!data.refresh_token) throw fail('Google did not return a refresh token. Remove Edean from your Google account\'s third-party access and try again.', 502);
  settings.refreshToken = data.refresh_token;
  access = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
  try {
    const about = await api('GET', '/drive/v3/about', { query: { fields: 'user(emailAddress)' } });
    settings.email = about.user?.emailAddress || '';
  } catch { settings.email = ''; }
  // A folder from a previous connection may not be visible to this account.
  if (settings.folder) {
    try { await api('GET', `/drive/v3/files/${settings.folder.id}`, { query: { fields: 'id,trashed' } }); } catch { settings.folder = null; }
  }
  fileIds.clear();
  await persist();
}

export async function disconnect() {
  await load();
  const token = settings.refreshToken;
  delete settings.refreshToken;
  delete settings.email;
  delete settings.folder;
  access = null;
  fileIds.clear();
  await persist();
  if (token) {
    await fetch(URLS.revoke, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(10000),
    }).catch(() => {});
  }
}

async function accessToken() {
  if (access && Date.now() < access.expiresAt) return access.token;
  if (!settings.refreshToken) throw fail('Google Drive is not connected.', 409);
  try {
    const data = await tokenRequest({ refresh_token: settings.refreshToken, grant_type: 'refresh_token' });
    access = { token: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
    return access.token;
  } catch (err) {
    if (/invalid_grant/.test(err.message)) {
      // The user revoked access, or the token expired (7 days for apps in "Testing").
      delete settings.refreshToken;
      await persist();
      throw fail('Google Drive access expired. Open Chat storage and sign in again.', 401);
    }
    throw err;
  }
}

async function api(method, pathname, { query, json, body, headers = {}, raw = false, retry = true } = {}) {
  const url = new URL(URLS.api + pathname);
  for (const [k, v] of Object.entries(query || {})) url.searchParams.set(k, v);
  const r = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${await accessToken()}`,
      ...(json ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: json ? JSON.stringify(json) : body,
    signal: AbortSignal.timeout(30000),
  });
  if (r.status === 401 && retry) {
    access = null;
    return api(method, pathname, { query, json, body, headers, raw, retry: false });
  }
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw fail(`Google Drive error: ${data.error?.message || r.statusText || r.status}`, r.status === 404 ? 404 : 502);
  }
  if (raw) return r.text();
  return r.status === 204 ? null : r.json();
}

const q = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

async function listAll(query, fields) {
  const files = [];
  let pageToken = '';
  do {
    const data = await api('GET', '/drive/v3/files', {
      query: { q: query, fields: `nextPageToken,files(${fields})`, pageSize: '1000', spaces: 'drive', ...(pageToken ? { pageToken } : {}) },
    });
    files.push(...(data.files || []));
    pageToken = data.nextPageToken || '';
  } while (pageToken);
  return files;
}

// Folders Edean can use: with drive.file access, that's folders Edean created.
export async function listFolders() {
  await load();
  const files = await listAll(`mimeType=${q(FOLDER_MIME)} and trashed=false`, 'id,name,modifiedTime');
  return files.map((f) => ({ id: f.id, name: f.name }));
}

export async function chooseFolder({ id, name }) {
  await load();
  let folder;
  if (id) {
    const f = await api('GET', `/drive/v3/files/${encodeURIComponent(id)}`, { query: { fields: 'id,name,mimeType,trashed' } });
    if (f.mimeType !== FOLDER_MIME || f.trashed) throw fail('That is not an available folder.');
    folder = { id: f.id, name: f.name };
  } else {
    name = String(name || '').trim().slice(0, 120);
    if (!name) throw fail('Give the new folder a name.');
    const f = await api('POST', '/drive/v3/files', { query: { fields: 'id,name' }, json: { name, mimeType: FOLDER_MIME } });
    folder = { id: f.id, name: f.name };
  }
  folder.link = `https://drive.google.com/drive/folders/${folder.id}`;
  settings.folder = folder;
  fileIds.clear();
  await persist();
  return folder;
}

function requireFolder() {
  if (!settings.refreshToken) throw fail('Google Drive is not connected.', 409);
  if (!settings.folder) throw fail('Choose a Google Drive folder first.', 409);
  return settings.folder.id;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const n = i++; out[n] = await fn(items[n]); }
  }));
  return out;
}

export async function listChats() {
  await load();
  const folderId = requireFolder();
  const files = (await listAll(`${q(folderId)} in parents and trashed=false`, 'id,name,appProperties'))
    .filter((f) => f.appProperties?.edeanChatId);
  const chats = await mapLimit(files, 6, async (f) => {
    fileIds.set(f.appProperties.edeanChatId, f.id);
    try {
      const chat = JSON.parse(await api('GET', `/drive/v3/files/${f.id}`, { query: { alt: 'media' }, raw: true }));
      return chat && Array.isArray(chat.messages) ? { ...chat, id: f.appProperties.edeanChatId } : null;
    } catch { return null; }
  });
  return chats.filter(Boolean);
}

export function chatFileName(chat) {
  const date = new Date(chat.createdAt || Date.now()).toISOString().slice(0, 10);
  const title = String(chat.title || 'Chat').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Chat';
  return `${date} ${title}.json`;
}

async function findFileId(chatId) {
  if (fileIds.has(chatId)) return fileIds.get(chatId);
  const files = await listAll(
    `${q(settings.folder.id)} in parents and trashed=false and appProperties has { key='edeanChatId' and value=${q(chatId)} }`, 'id');
  if (files[0]) fileIds.set(chatId, files[0].id);
  return files[0]?.id || null;
}

function multipart(metadata, content) {
  const boundary = `edean-${crypto.randomUUID()}`;
  const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${content}\r\n--${boundary}--`;
  return { body, headers: { 'Content-Type': `multipart/related; boundary=${boundary}` } };
}

export async function saveChat(chatId, chat) {
  await load();
  const folderId = requireFolder();
  if (!CHAT_ID.test(chatId)) throw fail('Invalid chat id.');
  if (!chat || !Array.isArray(chat.messages)) throw fail('Invalid chat.');
  const content = JSON.stringify({ ...chat, id: chatId }, null, 2);
  const name = chatFileName(chat);
  const existing = await findFileId(chatId);
  if (existing) {
    try {
      const { body, headers } = multipart({ name }, content);
      await api('PATCH', `/upload/drive/v3/files/${existing}`, { query: { uploadType: 'multipart', fields: 'id' }, body, headers });
      return;
    } catch (err) {
      if (err.status !== 404) throw err;
      fileIds.delete(chatId); // deleted in Drive meanwhile: create it again
    }
  }
  const { body, headers } = multipart({ name, parents: [folderId], mimeType: 'application/json', appProperties: { edeanChatId: chatId } }, content);
  const created = await api('POST', '/upload/drive/v3/files', { query: { uploadType: 'multipart', fields: 'id' }, body, headers });
  fileIds.set(chatId, created.id);
}

export async function deleteChat(chatId) {
  await load();
  requireFolder();
  if (!CHAT_ID.test(chatId)) throw fail('Invalid chat id.');
  const id = await findFileId(chatId);
  if (!id) return;
  // Moved to Drive's trash, so it can still be recovered for 30 days.
  await api('PATCH', `/drive/v3/files/${id}`, { json: { trashed: true } });
  fileIds.delete(chatId);
}

// For tests.
export function _reset() { settings = null; access = null; pendingAuth.clear(); fileIds.clear(); }
