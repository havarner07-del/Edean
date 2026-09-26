// "Systems check" panel: green/red lights for everything Edean depends on,
// with one-click install of whatever is missing.
import { $ } from '/lib.js';

const ACTION_LABEL = { engine: 'Start', model: 'Download' };
const PLATFORM_NAME = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

export function initSystems({ onChange } = {}) {
  const els = {
    dialog: $('systems'), open: $('open-systems'), light: $('systems-light'), summary: $('systems-summary'),
    ai: $('checks-ai'), lang: $('checks-lang'), platform: $('systems-platform'), note: $('systems-note'),
    recheck: $('recheck'), installAll: $('install-all'), log: $('install-log'), close: $('close-systems'),
  };
  let status = null;
  let polling = false;
  let logNext = 0;

  const missing = () => (status ? status.checks.filter((c) => !c.ok) : []);

  function renderSummary() {
    if (!status) { els.light.className = 'light checking'; els.summary.textContent = 'Checking…'; return; }
    const aiDown = status.checks.some((c) => c.group === 'ai' && !c.ok);
    const langDown = status.checks.filter((c) => c.group === 'lang' && !c.ok).length;
    els.light.className = `light ${aiDown ? 'red' : langDown ? 'amber' : 'green'}`;
    els.summary.textContent = aiDown ? 'AI offline' : langDown ? `${langDown} missing` : 'All systems go';
  }

  function row(check, busy) {
    const el = document.createElement('div');
    el.className = `check ${check.ok ? 'ok' : 'bad'}`;
    const light = document.createElement('span');
    light.className = `light ${busy ? 'checking' : check.ok ? 'green' : 'red'}`;
    light.setAttribute('aria-hidden', 'true');
    const text = document.createElement('div');
    text.className = 'check-text';
    const name = document.createElement('div');
    name.className = 'check-name';
    name.textContent = check.label;
    if (check.langs) {
      const langs = document.createElement('span');
      langs.className = 'check-langs';
      langs.textContent = check.langs.join(' · ');
      name.appendChild(langs);
    }
    const detail = document.createElement('div');
    detail.className = 'check-detail';
    detail.textContent = check.detail;
    text.append(name, detail);
    const state = document.createElement('span');
    state.className = 'sr-only';
    state.textContent = check.ok ? 'OK' : 'Missing';
    el.append(light, text, state);
    if (!check.ok && status.canInstall) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn ghost small';
      b.textContent = ACTION_LABEL[check.id] || 'Install';
      b.disabled = busy;
      b.onclick = () => install([check.id]);
      el.appendChild(b);
    }
    return el;
  }

  function render() {
    renderSummary();
    if (!status) return;
    const busy = !!status.job?.running || polling;
    els.ai.replaceChildren(...status.checks.filter((c) => c.group === 'ai').map((c) => row(c, busy)));
    els.lang.replaceChildren(...status.checks.filter((c) => c.group === 'lang').map((c) => row(c, busy)));
    const n = missing().length;
    els.platform.textContent = `${PLATFORM_NAME[status.platform] || status.platform} · ${status.packageManager ? `installs with ${status.packageManager}` : 'no package manager found'}`;
    els.installAll.disabled = busy || !n || !status.canInstall;
    els.installAll.querySelector('.label').textContent = busy ? 'Installing…' : n ? `Install all missing (${n})` : 'Everything installed';
    els.recheck.disabled = busy;
    els.note.hidden = status.canInstall;
    els.note.textContent = status.installBlockedReason || '';
  }

  async function refresh(fresh = false) {
    try {
      status = await (await fetch(`/api/setup/status${fresh ? '?fresh=1' : ''}`)).json();
    } catch {
      status = null;
      els.summary.textContent = 'Server offline';
      els.light.className = 'light red';
      return null;
    }
    render();
    if (status.job?.running && !polling) pollLog();
    return status;
  }

  function appendLog(lines) {
    if (!lines.length) return;
    els.log.hidden = false;
    const nearBottom = els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < 40;
    for (const line of lines) {
      const div = document.createElement('div');
      div.textContent = line;
      if (line.startsWith('$ ')) div.className = 'cmd';
      else if (line.startsWith('✔')) div.className = 'ok';
      else if (line.startsWith('✖')) div.className = 'err';
      els.log.appendChild(div);
    }
    if (nearBottom) els.log.scrollTop = els.log.scrollHeight;
  }

  async function pollLog() {
    polling = true;
    render();
    try {
      for (;;) {
        const data = await (await fetch(`/api/setup/log?since=${logNext}`)).json();
        appendLog(data.lines);
        logNext = data.next;
        if (!data.running) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
    } catch (e) {
      appendLog([`✖ Lost contact with Edean: ${e.message}`]);
    }
    polling = false;
    await refresh(true);
    onChange?.();
  }

  async function install(ids) {
    els.log.replaceChildren();
    logNext = 0;
    const r = await fetch('/api/setup/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      appendLog([`✖ ${err.error || `Could not start the install (${r.status})`}`]);
      return;
    }
    pollLog();
  }

  els.open.onclick = () => { els.dialog.showModal(); refresh(true); };
  els.close.onclick = () => els.dialog.close();
  els.recheck.onclick = async () => {
    els.recheck.disabled = true;
    for (const l of els.dialog.querySelectorAll('.check .light')) l.className = 'light checking';
    await refresh(true);
    onChange?.();
  };
  els.installAll.onclick = () => install(missing().map((c) => c.id));

  // On startup, open the panel automatically if the AI side isn't ready yet.
  refresh().then((s) => {
    if (s?.checks.some((c) => c.group === 'ai' && !c.ok) && !els.dialog.open) els.dialog.showModal();
  });

  return { refresh };
}
