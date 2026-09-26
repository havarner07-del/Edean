// Workspace: a VS Code-style editor for your GitHub repositories.
// Explorer, tabs (Monaco — the editor inside VS Code), Save / Save All, Source Control
// (commit & push, discard, diff), branches, pull requests, dependencies, a Run/Output
// panel, a command palette, and an AI panel that proposes changes you can apply.
//
// Saving works like VS Code: Ctrl+S saves the file into your working changes (kept in
// this browser, per repository and branch); Source Control commits them to GitHub.
import { $, store, escapeHtml, renderReply, streamWithAdvisors, advisorInstructions, downloadText } from '/lib.js';
import { BASE_SYSTEM_PROMPT } from '/prompts.js';
import { describeResult } from '/compiler.js';

const RUN_LANG = {
  py: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', java: 'java', c: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', go: 'go', rs: 'rust', rb: 'ruby', php: 'php', sh: 'bash', bash: 'bash',
};
const ext = (p) => (p.includes('.') ? p.split('.').pop().toLowerCase() : '');
const baseName = (p) => p.split('/').pop();
const dirName = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

const ICONS = {
  explorer: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z M14 3v5h5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
  scm: '<circle cx="6" cy="6" r="2.2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="6" cy="18" r="2.2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="18" cy="8" r="2.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M6 8.2v7.6M18 10.2c0 4-6 3-10.4 6.4" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  branches: '<circle cx="7" cy="5.5" r="2.2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="7" cy="18.5" r="2.2" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="17" cy="12" r="2.2" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M7 7.7v8.6M7 12h7.8" fill="none" stroke="currentColor" stroke-width="1.6"/>',
  deps: '<path d="M12 3 4 7.5v9L12 21l8-4.5v-9z M4 7.5 12 12l8-4.5 M12 12v9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
  github: '<path d="M12 2.5a9.5 9.5 0 0 0-3 18.5c.5.1.7-.2.7-.5v-1.7c-2.7.6-3.3-1.2-3.3-1.2-.4-1.1-1.1-1.4-1.1-1.4-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.3 1.1 2.9.8.1-.6.3-1.1.6-1.3-2.1-.2-4.4-1.1-4.4-4.7 0-1 .4-1.9 1-2.6-.1-.2-.4-1.2.1-2.6 0 0 .8-.3 2.6 1a9 9 0 0 1 4.8 0c1.8-1.3 2.6-1 2.6-1 .5 1.4.2 2.4.1 2.6.6.7 1 1.6 1 2.6 0 3.7-2.3 4.5-4.4 4.7.3.3.7.9.7 1.8v2.7c0 .3.2.6.7.5A9.5 9.5 0 0 0 12 2.5Z" fill="currentColor"/>',
  ai: '<path d="M12 3v3M12 18v3M4.2 7.5l2.6 1.5M17.2 15l2.6 1.5M4.2 16.5 6.8 15M17.2 9l2.6-1.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="12" cy="12" r="3.2" fill="currentColor"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z M14 3v5h5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>',
  folder: '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5h4l2 2h9A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z" fill="none" stroke="currentColor" stroke-width="1.5"/>',
};
const icon = (name, cls = '') => `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch(path, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
}
const q = (o) => new URLSearchParams(o).toString();

// Monaco is large, so it's only loaded the first time the Workspace opens.
let monacoPromise = null;
function loadMonaco() {
  if (monacoPromise) return monacoPromise;
  const css = document.createElement('link');
  css.rel = 'stylesheet';
  css.href = '/vendor/monaco/vs/editor/editor.main.css';
  document.head.appendChild(css);
  monacoPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/monaco/vs/loader.js';
    s.onload = () => {
      window.require.config({ paths: { vs: '/vendor/monaco/vs' } });
      window.require(['vs/editor/editor.main'], () => resolve(window.monaco), reject);
    };
    s.onerror = () => reject(new Error('Could not load the editor.'));
    document.head.appendChild(s);
  });
  return monacoPromise;
}

export function initWorkspace({ settings, getAdvisorStatus, onOpenInCompiler }) {
  const root = $('workspace');
  const els = {
    activity: $('ws-activity'), sideTitle: $('ws-side-title'), sideActions: $('ws-side-actions'), side: $('ws-side-body'),
    tabs: $('ws-tabs'), crumbs: $('ws-crumbs'), editorHost: $('ws-editor'), diffHost: $('ws-diff'), welcome: $('ws-welcome'),
    panel: $('ws-panel'), output: $('ws-output'), stdin: $('ws-stdin'), status: $('ws-status'),
    ai: $('ws-ai'), aiLog: $('ws-ai-log'), aiInput: $('ws-ai-input'), aiForm: $('ws-ai-form'), aiSend: $('ws-ai-send'),
    palette: $('ws-palette'), paletteInput: $('ws-palette-input'), paletteList: $('ws-palette-list'), paletteTitle: $('ws-palette-title'),
  };

  const S = {
    gh: null,
    repos: null,
    repo: null,          // { owner, name, fullName, defaultBranch, canPush, htmlUrl }
    branch: '',
    branches: [],
    tree: [],            // [{ path, type: 'file' | 'dir', size }]
    truncated: false,
    expanded: new Set(),
    files: new Map(),    // path -> { original: string|null, model, binary }
    changes: {},         // path -> { content: string|null, isNew }  (saved, not committed)
    tabs: [],            // 'path' or 'diff:path'
    active: null,
    view: store.get('edean.ws.view', 'explorer'),
    aiOpen: store.get('edean.ws.ai', true),
    panelOpen: store.get('edean.ws.panel', true),
    ai: [],              // AI panel messages
    aiBusy: null,
    running: null,
    notice: '',
  };
  let monaco = null;
  let editor = null;
  let diffEditor = null;
  let cursor = { line: 1, col: 1 };

  // ---------- persistence of working changes ----------
  const changesKey = () => `edean.ws.changes.${S.repo.fullName}@${S.branch}`;
  const saveChanges = () => store.set(changesKey(), S.changes);
  const changedPaths = () => Object.keys(S.changes).sort();
  const isDeleted = (p) => S.changes[p]?.content === null;

  function visiblePaths() {
    const files = new Set(S.tree.filter((e) => e.type === 'file').map((e) => e.path));
    for (const [p, c] of Object.entries(S.changes)) {
      if (c.content === null) files.delete(p); else files.add(p);
    }
    return [...files].sort();
  }

  function savedContent(p) {
    if (p in S.changes) return S.changes[p].content;
    return S.files.get(p)?.original ?? null;
  }
  const isDirty = (p) => {
    const f = S.files.get(p);
    return !!(f?.model && !f.binary && f.model.getValue() !== (savedContent(p) ?? ''));
  };

  // ---------- rendering: activity bar & side views ----------
  const VIEWS = [
    ['explorer', 'Explorer (Ctrl+Shift+E)'], ['scm', 'Source Control'], ['branches', 'Branches & Pull Requests'],
    ['deps', 'Dependencies'], ['github', 'GitHub account'],
  ];
  function renderActivity() {
    const count = S.repo ? changedPaths().length : 0;
    els.activity.innerHTML = VIEWS.map(([id, title]) =>
      `<button type="button" class="ws-act${S.view === id ? ' active' : ''}" data-view="${id}" title="${title}" aria-label="${title}">${icon(id === 'github' ? 'github' : id)}${id === 'scm' && count ? `<span class="ws-badge">${count}</span>` : ''}</button>`).join('') +
      `<span class="ws-act-spacer"></span><button type="button" class="ws-act${S.aiOpen ? ' active' : ''}" data-toggle="ai" title="Edean AI panel" aria-label="Edean AI panel">${icon('ai')}</button>`;
  }

  function sideHeader(title, actions = '') {
    els.sideTitle.textContent = title;
    els.sideActions.innerHTML = actions;
  }

  function renderSide() {
    renderActivity();
    if (!S.gh?.connected && S.view !== 'github') return renderConnect();
    if (S.view === 'github') return renderGithubView();
    if (!S.repo) return renderRepoPicker();
    if (S.view === 'explorer') return renderExplorer();
    if (S.view === 'scm') return renderScm();
    if (S.view === 'branches') return renderBranches();
    if (S.view === 'deps') return renderDeps();
  }

  function renderConnect(message = '') {
    sideHeader('GitHub');
    els.side.innerHTML = `
      <div class="ws-pad">
        <p>Connect GitHub to open your repositories here, edit them like in VS Code, commit, create branches and open pull requests.</p>
        <ol class="ws-steps">
          <li>Create a <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">fine-grained personal access token</a>.</li>
          <li>Choose the repositories Edean may use (for example your Edean repo, so it can improve itself).</li>
          <li>Permissions: <strong>Contents</strong> read &amp; write, <strong>Pull requests</strong> read &amp; write, and (for the Copilot advisor) account permission <strong>Models</strong> read.</li>
          <li>Paste the token below.</li>
        </ol>
        ${message ? `<p class="ws-error">${escapeHtml(message)}</p>` : ''}
        <form id="ws-connect" class="ws-form">
          <input name="token" type="password" placeholder="github_pat_…" autocomplete="off" spellcheck="false" required>
          <button class="btn small" type="submit">Connect GitHub</button>
        </form>
        <p class="ws-muted">The token is stored only on this computer, in your Edean settings folder.</p>
      </div>`;
    $('ws-connect').onsubmit = async (e) => {
      e.preventDefault();
      try {
        S.gh = await api('/api/github/connect', { method: 'POST', body: { token: new FormData(e.target).get('token') } });
        S.view = 'explorer';
        renderAll();
      } catch (err) { renderConnect(err.message); }
    };
  }

  function renderGithubView() {
    sideHeader('GitHub');
    if (!S.gh?.connected) return renderConnect();
    els.side.innerHTML = `
      <div class="ws-pad">
        <div class="ws-account">${S.gh.avatar ? `<img src="${escapeHtml(S.gh.avatar)}" alt="">` : ''}<div><strong>${escapeHtml(S.gh.login)}</strong><div class="ws-muted">${escapeHtml(S.gh.name || '')}</div></div></div>
        ${S.repo ? `<p>Open repository: <a href="${escapeHtml(S.repo.htmlUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(S.repo.fullName)}</a></p>` : ''}
        <div class="ws-row">
          <button class="btn ghost small" type="button" id="ws-switch-repo">Open another repository</button>
          ${S.gh.fromEnv ? '' : '<button class="btn ghost small danger-text" type="button" id="ws-disconnect">Disconnect</button>'}
        </div>
      </div>`;
    $('ws-switch-repo').onclick = () => { S.repo = null; S.view = 'explorer'; renderAll(); };
    $('ws-disconnect')?.addEventListener('click', async () => {
      if (!confirm('Disconnect GitHub? Saved-but-uncommitted changes stay in this browser.')) return;
      await api('/api/github/disconnect', { method: 'POST', body: {} });
      S.gh = { connected: false };
      closeRepo();
      renderAll();
    });
  }

  async function renderRepoPicker() {
    sideHeader('Open a repository', `<button class="ws-icon" type="button" data-cmd="refresh-repos" title="Refresh">⟳</button>`);
    els.side.innerHTML = '<div class="ws-pad"><input class="ws-filter" id="ws-repo-filter" placeholder="Filter repositories"></div><div class="ws-list" id="ws-repo-list"><p class="ws-muted ws-pad">Loading…</p></div>';
    try {
      S.repos ||= (await api('/api/github/repos')).repos;
    } catch (err) { $('ws-repo-list').innerHTML = `<p class="ws-error ws-pad">${escapeHtml(err.message)}</p>`; return; }
    const draw = () => {
      const f = $('ws-repo-filter').value.toLowerCase();
      const list = S.repos.filter((r) => r.fullName.toLowerCase().includes(f));
      $('ws-repo-list').innerHTML = list.map((r) => `
        <button type="button" class="ws-item ws-repo" data-repo="${escapeHtml(r.fullName)}">
          ${icon('github')}<span><strong>${escapeHtml(r.fullName)}</strong>${r.private ? ' <em>private</em>' : ''}
          <small>${escapeHtml(r.description || r.language || '')}</small></span></button>`).join('') || '<p class="ws-muted ws-pad">No repositories match.</p>';
    };
    $('ws-repo-filter').oninput = draw;
    draw();
  }

  function treeModel() {
    const dirs = new Set(S.tree.filter((e) => e.type === 'dir').map((e) => e.path));
    const files = visiblePaths();
    for (const f of files) { let d = dirName(f); while (d) { dirs.add(d); d = dirName(d); } }
    const children = new Map([['', []]]);
    for (const d of [...dirs].sort()) { children.set(d, []); }
    for (const d of [...dirs].sort()) children.get(dirName(d))?.push({ path: d, dir: true });
    for (const f of files) children.get(dirName(f))?.push({ path: f, dir: false });
    for (const list of children.values()) list.sort((a, b) => (a.dir === b.dir ? baseName(a.path).localeCompare(baseName(b.path)) : a.dir ? -1 : 1));
    return children;
  }

  function renderExplorer() {
    sideHeader(`${S.repo.name}`, `
      <button class="ws-icon" type="button" data-cmd="new-file" title="New File…">＋</button>
      <button class="ws-icon" type="button" data-cmd="refresh" title="Refresh">⟳</button>
      <button class="ws-icon" type="button" data-cmd="collapse" title="Collapse folders">⊟</button>`);
    const children = treeModel();
    const status = (p) => (S.changes[p] ? (S.changes[p].isNew ? 'U' : 'M') : '');
    const lines = [];
    const walk = (dir, depth) => {
      for (const node of children.get(dir) || []) {
        const pad = `style="padding-left:${8 + depth * 12}px"`;
        if (node.dir) {
          const open = S.expanded.has(node.path);
          const changed = changedPaths().some((p) => p.startsWith(`${node.path}/`));
          lines.push(`<button type="button" class="ws-item ws-dir${changed ? ' changed' : ''}" data-dir="${escapeHtml(node.path)}" ${pad}><span class="ws-caret">${open ? '▾' : '▸'}</span>${icon('folder', 'ws-ficon')}<span class="ws-name">${escapeHtml(baseName(node.path))}</span></button>`);
          if (open) walk(node.path, depth + 1);
        } else {
          const st = status(node.path);
          lines.push(`<div class="ws-item ws-file${S.active === node.path ? ' active' : ''}${st ? ` st-${st}` : ''}" data-file="${escapeHtml(node.path)}" ${pad} role="button" tabindex="0">` +
            `<span class="ws-caret"></span>${icon('file', 'ws-ficon')}<span class="ws-name">${escapeHtml(baseName(node.path))}</span>` +
            `<span class="ws-file-actions"><button type="button" data-rename="${escapeHtml(node.path)}" title="Rename">✎</button><button type="button" data-delete="${escapeHtml(node.path)}" title="Delete">🗑</button></span>` +
            `${st ? `<span class="ws-st">${st}</span>` : ''}</div>`);
        }
      }
    };
    walk('', 0);
    els.side.innerHTML = `
      <div class="ws-branch-line"><button type="button" class="ws-link" data-view-go="branches">${icon('branches')} ${escapeHtml(S.branch)}</button>${S.repo.canPush ? '' : '<span class="ws-muted"> · read-only</span>'}</div>
      ${S.truncated ? '<p class="ws-muted ws-pad">This repository is very large; only part of the file list is shown.</p>' : ''}
      <div class="ws-tree">${lines.join('') || '<p class="ws-muted ws-pad">This branch has no files yet. Create one with ＋.</p>'}</div>`;
  }

  function renderScm(message = '') {
    const paths = changedPaths();
    sideHeader('Source Control', `<button class="ws-icon" type="button" data-cmd="refresh" title="Refresh">⟳</button>`);
    const dirty = S.tabs.filter((t) => !t.startsWith('diff:') && isDirty(t));
    els.side.innerHTML = `
      <div class="ws-pad">
        <textarea id="ws-commit-msg" class="ws-commit-msg" rows="3" placeholder="Message (Ctrl+Enter to commit on '${escapeHtml(S.branch)}')"></textarea>
        <button class="btn small ws-wide" type="button" id="ws-commit" ${paths.length && S.repo.canPush ? '' : 'disabled'}>✓ Commit &amp; Push${paths.length ? ` (${paths.length})` : ''}</button>
        ${!S.repo.canPush ? '<p class="ws-muted">Your token can\'t push to this repository.</p>' : ''}
        ${dirty.length ? `<p class="ws-warn">${dirty.length} open file${dirty.length > 1 ? 's have' : ' has'} unsaved edits. <button class="ws-link" type="button" data-cmd="save-all">Save all</button></p>` : ''}
        ${message ? `<p class="${message.startsWith('✓') ? 'ws-ok' : 'ws-error'}">${message}</p>` : ''}
      </div>
      <div class="ws-section-title">Changes <span class="ws-muted">${paths.length}</span></div>
      <div class="ws-list">${paths.map((p) => {
        const c = S.changes[p];
        const st = c.content === null ? 'D' : c.isNew ? 'U' : 'M';
        return `<div class="ws-item ws-change st-${st}" data-diff="${escapeHtml(p)}" role="button" tabindex="0" title="${escapeHtml(p)}">
          ${icon('file', 'ws-ficon')}<span class="ws-name">${escapeHtml(baseName(p))}</span><span class="ws-dim">${escapeHtml(dirName(p))}</span>
          <span class="ws-file-actions"><button type="button" data-discard="${escapeHtml(p)}" title="Discard changes">↺</button></span><span class="ws-st">${st}</span></div>`;
      }).join('') || '<p class="ws-muted ws-pad">No changes. Edit files and press Ctrl+S to save them here.</p>'}</div>
      <div class="ws-section-title">Recent commits on ${escapeHtml(S.branch)}</div>
      <div class="ws-list" id="ws-commits"><p class="ws-muted ws-pad">Loading…</p></div>`;
    const msg = $('ws-commit-msg');
    msg.onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commitChanges(); } };
    $('ws-commit').onclick = commitChanges;
    api(`/api/github/commits?${q({ owner: S.repo.owner, repo: S.repo.name, branch: S.branch })}`).then(({ commits }) => {
      const box = $('ws-commits');
      if (box) box.innerHTML = commits.map((c) => `<a class="ws-item ws-commit" href="${escapeHtml(c.url)}" target="_blank" rel="noopener noreferrer"><span class="ws-name">${escapeHtml(c.message)}</span><span class="ws-dim">${escapeHtml(c.author)} · ${new Date(c.date).toLocaleDateString()}</span></a>`).join('');
    }).catch((err) => { const box = $('ws-commits'); if (box) box.innerHTML = `<p class="ws-error ws-pad">${escapeHtml(err.message)}</p>`; });
  }

  async function renderBranches(message = '') {
    sideHeader('Branches', `<button class="ws-icon" type="button" data-cmd="new-branch" title="New branch…">＋</button><button class="ws-icon" type="button" data-cmd="refresh-branches" title="Refresh">⟳</button>`);
    const isDefault = S.branch === S.repo.defaultBranch;
    els.side.innerHTML = `
      ${message ? `<p class="ws-pad ${message.startsWith('✓') ? 'ws-ok' : 'ws-error'}">${message}</p>` : ''}
      <div class="ws-list" id="ws-branch-list"><p class="ws-muted ws-pad">Loading…</p></div>
      <div class="ws-section-title">Pull request</div>
      <div class="ws-pad">
        ${isDefault ? `<p class="ws-muted">You're on <strong>${escapeHtml(S.branch)}</strong>. Create a branch (＋) to propose changes through a pull request, e.g. for Edean to improve itself.</p>`
          : `<form id="ws-pr" class="ws-form ws-col">
              <input name="title" placeholder="Pull request title" required>
              <textarea name="body" rows="3" placeholder="Description (optional)"></textarea>
              <button class="btn small" type="submit">Open pull request: ${escapeHtml(S.branch)} → ${escapeHtml(S.repo.defaultBranch)}</button>
            </form>`}
      </div>
      <div class="ws-section-title">Open pull requests</div>
      <div class="ws-list" id="ws-pulls"><p class="ws-muted ws-pad">Loading…</p></div>`;
    $('ws-pr')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (changedPaths().length && !confirm('You have uncommitted changes. Open the pull request without them?')) return;
      const f = new FormData(e.target);
      try {
        const pr = await api('/api/github/pulls', { method: 'POST', body: { owner: S.repo.owner, repo: S.repo.name, title: f.get('title'), body: f.get('body'), head: S.branch, base: S.repo.defaultBranch } });
        renderBranches(`✓ Opened <a href="${escapeHtml(pr.url)}" target="_blank" rel="noopener noreferrer">pull request #${pr.number}</a>.`);
      } catch (err) { renderBranches(escapeHtml(err.message)); }
    });
    try {
      S.branches = (await api(`/api/github/branches?${q({ owner: S.repo.owner, repo: S.repo.name })}`)).branches;
      const list = $('ws-branch-list');
      if (list) {
        list.innerHTML = S.branches.map((b) => `<button type="button" class="ws-item${b.name === S.branch ? ' active' : ''}" data-branch="${escapeHtml(b.name)}">${icon('branches', 'ws-ficon')}<span class="ws-name">${escapeHtml(b.name)}</span>${b.name === S.repo.defaultBranch ? '<span class="ws-dim">default</span>' : ''}${b.protected ? '<span class="ws-dim">protected</span>' : ''}${b.name === S.branch ? '<span class="ws-st">✓</span>' : ''}</button>`).join('');
      }
    } catch (err) { const l = $('ws-branch-list'); if (l) l.innerHTML = `<p class="ws-error ws-pad">${escapeHtml(err.message)}</p>`; }
    api(`/api/github/pulls?${q({ owner: S.repo.owner, repo: S.repo.name })}`).then(({ pulls }) => {
      const box = $('ws-pulls');
      if (box) box.innerHTML = pulls.map((p) => `<a class="ws-item" href="${escapeHtml(p.url)}" target="_blank" rel="noopener noreferrer"><span class="ws-name">#${p.number} ${escapeHtml(p.title)}</span><span class="ws-dim">${escapeHtml(p.head)} → ${escapeHtml(p.base)}</span></a>`).join('') || '<p class="ws-muted ws-pad">None.</p>';
    }).catch(() => {});
  }

  async function renderDeps() {
    sideHeader('Dependencies', `<button class="ws-icon" type="button" data-cmd="refresh-deps" title="Refresh">⟳</button>`);
    els.side.innerHTML = '<p class="ws-muted ws-pad">Loading…</p>';
    try {
      S.deps ||= await api(`/api/github/dependencies?${q({ owner: S.repo.owner, repo: S.repo.name, branch: S.branch })}`);
      const groups = {};
      for (const p of S.deps.packages) (groups[p.ecosystem || 'other'] ||= []).push(p);
      els.side.innerHTML = `<p class="ws-muted ws-pad">${S.deps.packages.length} package${S.deps.packages.length === 1 ? '' : 's'} · from ${escapeHtml(S.deps.source)}</p>` +
        Object.entries(groups).map(([eco, list]) => `
          <div class="ws-section-title">${escapeHtml(eco)} <span class="ws-muted">${list.length}</span></div>
          <div class="ws-list">${list.map((p) => `<div class="ws-item ws-dep"><span class="ws-name">${escapeHtml(p.name)}</span><span class="ws-dim">${escapeHtml(p.version)}${p.dev ? ' · dev' : ''}</span></div>`).join('')}</div>`).join('');
    } catch (err) { els.side.innerHTML = `<p class="ws-error ws-pad">${escapeHtml(err.message)}</p>`; }
  }

  // ---------- tabs & editor ----------
  function renderTabs() {
    els.tabs.innerHTML = S.tabs.map((t) => {
      const diff = t.startsWith('diff:');
      const p = diff ? t.slice(5) : t;
      const dirty = !diff && isDirty(p);
      const st = S.changes[p] ? (S.changes[p].content === null ? 'D' : S.changes[p].isNew ? 'U' : 'M') : '';
      return `<div class="ws-tab${t === S.active ? ' active' : ''}${st ? ` st-${st}` : ''}" data-tab="${escapeHtml(t)}" title="${escapeHtml(p)}" role="tab" tabindex="0">
        ${icon('file', 'ws-ficon')}<span>${escapeHtml(baseName(p))}${diff ? ' <em>(changes)</em>' : ''}</span>
        <button type="button" class="ws-tab-close${dirty ? ' dirty' : ''}" data-close="${escapeHtml(t)}" aria-label="Close">${dirty ? '●' : '×'}</button></div>`;
    }).join('');
    const p = S.active?.replace(/^diff:/, '') || '';
    els.crumbs.innerHTML = p ? p.split('/').map((s) => `<span>${escapeHtml(s)}</span>`).join('<span class="ws-sep">›</span>') : '';
    const runnable = !!RUN_LANG[ext(p)] && !S.active?.startsWith('diff:');
    $('ws-run').disabled = !runnable;
    $('ws-run').title = runnable ? 'Run this file (F5)' : 'This file type can\'t be run';
    $('ws-save').disabled = !S.active || S.active.startsWith('diff:');
  }

  function renderStatus() {
    const n = S.repo ? changedPaths().length : 0;
    const p = S.active?.replace(/^diff:/, '');
    const lang = p && S.files.get(p)?.model ? S.files.get(p).model.getLanguageId() : '';
    els.status.innerHTML = S.repo
      ? `<button type="button" data-view-go="branches" title="Switch branch">${icon('branches')} ${escapeHtml(S.branch)}</button>
         <button type="button" data-view-go="scm" title="Source Control">${n} change${n === 1 ? '' : 's'}</button>
         <span class="ws-status-spacer"></span>
         ${p && !S.active.startsWith('diff:') ? `<span>Ln ${cursor.line}, Col ${cursor.col}</span>` : ''}
         ${lang ? `<span>${escapeHtml(lang)}</span>` : ''}
         <span>${icon('github')} ${escapeHtml(S.repo.fullName)}</span>`
      : `<span>${S.gh?.connected ? `${icon('github')} ${escapeHtml(S.gh.login)}` : 'GitHub not connected'}</span>`;
  }

  function showSurface() {
    const hasTab = !!S.active;
    const diff = S.active?.startsWith('diff:');
    els.welcome.hidden = hasTab;
    els.editorHost.hidden = !hasTab || diff;
    els.diffHost.hidden = !diff;
    if (!hasTab) renderWelcome();
  }

  function renderWelcome() {
    els.welcome.innerHTML = S.repo ? `
      <h2>${escapeHtml(S.repo.fullName)}</h2>
      <p class="ws-muted">Branch <strong>${escapeHtml(S.branch)}</strong>. Open a file from the Explorer, or:</p>
      <ul class="ws-shortcuts">
        <li><kbd>Ctrl</kbd>+<kbd>P</kbd> Go to file</li>
        <li><kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> Command palette</li>
        <li><kbd>Ctrl</kbd>+<kbd>S</kbd> Save · <kbd>F5</kbd> Run file</li>
        <li>Edean AI (right panel) can propose changes, even to Edean itself</li>
      </ul>` : `
      <h2>Workspace</h2>
      <p class="ws-muted">${S.gh?.connected ? 'Pick a repository on the left to open it.' : 'Connect GitHub on the left to open your repositories.'}</p>`;
  }

  function monacoTheme() {
    return document.documentElement.dataset.theme === 'dark' ? 'edean-dark' : 'vs';
  }

  async function ensureEditor() {
    if (editor) return;
    monaco = await loadMonaco();
    monaco.editor.defineTheme('edean-dark', {
      base: 'vs-dark', inherit: true, rules: [],
      colors: { 'editor.background': '#0d0e11', 'editorGutter.background': '#0d0e11', 'minimap.background': '#0d0e11', 'editor.lineHighlightBackground': '#15171b', 'editorWidget.background': '#15161a' },
    });
    const common = { theme: monacoTheme(), automaticLayout: true, fontSize: 13, fontFamily: getComputedStyle(document.documentElement).getPropertyValue('--mono'), minimap: { enabled: true }, scrollBeyondLastLine: false, tabSize: 2 };
    editor = monaco.editor.create(els.editorHost, { ...common, model: null });
    diffEditor = monaco.editor.createDiffEditor(els.diffHost, { ...common, readOnly: true, originalEditable: false, renderSideBySide: true });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => saveFile(S.active));
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyP, () => openPalette('commands'));
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, () => openPalette('files'));
    editor.addCommand(monaco.KeyCode.F5, () => runActive());
    editor.onDidChangeCursorPosition((e) => { cursor = { line: e.position.lineNumber, col: e.position.column }; renderStatus(); });
    new MutationObserver(() => monaco.editor.setTheme(monacoTheme())).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  async function loadFile(p) {
    if (S.files.get(p)?.model || S.files.get(p)?.binary) return S.files.get(p);
    let original = null;
    let binary = false;
    const inTree = S.tree.some((e) => e.path === p && e.type === 'file');
    if (inTree) {
      const f = await api(`/api/github/file?${q({ owner: S.repo.owner, repo: S.repo.name, branch: S.branch, path: p })}`);
      original = f.content;
      binary = f.binary;
    }
    const entry = { original, binary, model: null };
    if (!binary) {
      await ensureEditor();
      const value = p in S.changes ? (S.changes[p].content ?? '') : (original ?? '');
      entry.model = monaco.editor.createModel(value, undefined, monaco.Uri.file(`/${p}`));
      entry.model.onDidChangeContent(() => { renderTabs(); });
    }
    S.files.set(p, entry);
    // Now that the original is known, drop "changes" that match it.
    if (S.changes[p] && S.changes[p].content === original && original !== null) { delete S.changes[p]; saveChanges(); }
    return entry;
  }

  async function openTab(t) {
    const p = t.replace(/^diff:/, '');
    try {
      await ensureEditor();
      const f = await loadFile(p);
      if (f.binary) { output(`${p} is a binary file and can't be edited here.`, 'warn'); return; }
    } catch (err) { output(err.message, 'err'); return; }
    if (!S.tabs.includes(t)) S.tabs.push(t);
    S.active = t;
    const f = S.files.get(p);
    if (t.startsWith('diff:')) {
      const lang = f.model.getLanguageId();
      const oldModels = diffEditor.getModel();
      diffEditor.setModel({
        original: monaco.editor.createModel(f.original ?? '', lang),
        modified: monaco.editor.createModel(savedContent(p) ?? '', lang),
      });
      if (oldModels) { oldModels.original.dispose(); oldModels.modified.dispose(); }
    } else {
      editor.setModel(f.model);
      editor.focus();
    }
    showSurface();
    renderTabs();
    renderStatus();
    if (S.view === 'explorer') renderExplorer();
  }

  function closeTab(t) {
    const p = t.replace(/^diff:/, '');
    if (!t.startsWith('diff:') && isDirty(p)) {
      const choice = confirm(`Save changes to ${baseName(p)} before closing?\n\nOK = Save, Cancel = Discard unsaved edits`);
      if (choice) saveFile(p);
      else S.files.get(p).model.setValue(savedContent(p) ?? '');
    }
    const i = S.tabs.indexOf(t);
    S.tabs = S.tabs.filter((x) => x !== t);
    if (S.active === t) {
      S.active = S.tabs[Math.min(i, S.tabs.length - 1)] || null;
      if (S.active) return openTab(S.active);
      editor?.setModel(null);
    }
    showSurface();
    renderTabs();
    renderStatus();
  }

  // ---------- file operations ----------
  function saveFile(p, { quiet = false } = {}) {
    if (!p || p.startsWith('diff:')) return;
    const f = S.files.get(p);
    if (!f?.model) return;
    const value = f.model.getValue();
    if (f.original !== null && value === f.original) delete S.changes[p];
    else S.changes[p] = { content: value, isNew: f.original === null };
    saveChanges();
    renderTabs();
    renderActivity();
    renderStatus();
    if (S.view === 'explorer') renderExplorer();
    if (S.view === 'scm') renderScm();
    if (!quiet) flash(`Saved ${baseName(p)}`);
  }

  function saveAll() {
    for (const t of S.tabs) if (!t.startsWith('diff:') && isDirty(t)) saveFile(t, { quiet: true });
    flash('Saved all files');
  }

  async function newFile(prefill) {
    const dir = prefill ?? (S.active ? dirName(S.active.replace(/^diff:/, '')) : '');
    const p = (await askInput({ title: 'New file — path in the repository', value: dir ? `${dir}/` : '', placeholder: 'src/new-file.js' }))?.trim().replace(/^\/+/, '');
    if (!p) return;
    if (p.split('/').some((s) => !s || s === '..' || s === '.')) return flash('Invalid path', 'err');
    if (!visiblePaths().includes(p)) {
      S.changes[p] = { content: '', isNew: !S.tree.some((e) => e.path === p) };
      saveChanges();
      S.files.delete(p);
    }
    let d = dirName(p);
    while (d) { S.expanded.add(d); d = dirName(d); }
    renderSide();
    openTab(p);
  }

  function deleteFile(p) {
    if (!confirm(`Delete ${p}? The deletion becomes part of your changes; commit to apply it on GitHub.`)) return;
    if (S.changes[p]?.isNew) delete S.changes[p];
    else S.changes[p] = { content: null, isNew: false };
    saveChanges();
    for (const t of [p, `diff:${p}`]) if (S.tabs.includes(t)) { S.tabs = S.tabs.filter((x) => x !== t); if (S.active === t) S.active = S.tabs.at(-1) || null; }
    S.files.get(p)?.model?.dispose();
    S.files.delete(p);
    if (S.active) openTab(S.active); else { editor?.setModel(null); showSurface(); }
    renderAll();
  }

  async function renameFile(p) {
    const next = (await askInput({ title: `Rename ${p}`, value: p }))?.trim();
    if (!next || next === p) return;
    const f = await loadFile(p);
    const content = f.model ? f.model.getValue() : savedContent(p) ?? '';
    if (S.changes[p]?.isNew) delete S.changes[p]; else S.changes[p] = { content: null, isNew: false };
    S.changes[next] = { content, isNew: !S.tree.some((e) => e.path === next) };
    saveChanges();
    f.model?.dispose();
    S.files.delete(p);
    S.tabs = S.tabs.map((t) => (t === p ? next : t)).filter((t) => t !== `diff:${p}`);
    if (S.active === p) S.active = next;
    renderAll();
    if (S.active) openTab(S.active);
  }

  function discard(p) {
    if (!confirm(`Discard your changes to ${p}?`)) return;
    const wasNew = S.changes[p]?.isNew;
    delete S.changes[p];
    saveChanges();
    const f = S.files.get(p);
    if (wasNew) {
      f?.model?.dispose();
      S.files.delete(p);
      S.tabs = S.tabs.filter((t) => t !== p && t !== `diff:${p}`);
      if (S.active === p || S.active === `diff:${p}`) S.active = S.tabs.at(-1) || null;
    } else if (f?.model) f.model.setValue(f.original ?? '');
    S.tabs = S.tabs.filter((t) => t !== `diff:${p}`);
    if (S.active === `diff:${p}`) S.active = S.tabs.at(-1) || null;
    if (S.active) openTab(S.active); else { editor?.setModel(null); showSurface(); }
    renderAll();
  }

  async function commitChanges() {
    saveAll();
    const paths = changedPaths();
    if (!paths.length) return;
    const message = $('ws-commit-msg')?.value.trim() || (await askInput({ title: `Commit message for ${paths.length} change${paths.length > 1 ? 's' : ''} on ${S.branch}` }));
    if (!message) return;
    const changes = paths.map((p) => (S.changes[p].content === null ? { path: p, delete: true } : { path: p, content: S.changes[p].content }));
    const btn = $('ws-commit');
    if (btn) { btn.disabled = true; btn.textContent = 'Committing…'; }
    try {
      const res = await api('/api/github/commit', { method: 'POST', body: { owner: S.repo.owner, repo: S.repo.name, branch: S.branch, message, changes } });
      // The committed contents are the new originals.
      for (const c of changes) {
        const f = S.files.get(c.path);
        if (f) f.original = c.delete ? null : c.content;
      }
      S.changes = {};
      saveChanges();
      await loadTree();
      S.tabs = S.tabs.filter((t) => !t.startsWith('diff:'));
      if (S.active?.startsWith('diff:')) S.active = S.tabs.at(-1) || null;
      if (S.active) openTab(S.active); else showSurface();
      renderAll();
      renderScm(`✓ Committed <a href="${escapeHtml(res.url)}" target="_blank" rel="noopener noreferrer">${res.sha.slice(0, 7)}</a> to ${escapeHtml(S.branch)}.`);
    } catch (err) {
      renderScm(escapeHtml(err.message));
    }
  }

  // ---------- repository & branches ----------
  async function loadTree() {
    const t = await api(`/api/github/tree?${q({ owner: S.repo.owner, repo: S.repo.name, branch: S.branch })}`);
    S.tree = t.entries;
    S.truncated = t.truncated;
  }

  function closeRepo() {
    for (const f of S.files.values()) f.model?.dispose();
    S.files = new Map();
    S.tabs = [];
    S.active = null;
    S.deps = null;
    S.ai = [];
    editor?.setModel(null);
  }

  async function openRepo(fullName, branch) {
    const [owner, name] = fullName.split('/');
    els.side.innerHTML = '<p class="ws-muted ws-pad">Opening…</p>';
    try {
      const info = await api(`/api/github/repo?${q({ owner, repo: name })}`);
      closeRepo();
      S.repo = info;
      S.branch = branch || store.get(`edean.ws.branch.${info.fullName}`, info.defaultBranch);
      try { await loadTree(); } catch (err) {
        if (S.branch === info.defaultBranch) throw err;
        S.branch = info.defaultBranch;
        await loadTree();
      }
      S.changes = store.get(changesKey(), {});
      S.expanded = new Set();
      store.set('edean.ws.repo', info.fullName);
      store.set(`edean.ws.branch.${info.fullName}`, S.branch);
      S.view = 'explorer';
      renderAll();
      const readme = S.tree.find((e) => /^readme(\.md)?$/i.test(e.path));
      if (readme) openTab(readme.path);
    } catch (err) {
      S.repo = null;
      renderRepoPicker();
      output(err.message, 'err');
    }
  }

  async function switchBranch(name) {
    if (name === S.branch) return;
    saveAll();
    S.branch = name;
    store.set(`edean.ws.branch.${S.repo.fullName}`, name);
    closeRepo();
    try { await loadTree(); } catch (err) { output(err.message, 'err'); }
    S.changes = store.get(changesKey(), {});
    renderAll();
    flash(`Switched to ${name}`);
  }

  async function newBranch() {
    const name = (await askInput({ title: `New branch from '${S.branch}'`, placeholder: 'edean/my-improvement' }))?.trim();
    if (!name) return;
    saveAll();
    try {
      await api('/api/github/branches', { method: 'POST', body: { owner: S.repo.owner, repo: S.repo.name, name, from: S.branch } });
    } catch (err) { return renderBranches(escapeHtml(err.message)); }
    // Like git: uncommitted changes come along to the new branch.
    const carried = S.changes;
    store.set(changesKey(), {});
    S.branch = name;
    store.set(`edean.ws.branch.${S.repo.fullName}`, name);
    S.changes = carried;
    saveChanges();
    for (const f of S.files.values()) f.model?.dispose();
    S.files = new Map();
    const tabs = S.tabs.filter((t) => !t.startsWith('diff:'));
    S.tabs = [];
    S.active = null;
    await loadTree();
    renderAll();
    for (const t of tabs) await openTab(t);
    S.view = 'branches';
    renderBranches(`✓ Created and switched to ${escapeHtml(name)}${Object.keys(carried).length ? ' (your uncommitted changes came along)' : ''}.`);
  }

  // ---------- run & output ----------
  function output(text, kind = '') {
    els.output.innerHTML = '';
    const div = document.createElement('div');
    div.className = `console-note ${kind}`;
    div.textContent = text;
    els.output.appendChild(div);
    setPanel(true);
  }

  async function runActive() {
    const p = S.active;
    if (!p || p.startsWith('diff:')) return;
    const language = RUN_LANG[ext(p)];
    if (!language) return output(`Edean can't run .${ext(p)} files. Supported: Python, JavaScript, TypeScript, Java, C, C++, Go, Rust, Ruby, PHP, Bash.`, 'warn');
    if (S.running) { S.running.abort(); return; }
    S.running = new AbortController();
    $('ws-run').classList.add('stop');
    output(`Running ${p}…`, 'muted');
    try {
      const r = await fetch('/api/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: S.running.signal,
        body: JSON.stringify({ language, code: S.files.get(p).model.getValue(), stdin: els.stdin.value }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `Run failed (${r.status})`);
      const { kind, text } = describeResult(data);
      els.output.innerHTML = '';
      const head = document.createElement('div');
      head.className = `run-status ${kind}`;
      head.textContent = `${baseName(p)} — ${text}`;
      els.output.appendChild(head);
      for (const [s, cls] of [[data.compileOutput, 'out-compile'], [data.stdout, 'out-stdout'], [data.stderr, 'out-stderr']]) {
        if (!s) continue;
        const span = document.createElement('span');
        span.className = cls;
        span.textContent = s;
        els.output.appendChild(span);
      }
    } catch (e) {
      output(e.name === 'AbortError' ? 'Stopped.' : e.message, e.name === 'AbortError' ? 'muted' : 'err');
    } finally {
      S.running = null;
      $('ws-run').classList.remove('stop');
    }
  }

  function setPanel(open) {
    S.panelOpen = open;
    store.set('edean.ws.panel', open);
    root.classList.toggle('panel-closed', !open);
  }

  // ---------- AI panel ----------
  const PATH_LINE = /^\s*(?:\/\/|#|--|;|\/\*|<!--)\s*(?:path|file)?\s*:?\s*([\w@.\-/]+\.[\w]+)\s*(?:\*\/|-->)?\s*$/i;

  function workspacePrompt() {
    return `You are working inside the user's GitHub repository ${S.repo.fullName} (branch "${S.branch}") in Edean's Workspace, a VS Code-style editor.
When you change or create files, output EACH file in FULL in its own fenced code block whose first line is a comment with its path, for example "// path: src/app.js" or "# path: scripts/build.py". Never output partial files or diffs for files you change.
The user applies your changes, reviews them in Source Control, commits them to a branch and opens a pull request. If they ask you to improve Edean itself, treat this repository as Edean's source code.
Keep explanations short and put them before the code.`;
  }

  function aiContext() {
    const paths = visiblePaths();
    const active = S.active?.replace(/^diff:/, '');
    const parts = [`Repository files (${paths.length}${paths.length > 400 ? ', first 400 shown' : ''}):\n${paths.slice(0, 400).join('\n')}`];
    const changed = changedPaths();
    if (changed.length) parts.push(`Files with uncommitted changes: ${changed.join(', ')}`);
    if (active && S.files.get(active)?.model) {
      const content = S.files.get(active).model.getValue();
      const clipped = content.length > 40000 ? `${content.slice(0, 40000)}\n… [file truncated]` : content;
      const fence = clipped.includes('```') ? '~~~~' : '```';
      parts.push(`Currently open file: ${active}\n${fence}${ext(active)}\n${clipped}\n${fence}`);
    }
    const others = S.tabs.filter((t) => !t.startsWith('diff:') && t !== active);
    if (others.length) parts.push(`Other open tabs: ${others.join(', ')}`);
    return parts.join('\n\n');
  }

  function renderAi() {
    root.classList.toggle('ai-closed', !S.aiOpen);
    els.aiSend.textContent = S.aiBusy ? 'Stop' : 'Send';
    if (!S.ai.length) {
      els.aiLog.innerHTML = `<div class="ws-ai-empty">
        <strong>Edean AI</strong>
        <p>Ask about this repository or ask for changes. For example:</p>
        <ul><li>"Explain how this project is structured"</li><li>"Add input validation to the open file"</li><li>"Improve Edean: add a dark/light toggle to the toolbar"</li></ul>
        <p class="ws-muted">Proposed files get an <em>Apply</em> button. Review them in Source Control, then commit to a branch and open a pull request.</p></div>`;
      return;
    }
    els.aiLog.innerHTML = S.ai.map((m, i) => `<div class="ws-ai-msg ${m.role}" data-i="${i}"><div class="msg-body">${
      m.role === 'user' ? escapeHtml(m.display) : renderReply(m, { codeUseLabel: 'Open in compiler' })}</div></div>`).join('');
    addApplyButtons();
    els.aiLog.scrollTop = els.aiLog.scrollHeight;
  }

  function addApplyButtons() {
    for (const block of els.aiLog.querySelectorAll('.ws-ai-msg.assistant .code-block')) {
      if (block.querySelector('[data-action="apply-code"]')) continue;
      const code = block.querySelector('code').textContent;
      const m = code.split('\n')[0].match(PATH_LINE);
      const target = m ? m[1].replace(/^\.?\//, '') : S.active?.replace(/^diff:/, '');
      if (!target) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.action = 'apply-code';
      b.dataset.path = target;
      b.dataset.strip = m ? '1' : '';
      b.textContent = `Apply to ${baseName(target)}`;
      b.title = target;
      block.querySelector('.code-actions').prepend(b);
    }
  }

  async function applyCode(button) {
    const p = button.dataset.path;
    let code = button.closest('.code-block').querySelector('code').textContent;
    if (button.dataset.strip) code = code.split('\n').slice(1).join('\n');
    if (!code.endsWith('\n')) code += '\n';
    if (p.split('/').some((s) => !s || s === '..')) return flash('Invalid path', 'err');
    const exists = S.tree.some((e) => e.path === p && e.type === 'file');
    try {
      if (exists || S.files.has(p)) {
        const f = await loadFile(p);
        f.model?.setValue(code);
        S.changes[p] = { content: code, isNew: f.original === null };
        if (f.original !== null && code === f.original) delete S.changes[p];
      } else {
        S.changes[p] = { content: code, isNew: true };
      }
      saveChanges();
      let d = dirName(p);
      while (d) { S.expanded.add(d); d = dirName(d); }
      button.textContent = `Applied ✓`;
      renderAll();
      await openTab(p in S.changes && !S.changes[p].isNew ? `diff:${p}` : p);
      flash(`Applied to ${p} — review it in Source Control`);
    } catch (err) { flash(err.message, 'err'); }
  }

  async function sendAi(text) {
    if (S.aiBusy) { S.aiBusy.abort(); return; }
    text = text.trim();
    if (!text || !S.repo) return;
    const advisorStatus = getAdvisorStatus?.();
    const history = S.ai.filter((m) => !m.pending).slice(-8).map((m) => ({ role: m.role, content: m.content }));
    const user = { role: 'user', display: text, content: `${text}\n\n---\nWorkspace context:\n${aiContext()}` };
    const msg = { role: 'assistant', content: '', reasoning: '', pending: true };
    S.ai.push(user, msg);
    els.aiInput.value = '';
    S.aiBusy = new AbortController();
    renderAi();
    let frame = 0;
    const repaint = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const node = els.aiLog.querySelector(`.ws-ai-msg[data-i="${S.ai.length - 1}"] .msg-body`);
        if (node) { node.innerHTML = renderReply(msg, { codeUseLabel: 'Open in compiler' }); els.aiLog.scrollTop = els.aiLog.scrollHeight; }
      });
    };
    try {
      await streamWithAdvisors({
        model: settings.model, temperature: settings.temperature, maxTokens: settings.maxTokens,
        messages: [
          { role: 'system', content: [settings.systemPrompt || BASE_SYSTEM_PROMPT, workspacePrompt(), advisorInstructions(advisorStatus)].filter(Boolean).join('\n\n') },
          // Only the newest question carries the (large) workspace context, to keep tokens down.
          ...history.map((m) => (m.role === 'user' ? { role: 'user', content: m.content.split('\n\n---\nWorkspace context:')[0] } : m)),
          { role: 'user', content: user.content },
        ],
        msg, advisorStatus, signal: S.aiBusy.signal, onUpdate: repaint,
      });
    } catch (e) {
      if (e.name !== 'AbortError') msg.error = e.message;
    } finally {
      if (frame) cancelAnimationFrame(frame);
      delete msg.pending;
      for (const c of msg.consults || []) if (c.pending) { delete c.pending; c.error = 'Stopped.'; }
      if (!msg.content && !msg.error) msg.content = '_Stopped._';
      S.aiBusy = null;
      renderAi();
    }
  }

  // ---------- command palette & input box ----------
  let paletteMode = null;
  let paletteResolve = null;
  let paletteItems = [];
  let paletteIndex = 0;

  const COMMANDS = () => [
    ['Go to File…', 'Ctrl+P', () => openPalette('files')],
    ['File: Save', 'Ctrl+S', () => saveFile(S.active)],
    ['File: Save All', '', saveAll],
    ['File: New File…', '', () => newFile()],
    ['File: Download Current File', '', exportFile],
    ['File: Open Current File in Compiler Tab', '', () => { const p = S.active?.replace(/^diff:/, ''); if (p) onOpenInCompiler?.(S.files.get(p).model.getValue(), RUN_LANG[ext(p)]); }],
    ['Run: Run Current File', 'F5', runActive],
    ['View: Toggle Panel (Output)', 'Ctrl+`', () => setPanel(!S.panelOpen)],
    ['View: Toggle Edean AI Panel', '', toggleAi],
    ['View: Explorer', '', () => goView('explorer')],
    ['View: Source Control', '', () => goView('scm')],
    ['View: Dependencies', '', () => goView('deps')],
    ['Git: Commit & Push', '', () => { goView('scm'); commitChanges(); }],
    ['Git: Create Branch…', '', newBranch],
    ['Git: Switch Branch…', '', () => openPalette('branches')],
    ['Git: Open Pull Request…', '', () => goView('branches')],
    ['Repository: Download ZIP of Branch', '', exportZip],
    ['Repository: Open Another Repository…', '', () => { S.repo = null; S.view = 'explorer'; renderAll(); }],
    ['Repository: Open on GitHub', '', () => S.repo && window.open(S.repo.htmlUrl, '_blank', 'noopener')],
  ].filter(([label]) => S.repo || /Toggle|Another/.test(label));

  function drawPalette() {
    const f = els.paletteInput.value.toLowerCase();
    let items = [];
    if (paletteMode === 'files') items = visiblePaths().filter((p) => p.toLowerCase().includes(f)).slice(0, 200).map((p) => [baseName(p), dirName(p), () => openTab(p)]);
    else if (paletteMode === 'commands') items = COMMANDS().filter(([l]) => l.toLowerCase().includes(f));
    else if (paletteMode === 'branches') items = S.branches.filter((b) => b.name.toLowerCase().includes(f)).map((b) => [b.name, b.name === S.branch ? 'current' : '', () => switchBranch(b.name)]);
    paletteItems = items;
    paletteIndex = Math.min(paletteIndex, Math.max(0, items.length - 1));
    els.paletteList.innerHTML = items.map(([label, hint], i) => `<button type="button" class="ws-pal-item${i === paletteIndex ? ' active' : ''}" data-i="${i}"><span>${escapeHtml(label)}</span><small>${escapeHtml(hint || '')}</small></button>`).join('');
    els.paletteList.hidden = paletteMode === 'input';
  }

  async function openPalette(mode) {
    if (!S.repo && mode !== 'commands') return;
    if (mode === 'branches' && !S.branches.length) { try { S.branches = (await api(`/api/github/branches?${q({ owner: S.repo.owner, repo: S.repo.name })}`)).branches; } catch { /* offline */ } }
    paletteMode = mode;
    paletteIndex = 0;
    els.paletteTitle.textContent = { files: 'Go to file', commands: 'Command palette', branches: 'Switch branch' }[mode];
    els.paletteInput.value = mode === 'commands' ? '' : '';
    els.paletteInput.placeholder = { files: 'Type a file name', commands: 'Type a command', branches: 'Select a branch' }[mode];
    els.palette.hidden = false;
    drawPalette();
    els.paletteInput.focus();
  }

  function askInput({ title, value = '', placeholder = '' }) {
    paletteMode = 'input';
    els.paletteTitle.textContent = title;
    els.paletteInput.value = value;
    els.paletteInput.placeholder = placeholder;
    els.palette.hidden = false;
    drawPalette();
    els.paletteInput.focus();
    els.paletteInput.setSelectionRange(value.length, value.length);
    return new Promise((resolve) => { paletteResolve = resolve; });
  }

  function closePalette(result = null) {
    els.palette.hidden = true;
    if (paletteResolve) { const r = paletteResolve; paletteResolve = null; r(result); }
    paletteMode = null;
    if (S.active && !S.active.startsWith('diff:')) editor?.focus();
  }

  function runPaletteItem(i) {
    const item = paletteItems[i];
    closePalette();
    item?.[2]();
  }

  els.paletteInput.addEventListener('input', () => { paletteIndex = 0; drawPalette(); });
  els.paletteInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); closePalette(null); }
    else if (e.key === 'Enter') { e.preventDefault(); if (paletteMode === 'input') closePalette(els.paletteInput.value); else runPaletteItem(paletteIndex); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      paletteIndex = Math.max(0, Math.min(paletteItems.length - 1, paletteIndex + (e.key === 'ArrowDown' ? 1 : -1)));
      drawPalette();
    }
  });
  els.paletteList.addEventListener('click', (e) => { const b = e.target.closest('[data-i]'); if (b) runPaletteItem(Number(b.dataset.i)); });
  els.palette.addEventListener('click', (e) => { if (e.target === els.palette) closePalette(null); });

  // ---------- export ----------
  function exportFile() {
    const p = S.active?.replace(/^diff:/, '');
    if (!p) return flash('Open a file first', 'err');
    downloadText(baseName(p), S.files.get(p).model.getValue());
  }
  function exportZip() {
    if (!S.repo) return;
    if (changedPaths().length) flash('The ZIP has the committed files; your uncommitted changes aren\'t included.');
    const a = document.createElement('a');
    a.href = `/api/github/zip?${q({ owner: S.repo.owner, repo: S.repo.name, branch: S.branch })}`;
    a.download = '';
    document.body.appendChild(a); a.click(); a.remove();
  }

  // ---------- small helpers ----------
  let flashTimer = 0;
  function flash(text, kind = '') {
    const el = $('ws-flash');
    el.textContent = text;
    el.className = `ws-flash show ${kind}`;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => { el.className = 'ws-flash'; }, 2200);
  }

  function goView(v) {
    S.view = v;
    store.set('edean.ws.view', v);
    renderSide();
  }
  function toggleAi() {
    S.aiOpen = !S.aiOpen;
    store.set('edean.ws.ai', S.aiOpen);
    renderAi();
    renderActivity();
  }

  function renderAll() {
    renderSide();
    renderTabs();
    renderStatus();
    showSurface();
    renderAi();
  }

  // ---------- events ----------
  els.activity.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.toggle === 'ai') return toggleAi();
    if (matchMedia('(max-width: 900px)').matches) root.classList.toggle('side-open', !(root.classList.contains('side-open') && S.view === b.dataset.view));
    if (b.dataset.view) goView(b.dataset.view);
  });

  els.sideActions.addEventListener('click', (e) => {
    const cmd = e.target.closest('[data-cmd]')?.dataset.cmd;
    if (cmd) sideCommand(cmd);
  });

  async function sideCommand(cmd) {
    if (cmd === 'new-file') return newFile();
    if (cmd === 'new-branch') return newBranch();
    if (cmd === 'save-all') return saveAll();
    if (cmd === 'collapse') { S.expanded.clear(); return renderExplorer(); }
    if (cmd === 'refresh-repos') { S.repos = null; return renderRepoPicker(); }
    if (cmd === 'refresh-deps') { S.deps = null; return renderDeps(); }
    if (cmd === 'refresh-branches') return renderBranches();
    if (cmd === 'refresh') {
      try { await loadTree(); } catch (err) { flash(err.message, 'err'); }
      return renderSide();
    }
  }

  els.side.addEventListener('click', (e) => {
    const t = e.target;
    const cmd = t.closest('[data-cmd]')?.dataset.cmd;
    if (cmd) return sideCommand(cmd);
    const go = t.closest('[data-view-go]');
    if (go) return goView(go.dataset.viewGo);
    const del = t.closest('[data-delete]');
    if (del) { e.stopPropagation(); return deleteFile(del.dataset.delete); }
    const ren = t.closest('[data-rename]');
    if (ren) { e.stopPropagation(); return renameFile(ren.dataset.rename); }
    const dis = t.closest('[data-discard]');
    if (dis) { e.stopPropagation(); return discard(dis.dataset.discard); }
    const repo = t.closest('[data-repo]');
    if (repo) return openRepo(repo.dataset.repo);
    const dir = t.closest('[data-dir]');
    if (dir) {
      const p = dir.dataset.dir;
      if (S.expanded.has(p)) S.expanded.delete(p); else S.expanded.add(p);
      return renderExplorer();
    }
    const file = t.closest('[data-file]');
    if (file) { root.classList.remove('side-open'); return openTab(file.dataset.file); }
    const diff = t.closest('[data-diff]');
    if (diff) {
      const p = diff.dataset.diff;
      if (S.changes[p]?.content === null || S.changes[p]?.isNew) return S.changes[p]?.content === null ? flash(`${p} will be deleted`) : openTab(p);
      return openTab(`diff:${p}`);
    }
    const br = t.closest('[data-branch]');
    if (br) return switchBranch(br.dataset.branch);
  });
  els.side.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('[role="button"]')) e.target.click(); });

  els.tabs.addEventListener('click', (e) => {
    const close = e.target.closest('[data-close]');
    if (close) { e.stopPropagation(); return closeTab(close.dataset.close); }
    const tab = e.target.closest('[data-tab]');
    if (tab) openTab(tab.dataset.tab);
  });
  els.tabs.addEventListener('auxclick', (e) => { const tab = e.target.closest('[data-tab]'); if (tab && e.button === 1) closeTab(tab.dataset.tab); });

  els.status.addEventListener('click', (e) => { const go = e.target.closest('[data-view-go]'); if (go) goView(go.dataset.viewGo); });

  $('ws-save').onclick = () => saveFile(S.active);
  $('ws-run').onclick = runActive;
  $('ws-palette-btn').onclick = () => openPalette('commands');
  $('ws-export').onchange = (e) => {
    const v = e.target.value;
    e.target.value = '';
    if (v === 'file') exportFile();
    else if (v === 'zip') exportZip();
    else if (v === 'compiler') { const p = S.active?.replace(/^diff:/, ''); if (p) onOpenInCompiler?.(S.files.get(p).model.getValue(), RUN_LANG[ext(p)]); }
    else if (v === 'saveall') saveAll();
  };
  $('ws-panel-close').onclick = () => setPanel(false);
  $('ws-ai-close').onclick = toggleAi;
  els.aiForm.onsubmit = (e) => { e.preventDefault(); sendAi(els.aiInput.value); };
  els.aiInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); els.aiForm.requestSubmit(); } });
  els.aiLog.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-action]');
    if (!b) return;
    if (b.dataset.action === 'apply-code') return applyCode(b);
    if (b.dataset.action === 'copy-code') navigator.clipboard?.writeText(b.closest('.code-block').querySelector('code').textContent);
    if (b.dataset.action === 'use-code') onOpenInCompiler?.(b.closest('.code-block').querySelector('code').textContent, undefined);
  });

  // Workspace-wide shortcuts (the editor handles its own when focused).
  document.addEventListener('keydown', (e) => {
    if (root.hidden) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); if (e.shiftKey || e.altKey) saveAll(); else saveFile(S.active); }
    else if (mod && e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); openPalette('commands'); }
    else if (mod && !e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); openPalette('files'); }
    else if (mod && e.key === '`') { e.preventDefault(); setPanel(!S.panelOpen); }
    else if (mod && e.shiftKey && e.key.toLowerCase() === 'e') { e.preventDefault(); goView('explorer'); }
    else if (e.key === 'F5') { e.preventDefault(); runActive(); }
  });
  window.addEventListener('beforeunload', (e) => {
    if (S.tabs.some((t) => !t.startsWith('diff:') && isDirty(t))) e.preventDefault();
  });

  // ---------- boot ----------
  let started = false;
  async function start() {
    if (started) { editor?.layout(); return; }
    started = true;
    setPanel(S.panelOpen);
    renderAll();
    ensureEditor().catch((err) => output(err.message, 'err'));
    try { S.gh = await api('/api/github/status'); } catch (err) { S.gh = { connected: false }; output(err.message, 'err'); }
    const last = store.get('edean.ws.repo', null);
    if (S.gh.connected && last) await openRepo(last);
    else renderAll();
  }

  return { show: start };
}
