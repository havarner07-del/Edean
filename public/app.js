import {
  $, store, uid, escapeHtml, LANG_FROM_EXT, renderMarkdown, renderReply, streamWithAdvisors, advisorInstructions, askAdvisor,
  downloadText, copyText, handleCodeAction,
} from '/lib.js';
import { BASE_SYSTEM_PROMPT, MODES, STARTERS } from '/prompts.js';
import { initCompiler } from '/compiler.js';
import { initSystems } from '/systems.js';
import { initDrive, driveApi } from '/drive.js';
import { initWorkspace } from '/workspace.js';
import { initAgent } from '/agent-ui.js';

// If the session expires, go back to the login screen.
{
  const realFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const res = await realFetch(...args);
    const url = String(args[0]?.url || args[0]);
    if (res.status === 401 && res.headers.get('X-Edean-Auth') === 'required' && url.startsWith('/api/')) location.href = '/login';
    return res;
  };
}

const els = {
  sidebar: $('sidebar'), scrim: $('scrim'), menuBtn: $('menu-btn'),
  newChat: $('new-chat'), search: $('search'), chatList: $('chat-list'),
  modelSelect: $('model-select'), statusDot: $('status-dot'), modes: $('modes'),
  viewTabs: document.querySelectorAll('.view-tab'), chatView: $('chat-view'), compilerView: $('compiler'), workspaceView: $('workspace'), agentView: $('agent-view'),
  messages: $('messages'), composer: $('composer'), input: $('input'), sendBtn: $('send-btn'),
  attachBtn: $('attach-btn'), fileInput: $('file-input'), attachments: $('attachments'),
  settings: $('settings'), openSettings: $('open-settings'), setSystem: $('set-system'),
  resetSystem: $('reset-system'), setTemp: $('set-temp'), tempOut: $('temp-out'), setMax: $('set-max'),
  setTheme: $('set-theme'), exportChats: $('export-chats'), deleteAll: $('delete-all'),
  storageBtn: $('storage-btn'), storageLabel: $('storage-label'), storageSub: $('storage-sub'), storageDrive: $('open-drive'),
};

const DEFAULT_SETTINGS = { systemPrompt: BASE_SYSTEM_PROMPT, temperature: 0.2, maxTokens: 8192, theme: 'dark', model: '', mode: 'build', view: 'chat' };
const settings = { ...DEFAULT_SETTINGS, ...store.get('edean.settings', {}) };
// The HUD redesign made dark the default; move older installs over once.
if (!settings.hudTheme) { settings.theme = 'dark'; settings.hudTheme = true; }
// Chats live either in this browser ("local") or in a Google Drive folder ("drive").
let storage = { mode: 'local', loading: false, error: '', folder: null, email: '' };
let chats = store.get('edean.chats', []);
let currentId = store.get('edean.current', null);
let pendingFiles = [];
let streaming = null; // { controller, chatId }

const saveSettings = () => store.set('edean.settings', settings);

// ---------- chat storage ----------
const synced = new Map(); // chat id -> JSON last saved to Drive
let syncTimer = 0;
let syncing = null;
let syncState = 'idle'; // idle | saving | error
let clearLocalAfterSync = false;

function saveChats() {
  store.set('edean.current', currentId);
  if (storage.mode === 'local') { store.set('edean.chats', chats); return; }
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncToDrive, 1200);
}

const unsyncedChats = () => chats.filter((c) => !c.messages.some((m) => m.pending) && synced.get(c.id) !== JSON.stringify(c));

async function syncToDrive() {
  if (storage.mode !== 'drive' || storage.loading) return;
  if (syncing) { await syncing; return syncToDrive(); }
  clearTimeout(syncTimer);
  const dirty = unsyncedChats();
  if (!dirty.length) return;
  syncing = (async () => {
    syncState = 'saving';
    renderStorage();
    let failed = 0;
    for (const chat of dirty) {
      const snapshot = JSON.stringify(chat);
      try {
        await driveApi.saveChat(JSON.parse(snapshot));
        synced.set(chat.id, snapshot);
      } catch (e) {
        failed++;
        storage.error = e.message;
      }
    }
    syncState = failed ? 'error' : 'idle';
    if (!failed) {
      storage.error = '';
      if (clearLocalAfterSync) { store.set('edean.chats', []); clearLocalAfterSync = false; }
    } else {
      clearTimeout(syncTimer);
      syncTimer = setTimeout(syncToDrive, 15000); // keep retrying in the background
    }
    renderStorage();
  })();
  try { await syncing; } finally { syncing = null; }
}

async function removeChatFromStorage(id) {
  synced.delete(id);
  if (storage.mode === 'drive') {
    try { await driveApi.deleteChat(id); } catch (e) { alert(`Could not delete the chat from Google Drive: ${e.message}`); }
  }
}

function renderStorage() {
  const drive = storage.mode === 'drive';
  els.storageBtn.classList.toggle('drive', drive);
  els.storageLabel.textContent = drive ? `Google Drive · ${storage.folder?.name || ''}` : 'Saved in this browser';
  els.storageSub.textContent = !drive ? 'Connect Google Drive'
    : storage.loading ? 'Loading chats…'
      : syncState === 'saving' ? 'Saving…'
        : syncState === 'error' || storage.error ? 'Not saved — retrying' : 'All chats saved';
  els.storageBtn.classList.toggle('error', drive && (syncState === 'error' || !!storage.error));
  els.storageBtn.title = storage.error || (drive ? `Chats are saved in Google Drive (${storage.email})` : 'Chats are stored only in this browser');
}

async function initStorage() {
  let status;
  try { status = await driveApi.status(); } catch { return; }
  if (!status.connected || !status.folder) { renderStorage(); return; }
  storage = { mode: 'drive', loading: true, error: '', folder: status.folder, email: status.email };
  const localChats = chats;
  chats = [];
  renderStorage();
  renderAll();
  try {
    chats = await driveApi.listChats();
    for (const c of chats) {
      for (const m of c.messages) if (m.pending) { delete m.pending; m.error = m.error || 'Interrupted.'; }
      synced.set(c.id, JSON.stringify(c));
    }
  } catch (e) {
    storage.error = `Couldn't load chats from Google Drive: ${e.message}`;
  }
  storage.loading = false;
  if (!chats.some((c) => c.id === currentId)) currentId = null;
  renderAll();
  renderStorage();
  // Offer to move chats that were saved in this browser before Drive was connected.
  const toMove = localChats.filter((c) => !chats.some((d) => d.id === c.id));
  if (!storage.error && toMove.length && confirm(`Move ${toMove.length} chat${toMove.length === 1 ? '' : 's'} saved in this browser to your Google Drive folder "${status.folder.name}"? They'll be removed from this computer once they're uploaded.`)) {
    chats.push(...toMove);
    clearLocalAfterSync = true;
    renderAll();
    await syncToDrive();
  } else if (!toMove.length && localChats.length) {
    store.set('edean.chats', []); // already in Drive
  }
}

window.addEventListener('beforeunload', (e) => {
  if (storage.mode === 'drive' && unsyncedChats().length) {
    syncToDrive();
    e.preventDefault();
  }
});
const currentChat = () => chats.find((c) => c.id === currentId) || null;

const compiler = initCompiler({ settings, onOpen: () => setView('compiler') });
const workspace = initWorkspace({
  settings,
  getAdvisorStatus: () => advisorStatus,
  onOpenInCompiler: (code, lang) => compiler.open(code, lang),
});
const agentPanel = initAgent({
  settings,
  onOpenInWorkspace: (fullName, branch) => { workspace.openRepo(fullName, branch); setView('workspace'); },
});
// After installing things, refresh the model list and the compiler's languages.
initSystems({ onChange: () => { loadModels(); compiler.refreshLanguages(); } });

// ---------- views ----------
function setView(view) {
  settings.view = ['compiler', 'workspace', 'agent'].includes(view) ? view : 'chat';
  saveSettings();
  const isChat = settings.view === 'chat';
  els.chatView.hidden = !isChat;
  els.compilerView.hidden = settings.view !== 'compiler';
  els.workspaceView.hidden = settings.view !== 'workspace';
  els.agentView.hidden = settings.view !== 'agent';
  if (settings.view === 'agent') agentPanel.show();
  document.body.classList.toggle('ws-mode', settings.view === 'workspace');
  els.modes.hidden = !isChat;
  if (settings.view === 'workspace') workspace.show();
  for (const tab of els.viewTabs) {
    const active = tab.dataset.view === settings.view;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
  }
  if (isChat) els.input.focus(); else if (settings.view === 'compiler') compiler.focus();
}

// ---------- UI rendering ----------
function applyTheme() {
  const dark = settings.theme === 'dark' || (settings.theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  $('hl-dark').disabled = !dark;
  $('hl-light').disabled = dark;
}

function renderModes() {
  els.modes.innerHTML = '';
  for (const mode of MODES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'mode' + (settings.mode === mode.id ? ' active' : '');
    b.textContent = mode.label;
    b.title = mode.hint;
    b.setAttribute('role', 'radio');
    b.setAttribute('aria-checked', String(settings.mode === mode.id));
    b.onclick = () => { settings.mode = mode.id; saveSettings(); renderModes(); };
    els.modes.appendChild(b);
  }
}

function renderChatList() {
  const q = els.search.value.trim().toLowerCase();
  els.chatList.innerHTML = '';
  const list = [...chats].sort((a, b) => b.updatedAt - a.updatedAt)
    .filter((c) => !q || c.title.toLowerCase().includes(q) || c.messages.some((m) => m.content.toLowerCase().includes(q)));
  if (!list.length) {
    const p = document.createElement('p');
    p.className = 'empty-list';
    p.textContent = storage.loading ? 'Loading chats from Google Drive…' : storage.error && storage.mode === 'drive' && !chats.length ? storage.error : q ? 'No matching chats' : 'No chats yet';
    els.chatList.appendChild(p);
  }
  for (const chat of list) {
    const row = document.createElement('div');
    row.className = 'chat-item' + (chat.id === currentId && settings.view === 'chat' ? ' active' : '');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'chat-title';
    open.textContent = chat.title;
    open.onclick = () => { currentId = chat.id; saveChats(); setView('chat'); renderAll(); closeSidebar(); };
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'chat-del';
    del.setAttribute('aria-label', 'Delete chat');
    del.textContent = '×';
    del.onclick = () => {
      if (!confirm(`Delete "${chat.title}"?`)) return;
      if (streaming?.chatId === chat.id) stopStreaming();
      chats = chats.filter((c) => c.id !== chat.id);
      if (currentId === chat.id) currentId = null;
      removeChatFromStorage(chat.id);
      saveChats(); renderAll();
    };
    row.append(open, del);
    els.chatList.appendChild(row);
  }
}

function renderWelcome() {
  const wrap = document.createElement('div');
  wrap.className = 'welcome';
  wrap.innerHTML = `
    <svg class="reactor hero" viewBox="0 0 100 100" aria-hidden="true">
      <circle class="ring r1" cx="50" cy="50" r="46"/><circle class="ring r2" cx="50" cy="50" r="38"/>
      <circle class="ring r3" cx="50" cy="50" r="30"/><circle class="core" cx="50" cy="50" r="22"/>
      <path class="glyph" transform="translate(34 34)" d="M11 9 4 16l7 7M21 9l7 7-7 7M18 6l-4 20"/>
    </svg>
    <p class="welcome-kicker">Edean online</p>
    <h1>What are we building?</h1>
    <p>Your private coding assistant. Chats never leave this device and your model.</p>`;
  const grid = document.createElement('div');
  grid.className = 'starters';
  for (const s of STARTERS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'starter';
    const mode = MODES.find((m) => m.id === s.mode);
    b.innerHTML = `<span class="starter-mode">${escapeHtml(mode?.label || '')}</span><span></span>`;
    b.lastChild.textContent = s.text;
    b.onclick = () => { settings.mode = s.mode; saveSettings(); renderModes(); els.input.value = s.text; autosize(); els.input.focus(); };
    grid.appendChild(b);
  }
  wrap.appendChild(grid);
  return wrap;
}

function messageEl(msg, index, chat) {
  const el = document.createElement('article');
  el.className = `msg ${msg.role}`;
  el.dataset.index = index;
  const body = document.createElement('div');
  body.className = 'msg-body';
  fillMessageBody(body, msg);
  el.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'msg-actions';
  const add = (label, action) => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = label; b.dataset.action = action; b.dataset.index = index;
    actions.appendChild(b);
  };
  add('Copy', 'copy-msg');
  if (msg.role === 'user') add('Edit', 'edit-msg');
  if (msg.role === 'assistant' && index === chat.messages.length - 1) add('Regenerate', 'regen');
  if (msg.role === 'assistant' && msg.content && !msg.pending) {
    if (advisorStatus?.claude?.configured) add('Ask Claude', 'review-claude');
    if (advisorStatus?.copilot?.configured) add('Ask Copilot', 'review-copilot');
  }
  if (msg.model) {
    const tag = document.createElement('span');
    tag.className = 'model-tag';
    tag.textContent = msg.model;
    actions.appendChild(tag);
  }
  el.appendChild(actions);
  return el;
}

function fillMessageBody(body, msg) {
  if (msg.role !== 'user') { body.innerHTML = renderReply(msg); return; }
  body.innerHTML = renderMarkdown(msg.display ?? msg.content);
  if (msg.files?.length) {
    const f = document.createElement('div');
    f.className = 'file-chips';
    for (const file of msg.files) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = file;
      f.appendChild(chip);
    }
    body.appendChild(f);
  }
}

function renderMessages() {
  const chat = currentChat();
  els.messages.innerHTML = '';
  if (!chat || !chat.messages.length) { els.messages.appendChild(renderWelcome()); return; }
  const inner = document.createElement('div');
  inner.className = 'thread';
  chat.messages.forEach((m, i) => inner.appendChild(messageEl(m, i, chat)));
  els.messages.appendChild(inner);
  els.messages.scrollTop = els.messages.scrollHeight;
}

function renderAll() { renderChatList(); renderMessages(); updateSendButton(); }

function updateSendButton() {
  const busy = !!streaming && streaming.chatId === currentId;
  els.sendBtn.classList.toggle('stop', busy);
  els.sendBtn.setAttribute('aria-label', busy ? 'Stop generating' : 'Send');
}

function renderAttachments() {
  els.attachments.innerHTML = '';
  pendingFiles.forEach((f, i) => {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = `${f.name} `;
    const x = document.createElement('button');
    x.type = 'button'; x.textContent = '×'; x.setAttribute('aria-label', `Remove ${f.name}`);
    x.onclick = () => { pendingFiles.splice(i, 1); renderAttachments(); };
    chip.appendChild(x);
    els.attachments.appendChild(chip);
  });
}

// ---------- models ----------
async function loadModels() {
  try {
    const r = await fetch('/api/models');
    const data = await r.json();
    const models = data.models.length ? data.models : [data.defaultModel];
    if (settings.model && !models.includes(settings.model)) models.unshift(settings.model);
    els.modelSelect.innerHTML = '';
    for (const m of models) {
      const o = document.createElement('option');
      o.value = m; o.textContent = m;
      els.modelSelect.appendChild(o);
    }
    els.modelSelect.value = settings.model || (models.includes(data.defaultModel) ? data.defaultModel : models[0]);
    settings.model = els.modelSelect.value;
    els.statusDot.className = 'status-dot ' + (data.online ? 'online' : 'offline');
    els.statusDot.title = data.online ? 'Model backend connected' : `Model backend offline: ${data.error || 'unreachable'}`;
  } catch {
    els.statusDot.className = 'status-dot offline';
    els.statusDot.title = 'Cannot reach the Edean server';
  }
}

// ---------- chatting ----------
let advisorStatus = null;
async function loadAdvisors() {
  try { advisorStatus = await (await fetch('/api/advisors')).json(); } catch { advisorStatus = null; }
  return advisorStatus;
}

function buildSystemPrompt() {
  const mode = MODES.find((m) => m.id === settings.mode);
  return [settings.systemPrompt || BASE_SYSTEM_PROMPT, mode?.prompt, advisorInstructions(advisorStatus)].filter(Boolean).join('\n\n');
}

function composeUserMessage(text) {
  const files = pendingFiles;
  pendingFiles = [];
  renderAttachments();
  if (!files.length) return { role: 'user', content: text };
  const blocks = files.map((f) => {
    const ext = f.name.includes('.') ? f.name.split('.').pop().toLowerCase() : '';
    const lang = LANG_FROM_EXT[ext] || ext || '';
    const fence = f.text.includes('```') ? '~~~~' : '```';
    return `File: ${f.name}\n${fence}${lang}\n${f.text}\n${fence}`;
  });
  return { role: 'user', content: `${text}\n\n${blocks.join('\n\n')}`, display: text, files: files.map((f) => f.name) };
}

async function send(text) {
  if (streaming) return;
  text = text.trim();
  if (!text && !pendingFiles.length) return;
  let chat = currentChat();
  if (!chat) {
    chat = { id: uid(), title: 'New chat', messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    chats.push(chat);
    currentId = chat.id;
  }
  const userMsg = composeUserMessage(text);
  if (chat.messages.length === 0) chat.title = (text || userMsg.files?.join(', ') || 'New chat').replace(/\s+/g, ' ').slice(0, 60);
  chat.messages.push(userMsg);
  els.input.value = '';
  autosize();
  await generate(chat);
}

async function generate(chat) {
  const msg = { role: 'assistant', content: '', reasoning: '', model: settings.model, pending: true };
  chat.messages.push(msg);
  chat.updatedAt = Date.now();
  saveChats();
  const controller = new AbortController();
  streaming = { controller, chatId: chat.id };
  renderAll();

  const history = chat.messages.slice(0, -1).map((m) => ({ role: m.role, content: m.content }));
  let frame = 0;
  const repaint = () => {
    if (frame || currentId !== chat.id) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const node = els.messages.querySelector(`.msg[data-index="${chat.messages.length - 1}"] .msg-body`);
      if (!node) return;
      const nearBottom = els.messages.scrollHeight - els.messages.scrollTop - els.messages.clientHeight < 120;
      fillMessageBody(node, msg);
      if (nearBottom) els.messages.scrollTop = els.messages.scrollHeight;
    });
  };

  try {
    await streamWithAdvisors({
      model: settings.model,
      temperature: settings.temperature,
      maxTokens: settings.maxTokens,
      messages: [{ role: 'system', content: buildSystemPrompt() }, ...history],
      msg,
      advisorStatus,
      signal: controller.signal,
      onUpdate: repaint,
    });
  } catch (e) {
    if (e.name !== 'AbortError') msg.error = e.message || String(e);
  } finally {
    if (frame) cancelAnimationFrame(frame);
    delete msg.pending;
    if (!msg.reasoning) delete msg.reasoning;
    for (const c of msg.consults || []) if (c.pending) { delete c.pending; c.error = 'Stopped.'; }
    if (!msg.consults?.length) delete msg.consults;
    if (!msg.content && !msg.error && controller.signal.aborted) msg.content = '_Stopped._';
    streaming = null;
    chat.updatedAt = Date.now();
    saveChats();
    if (currentId === chat.id) renderMessages();
    renderChatList();
    updateSendButton();
  }
}

function stopStreaming() { streaming?.controller.abort(); }

// Ask Claude or Copilot to check a local answer. Only the question and the answer are sent.
async function secondOpinion(chat, index, advisor) {
  const msg = chat.messages[index];
  const question = chat.messages.slice(0, index).reverse().find((m) => m.role === 'user');
  const clip = (t, n) => (t.length > n ? `${t.slice(0, n)}\n[truncated]` : t);
  const consult = { advisor, review: true, question: 'Is this answer right?', pending: true };
  (msg.consults ||= []).push(consult);
  renderMessages();
  try {
    const res = await askAdvisor(advisor, [
      'A user asked a local coding model:', '---', clip(question?.display ?? question?.content ?? '', 4000), '---', '',
      'The local model answered:', '---', clip(msg.content, 8000), '---', '',
      'Is this answer correct and complete? If it is, say so in one line. Otherwise list the mistakes and give the corrected code or explanation, as briefly as possible.',
    ].join('\n'));
    Object.assign(consult, { answer: res.answer, usage: res.usage, model: res.model });
  } catch (e) {
    consult.error = e.message;
  }
  delete consult.pending;
  chat.updatedAt = Date.now();
  saveChats();
  if (currentId === chat.id) renderMessages();
}

// ---------- events ----------
function autosize() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 280) + 'px';
}

els.messages.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-action]');
  if (!b) return;
  if (handleCodeAction(b, { onUse: (code, lang) => compiler.open(code, lang) })) return;
  const chat = currentChat();
  if (!chat) return;
  const action = b.dataset.action;
  const index = Number(b.dataset.index);
  const msg = chat.messages[index];
  if (action === 'copy-msg') return copyText(msg.content, b);
  if (streaming) return;
  if (action === 'review-claude' || action === 'review-copilot') return secondOpinion(chat, index, action.slice(7));
  if (action === 'regen') {
    chat.messages.splice(index, 1);
    generate(chat);
  } else if (action === 'edit-msg') {
    els.input.value = msg.display ?? msg.content;
    chat.messages.splice(index);
    saveChats(); renderAll(); autosize(); els.input.focus();
  }
});

els.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  if (streaming) stopStreaming(); else send(els.input.value);
});
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); els.composer.requestSubmit(); }
});
els.input.addEventListener('input', autosize);

els.attachBtn.onclick = () => els.fileInput.click();
els.fileInput.onchange = async () => {
  for (const file of els.fileInput.files) {
    if (file.size > 512 * 1024) { alert(`${file.name} is larger than 512 KB — attach a smaller file or paste the relevant part.`); continue; }
    const text = await file.text();
    if (text.includes('\u0000')) { alert(`${file.name} looks like a binary file and was skipped.`); continue; }
    pendingFiles.push({ name: file.name, text });
  }
  els.fileInput.value = '';
  renderAttachments();
};
els.composer.addEventListener('dragover', (e) => { e.preventDefault(); els.composer.classList.add('drag'); });
els.composer.addEventListener('dragleave', () => els.composer.classList.remove('drag'));
els.composer.addEventListener('drop', (e) => {
  e.preventDefault();
  els.composer.classList.remove('drag');
  if (!e.dataTransfer.files.length) return;
  const dt = new DataTransfer();
  for (const f of e.dataTransfer.files) dt.items.add(f);
  els.fileInput.files = dt.files;
  els.fileInput.onchange();
});

for (const tab of els.viewTabs) tab.onclick = () => { setView(tab.dataset.view); renderChatList(); };
els.newChat.onclick = () => { currentId = null; saveChats(); setView('chat'); renderAll(); closeSidebar(); els.input.focus(); };
els.search.addEventListener('input', renderChatList);
els.modelSelect.onchange = () => { settings.model = els.modelSelect.value; saveSettings(); };

const closeSidebar = () => document.body.classList.remove('sidebar-open');
els.menuBtn.onclick = () => document.body.classList.toggle('sidebar-open');
els.scrim.onclick = closeSidebar;

els.openSettings.onclick = () => {
  refreshAccount();
  loadAdvisors().then(fillAdvisorSettings);
  els.setSystem.value = settings.systemPrompt;
  els.setTemp.value = settings.temperature;
  els.tempOut.textContent = settings.temperature;
  els.setMax.value = settings.maxTokens;
  els.setTheme.value = settings.theme;
  els.settings.showModal();
};
els.setTemp.oninput = () => { els.tempOut.textContent = els.setTemp.value; };
els.resetSystem.onclick = () => { els.setSystem.value = BASE_SYSTEM_PROMPT; };
els.settings.addEventListener('close', () => {
  settings.systemPrompt = els.setSystem.value.trim() || BASE_SYSTEM_PROMPT;
  settings.temperature = Number(els.setTemp.value);
  settings.maxTokens = Math.max(256, Number(els.setMax.value) || DEFAULT_SETTINGS.maxTokens);
  settings.theme = els.setTheme.value;
  saveSettings();
  applyTheme();
});
els.exportChats.onclick = () => downloadText(`edean-chats-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(chats, null, 2), 'application/json');
els.deleteAll.onclick = async () => {
  const where = storage.mode === 'drive' ? `in your Google Drive folder "${storage.folder?.name}" (they go to Drive's trash)` : 'in this browser';
  if (!confirm(`Delete every chat ${where}?`)) return;
  stopStreaming();
  const ids = chats.map((c) => c.id);
  chats = []; currentId = null; saveChats(); renderAll(); els.settings.close();
  for (const id of ids) await removeChatFromStorage(id);
};

// ---------- account ----------
async function refreshAccount() {
  try {
    const a = await (await fetch('/api/account')).json();
    $('password-note').textContent = a.passwordFromEnv ? 'The password is set with APP_PASSWORD in your settings file.'
      : a.customPassword ? '' : 'You are still using the default password 0000. Choose your own below.';
    $('change-password').disabled = a.passwordFromEnv;
  } catch { /* offline */ }
}
$('change-password').onclick = async () => {
  const status = $('pw-status');
  const r = await fetch('/api/password', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current: $('pw-current').value, next: $('pw-next').value }),
  });
  const data = await r.json().catch(() => ({}));
  status.textContent = r.ok ? 'Password changed.' : data.error || 'Could not change the password.';
  status.className = `pw-status ${r.ok ? 'ok' : 'err'}`;
  if (r.ok) { $('pw-current').value = ''; $('pw-next').value = ''; refreshAccount(); }
};
function fillAdvisorSettings() {
  const a = advisorStatus;
  if (!a) return;
  $('adv-auto').checked = a.auto;
  $('adv-key').value = '';
  $('adv-key').placeholder = a.claude.configured ? (a.claude.keyFromEnv ? 'Set by ANTHROPIC_API_KEY' : 'Saved — type a new key to replace it') : 'sk-ant-…';
  $('adv-claude-model').value = a.claude.model;
  $('adv-copilot-model').value = a.copilot.model;
  $('adv-status').textContent = `Claude: ${a.claude.configured ? 'ready' : 'needs an API key'} · Copilot: ${a.copilot.configured ? 'ready' : 'connect GitHub in the Workspace'}`;
  $('adv-status').className = 'pw-status';
}
$('adv-save').onclick = async () => {
  const body = { auto: $('adv-auto').checked, claudeModel: $('adv-claude-model').value, copilotModel: $('adv-copilot-model').value };
  if ($('adv-key').value.trim()) body.anthropicKey = $('adv-key').value.trim();
  const r = await fetch('/api/advisors/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { $('adv-status').textContent = data.error || 'Could not save.'; $('adv-status').className = 'pw-status err'; return; }
  advisorStatus = data;
  fillAdvisorSettings();
  $('adv-status').textContent = `Saved. ${$('adv-status').textContent}`;
  $('adv-status').className = 'pw-status ok';
  renderMessages();
};
// Desktop app: tell Edean.exe this window is still open, and offer "Quit Edean".
async function ping() {
  try {
    const r = await fetch('/api/ping');
    if (r.ok) $('quit-app').hidden = !(await r.json()).desktop;
  } catch { /* server stopped */ }
}
ping();
setInterval(ping, 30000);
$('quit-app').onclick = async () => {
  if (!confirm('Quit Edean? This closes the app and stops its server.')) return;
  await syncToDrive();
  await fetch('/api/quit', { method: 'POST' });
  document.body.innerHTML = '<p style="margin:40vh auto;text-align:center;color:#858891;font:15px system-ui">Edean has quit. You can close this window.</p>';
  setTimeout(() => window.close(), 400);
};
$('sign-out').onclick = async () => {
  await syncToDrive();
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login';
};

const drivePanel = initDrive({ beforeChange: syncToDrive });
els.storageBtn.onclick = () => drivePanel.open();
els.storageDrive.onclick = () => { els.settings.close(); drivePanel.open(); };
// Coming back from Google sign-in.
{
  const params = new URLSearchParams(location.search);
  if (params.has('drive')) {
    history.replaceState(null, '', '/');
    drivePanel.open(params.get('drive') === 'error' ? { text: params.get('message') || 'Google sign-in failed.', kind: 'err' } : null);
  }
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

// ---------- boot ----------
// A reload mid-stream leaves a pending message behind; mark it as interrupted.
for (const c of chats) for (const m of c.messages) if (m.pending) { delete m.pending; m.error = m.error || 'Interrupted.'; }
applyTheme();
renderModes();
renderAll();
setView(settings.view);
loadModels();
initStorage();
loadAdvisors().then(() => renderMessages());
