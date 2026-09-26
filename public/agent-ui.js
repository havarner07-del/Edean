// Agent tab: tell Edean what you want and it does the work — asks Claude how to do
// it, creates or opens a repository (or a folder on this computer), writes files, runs
// them, fixes problems, commits and pushes. Each task's file changes can be undone.
import { $, store, escapeHtml, renderMarkdown } from '/lib.js';

const ICON = {
  create_repository: '＋', open_repository: '▤', create_branch: '⑂', list_files: '☰', read_file: '👁', write_file: '✎',
  edit_file: '✎', delete_file: '🗑', search_files: '⌕', run_command: '▶', git_status: '±', commit_and_push: '⇡',
  open_pull_request: '⇄', ask_advisor: '✦', list_repositories: '☰', open_folder: '▤',
};
const EXAMPLES = [
  'Create a Python command-line app that tracks my expenses in a CSV file, with tests, in a new private repo called expense-tracker.',
  'Open my Edean repository and add a keyboard shortcut (Ctrl+K) that starts a new chat. Open a pull request.',
  'In my open folder, find why the tests fail and fix the code until they all pass.',
  'Build a small static website for a bakery with a menu page and a contact form, and put it in a new repo.',
];
const LANG = { js: 'javascript', mjs: 'javascript', ts: 'typescript', py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', c: 'c', cpp: 'cpp', html: 'html', css: 'css', json: 'json', md: 'markdown', sh: 'bash', yml: 'yaml', yaml: 'yaml' };

export function initAgent({ settings, onOpenInWorkspace }) {
  const els = {
    log: $('agent-log'), form: $('agent-form'), input: $('agent-input'), send: $('agent-send'), project: $('agent-project'),
    auto: $('agent-auto'), newSession: $('agent-new'), openWs: $('agent-open-ws'), openGh: $('agent-open-gh'),
    plan: $('agent-plan'), review: $('agent-review'), folderBtn: $('agent-folder'), reveal: $('agent-reveal'),
  };
  const saved = store.get('edean.agent.session', {});
  const S = {
    items: Array.isArray(saved.items) ? saved.items : [],
    history: Array.isArray(saved.history) ? saved.history : [],
    project: saved.project || '',
    projects: [],
    running: null, // { controller, runId }
  };
  els.auto.checked = store.get('edean.agent.auto', false);
  els.plan.checked = store.get('edean.agent.plan', true);
  els.review.checked = store.get('edean.agent.review', false);

  const save = () => {
    // Keep the saved session small: newest items, trimmed details.
    const items = S.items.slice(-200).map((it) => (it.detail?.content?.length > 4000 || it.detail?.output?.length > 4000
      ? { ...it, detail: { ...it.detail, content: it.detail.content?.slice(0, 4000), output: it.detail.output?.slice(-4000) } } : it));
    store.set('edean.agent.session', { items, history: S.history.slice(-12), project: S.project });
  };

  // ---------- rendering ----------
  function detailHtml(d) {
    if (!d) return '';
    if (d.kind === 'file') {
      const lang = LANG[d.path.split('.').pop()] || '';
      return renderMarkdown(`\`\`\`\`${lang}\n${d.content}\n\`\`\`\``, { codeUseLabel: 'Open in compiler' });
    }
    if (d.kind === 'edit') {
      const lines = [...d.old.split('\n').map((l) => `- ${l}`), ...d.new.split('\n').map((l) => `+ ${l}`)];
      return `<pre class="agent-diff">${lines.map((l) => `<span class="${l[0] === '+' ? 'add' : 'del'}">${escapeHtml(l)}</span>`).join('\n')}</pre>`;
    }
    if (d.kind === 'command') {
      return `<pre class="agent-out"><span class="cmd">$ ${escapeHtml(d.command)}</span>\n${escapeHtml(d.output || '(no output)')}\n<span class="${d.exitCode === 0 ? 'ok' : 'err'}">${d.timedOut ? 'timed out' : `exit code ${d.exitCode}`}</span></pre>`;
    }
    if (d.kind === 'advisor') {
      return `<div class="agent-advisor"><p><strong>Q:</strong> ${escapeHtml(d.question)}</p>${renderMarkdown(d.answer)}${d.usage ? `<p class="agent-dim">${d.usage.input + d.usage.output} tokens</p>` : ''}</div>`;
    }
    return `<pre class="agent-out">${escapeHtml(d.text || '')}</pre>`;
  }

  function itemHtml(it, i) {
    switch (it.type) {
      case 'user': return `<div class="agent-item user"><div class="agent-bubble">${escapeHtml(it.text)}</div></div>`;
      case 'assistant': return `<div class="agent-item assistant msg-body">${renderMarkdown(it.text)}</div>`;
      case 'status': return `<div class="agent-item status">${escapeHtml(it.text)}</div>`;
      case 'error': return `<div class="agent-item"><div class="error">${escapeHtml(it.text)}</div></div>`;
      case 'done': return `<div class="agent-item assistant final msg-body">${renderMarkdown(it.text)}</div>`;
      case 'plan': case 'review': {
        const who = it.advisor === 'copilot' ? 'Copilot' : 'Claude';
        const title = it.type === 'plan' ? `${who}'s plan` : it.ok ? `${who} reviewed the changes: looks good` : `${who} reviewed the changes and found problems`;
        const cls = it.type === 'review' ? (it.ok ? ' review-ok' : ' review-bad') : '';
        const tokens = it.usage ? `${(it.usage.input + it.usage.output).toLocaleString()} tokens` : '';
        return `<details class="agent-item plan${cls}" data-i="${i}"${it.open ? ' open' : ''}><summary>${escapeHtml(title)}<span class="agent-dim">${tokens}</span></summary>
          <div class="msg-body">${renderMarkdown(it.text)}</div></details>`;
      }
      case 'undo': {
        if (it.undone) return `<div class="agent-item agent-undo">↺ Undid ${it.undone} file change(s) from that task.</div>`;
        return `<div class="agent-item agent-undo" data-i="${i}">${it.changed} file(s) changed in this task.
          <button class="btn ghost small" type="button" data-undo="${escapeHtml(it.run)}">Undo these changes</button></div>`;
      }
      case 'approval': {
        const pending = !it.decision;
        if (it.decision && it.decision !== 'deny') return ''; // approved: the step itself shows what happened
        return `<div class="agent-item approval${pending ? ' pending' : ''}" data-i="${i}">
          <div class="agent-approval-text"><span class="agent-q">Edean wants to</span> ${escapeHtml(it.text)}</div>
          ${it.args?.command ? `<pre class="agent-out"><span class="cmd">$ ${escapeHtml(it.args.command)}</span></pre>` : ''}
          ${pending ? `<div class="agent-approval-actions">
              <button class="btn small" type="button" data-decide="allow">Allow</button>
              <button class="btn ghost small" type="button" data-decide="allow_all">Allow all for this task</button>
              <button class="btn ghost small danger-text" type="button" data-decide="deny">Deny</button></div>`
            : `<div class="agent-dim">${it.decision === 'deny' ? 'Denied' : it.decision === 'allow_all' ? 'Allowed (and everything else in this task)' : 'Allowed'}</div>`}
        </div>`;
      }
      case 'tool': {
        const state = it.ok === undefined ? 'running' : it.ok ? 'ok' : 'fail';
        return `<details class="agent-item tool ${state}" data-i="${i}"${it.open ? ' open' : ''}>
          <summary><span class="agent-ticon">${ICON[it.name] || '•'}</span><span class="agent-tool-text">${escapeHtml(it.text)}</span>
            <span class="agent-state">${state === 'running' ? '<span class="agent-spin"></span>' : state === 'ok' ? '✓' : '✗'}</span></summary>
          ${it.summary ? `<div class="agent-summary">${escapeHtml(it.summary)}</div>` : ''}
          ${detailHtml(it.detail)}
        </details>`;
      }
      default: return '';
    }
  }

  function render() {
    if (!S.items.length) {
      els.log.innerHTML = `<div class="agent-welcome">
        <h2>Tell Edean what to build</h2>
        <p>The agent asks Claude how to do the job, then does it itself: it opens your code (a folder on this computer
        or a GitHub repository) or creates a new repository, writes the files, runs them, fixes what breaks, and commits,
        the same way a developer works. You just say what you want. Every task's file changes can be undone.</p>
        <div class="agent-examples">${EXAMPLES.map((e) => `<button type="button" class="starter" data-example="${escapeHtml(e)}"><span>${escapeHtml(e)}</span></button>`).join('')}</div>
        <p class="agent-dim">By default it asks before running commands, creating repositories and pushing. Tick <em>Work on its own</em> to let it go without asking.</p>
      </div>`;
    } else {
      els.log.innerHTML = S.items.map(itemHtml).join('') + (S.running ? '<div class="agent-item status"><span class="agent-spin"></span> Working…</div>' : '');
    }
    els.send.textContent = S.running ? 'Stop' : 'Send';
    els.send.classList.toggle('stop', !!S.running);
    els.log.scrollTop = els.log.scrollHeight;
    const p = S.projects.find((x) => x.id === S.project);
    els.openWs.hidden = p?.kind === 'folder';
    els.openWs.disabled = !p || p.local;
    els.reveal.hidden = !p || (p.kind !== 'folder' && !p.local);
    els.openGh.hidden = !p?.htmlUrl;
    if (p?.htmlUrl) els.openGh.href = p.htmlUrl;
  }

  async function loadProjects() {
    try {
      const data = await (await fetch('/api/agent/projects')).json();
      S.projects = data.projects || [];
    } catch { S.projects = []; }
    const name = (p) => (p.kind === 'folder' ? `📁 ${p.name}${p.branch ? ` · ${p.branch}` : ''} — ${p.dir}` : `${p.id} · ${p.branch}${p.local ? ' (local)' : ''}`);
    els.project.innerHTML = `<option value="">No project yet — the agent will create or open one</option>` +
      S.projects.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(name(p))}</option>`).join('');
    els.project.value = S.projects.some((p) => p.id === S.project) ? S.project : '';
    render();
  }

  // ---------- running ----------
  function handle(ev) {
    if (ev.type === 'start') { S.running.runId = ev.run; return; }
    if (ev.type === 'assistant') S.items.push({ type: 'assistant', text: ev.text });
    else if (ev.type === 'status') S.items.push({ type: 'status', text: ev.text });
    else if (ev.type === 'tool') S.items.push({ type: 'tool', id: ev.id, name: ev.name, text: ev.text });
    else if (ev.type === 'tool_result') {
      const it = S.items.findLast((x) => x.type === 'tool' && x.id === ev.id);
      if (it) Object.assign(it, { ok: ev.ok, summary: ev.summary, detail: ev.detail, open: !ev.ok || ev.detail?.kind === 'command' });
    } else if (ev.type === 'approval') S.items.push({ type: 'approval', id: ev.id, run: ev.run, name: ev.name, text: ev.text, args: ev.args });
    else if (ev.type === 'approval_done') {
      const it = S.items.findLast((x) => x.type === 'approval' && x.id === ev.id);
      if (it) it.decision = ev.decision;
    } else if (ev.type === 'project') {
      S.project = ev.project.id;
      loadProjects();
    } else if (ev.type === 'plan' || ev.type === 'review') {
      S.items.push({ type: ev.type, advisor: ev.advisor, text: ev.text, ok: ev.ok, usage: ev.usage, open: ev.type === 'plan' || !ev.ok });
    } else if (ev.type === 'done' || ev.type === 'error') {
      S.items.push(ev.type === 'done' ? { type: 'done', text: ev.text } : { type: 'error', text: ev.message });
      if (ev.changed > 0 && ev.run) S.items.push({ type: 'undo', run: ev.run, changed: ev.changed });
    }
    render();
    save();
  }

  async function start(task) {
    task = task.trim();
    if (!task || S.running) return;
    const controller = new AbortController();
    S.running = { controller, runId: null };
    S.items.push({ type: 'user', text: task });
    const firstIndex = S.items.length;
    els.input.value = '';
    render();
    try {
      const r = await fetch('/api/agent/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          task, history: S.history, project: S.project || null, model: settings.model,
          autonomy: els.auto.checked ? 'auto' : 'ask', plan: els.plan.checked, review: els.review.checked,
        }),
        signal: controller.signal,
      });
      if (!r.ok) {
        const err = await r.json().catch(() => ({}));
        throw new Error(err.error || `The agent couldn't start (${r.status}).`);
      }
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split('\n\n');
        buf = parts.pop();
        for (const part of parts) {
          if (!part.startsWith('data: ')) continue;
          try { handle(JSON.parse(part.slice(6))); } catch { /* ignore a bad event */ }
        }
      }
    } catch (e) {
      if (e.name !== 'AbortError') S.items.push({ type: 'error', text: e.message });
    } finally {
      // Remember what happened, briefly, for the next instruction.
      const planItem = S.items.slice(firstIndex).find((x) => x.type === 'plan');
      if (planItem) planItem.open = false; // the plan has been followed; keep the log compact
      const actions = S.items.slice(firstIndex).filter((x) => x.type === 'tool' && x.ok).map((x) => x.text);
      const final = S.items.slice(firstIndex).findLast((x) => x.type === 'done')?.text || '';
      S.history.push({ role: 'user', content: task }, { role: 'assistant', content: `${final}${actions.length ? `\n\n(Actions taken: ${actions.join('; ')})` : ''}`.slice(0, 4000) });
      for (const it of S.items) if (it.type === 'approval' && !it.decision) it.decision = 'deny';
      for (const it of S.items) if (it.type === 'tool' && it.ok === undefined) { it.ok = false; it.summary = 'Stopped'; }
      S.running = null;
      save();
      render();
    }
  }

  async function stop() {
    if (!S.running) return;
    if (S.running.runId) await fetch('/api/agent/stop', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ run: S.running.runId }) }).catch(() => {});
    S.running?.controller.abort();
  }

  // ---------- events ----------
  els.form.onsubmit = (e) => { e.preventDefault(); if (S.running) stop(); else start(els.input.value); };
  els.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); els.form.requestSubmit(); }
  });
  els.log.addEventListener('click', async (e) => {
    const ex = e.target.closest('[data-example]');
    if (ex) { els.input.value = ex.dataset.example; els.input.focus(); return; }
    const u = e.target.closest('[data-undo]');
    if (u) { undo(u); return; }
    const b = e.target.closest('[data-decide]');
    if (!b) return;
    const it = S.items[Number(b.closest('[data-i]').dataset.i)];
    it.decision = b.dataset.decide;
    render();
    await fetch('/api/agent/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ run: it.run, id: it.id, decision: it.decision }) });
  });
  els.log.addEventListener('toggle', (e) => {
    const d = e.target.closest?.('details.tool, details.plan');
    if (d && S.items[Number(d.dataset.i)]) S.items[Number(d.dataset.i)].open = d.open;
  }, true);
  els.auto.onchange = () => store.set('edean.agent.auto', els.auto.checked);
  els.plan.onchange = () => store.set('edean.agent.plan', els.plan.checked);
  els.review.onchange = () => store.set('edean.agent.review', els.review.checked);
  els.reveal.onclick = () => fetch('/api/agent/reveal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project: S.project }) });
  els.folderBtn.onclick = () => openPicker();

  async function undo(btn) {
    if (S.running) return;
    const it = S.items[Number(btn.closest('[data-i]').dataset.i)];
    if (!confirm(`Put back the ${it.changed} file(s) this task changed? (Changes made by commands it ran, like installed packages, are not undone.)`)) return;
    btn.disabled = true;
    try {
      const r = await fetch('/api/agent/undo', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ run: it.run }) });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Undo failed.');
      it.undone = data.files.length || it.changed;
      S.history.push({ role: 'user', content: '(I undid all file changes from your last task.)' }, { role: 'assistant', content: 'Understood: those changes were reverted.' });
    } catch (err) {
      S.items.push({ type: 'error', text: err.message });
    }
    save();
    render();
  }

  // ---------- folder picker ----------
  const picker = {
    dialog: $('folder-picker'), input: $('folder-path'), list: $('folder-list'), shortcuts: $('folder-shortcuts'), msg: $('folder-msg'),
    current: '',
  };
  let browseSeq = 0;
  async function browse(p) {
    picker.msg.textContent = '';
    const seq = ++browseSeq;
    try {
      const r = await fetch(`/api/agent/browse?path=${encodeURIComponent(p || '')}`);
      const data = await r.json();
      if (seq !== browseSeq) return; // a newer listing was requested meanwhile
      if (!r.ok) throw new Error(data.error || 'Could not open that folder.');
      picker.current = data.path;
      picker.input.value = data.path;
      if (data.shortcuts) {
        picker.shortcuts.innerHTML = [...data.shortcuts, ...(data.roots || [])]
          .map((x) => `<button type="button" class="btn ghost small" data-path="${escapeHtml(x.path)}">${escapeHtml(x.name)}</button>`).join('');
      }
      const up = data.parent ? `<button type="button" class="drive-folder" data-path="${escapeHtml(data.parent)}">↑ ..</button>` : '';
      picker.list.innerHTML = up + (data.folders.length ? data.folders.map((f) => `<button type="button" class="drive-folder" data-path="${escapeHtml(f.path)}">📁 ${escapeHtml(f.name)}${f.git ? '<span class="git">git</span>' : ''}</button>`).join('')
        : '<p class="drive-sub">No sub-folders.</p>');
      $('folder-open').disabled = !!data.blocked;
      if (data.blocked) picker.msg.textContent = `Edean won't work directly in ${data.blocked}. Open the project's own folder.`;
      else if (data.git) picker.msg.textContent = '';
    } catch (err) {
      if (seq === browseSeq) picker.msg.textContent = err.message;
    }
  }
  function openPicker() {
    const p = S.projects.find((x) => x.id === S.project && x.kind === 'folder');
    picker.dialog.showModal();
    browse(p ? p.dir : picker.current);
  }
  picker.dialog.addEventListener('click', (e) => {
    const b = e.target.closest('[data-path]');
    if (b) browse(b.dataset.path);
  });
  $('folder-path-form').onsubmit = (e) => { e.preventDefault(); browse(picker.input.value.trim()); };
  $('close-folder').onclick = $('folder-cancel').onclick = () => picker.dialog.close();
  $('folder-open').onclick = async () => {
    picker.msg.textContent = '';
    try {
      const r = await fetch('/api/agent/open-folder', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: picker.input.value.trim() || picker.current }) });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Could not open that folder.');
      S.project = data.project.id;
      picker.dialog.close();
      save();
      await loadProjects();
      els.input.focus();
    } catch (err) {
      picker.msg.textContent = err.message;
    }
  };
  els.project.onchange = () => { S.project = els.project.value; save(); render(); };
  els.newSession.onclick = () => {
    if (S.running) return;
    if (S.items.length && !confirm('Start a new session? The current conversation with the agent is cleared (its work stays in the project).')) return;
    S.items = [];
    S.history = [];
    save();
    render();
  };
  els.openWs.onclick = () => {
    const p = S.projects.find((x) => x.id === S.project);
    if (p && !p.local) onOpenInWorkspace?.(p.id, p.branch);
  };

  render();
  let loaded = false;
  return {
    show() {
      if (!loaded) { loaded = true; loadProjects(); }
      els.input.focus();
    },
  };
}
