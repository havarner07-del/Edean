import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.RUN_TIMEOUT_MS = '1500';
process.env.RUN_MAX_OUTPUT = '4096';
const { runCode } = await import('../runner.js');

test('kills programs that run too long', async () => {
  const started = Date.now();
  const r = await runCode({ language: 'javascript', code: 'setInterval(() => {}, 1000)' });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - started < 5000);
});

test('caps runaway output', async () => {
  const r = await runCode({ language: 'javascript', code: 'for (;;) process.stdout.write("x".repeat(1000))' });
  assert.equal(r.truncated, true);
  assert.ok(r.stdout.length <= 4096);
});
