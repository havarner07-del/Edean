import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ollamaBaseUrl } from '../setup.js';
import { nodeVersionOk } from '../toolchains.js';

test('derives the Ollama API from the OpenAI-style URL', () => {
  assert.equal(ollamaBaseUrl('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434');
  assert.equal(ollamaBaseUrl('http://box:11434/v1/'), 'http://box:11434');
});

test('compares Node versions', () => {
  assert.equal(nodeVersionOk('v22.6.0', 22, 6), true);
  assert.equal(nodeVersionOk('v22.5.1', 22, 6), false);
  assert.equal(nodeVersionOk('v24.0.0', 22, 6), true);
  assert.equal(nodeVersionOk('', 22, 6), false);
});
