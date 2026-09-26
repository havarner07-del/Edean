// Code runner: compiles/runs a single-file program with the toolchains installed
// on this machine (or inside the Docker image). Each run gets a fresh temp
// directory, a time limit, an output cap, and its whole process group is killed
// when it finishes, times out, or the browser disconnects.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { accessSync, constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const limits = {
  runTimeoutMs: Number(process.env.RUN_TIMEOUT_MS || 10000),
  compileTimeoutMs: Number(process.env.COMPILE_TIMEOUT_MS || 30000),
  maxOutputBytes: Number(process.env.RUN_MAX_OUTPUT || 128 * 1024),
  maxConcurrent: Number(process.env.RUN_CONCURRENCY || 2),
  maxCodeBytes: 256 * 1024,
};

function javaFileName(code) {
  const m = code.match(/public\s+(?:(?:final|abstract|sealed|strictfp)\s+)*(?:class|record|enum|interface)\s+([A-Za-z_$][\w$]*)/);
  return `${m ? m[1] : 'Main'}.java`;
}

const nodeMajorMinor = process.versions.node.split('.').slice(0, 2).map(Number);
const nodeHasTypeStripping = nodeMajorMinor[0] > 22 || (nodeMajorMinor[0] === 22 && nodeMajorMinor[1] >= 6);

// `compile` and `run` receive (dir, file) and return [command, ...args].
export const LANGUAGES = {
  python: { label: 'Python 3', file: 'main.py', needs: ['python3'], run: (d, f) => ['python3', '-u', f] },
  javascript: { label: 'JavaScript (Node.js)', file: 'main.js', needs: [], run: (d, f) => [process.execPath, f] },
  typescript: {
    label: 'TypeScript (Node.js)', file: 'main.ts', needs: [], supported: nodeHasTypeStripping,
    unsupportedReason: 'needs Node.js 22.6 or newer',
    run: (d, f) => [process.execPath, '--experimental-strip-types', '--no-warnings', f],
  },
  // Java 11+ can compile and run a single source file in one step.
  java: { label: 'Java', file: javaFileName, needs: ['java'], runTimeoutMs: 20000, run: (d, f) => ['java', f] },
  c: { label: 'C', file: 'main.c', needs: ['gcc'], compile: (d, f) => ['gcc', '-O2', '-Wall', '-o', 'main', f, '-lm'], run: (d) => [path.join(d, 'main')] },
  cpp: { label: 'C++', file: 'main.cpp', needs: ['g++'], compile: (d, f) => ['g++', '-O2', '-Wall', '-std=c++17', '-o', 'main', f], run: (d) => [path.join(d, 'main')] },
  go: { label: 'Go', file: 'main.go', needs: ['go'], compile: (d, f) => ['go', 'build', '-o', 'main', f], run: (d) => [path.join(d, 'main')] },
  rust: { label: 'Rust', file: 'main.rs', needs: ['rustc'], compile: (d, f) => ['rustc', '-O', '-o', 'main', f], run: (d) => [path.join(d, 'main')] },
  ruby: { label: 'Ruby', file: 'main.rb', needs: ['ruby'], run: (d, f) => ['ruby', f] },
  php: { label: 'PHP', file: 'main.php', needs: ['php'], run: (d, f) => ['php', f] },
  bash: { label: 'Bash', file: 'main.sh', needs: ['bash'], run: (d, f) => ['bash', f] },
};

function onPath(cmd) {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    try { accessSync(path.join(dir, cmd), constants.X_OK); return true; } catch { /* keep looking */ }
  }
  return false;
}

// Checked on every call so a toolchain installed while Edean is running shows up.
export function listLanguages() {
  return Object.entries(LANGUAGES).map(([id, spec]) => {
    const missing = spec.needs.filter((c) => !onPath(c));
    const available = spec.supported !== false && missing.length === 0;
    const reason = spec.supported === false ? spec.unsupportedReason : missing.length ? `${missing.join(', ')} not installed` : '';
    return { id, label: spec.label, available, reason };
  });
}

// Programs get this server's environment minus anything that looks like a secret.
function childEnv(dir) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!/KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH/i.test(k)) env[k] = v;
  }
  env.TMPDIR = dir;
  env.PYTHONIOENCODING = 'utf-8';
  env.PYTHONDONTWRITEBYTECODE = '1';
  return env;
}

function exec(argv, { cwd, env, stdin = '', timeoutMs, signal }) {
  return new Promise((resolve) => {
    const started = performance.now();
    const out = { stdout: '', stderr: '', exitCode: null, signal: null, timedOut: false, truncated: false, durationMs: 0 };
    let size = 0;
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      out.stderr = String(err.message || err);
      return resolve(out);
    }
    const killGroup = () => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } };
    const timer = setTimeout(() => { out.timedOut = true; killGroup(); }, timeoutMs);
    const onAbort = () => killGroup();
    signal?.addEventListener('abort', onAbort);

    const collect = (key) => (text) => {
      if (out.truncated) return;
      size += Buffer.byteLength(text);
      if (size > limits.maxOutputBytes) {
        out[key] += text.slice(0, Math.max(0, text.length - (size - limits.maxOutputBytes)));
        out.truncated = true;
        killGroup();
        return;
      }
      out[key] += text;
    };
    child.stdout.setEncoding('utf8').on('data', collect('stdout'));
    child.stderr.setEncoding('utf8').on('data', collect('stderr'));
    child.on('error', (err) => {
      out.stderr += err.code === 'ENOENT' ? `${argv[0]}: command not found\n` : `${err.message}\n`;
    });
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      killGroup(); // clean up anything the program left running in the background
      out.exitCode = code;
      out.signal = sig;
      out.durationMs = Math.round(performance.now() - started);
      resolve(out);
    });
    child.stdin.on('error', () => { /* program exited without reading stdin */ });
    child.stdin.end(stdin);
  });
}

let active = 0;

export async function runCode({ language, code, stdin }, { signal } = {}) {
  const spec = LANGUAGES[language];
  if (!spec) throw Object.assign(new Error(`Unknown language "${language}"`), { status: 400 });
  if (typeof code !== 'string' || !code.trim()) throw Object.assign(new Error('There is no code to run'), { status: 400 });
  if (Buffer.byteLength(code) > limits.maxCodeBytes) throw Object.assign(new Error('Code is too large (max 256 KB)'), { status: 413 });
  const info = listLanguages().find((l) => l.id === language);
  if (!info.available) throw Object.assign(new Error(`${spec.label} can't run here: ${info.reason}`), { status: 400 });
  if (active >= limits.maxConcurrent) throw Object.assign(new Error('Too many programs running at once — try again in a moment'), { status: 429 });

  active++;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'edean-run-'));
  try {
    const file = typeof spec.file === 'function' ? spec.file(code) : spec.file;
    await fs.writeFile(path.join(dir, file), code);
    const env = childEnv(dir);
    const input = typeof stdin === 'string' ? stdin : '';
    let compile = null;
    if (spec.compile) {
      compile = await exec(spec.compile(dir, file), { cwd: dir, env, timeoutMs: limits.compileTimeoutMs, signal });
      if (compile.exitCode !== 0) {
        return { language, phase: 'compile', ...compile, compileMs: compile.durationMs };
      }
    }
    const run = await exec(spec.run(dir, file), { cwd: dir, env, stdin: input, timeoutMs: spec.runTimeoutMs || limits.runTimeoutMs, signal });
    return {
      language,
      phase: 'run',
      ...run,
      compileMs: compile?.durationMs,
      compileOutput: compile?.stderr || compile?.stdout || '',
    };
  } finally {
    active--;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
