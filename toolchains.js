// Finds the programs Edean depends on (Ollama and the compiler toolchains) by
// actually running them, so broken stubs (e.g. the Windows Store "python"
// alias or macOS's /usr/bin/java placeholder) don't count as installed.

import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WIN = process.platform === 'win32';
const home = os.homedir();

// True when running as the packaged Edean executable (Node single executable app).
export const isSea = (() => {
  try { return !!process.getBuiltinModule?.('node:sea')?.isSea(); } catch { return false; }
})();

// Apps launched by double-click often get a minimal PATH, so add the usual install locations.
function extraPathDirs() {
  if (WIN) {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    return [
      path.join(local, 'Programs', 'Ollama'), path.join(pf, 'Git', 'bin'), path.join(pf, 'Go', 'bin'),
      path.join(home, '.cargo', 'bin'), path.join(pf, 'nodejs'),
    ];
  }
  return [
    '/opt/homebrew/bin', '/usr/local/bin', '/opt/homebrew/opt/openjdk/bin', '/usr/local/opt/openjdk/bin',
    '/usr/local/go/bin', path.join(home, '.cargo', 'bin'), path.join(home, '.local', 'bin'),
  ];
}

// On Windows, installers update PATH in the registry; pull those changes into this process.
function windowsRegistryPath() {
  const read = (key) => {
    try {
      const out = execFileSync('reg', ['query', key, '/v', 'Path'], { encoding: 'utf8', windowsHide: true });
      const m = out.match(/Path\s+REG(?:_EXPAND)?_SZ\s+(.*)/i);
      return m ? m[1].trim().replace(/%([^%]+)%/g, (_, v) => process.env[v] ?? `%${v}%`) : '';
    } catch { return ''; }
  };
  return [read('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'), read('HKCU\\Environment')]
    .join(';').split(';').filter(Boolean);
}

export function refreshPath() {
  const parts = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const extra = [...(WIN ? windowsRegistryPath() : []), ...extraPathDirs()];
  for (const dir of extra) {
    if (!parts.some((p) => p.toLowerCase() === dir.toLowerCase()) && existsSync(dir)) parts.push(dir);
  }
  process.env.PATH = parts.join(path.delimiter);
}
refreshPath();

// Each tool lists commands to try in order; `pre` are arguments that go before everything else.
export const TOOLS = [
  { id: 'ollama', label: 'Ollama', group: 'ai', candidates: [{ cmd: 'ollama', ver: ['--version'] }] },
  {
    id: 'node', label: 'Node.js', group: 'lang', langs: ['JavaScript', 'TypeScript'],
    candidates: isSea ? [{ cmd: 'node', ver: ['--version'] }] : [{ cmd: process.execPath, ver: ['--version'] }],
  },
  {
    id: 'python', label: 'Python 3', group: 'lang', langs: ['Python'],
    candidates: WIN
      ? [{ cmd: 'python', ver: ['--version'] }, { cmd: 'py', pre: ['-3'], ver: ['--version'] }, { cmd: 'python3', ver: ['--version'] }]
      : [{ cmd: 'python3', ver: ['--version'] }, { cmd: 'python', ver: ['--version'] }],
  },
  { id: 'java', label: 'Java JDK', group: 'lang', langs: ['Java'], candidates: [{ cmd: 'java', ver: ['-version'] }] },
  { id: 'gcc', label: 'GCC', group: 'lang', langs: ['C'], candidates: [{ cmd: 'gcc', ver: ['--version'] }] },
  { id: 'gpp', label: 'G++', group: 'lang', langs: ['C++'], candidates: [{ cmd: 'g++', ver: ['--version'] }] },
  { id: 'go', label: 'Go', group: 'lang', langs: ['Go'], candidates: [{ cmd: 'go', ver: ['version'] }] },
  { id: 'rustc', label: 'Rust', group: 'lang', langs: ['Rust'], candidates: [{ cmd: 'rustc', ver: ['--version'] }] },
  { id: 'ruby', label: 'Ruby', group: 'lang', langs: ['Ruby'], candidates: [{ cmd: 'ruby', ver: ['--version'] }] },
  { id: 'php', label: 'PHP', group: 'lang', langs: ['PHP'], candidates: [{ cmd: 'php', ver: ['--version'] }] },
  {
    id: 'bash', label: 'Bash', group: 'lang', langs: ['Bash'],
    // Prefer Git Bash on Windows; System32\bash.exe is the WSL launcher.
    candidates: WIN
      ? [{ cmd: path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Git', 'bin', 'bash.exe'), ver: ['--version'] }]
      : [{ cmd: 'bash', ver: ['--version'] }],
  },
];

function probe({ cmd, pre = [], ver }) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(cmd, [...pre, ...ver], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch { return resolve(null); }
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, 8000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return resolve(null);
      const line = out.split(/\r?\n/).find((l) => /\d+\.\d+/.test(l) && !/^Picked up/.test(l)) || out.split(/\r?\n/)[0] || '';
      resolve(line.trim().slice(0, 120));
    });
  });
}

let cache = null;
let cacheAt = 0;
let inflight = null;

// Returns { [id]: { found, cmd, pre, version } }. Cached for 30 s unless `fresh`.
export async function detectTools({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cacheAt < 30000) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    if (fresh) refreshPath();
    const results = await Promise.all(TOOLS.map(async (tool) => {
      for (const c of tool.candidates) {
        const version = await probe(c);
        if (version !== null) return [tool.id, { found: true, cmd: c.cmd, pre: c.pre || [], version }];
      }
      return [tool.id, { found: false, cmd: '', pre: [], version: '' }];
    }));
    cache = Object.fromEntries(results);
    cacheAt = Date.now();
    return cache;
  })();
  try { return await inflight; } finally { inflight = null; }
}

export function nodeVersionOk(versionLine, major, minor) {
  const m = /v?(\d+)\.(\d+)/.exec(versionLine || '');
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a > major || (a === major && b >= minor);
}
