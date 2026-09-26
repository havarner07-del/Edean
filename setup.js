// System check + one-click installer for everything Edean needs:
// the AI engine (Ollama), a coding model, and the compiler toolchains.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { TOOLS, detectTools, refreshPath, isSea } from './toolchains.js';

const PLATFORM = process.platform;

// Package names per package manager. `gpp` shares a package with `gcc` where that's how it ships.
const PACKAGES = {
  winget: {
    ollama: 'Ollama.Ollama', node: 'OpenJS.NodeJS.LTS', python: 'Python.Python.3.12', java: 'EclipseAdoptium.Temurin.21.JDK',
    gcc: 'BrechtSanders.WinLibs.POSIX.UCRT', gpp: 'BrechtSanders.WinLibs.POSIX.UCRT', go: 'GoLang.Go',
    rustc: 'Rustlang.Rust.GNU', ruby: 'RubyInstallerTeam.Ruby.3.3', php: 'PHP.PHP.8.3', bash: 'Git.Git',
  },
  brew: {
    ollama: 'ollama', node: 'node', python: 'python', java: 'openjdk', gcc: 'gcc', gpp: 'gcc', go: 'go', rustc: 'rust',
    ruby: 'ruby', php: 'php', bash: 'bash',
  },
  apt: {
    node: 'nodejs', python: 'python3', java: 'default-jdk', gcc: 'gcc', gpp: 'g++', go: 'golang-go', rustc: 'rustc',
    ruby: 'ruby', php: 'php-cli', bash: 'bash',
  },
  dnf: {
    node: 'nodejs', python: 'python3', java: 'java-21-openjdk-devel', gcc: 'gcc', gpp: 'gcc-c++', go: 'golang', rustc: 'rust',
    ruby: 'ruby', php: 'php-cli', bash: 'bash',
  },
  pacman: {
    node: 'nodejs', python: 'python', java: 'jdk-openjdk', gcc: 'gcc', gpp: 'gcc', go: 'go', rustc: 'rust',
    ruby: 'ruby', php: 'php', bash: 'bash',
  },
};

function which(cmd) {
  return new Promise((resolve) => {
    const child = spawn(PLATFORM === 'win32' ? 'where' : 'which', [cmd], { windowsHide: true, stdio: 'ignore' });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0));
  });
}

async function packageManager() {
  if (PLATFORM === 'win32') return (await which('winget')) ? 'winget' : null;
  if (PLATFORM === 'darwin') {
    for (const p of ['/opt/homebrew/bin/brew', '/usr/local/bin/brew']) if (existsSync(p)) return 'brew';
    return (await which('brew')) ? 'brew' : null;
  }
  for (const m of ['apt-get', 'dnf', 'pacman']) if (await which(m)) return m === 'apt-get' ? 'apt' : m;
  return null;
}

// On Linux, system packages need root: use it directly, passwordless sudo, or a graphical pkexec prompt.
async function linuxElevation() {
  if (process.getuid?.() === 0) return [];
  const sudoOk = await new Promise((resolve) => {
    const c = spawn('sudo', ['-n', 'true'], { stdio: 'ignore' });
    c.on('error', () => resolve(false));
    c.on('close', (code) => resolve(code === 0));
  });
  if (sudoOk) return ['sudo', '-n'];
  if ((process.env.DISPLAY || process.env.WAYLAND_DISPLAY) && (await which('pkexec'))) return ['pkexec'];
  return null;
}

export function ollamaBaseUrl(llmBaseUrl) {
  return llmBaseUrl.replace(/\/v1\/?$/, '');
}

async function backendModels(llmBaseUrl, apiKey) {
  try {
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    const r = await fetch(`${llmBaseUrl}/models`, { headers, signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    return ((await r.json()).data || []).map((m) => m.id);
  } catch { return null; }
}

const modelMatches = (models, wanted) => models.some((m) => m === wanted || m === `${wanted}:latest` || `${m}:latest` === wanted);

export async function getStatus(config, { fresh = false } = {}) {
  const [tools, models, manager] = await Promise.all([
    detectTools({ fresh }),
    backendModels(config.llmBaseUrl, config.llmApiKey),
    packageManager(),
  ]);
  const running = models !== null;
  const checks = [
    {
      id: 'ollama', group: 'ai', label: 'AI engine (Ollama)',
      ok: tools.ollama.found || running,
      detail: tools.ollama.found ? tools.ollama.version : running ? 'Another model server is answering' : 'Not installed',
    },
    {
      id: 'engine', group: 'ai', label: 'AI engine running',
      ok: running,
      detail: running ? config.llmBaseUrl : `Nothing answering at ${config.llmBaseUrl}`,
    },
    {
      id: 'model', group: 'ai', label: `Coding model (${config.defaultModel})`,
      ok: running && modelMatches(models, config.defaultModel),
      detail: !running ? 'Waiting for the AI engine' : modelMatches(models, config.defaultModel) ? 'Downloaded' : 'Not downloaded yet',
    },
    ...TOOLS.filter((t) => t.group === 'lang').map((t) => ({
      id: t.id, group: 'lang', label: t.label, langs: t.langs,
      ok: tools[t.id].found,
      detail: tools[t.id].found ? tools[t.id].version : 'Not installed',
    })),
  ];
  return {
    platform: PLATFORM,
    packageManager: manager,
    packaged: isSea,
    checks,
    job: job ? { running: job.running, ok: job.ok } : null,
  };
}

// ---------- install job ----------
let job = null; // { lines: [], running, ok }

function log(line) {
  if (!job) return;
  for (const l of String(line).split(/\r?\n|\r/)) {
    const t = l.trimEnd();
    if (t) job.lines.push(t);
  }
  if (job.lines.length > 2000) {
    const drop = job.lines.length - 2000;
    job.lines.splice(0, drop);
    job.base += drop;
  }
}

function runLogged(argv, { env } = {}) {
  log(`$ ${argv.join(' ')}`);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { windowsHide: true, env: env || process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) { log(`  ${err.message}`); return resolve(1); }
    let last = '';
    const onData = (d) => {
      // Package managers draw progress bars with \r; only keep lines that changed.
      for (const piece of String(d).split(/\r?\n|\r/)) {
        const t = piece.trim();
        if (t && t !== last && !/^[-\\|/█▒░\s\d.%KMGBs/]+$/.test(t)) { log(`  ${t}`); last = t; }
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => { log(`  ${err.message}`); resolve(1); });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

async function waitForEngine(config, seconds) {
  for (let i = 0; i < seconds; i++) {
    if ((await backendModels(config.llmBaseUrl, config.llmApiKey)) !== null) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

export function startOllama() {
  try {
    // The agent needs room for files and tool output; Ollama's default context is small.
    const env = { ...process.env, OLLAMA_CONTEXT_LENGTH: process.env.OLLAMA_CONTEXT_LENGTH || '32768' };
    const child = spawn('ollama', ['serve'], { detached: true, stdio: 'ignore', windowsHide: true, env });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch { return false; }
}

async function pullModel(config) {
  const base = ollamaBaseUrl(config.llmBaseUrl);
  log(`Downloading ${config.defaultModel} (this can take a while — coding models are several GB)…`);
  const r = await fetch(`${base}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.defaultModel, stream: true }),
  });
  if (!r.ok || !r.body) throw new Error(`Ollama refused the download (${r.status})`);
  const decoder = new TextDecoder();
  let buf = '';
  let lastPct = -10;
  let lastStatus = '';
  for await (const chunk of r.body) {
    buf += decoder.decode(chunk, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      if (msg.error) throw new Error(msg.error);
      if (msg.total && msg.completed != null) {
        const pct = Math.floor((msg.completed / msg.total) * 100);
        if (pct >= lastPct + 5 || pct === 100) {
          lastPct = pct;
          log(`  ${msg.status}: ${pct}% of ${(msg.total / 1e9).toFixed(2)} GB`);
        }
      } else if (msg.status && msg.status !== lastStatus) {
        lastStatus = msg.status;
        log(`  ${msg.status}`);
      }
    }
  }
}

async function installPackages(manager, ids) {
  let ok = true;
  if (manager === 'brew' && (ids.includes('gcc') || ids.includes('gpp'))) {
    // On macOS, gcc/g++ come from Apple's Command Line Tools, which have their own installer.
    ids = ids.filter((id) => id !== 'gcc' && id !== 'gpp');
    await runLogged(['xcode-select', '--install']);
    log('  A macOS installer window opened for the C/C++ compiler — follow it, then press Re-check.');
  }
  const names = [...new Set(ids.map((id) => PACKAGES[manager]?.[id]).filter(Boolean))];
  if (!names.length) return ok;
  if (manager === 'winget') {
    for (const name of names) {
      const code = await runLogged(['winget', 'install', '--id', name, '-e', '--silent', '--disable-interactivity',
        '--accept-package-agreements', '--accept-source-agreements']);
      // winget returns a non-zero "already installed" code (0x8A15002B) that's not a failure.
      if (code !== 0 && code !== -1978335189 && code !== 2316632107) ok = false;
    }
    return ok;
  }
  if (manager === 'brew') {
    const brew = existsSync('/opt/homebrew/bin/brew') ? '/opt/homebrew/bin/brew' : existsSync('/usr/local/bin/brew') ? '/usr/local/bin/brew' : 'brew';
    return (await runLogged([brew, 'install', ...names], { env: { ...process.env, HOMEBREW_NO_AUTO_UPDATE: '1' } })) === 0 && ok;
  }
  const elevate = await linuxElevation();
  const manual = { apt: `sudo apt-get install -y ${names.join(' ')}`, dnf: `sudo dnf install -y ${names.join(' ')}`, pacman: `sudo pacman -S --needed ${names.join(' ')}` }[manager];
  if (!elevate) {
    log('Installing system packages needs administrator rights, and Edean could not ask for them here.');
    log(`Run this in a terminal, then press Re-check:\n  ${manual}`);
    return false;
  }
  if (manager === 'apt') {
    await runLogged([...elevate, 'apt-get', 'update']);
    return (await runLogged([...elevate, 'env', 'DEBIAN_FRONTEND=noninteractive', 'apt-get', 'install', '-y', ...names])) === 0;
  }
  if (manager === 'dnf') return (await runLogged([...elevate, 'dnf', 'install', '-y', ...names])) === 0;
  return (await runLogged([...elevate, 'pacman', '-S', '--noconfirm', '--needed', ...names])) === 0;
}

async function installOllamaLinux() {
  const elevate = await linuxElevation();
  if (!elevate) {
    log('Installing Ollama needs administrator rights. Run this in a terminal, then press Re-check:');
    log('  curl -fsSL https://ollama.com/install.sh | sh');
    return false;
  }
  return (await runLogged([...elevate, 'sh', '-c', 'curl -fsSL https://ollama.com/install.sh | sh'])) === 0;
}

async function runInstall(config, requested) {
  const status = await getStatus(config, { fresh: true });
  const missing = new Set(status.checks.filter((c) => !c.ok && (!requested || requested.includes(c.id))).map((c) => c.id));
  if (!missing.size) { log('Everything selected is already installed.'); return true; }
  const manager = status.packageManager;
  let ok = true;

  // 1. Packages (toolchains, and Ollama where a package manager ships it).
  const pkgIds = [...missing].filter((id) => id !== 'engine' && id !== 'model' && !(id === 'ollama' && PLATFORM === 'linux'));
  if (pkgIds.length) {
    if (!manager) {
      const hint = PLATFORM === 'darwin'
        ? 'Install Homebrew first (https://brew.sh), then press Install again.'
        : PLATFORM === 'win32'
          ? 'winget was not found. Install "App Installer" from the Microsoft Store, then press Install again.'
          : 'No supported package manager (apt, dnf or pacman) was found.';
      log(hint);
      ok = false;
    } else {
      log(`Installing with ${manager}: ${pkgIds.join(', ')}`);
      if (!(await installPackages(manager, pkgIds))) ok = false;
    }
  }
  if (missing.has('ollama') && PLATFORM === 'linux') {
    log('Installing Ollama…');
    if (!(await installOllamaLinux())) ok = false;
  }
  if (PLATFORM === 'win32') refreshPath();

  // 2. Start the AI engine and download the model.
  if (missing.has('engine') || missing.has('model') || missing.has('ollama')) {
    let running = (await backendModels(config.llmBaseUrl, config.llmApiKey)) !== null;
    if (!running) {
      log('Starting the AI engine…');
      startOllama();
      running = await waitForEngine(config, 30);
      log(running ? '  AI engine is running.' : '  The AI engine did not start. Open the Ollama app, then press Re-check.');
      if (!running) ok = false;
    }
    if (running) {
      const models = await backendModels(config.llmBaseUrl, config.llmApiKey);
      if (!modelMatches(models, config.defaultModel)) {
        try { await pullModel(config); log('  Model downloaded.'); } catch (err) { log(`  Download failed: ${err.message}`); ok = false; }
      }
    }
  }
  await detectTools({ fresh: true });
  return ok;
}

export function startInstall(config, ids) {
  if (job?.running) return false;
  job = { lines: [], base: 0, running: true, ok: false };
  runInstall(config, Array.isArray(ids) && ids.length ? ids : null)
    .then((ok) => { job.ok = ok; log(ok ? '✔ Done. Everything is installed.' : '✖ Finished with problems — see above.'); })
    .catch((err) => { log(`✖ ${err.message}`); })
    .finally(() => { job.running = false; });
  return true;
}

export function installLog(since = 0) {
  if (!job) return { lines: [], next: 0, running: false, ok: false };
  const start = Math.max(0, since - job.base);
  return { lines: job.lines.slice(start), next: job.base + job.lines.length, running: job.running, ok: job.ok };
}
