// Compiler tab: a code editor that runs programs on the Edean server, plus an
// "Advice" button that asks your model about the code and writes the answer
// into the Notepad panel.
import { $, store, uid, escapeHtml, renderReply, streamChat, copyText, handleCodeAction } from '/lib.js';
import { BASE_SYSTEM_PROMPT, ADVICE_PROMPT, TEMPLATES } from '/prompts.js';

const LABELS = {
  python: 'Python 3', javascript: 'JavaScript (Node.js)', typescript: 'TypeScript (Node.js)', java: 'Java', c: 'C', cpp: 'C++',
  go: 'Go', rust: 'Rust', ruby: 'Ruby', php: 'PHP', bash: 'Bash',
};
// highlight.js / code-fence names happen to match our ids.
const INDENT = { go: '\t', javascript: '  ', typescript: '  ', ruby: '  ', bash: '  ' };
const MAX_NOTES = 50;

const clip = (s, n = 6000) => (s.length <= n ? s : `${s.slice(0, n / 2)}\n… [truncated] …\n${s.slice(-n / 2)}`);
const fenced = (s, lang = 'text') => {
  const f = s.includes('```') ? '~~~~' : '```';
  return `${f}${lang}\n${s.replace(/\s+$/, '')}\n${f}`;
};

export function describeResult(r) {
  const secs = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`);
  if (r.phase === 'compile') return { kind: 'err', text: r.timedOut ? 'Compilation timed out' : 'Compilation failed' };
  if (r.timedOut) return { kind: 'warn', text: `Timed out after ${secs(r.durationMs)} — the program was stopped` };
  if (r.truncated) return { kind: 'warn', text: 'Output limit reached — the program was stopped' };
  const time = `${secs(r.durationMs)}${r.compileMs ? ` (+${secs(r.compileMs)} compile)` : ''}`;
  if (r.exitCode === 0) return { kind: 'ok', text: `Finished · exit code 0 · ${time}` };
  if (r.signal) return { kind: 'err', text: `Killed by ${r.signal} · ${time}` };
  return { kind: 'err', text: `Exited with code ${r.exitCode} · ${time}` };
}

export function initCompiler({ settings, onOpen }) {
  const els = {
    root: $('compiler'), lang: $('lang-select'), reset: $('reset-code'), run: $('run-btn'), advice: $('advice-btn'),
    notepadToggle: $('notepad-toggle'), notesCount: $('notes-count'), editor: $('editor'), gutter: $('gutter'),
    hl: $('code-hl'), input: $('code-input'), ioTabs: document.querySelectorAll('.io-tab'), console: $('console'),
    stdin: $('stdin'), stdinDot: $('stdin-dot'), runStatus: $('run-status'), notepad: $('notepad'),
    notes: $('notes'), question: $('advice-question'), clearNotes: $('clear-notes'), closeNotepad: $('close-notepad'),
  };

  const saved = store.get('edean.editor', {});
  const state = {
    lang: TEMPLATES[saved.lang] ? saved.lang : 'python',
    code: saved.code && typeof saved.code === 'object' ? saved.code : {},
    stdin: typeof saved.stdin === 'string' ? saved.stdin : '',
    notepadOpen: saved.notepadOpen ?? true,
  };
  let notes = store.get('edean.notes', []);
  let languages = Object.keys(TEMPLATES).map((id) => ({ id, label: LABELS[id], available: true, reason: '' }));
  let runner = { enabled: true, reason: '' };
  let running = null;   // AbortController for the current run
  let advising = null;  // AbortController for the current advice stream
  let lastRun = null;   // { lang, code, stdin, result }

  let saveTimer = 0;
  const saveEditor = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => store.set('edean.editor', state), 250);
  };
  const saveNotes = () => store.set('edean.notes', notes);
  const codeFor = (lang) => state.code[lang] ?? TEMPLATES[lang];
  const langInfo = (id) => languages.find((l) => l.id === id) || { id, label: LABELS[id], available: false, reason: 'unknown' };

  // ---------- editor ----------
  let hlFrame = 0;
  function paint() {
    hlFrame = 0;
    const code = els.input.value;
    let html;
    try { html = window.hljs ? window.hljs.highlight(code, { language: state.lang, ignoreIllegals: true }).value : escapeHtml(code); } catch { html = escapeHtml(code); }
    // The extra line keeps the highlight layer at least as tall as the textarea.
    els.hl.innerHTML = html + '\n\n';
    const lines = code.split('\n').length;
    if (els.gutter.dataset.lines !== String(lines)) {
      els.gutter.dataset.lines = lines;
      els.gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
    }
  }
  const schedulePaint = () => { if (!hlFrame) hlFrame = requestAnimationFrame(paint); };

  function loadEditor() {
    els.input.value = codeFor(state.lang);
    els.lang.value = state.lang;
    paint();
    updateButtons();
  }

  // Replace text through the browser's editing commands so Ctrl+Z still works.
  function replaceRange(start, end, text) {
    els.input.focus();
    els.input.setSelectionRange(start, end);
    if (!document.execCommand('insertText', false, text)) {
      els.input.setRangeText(text, start, end, 'end');
      els.input.dispatchEvent(new Event('input'));
    }
  }

  function setCode(code) {
    replaceRange(0, els.input.value.length, code);
    els.input.setSelectionRange(0, 0);
    els.editor.scrollTop = 0;
  }

  function switchLang(lang) {
    if (!TEMPLATES[lang]) return;
    state.lang = lang;
    saveEditor();
    loadEditor();
  }

  // Does this line start a new indented block?
  function opensBlock(line) {
    if (/[{[(]$/.test(line)) return true;
    if (state.lang === 'python') return line.endsWith(':');
    if (state.lang === 'ruby') return /\bdo(\s*\|[^|]*\|)?$/.test(line) || /^\s*(def|class|module|if|unless|while|until|case|begin)\b/.test(line);
    if (state.lang === 'bash') return /\b(then|do|else)$/.test(line);
    return false;
  }

  let escapePressed = false;
  els.input.addEventListener('keydown', (e) => {
    const ta = els.input;
    const { selectionStart: start, selectionEnd: end, value } = ta;
    const unit = INDENT[state.lang] || '    ';
    if (e.key === 'Escape') { escapePressed = true; return; }
    if (e.key === 'Tab' && !escapePressed && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      if (start === end && !e.shiftKey) return replaceRange(start, end, unit);
      // Indent / outdent every selected line.
      const blockEnd = end > start && value[end - 1] === '\n' ? end - 1 : end;
      const lineEnd = value.indexOf('\n', blockEnd) === -1 ? value.length : value.indexOf('\n', blockEnd);
      const lines = value.slice(lineStart, lineEnd).split('\n');
      const changed = lines.map((l) => {
        if (!e.shiftKey) return unit + l;
        if (l.startsWith(unit)) return l.slice(unit.length);
        return l.replace(/^(\t| {1,4})/, '');
      }).join('\n');
      replaceRange(lineStart, lineEnd, changed);
      ta.setSelectionRange(lineStart, lineStart + changed.length);
      return;
    }
    escapePressed = false;
    if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && !e.isComposing) {
      e.preventDefault();
      const lineStart = value.lastIndexOf('\n', start - 1) + 1;
      const indent = value.slice(lineStart, start).match(/^[\t ]*/)[0];
      const before = value.slice(lineStart, start).trimEnd();
      const after = value.slice(end);
      const opens = opensBlock(before);
      if (opens && /^\s*[}\])]/.test(after)) {
        // Cursor between brackets: put the closing bracket on its own line.
        replaceRange(start, end, `\n${indent}${unit}\n${indent}`);
        const caret = start + 1 + indent.length + unit.length;
        ta.setSelectionRange(caret, caret);
      } else {
        replaceRange(start, end, `\n${indent}${opens ? unit : ''}`);
      }
    }
  });

  els.input.addEventListener('input', () => {
    state.code[state.lang] = els.input.value;
    saveEditor();
    schedulePaint();
  });

  // ---------- running ----------
  function updateButtons() {
    const info = langInfo(state.lang);
    const canRun = runner.enabled && info.available;
    els.run.classList.toggle('stop', !!running);
    els.run.querySelector('.label').textContent = running ? 'Stop' : 'Run';
    els.run.disabled = !running && !canRun;
    els.run.title = !runner.enabled ? runner.reason : !info.available ? `${info.label} can't run here: ${info.reason}` : 'Run (Ctrl+Enter)';
    els.advice.classList.toggle('stop', !!advising);
    els.advice.querySelector('.label').textContent = advising ? 'Stop' : 'Advice';
    els.notesCount.textContent = notes.length ? String(notes.length) : '';
    els.notepadToggle.setAttribute('aria-pressed', String(state.notepadOpen));
    els.stdinDot.hidden = !state.stdin.trim();
  }

  function showIo(which) {
    for (const t of els.ioTabs) {
      const active = t.dataset.io === which;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', String(active));
    }
    els.console.hidden = which !== 'output';
    els.stdin.hidden = which !== 'input';
    if (which === 'input') els.stdin.focus();
  }

  function consoleMessage(text, kind = '') {
    els.console.innerHTML = '';
    const p = document.createElement('div');
    p.className = `console-note ${kind}`;
    p.textContent = text;
    els.console.appendChild(p);
  }

  function renderResult(r) {
    const { kind, text } = describeResult(r);
    els.runStatus.className = `run-status ${kind}`;
    els.runStatus.textContent = text;
    els.console.innerHTML = '';
    const add = (s, cls) => {
      if (!s) return;
      const span = document.createElement('span');
      span.className = cls;
      span.textContent = s.endsWith('\n') ? s : s + '\n';
      els.console.appendChild(span);
    };
    add(r.compileOutput, 'out-compile');
    add(r.stdout, 'out-stdout');
    add(r.stderr, 'out-stderr');
    if (!r.stdout && !r.stderr && !r.compileOutput) consoleMessage('(no output)', 'muted');
    if (r.truncated) add('… output truncated', 'out-compile');
  }

  function showRunnerHint() {
    const info = langInfo(state.lang);
    if (!runner.enabled) consoleMessage(`${runner.reason}\n\nYou can still press Advice to get notes on your code.`, 'warn');
    else if (!info.available) consoleMessage(`${info.label} isn't installed on the Edean server (${info.reason}).\nInstall it, or use the Docker image, which includes it. You can still press Advice.`, 'warn');
    else consoleMessage('Press Run (Ctrl+Enter) to compile and run your program. Output appears here.', 'muted');
    els.runStatus.textContent = '';
  }

  async function run() {
    if (running) { running.abort(); return; }
    const info = langInfo(state.lang);
    if (!runner.enabled || !info.available) { showRunnerHint(); return; }
    const snapshot = { lang: state.lang, code: els.input.value, stdin: state.stdin };
    if (!snapshot.code.trim()) return;
    running = new AbortController();
    updateButtons();
    showIo('output');
    els.runStatus.className = 'run-status';
    els.runStatus.textContent = 'Running…';
    consoleMessage(['c', 'cpp', 'go', 'rust', 'java'].includes(snapshot.lang) ? 'Compiling and running…' : 'Running…', 'muted');
    try {
      const res = await fetch('/api/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language: snapshot.lang, code: snapshot.code, stdin: snapshot.stdin }),
        signal: running.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Run failed (${res.status})`);
      lastRun = { ...snapshot, result: data };
      renderResult(data);
    } catch (e) {
      els.runStatus.className = 'run-status';
      els.runStatus.textContent = '';
      if (e.name === 'AbortError') consoleMessage('Stopped.', 'muted');
      else consoleMessage(e.message || String(e), 'err');
    } finally {
      running = null;
      updateButtons();
    }
  }

  // ---------- advice + notepad ----------
  function buildAdviceRequest(code, question) {
    const lang = state.lang;
    const parts = [`Here is my ${langInfo(lang).label} program from the Edean compiler:`, fenced(code, lang)];
    if (state.stdin.trim()) parts.push(`Standard input it runs with:\n${fenced(clip(state.stdin))}`);
    const r = lastRun && lastRun.lang === lang && lastRun.code === code && lastRun.stdin === state.stdin ? lastRun.result : null;
    if (r) {
      parts.push(`I ran it. Result: ${describeResult(r).text}.`);
      if (r.compileOutput?.trim()) parts.push(`Compiler output:\n${fenced(clip(r.compileOutput))}`);
      if (r.stdout.trim()) parts.push(`stdout:\n${fenced(clip(r.stdout))}`);
      if (r.stderr.trim()) parts.push(`${r.phase === 'compile' ? 'Compiler errors' : 'stderr'}:\n${fenced(clip(r.stderr))}`);
      if (!r.stdout.trim() && !r.stderr.trim()) parts.push('It printed nothing.');
    } else {
      parts.push("I haven't run this version of the code yet.");
    }
    parts.push(question ? `My question: ${question}` : 'What should I fix or improve?');
    return parts.join('\n\n');
  }

  function setNotepad(open) {
    state.notepadOpen = open;
    els.root.classList.toggle('notepad-closed', !open);
    saveEditor();
    updateButtons();
  }

  function noteEl(note) {
    const el = document.createElement('article');
    el.className = 'note';
    el.dataset.id = note.id;
    const meta = document.createElement('header');
    meta.className = 'note-meta';
    const when = new Date(note.createdAt);
    const sameDay = when.toDateString() === new Date().toDateString();
    meta.textContent = `${LABELS[note.lang] || note.lang} · ${sameDay ? when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : when.toLocaleDateString()}`;
    if (note.model) {
      const tag = document.createElement('span');
      tag.className = 'model-tag';
      tag.textContent = note.model;
      meta.appendChild(tag);
    }
    el.appendChild(meta);
    if (note.question) {
      const q = document.createElement('p');
      q.className = 'note-q';
      q.textContent = note.question;
      el.appendChild(q);
    }
    const body = document.createElement('div');
    body.className = 'note-body msg-body';
    body.innerHTML = renderReply(note, { codeUseLabel: 'Use in editor' });
    el.appendChild(body);
    if (!note.pending) {
      const actions = document.createElement('footer');
      actions.className = 'note-actions';
      for (const [label, action] of [['Copy', 'copy-note'], ['Delete', 'delete-note']]) {
        const b = document.createElement('button');
        b.type = 'button'; b.textContent = label; b.dataset.action = action;
        actions.appendChild(b);
      }
      el.appendChild(actions);
    }
    return el;
  }

  function renderNotes() {
    els.notes.innerHTML = '';
    if (!notes.length) {
      const empty = document.createElement('div');
      empty.className = 'notes-empty';
      empty.innerHTML = '<strong>Your notes will appear here.</strong><br>Press <em>Advice</em> and Edean will review the code in the editor, including the output of your last run, and write its advice on this notepad.';
      els.notes.appendChild(empty);
    }
    for (const note of notes) els.notes.appendChild(noteEl(note));
    updateButtons();
  }

  async function advise() {
    if (advising) { advising.abort(); return; }
    const code = els.input.value;
    if (!code.trim()) { els.input.focus(); return; }
    const question = els.question.value.trim();
    els.question.value = '';
    const note = { id: uid(), createdAt: Date.now(), lang: state.lang, model: settings.model, question, content: '', reasoning: '', pending: true };
    notes.unshift(note);
    if (notes.length > MAX_NOTES) notes.length = MAX_NOTES;
    advising = new AbortController();
    setNotepad(true);
    renderNotes();
    els.notes.scrollTop = 0;

    let frame = 0;
    const repaint = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        const body = els.notes.querySelector(`.note[data-id="${note.id}"] .note-body`);
        if (body) body.innerHTML = renderReply(note, { codeUseLabel: 'Use in editor' });
      });
    };

    try {
      await streamChat({
        model: settings.model,
        temperature: settings.temperature,
        maxTokens: settings.maxTokens,
        messages: [
          { role: 'system', content: `${settings.systemPrompt || BASE_SYSTEM_PROMPT}\n\n${ADVICE_PROMPT}` },
          { role: 'user', content: buildAdviceRequest(code, question) },
        ],
        signal: advising.signal,
        onDelta: ({ content, reasoning }) => { note.content += content; note.reasoning += reasoning; repaint(); },
      });
    } catch (e) {
      if (e.name !== 'AbortError') note.error = e.message || String(e);
    } finally {
      if (frame) cancelAnimationFrame(frame);
      if (!note.content && !note.error && advising.signal.aborted) note.content = '_Stopped._';
      delete note.pending;
      if (!note.reasoning) delete note.reasoning;
      advising = null;
      saveNotes();
      renderNotes();
    }
  }

  // ---------- languages ----------
  function renderLanguageOptions() {
    els.lang.innerHTML = '';
    for (const l of languages) {
      const o = document.createElement('option');
      o.value = l.id;
      o.textContent = l.available ? l.label : `${l.label} (not installed)`;
      els.lang.appendChild(o);
    }
    els.lang.value = state.lang;
  }

  async function loadLanguages(fresh = false) {
    try {
      const data = await (await fetch(`/api/run/languages${fresh ? '?fresh=1' : ''}`)).json();
      runner = { enabled: data.enabled, reason: data.reason };
      languages = data.languages.filter((l) => TEMPLATES[l.id]);
    } catch {
      runner = { enabled: false, reason: 'Cannot reach the Edean server.' };
    }
    renderLanguageOptions();
    updateButtons();
    if (!lastRun) showRunnerHint();
  }

  // ---------- events ----------
  els.lang.onchange = () => switchLang(els.lang.value);
  els.reset.onclick = () => {
    if (els.input.value !== TEMPLATES[state.lang] && !confirm(`Replace the editor contents with the ${langInfo(state.lang).label} starter program? (Ctrl+Z undoes this.)`)) return;
    setCode(TEMPLATES[state.lang]);
  };
  els.run.onclick = run;
  els.advice.onclick = advise;
  els.notepadToggle.onclick = () => setNotepad(!state.notepadOpen);
  els.closeNotepad.onclick = () => setNotepad(false);
  els.clearNotes.onclick = () => {
    if (!notes.length || !confirm('Delete every note on the notepad?')) return;
    advising?.abort();
    notes = [];
    saveNotes();
    renderNotes();
  };
  els.question.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing && !e.ctrlKey && !e.metaKey) { e.preventDefault(); if (!advising) advise(); }
  });
  for (const t of els.ioTabs) t.onclick = () => showIo(t.dataset.io);
  els.stdin.value = state.stdin;
  els.stdin.addEventListener('input', () => { state.stdin = els.stdin.value; saveEditor(); updateButtons(); });

  els.root.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (e.shiftKey) { if (!advising) advise(); } else if (!running) run();
    }
  });

  els.notes.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-action]');
    if (!b) return;
    if (handleCodeAction(b, { onUse: (code, lang) => open(code, lang) })) return;
    const id = b.closest('.note')?.dataset.id;
    const note = notes.find((n) => n.id === id);
    if (!note) return;
    if (b.dataset.action === 'copy-note') copyText(note.content, b);
    if (b.dataset.action === 'delete-note') {
      notes = notes.filter((n) => n.id !== id);
      saveNotes();
      renderNotes();
    }
  });

  // Open code (e.g. from a chat reply or a note) in the editor.
  function open(code, lang) {
    onOpen?.();
    if (lang && lang !== state.lang && TEMPLATES[lang]) switchLang(lang);
    setCode(code.endsWith('\n') ? code : code + '\n');
    if (window.matchMedia('(max-width: 1180px)').matches) setNotepad(false);
  }

  // The notepad drawer (medium screens) sits just below the toolbar.
  const toolbar = els.root.querySelector('.compiler-toolbar');
  new ResizeObserver(() => els.root.style.setProperty('--toolbar-h', `${toolbar.offsetHeight}px`)).observe(toolbar);

  // ---------- boot ----------
  // Notes left pending by a reload can never finish.
  for (const n of notes) if (n.pending) { delete n.pending; n.error = n.error || 'Interrupted.'; }
  renderLanguageOptions();
  loadEditor();
  setNotepad(state.notepadOpen && !window.matchMedia('(max-width: 1180px)').matches);
  renderNotes();
  showIo('output');
  loadLanguages();

  return {
    open,
    refreshLanguages: () => loadLanguages(true),
    focus: () => els.input.focus({ preventScroll: true }),
  };
}
