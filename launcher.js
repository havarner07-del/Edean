// Desktop launcher: this is what Edean.exe runs when you double-click it.
//
// It loads settings from edean.env, starts the AI engine if it's installed but not
// running, starts Edean's server, and opens Edean in its own app window (Microsoft
// Edge or Google Chrome in "app mode": no tabs or address bar). Closing that window
// quits Edean. If neither browser is available it falls back to your default browser
// and quits after it has been idle for a while.
//
// The Windows build has no console window, so progress and errors go to
// ~/.edean/edean.log, and startup errors are shown in a message box.

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PACKAGED = typeof import.meta.url !== 'string'; // bundled into the executable
// Settings files live next to the executable (or next to this file when run with Node).
const APP_DIR = PACKAGED ? path.dirname(process.execPath) : path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = () => process.env.EDEAN_DATA_DIR || path.join(os.homedir(), '.edean');
const WIN = process.platform === 'win32';
const IDLE_QUIT_MS = 15 * 60 * 1000;

// ---------- logging ----------
let logFile = null;
function log(...parts) {
  const line = parts.join(' ');
  console.log(line);
  try {
    if (!logFile) {
      fs.mkdirSync(DATA_DIR(), { recursive: true });
      logFile = path.join(DATA_DIR(), 'edean.log');
      // Keep the log small: start fresh when it gets large.
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1024 * 1024) fs.rmSync(logFile);
    }
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${line}\n`);
  } catch { /* logging must never break startup */ }
}

function showError(message) {
  log(`ERROR: ${message}`);
  const text = `Edean could not start:\n\n${message}\n\nDetails are in ${path.join(DATA_DIR(), 'edean.log')}`;
  try {
    if (WIN) {
      const ps = `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show($env:EDEAN_MSG, 'Edean', 'OK', 'Error') | Out-Null`;
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { env: { ...process.env, EDEAN_MSG: text }, windowsHide: true, timeout: 5 * 60 * 1000 });
    } else if (process.platform === 'darwin') {
      execFileSync('osascript', ['-e', `display alert "Edean" message ${JSON.stringify(text)} as critical`], { timeout: 5 * 60 * 1000 });
    } else {
      execFileSync('zenity', ['--error', '--title=Edean', `--text=${text}`], { timeout: 5 * 60 * 1000 });
    }
  } catch { console.error(text); }
}

// ---------- settings ----------
// Minimal KEY=value loader for edean.env / .env next to the app. Real env vars win.
function loadEnvFile() {
  for (const name of ['edean.env', '.env']) {
    const file = path.join(APP_DIR, name);
    if (!fs.existsSync(file)) continue;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m || line.trim().startsWith('#')) continue;
      const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
      if (process.env[m[1]] === undefined && value !== '') process.env[m[1]] = value;
    }
    return file;
  }
  return null;
}

// ---------- app window ----------
// Chromium-based browsers can show a site as a standalone app window.
function findAppBrowser() {
  if (process.env.EDEAN_BROWSER === 'default') return null;
  const candidates = [];
  if (process.env.EDEAN_BROWSER) candidates.push(process.env.EDEAN_BROWSER);
  if (WIN) {
    const dirs = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean);
    for (const d of dirs) {
      candidates.push(path.join(d, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
      candidates.push(path.join(d, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      candidates.push(path.join(d, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'));
    }
  } else if (process.platform === 'darwin') {
    for (const app of ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Chromium']) {
      candidates.push(`/Applications/${app}.app/Contents/MacOS/${app}`);
      candidates.push(path.join(os.homedir(), 'Applications', `${app}.app`, 'Contents', 'MacOS', app));
    }
  } else {
    for (const dir of (process.env.PATH || '').split(':')) {
      for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'brave-browser']) {
        candidates.push(path.join(dir, name));
      }
    }
  }
  return candidates.find((c) => { try { return fs.statSync(c).isFile(); } catch { return false; } }) || null;
}

// Opens Edean in its own window. Resolves with the window's process (or null if it
// had to fall back to the default browser).
function openWindow(url) {
  const browser = findAppBrowser();
  if (browser) {
    const profile = path.join(DATA_DIR(), 'window');
    const args = [
      `--app=${url}`, `--user-data-dir=${profile}`, '--window-size=1440,920',
      '--no-first-run', '--no-default-browser-check', '--disable-background-mode', '--disable-features=msEdgeStartupBoost',
    ];
    try {
      const child = spawn(browser, args, { stdio: 'ignore', windowsHide: false });
      child.on('error', (err) => { log(`Could not open ${browser}: ${err.message}`); openDefaultBrowser(url); });
      log(`Opened app window with ${path.basename(browser)}`);
      return child;
    } catch (err) {
      log(`Could not open ${browser}: ${err.message}`);
    }
  }
  openDefaultBrowser(url);
  return null;
}

function openDefaultBrowser(url) {
  const [cmd, args] = WIN ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => log(`Open ${url} in your browser.`));
    child.unref();
    log(`Opened ${url} in the default browser`);
  } catch {
    log(`Open ${url} in your browser.`);
  }
}

async function isEdean(url) {
  try {
    const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
    return (await r.json()).app === 'edean';
  } catch { return false; }
}

// ---------- main ----------
async function main() {
  const envFile = loadEnvFile();
  process.env.HOST ||= '127.0.0.1';
  const { config, startServer, desktop } = await import('./server.js');
  const { detectTools } = await import('./toolchains.js');
  const { startOllama } = await import('./setup.js');
  const updater = await import('./updater.js');
  const restarted = process.env.EDEAN_RESTARTED === '1';
  delete process.env.EDEAN_RESTARTED; // don't pass it on to programs Edean runs
  updater.cleanupOld().catch(() => {});

  log(`Starting Edean${PACKAGED ? ' (desktop app)' : ''}${envFile ? ` with settings from ${envFile}` : ''}`);

  // If Edean is already running, just open another window onto it.
  const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
  for (let port = config.port; port < config.port + 20 && !restarted; port++) {
    if (await isEdean(`http://${host}:${port}`)) {
      log(`Edean is already running on port ${port}; opening a window.`);
      const child = openWindow(`http://${host}:${port}`);
      child?.unref();
      setTimeout(() => process.exit(0), 2000);
      return;
    }
  }

  // Start the local AI engine if it's installed but not running.
  const usesLocalOllama = /^https?:\/\/(127\.0\.0\.1|localhost):11434\b/.test(config.llmBaseUrl);
  if (usesLocalOllama) {
    const up = await fetch(`${config.llmBaseUrl}/models`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
    if (!up && (await detectTools()).ollama.found) {
      log('Starting the AI engine (Ollama)…');
      startOllama();
    }
  }

  let server;
  // After an update the open window reloads from the same address, so wait for the old
  // version to let go of its port instead of moving to another one.
  const wantedPort = restarted && process.env.EDEAN_PORT ? Number(process.env.EDEAN_PORT) : config.port;
  for (let tries = 0; restarted && !server && tries < 40; tries++) {
    try { server = await startServer({ port: wantedPort, host: config.host }); } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  for (let port = config.port; !server && port < config.port + 20; port++) {
    try {
      server = await startServer({ port, host: config.host });
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
    }
  }
  if (!server) throw new Error(`No free port between ${config.port} and ${config.port + 19}. Close other programs using them, or set PORT in edean.env.`);
  const url = `http://${host}:${server.address().port}`;
  log(`Edean is running at ${url}`);

  const quit = (why) => {
    log(`Quitting: ${why}`);
    server.close();
    setTimeout(() => process.exit(0), 300).unref();
  };
  desktop.enabled = true;
  desktop.quit = () => quit('Quit from the app');
  // After an update: start the new version (it takes over this port and the open window reloads).
  desktop.restart = (newExecutable) => {
    log(`Restarting into the updated version${newExecutable ? ` (${newExecutable})` : ''}`);
    const [cmd, args] = newExecutable ? [newExecutable, []] : [process.execPath, process.argv.slice(1)];
    const env = { ...process.env, EDEAN_RESTARTED: '1', EDEAN_PORT: String(server.address().port) };
    server.close();
    server.closeAllConnections?.();
    try {
      spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false, env, cwd: APP_DIR }).unref();
    } catch (err) {
      showError(`The update was installed, but Edean couldn't restart itself: ${err.message}. Start it again.`);
    }
    setTimeout(() => process.exit(0), 500).unref();
  };

  // A restart after an update reuses the window that's already open.
  const window = restarted ? null : openWindow(url);
  let tracking = false;
  if (window) {
    const openedAt = Date.now();
    tracking = true;
    window.on('exit', () => {
      // A quick exit means the browser handed the window to an already-running copy
      // of itself, so we can't tell when it closes; fall back to the idle timer.
      if (Date.now() - openedAt > 8000) quit('the Edean window was closed');
      else { tracking = false; log('The browser handed off the window; Edean will quit after being idle.'); }
    });
  }
  // Without a window we can watch, quit once no Edean page has checked in for a while.
  // (Open pages check in every 30 seconds.) Only for the packaged app; `npm start` keeps running.
  if (PACKAGED) {
    setInterval(() => {
      if (!tracking && Date.now() - desktop.lastActivity > IDLE_QUIT_MS) quit('no Edean window has been open for 15 minutes');
    }, 60 * 1000).unref();
  }
  if (!PACKAGED) {
    console.log(`\nIf a window didn't open, go to ${url}`);
    console.log('Close the Edean window or press Ctrl+C to stop.');
  }
}

main().catch((err) => {
  showError(err.message || String(err));
  process.exit(1);
});
