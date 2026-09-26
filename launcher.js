// Desktop launcher: this is what the Edean executable runs.
// It loads settings from edean.env, starts the AI engine if it's installed but
// not running, starts Edean, and opens it in your browser. Close the window to quit.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Settings files live next to the executable (or next to this file when run with Node).
const APP_DIR = typeof import.meta.url === 'string' ? path.dirname(fileURLToPath(import.meta.url)) : path.dirname(process.execPath);

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

function openBrowser(url) {
  const [cmd, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => console.log(`Open ${url} in your browser.`));
    child.unref();
  } catch {
    console.log(`Open ${url} in your browser.`);
  }
}

async function isEdean(url) {
  try {
    const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
    return (await r.json()).app === 'edean';
  } catch { return false; }
}

async function main() {
  const envFile = loadEnvFile();
  process.env.HOST ||= '127.0.0.1';
  const { config, startServer } = await import('./server.js');
  const { detectTools } = await import('./toolchains.js');
  const { startOllama } = await import('./setup.js');

  console.log('');
  console.log('  ███████╗██████╗ ███████╗ █████╗ ███╗   ██╗');
  console.log('  ██╔════╝██╔══██╗██╔════╝██╔══██╗████╗  ██║');
  console.log('  █████╗  ██║  ██║█████╗  ███████║██╔██╗ ██║');
  console.log('  ██╔══╝  ██║  ██║██╔══╝  ██╔══██║██║╚██╗██║');
  console.log('  ███████╗██████╔╝███████╗██║  ██║██║ ╚████║');
  console.log('  ╚══════╝╚═════╝ ╚══════╝╚═╝  ╚═╝╚═╝  ╚═══╝');
  console.log('  Private coding AI — keep this window open while you use Edean.\n');
  if (envFile) console.log(`Settings loaded from ${envFile}`);

  // If Edean is already running, just open it again.
  const host = config.host === '0.0.0.0' ? '127.0.0.1' : config.host;
  if (await isEdean(`http://${host}:${config.port}`)) {
    console.log('Edean is already running — opening it.');
    openBrowser(`http://${host}:${config.port}`);
    setTimeout(() => process.exit(0), 1500);
    return;
  }

  // Start the local AI engine if it's installed but not running.
  const usesLocalOllama = /^https?:\/\/(127\.0\.0\.1|localhost):11434\b/.test(config.llmBaseUrl);
  if (usesLocalOllama) {
    const up = await fetch(`${config.llmBaseUrl}/models`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
    if (!up && (await detectTools()).ollama.found) {
      console.log('Starting the AI engine (Ollama)…');
      startOllama();
    }
  }

  let server;
  for (let port = config.port; port < config.port + 20; port++) {
    try {
      server = await startServer({ port, host: config.host });
      break;
    } catch (err) {
      if (err.code !== 'EADDRINUSE') throw err;
    }
  }
  if (!server) throw new Error(`No free port between ${config.port} and ${config.port + 19}.`);
  const url = `http://${host}:${server.address().port}`;
  openBrowser(url);
  console.log(`\nIf your browser didn't open, go to ${url}`);
  console.log('Press Ctrl+C or close this window to stop Edean.');
}

main().catch((err) => {
  console.error(`\nEdean could not start: ${err.message || err}`);
  if (process.platform === 'win32') {
    console.error('Press Enter to close this window.');
    process.stdin.resume();
    process.stdin.once('data', () => process.exit(1));
  } else {
    process.exit(1);
  }
});
