// Shared helpers used by the chat view and the compiler view.
import { Marked } from '/vendor/marked.esm.js';
import DOMPurify from '/vendor/purify.es.mjs';

export const $ = (id) => document.getElementById(id);

// Browser-only storage, wrapped because storage can be unavailable.
export const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { console.warn('Could not save', key, e); }
  },
};

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
export const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const EXT = {
  javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', tsx: 'tsx', jsx: 'jsx', python: 'py', py: 'py', rust: 'rs', go: 'go',
  java: 'java', kotlin: 'kt', swift: 'swift', c: 'c', cpp: 'cpp', 'c++': 'cpp', csharp: 'cs', cs: 'cs', ruby: 'rb', php: 'php',
  html: 'html', css: 'css', scss: 'scss', json: 'json', yaml: 'yml', yml: 'yml', toml: 'toml', sql: 'sql', bash: 'sh', sh: 'sh',
  shell: 'sh', zsh: 'sh', powershell: 'ps1', dockerfile: 'Dockerfile', markdown: 'md', md: 'md', lua: 'lua', dart: 'dart',
  scala: 'scala', r: 'r', xml: 'xml', vue: 'vue', svelte: 'svelte', zig: 'zig', elixir: 'ex', haskell: 'hs',
};
export const LANG_FROM_EXT = Object.fromEntries(Object.entries(EXT).map(([lang, ext]) => [ext.toLowerCase(), lang]));

// Code-fence language → compiler language id.
export const RUNNER_LANG = {
  python: 'python', py: 'python', python3: 'python', javascript: 'javascript', js: 'javascript', node: 'javascript', mjs: 'javascript',
  typescript: 'typescript', ts: 'typescript', java: 'java', c: 'c', cpp: 'cpp', 'c++': 'cpp', cc: 'cpp', go: 'go', golang: 'go',
  rust: 'rust', rs: 'rust', ruby: 'ruby', rb: 'ruby', php: 'php', bash: 'bash', sh: 'bash', shell: 'bash',
};

let useLabel = 'Open in compiler';

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
      const use = RUNNER_LANG[language]
        ? `<button type="button" data-action="use-code" data-lang="${escapeHtml(language)}">${escapeHtml(useLabel)}</button>` : '';
      return `<div class="code-block"><div class="code-head"><span class="code-lang">${escapeHtml(language || 'code')}</span>` +
        `<span class="code-actions">${use}<button type="button" data-action="download-code" data-lang="${escapeHtml(language)}">Download</button>` +
        `<button type="button" data-action="copy-code">Copy</button></span></div>` +
        `<pre><code class="hljs">${html}</code></pre></div>`;
    },
  },
});

export function renderMarkdown(text, { codeUseLabel = 'Open in compiler' } = {}) {
  useLabel = codeUseLabel;
  return DOMPurify.sanitize(marked.parse(text || ''), { ADD_ATTR: ['data-action', 'data-lang'] });
}

// Split out <think>…</think> reasoning that some models (Qwen3, DeepSeek-R1) emit.
export function splitThinking(content) {
  const m = content.match(/^\s*<think>([\s\S]*?)(<\/think>|$)/);
  if (!m) return { thinking: '', answer: content, thinkingDone: true };
  return { thinking: m[1].trim(), answer: content.slice(m[0].length), thinkingDone: m[2] === '</think>' };
}

// Render an assistant reply (reasoning + answer) into HTML.
export function renderReply({ content = '', reasoning = '', pending = false, error = '' }, opts) {
  const { thinking, answer, thinkingDone } = splitThinking(content);
  const allReasoning = [reasoning, thinking].filter(Boolean).join('\n\n');
  let html = '';
  if (allReasoning) {
    const open = pending && !answer.trim() ? ' open' : '';
    html += `<details class="thinking"${open}><summary>${pending && !thinkingDone ? 'Thinking…' : 'Reasoning'}</summary>${renderMarkdown(allReasoning, opts)}</details>`;
  }
  html += renderMarkdown(answer, opts);
  if (pending && !answer.trim() && !allReasoning) html += '<div class="typing"><span></span><span></span><span></span></div>';
  if (error) html += `<div class="error">${escapeHtml(error)}</div>`;
  return html;
}

// Stream a chat completion from the Edean server. Calls onDelta({ content, reasoning }) per chunk.
export async function streamChat({ messages, model, temperature, maxTokens, signal, onDelta }) {
  const res = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, temperature, max_tokens: maxTokens, messages }),
    signal,
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
      const reasoning = delta.reasoning_content || delta.reasoning || '';
      if (reasoning || delta.content) onDelta({ content: delta.content || '', reasoning });
    }
  }
}

export function downloadText(filename, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function copyText(text, button) {
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

// Handles Copy / Download / Use buttons on rendered code blocks. Returns true if it handled the click.
export function handleCodeAction(button, { onUse } = {}) {
  const action = button.dataset.action;
  if (!['copy-code', 'download-code', 'use-code'].includes(action)) return false;
  const code = button.closest('.code-block')?.querySelector('code')?.textContent;
  if (code == null) return true;
  const lang = button.dataset.lang;
  if (action === 'copy-code') copyText(code, button);
  else if (action === 'use-code') onUse?.(code, RUNNER_LANG[lang]);
  else {
    const pathMatch = code.split('\n')[0].match(/([\w./-]+\.[A-Za-z0-9]+)\s*(?:\*\/|-->)?\s*$/);
    downloadText(pathMatch ? pathMatch[1].split('/').pop() : `snippet.${EXT[lang] || 'txt'}`, code);
  }
  return true;
}
