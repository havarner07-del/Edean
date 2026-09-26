import { Marked } from '/vendor/marked.esm.js';
import DOMPurify from '/vendor/purify.es.mjs';
import { BASE_SYSTEM_PROMPT, MODES, STARTERS } from '/prompts.js';

const $ = (id) => document.getElementById(id);
const els = {
  sidebar: $('sidebar'), scrim: $('scrim'), menuBtn: $('menu-btn'),
  newChat: $('new-chat'), search: $('search'), chatList: $('chat-list'),
  modelSelect: $('model-select'), statusDot: $('status-dot'), modes: $('modes'),
  messages: $('messages'), composer: $('composer'), input: $('input'), sendBtn: $('send-btn'),
  attachBtn: $('attach-btn'), fileInput: $('file-input'), attachments: $('attachments'),
  settings: $('settings'), openSettings: $('open-settings'), setSystem: $('set-system'),
  resetSystem: $('reset-system'), setTemp: $('set-temp'), tempOut: $('temp-out'), setMax: $('set-max'),
  setTheme: $('set-theme'), exportChats: $('export-chats'), deleteAll: $('delete-all'),
};

// ---------- storage (browser only; wrapped because storage can be unavailable) ----------
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { console.warn('Could not save', key, e); }
  },
};

const DEFAULT_SETTINGS = { systemPrompt: BASE_SYSTEM_PROMPT, temperature: 0.2, maxTokens: 8192, theme: 'system', model: '', mode: 'build' };
const settings = { ...DEFAULT_SETTINGS, ...store.get('edean.settings', {}) };
let chats = store.get('edean.chats', []);
let currentId = store.get('edean.current', null);
let pendingFiles = [];
let streaming = null; // { controller, chatId }

const saveSettings = () => store.set('edean.settings', settings);
const saveChats = () => { store.set('edean.chats', chats); store.set('edean.current', currentId); };
const currentChat = () => chats.find((c) => c.id === currentId) || null;
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

// ---------- markdown + code rendering ----------
const EXT = {
  javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', tsx: 'tsx', jsx: 'jsx', python: 'py', py: 'py', rust: 'rs', go: 'go',
  java: 'java', kotlin: 'kt', swift: 'swift', c: 'c', cpp: 'cpp', 'c++': 'cpp', csharp: 'cs', cs: 'cs', ruby: 'rb', php: 'php',
  html: 'html', css: 'css', scss: 'scss', json: 'json', yaml: 'yml', yml: 'yml', toml: 'toml', sql: 'sql', bash: 'sh', sh: 'sh',
  shell: 'sh', zsh: 'sh', powershell: 'ps1', dockerfile: 'Dockerfile', markdown: 'md', md: 'md', lua: 'lua', dart: 'dart',
  scala: 'scala', r: 'r', xml: 'xml', vue: 'vue', svelte: 'svelte', zig: 'zig', elixir: 'ex', haskell: 'hs',
};
const LANG_FROM_EXT = Object.fromEntries(Object.entries(EXT).map(([lang, ext]) => [ext.toLowerCase(), lang]));

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const marked = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    code({ text, lang }) {
      const language = (lang || '').trim().split(/\s+/)[0].toLowerCase();
      let html;
      try {
        html = language && window.hljs?.getLanguage(language)
          ? window.hljs.highlight(text, { language, ignoreIllegals: true }).value
          : window.hljs ? window.hljs.highlightAuto(text).value : escapeHtml(text);
      } catch { html = escapeHtml(text); }
      return `<div class="code-block"><div class="code-head"><span class="code-lang">${escapeHtml(language || 'code')}</span>` +
        `<span class="code-actions"><button type="button" data-action="download-code" data-lang="${escapeHtml(language)}">Download</button>` +
        `<button type="button" data-action="copy-code">Copy</button></span></div>` +
        `<pre><code class="hljs">${html}</code></pre></div>`;
    },
  },
});

// Split out <think>…</think> reasoning that some models (Qwen3, DeepSeek-R1) emit.
function splitThinking(content) {
  const m = content.match(/^\s*<think>([\s\S]*?)(<\/think>|$)/);
  if (!m) return { thinking: '', answer: content, thinkingDone: true };
  return { thinking: m[1].trim(), answer: content.slice(m[0].length), thinkingDone: m[2] === '</think>' };
}

function renderMarkdown(text) {
  return DOMPurify.sanitize(marked.parse(text || ''), { ADD_ATTR: ['data-action', 'data-lang'] });
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
    p.textContent = q ? 'No matching chats' : 'No chats yet';
    els.chatList.appendChild(p);
  }
  for (const chat of list) {
    const row = document.createElement('div');
    row.className = 'chat-item' + (chat.id === currentId ? ' active' : '');
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'chat-title';
    open.textContent = chat.title;
    open.onclick = () => { currentId = chat.id; saveChats(); renderAll(); closeSidebar(); };
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
    <svg class="welcome-logo" viewBox="0 0 32 32" aria-hidden="true"><path d="M11 9 4 16l7 7M21 9l7 7-7 7M18 6l-4 20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
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
  if (msg.role === 'user') {
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
    return;
  }
  const { thinking, answer, thinkingDone } = splitThinking(msg.content);
  const reasoning = [msg.reasoning, thinking].filter(Boolean).join('\n\n');
  let html = '';
  if (reasoning) {
    const open = msg.pending && !answer.trim() ? ' open' : '';
    html += `<details class="thinking"${open}><summary>${msg.pending && !thinkingDone ? 'Thinking…' : 'Reasoning'}</summary>${renderMarkdown(reasoning)}</details>`;
  }
  html += renderMarkdown(answer);
  if (msg.pending && !answer.trim() && !reasoning) html += '<div class="typing"><span></span><span></span><span></span></div>';
  if (msg.error) html += `<div class="error">${escapeHtml(msg.error)}</div>`;
  body.innerHTML = html;
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
  } catch (e) {
    els.statusDot.className = 'status-dot offline';
    els.statusDot.title = 'Cannot reach the Edean server';
  }
}

// ---------- chatting ----------
function buildSystemPrompt() {
  const mode = MODES.find((m) => m.id === settings.mode);
  return [settings.systemPrompt || BASE_SYSTEM_PROMPT, mode?.prompt].filter(Boolean).join('\n\n');
}

async function composeUserMessage(text) {
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
  const userMsg = await composeUserMessage(text);
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
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: settings.model,
        temperature: settings.temperature,
        max_tokens: settings.maxTokens,
        messages: [{ role: 'system', content: buildSystemPrompt() }, ...history],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Request failed (${res.status})`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;
        let json;
        try { json = JSON.parse(data); } catch { continue; }
        if (json.error) throw new Error(json.error.message || String(json.error));
        const delta = json.choices?.[0]?.delta || {};
        if (delta.reasoning_content || delta.reasoning) msg.reasoning += delta.reasoning_content || delta.reasoning;
        if (delta.content) msg.content += delta.content;
        repaint();
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') msg.error = e.message || String(e);
  } finally {
    if (frame) cancelAnimationFrame(frame);
    delete msg.pending;
    if (!msg.reasoning) delete msg.reasoning;
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

// ---------- events ----------
function autosize() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 280) + 'px';
}

function downloadText(filename, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
  }
  if (button) {
    const old = button.textContent;
    button.textContent = 'Copied';
    setTimeout(() => { button.textContent = old; }, 1200);
  }
}

els.messages.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-action]');
  if (!b) return;
  const chat = currentChat();
  const action = b.dataset.action;
  if (action === 'copy-code' || action === 'download-code') {
    const code = b.closest('.code-block').querySelector('code').textContent;
    if (action === 'copy-code') return copyText(code, b);
    const lang = b.dataset.lang;
    const firstLine = code.split('\n')[0];
    const pathMatch = firstLine.match(/([\w./-]+\.[A-Za-z0-9]+)\s*(?:\*\/|-->)?\s*$/);
    const name = pathMatch ? pathMatch[1].split('/').pop() : `snippet.${EXT[lang] || 'txt'}`;
    return downloadText(name, code);
  }
  if (!chat) return;
  const index = Number(b.dataset.index);
  const msg = chat.messages[index];
  if (action === 'copy-msg') return copyText(msg.content, b);
  if (streaming) return;
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

els.newChat.onclick = () => { currentId = null; saveChats(); renderAll(); closeSidebar(); els.input.focus(); };
els.search.addEventListener('input', renderChatList);
els.modelSelect.onchange = () => { settings.model = els.modelSelect.value; saveSettings(); };

const closeSidebar = () => document.body.classList.remove('sidebar-open');
els.menuBtn.onclick = () => document.body.classList.toggle('sidebar-open');
els.scrim.onclick = closeSidebar;

els.openSettings.onclick = () => {
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
els.deleteAll.onclick = () => {
  if (!confirm('Permanently delete every chat stored in this browser?')) return;
  stopStreaming();
  chats = []; currentId = null; saveChats(); renderAll(); els.settings.close();
};
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

// ---------- boot ----------
// A reload mid-stream leaves a pending message behind; mark it as interrupted.
for (const c of chats) for (const m of c.messages) if (m.pending) { delete m.pending; m.error = m.error || 'Interrupted.'; }
applyTheme();
renderModes();
renderAll();
loadModels();
els.input.focus();
