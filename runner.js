// Code runner: compiles/runs a single-file program with the toolchains installed
// on this machine (or inside the Docker image). Each run gets a fresh temp
// directory, a time limit, an output cap, and its whole process group is killed
// when it finishes, times out, or the browser disconnects.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TOOLS, detectTools, nodeVersionOk } from './toolchains.js';

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

const WIN = process.platform === 'win32';
const EXE = WIN ? 'main.exe' : 'main';

// `tool` names the toolchain from toolchains.js. `compile` and `run` receive
// (dir, file, t) where t is the detected tool, and return [command, ...args].
const bin = (d) => [path.join(d, EXE)];
export const LANGUAGES = {
  python: { label: 'Python 3', file: 'main.py', tool: 'python', run: (d, f, t) => [t.cmd, ...t.pre, '-u', f] },
  javascript: { label: 'JavaScript (Node.js)', file: 'main.js', tool: 'node', run: (d, f, t) => [t.cmd, f] },
  typescript: {
    label: 'TypeScript (Node.js)', file: 'main.ts', tool: 'node', minNode: [22, 6],
    run: (d, f, t) => [t.cmd, '--experimental-strip-types', '--no-warnings', f],
  },
  // Java 11+ can compile and run a single source file in one step.
  java: { label: 'Java', file: javaFileName, tool: 'java', runTimeoutMs: 20000, run: (d, f, t) => [t.cmd, f] },
  c: { label: 'C', file: 'main.c', tool: 'gcc', compile: (d, f, t) => [t.cmd, '-O2', '-Wall', '-o', EXE, f, '-lm'], run: bin },
  cpp: { label: 'C++', file: 'main.cpp', tool: 'gpp', compile: (d, f, t) => [t.cmd, '-O2', '-Wall', '-std=c++17', '-o', EXE, f], run: bin },
  go: { label: 'Go', file: 'main.go', tool: 'go', compile: (d, f, t) => [t.cmd, 'build', '-o', EXE, f], run: bin },
  rust: { label: 'Rust', file: 'main.rs', tool: 'rustc', compile: (d, f, t) => [t.cmd, '-O', '-o', EXE, f], run: bin },
  ruby: { label: 'Ruby', file: 'main.rb', tool: 'ruby', run: (d, f, t) => [t.cmd, f] },
  php: { label: 'PHP', file: 'main.php', tool: 'php', run: (d, f, t) => [t.cmd, f] },
  bash: { label: 'Bash', file: 'main.sh', tool: 'bash', run: (d, f, t) => [t.cmd, f] },
};

const TOOL_LABEL = Object.fromEntries(TOOLS.map((t) => [t.id, t.label]));

export async function listLanguages({ fresh = false } = {}) {
  const tools = await detectTools({ fresh });
  return Object.entries(LANGUAGES).map(([id, spec]) => {
    const t = tools[spec.tool];
    let available = !!t?.found;
    let reason = available ? '' : `${TOOL_LABEL[spec.tool]} not installed`;
    if (available && spec.minNode && !nodeVersionOk(t.version, ...spec.minNode)) {
      available = false;
      reason = `needs Node.js ${spec.minNode.join('.')} or newer`;
    }
    return { id, label: spec.label, available, reason, tool: spec.tool };
  });
}

// Programs get this server's environment minus anything that looks like a secret.
export function childEnv(dir) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!/KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH/i.test(k)) env[k] = v;
  }
  env.TMPDIR = dir;
  env.PYTHONIOENCODING = 'utf-8';
  env.PYTHONDONTWRITEBYTECODE = '1';
  return env;
}

export function exec(argv, { cwd, env, stdin = '', timeoutMs, signal }) {
  return new Promise((resolve) => {
    const started = performance.now();
    const out = { stdout: '', stderr: '', exitCode: null, signal: null, timedOut: false, truncated: false, durationMs: 0 };
    let size = 0;
    let child;
    try {
      // A separate process group lets us kill everything the program starts (POSIX only).
      child = spawn(argv[0], argv.slice(1), { cwd, env, detached: !WIN, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      out.stderr = String(err.message || err);
      return resolve(out);
    }
    const killGroup = () => {
      if (!child.pid) return;
      if (WIN) {
        if (child.exitCode === null) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
        return;
      }
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
    };
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
  const info = (await listLanguages()).find((l) => l.id === language);
  if (!info.available) throw Object.assign(new Error(`${spec.label} can't run here: ${info.reason}`), { status: 400 });
  const tool = (await detectTools())[spec.tool];
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
      compile = await exec(spec.compile(dir, file, tool), { cwd: dir, env, timeoutMs: limits.compileTimeoutMs, signal });
      if (compile.exitCode !== 0) {
        return { language, phase: 'compile', ...compile, compileMs: compile.durationMs };
      }
    }
    const run = await exec(spec.run(dir, file, tool), { cwd: dir, env, stdin: input, timeoutMs: spec.runTimeoutMs || limits.runTimeoutMs, signal });
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
