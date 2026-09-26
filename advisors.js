// Advisors: when the local model isn't sure about something, it can ask a
// stronger model a short, focused question instead of guessing. Only that
// question (not the whole conversation) is sent, which keeps paid tokens low.
//
//   claude  — Anthropic's Claude, through the official Anthropic SDK
//   copilot — GitHub Models (GitHub's AI inference API), using your GitHub token.
//             GitHub Copilot itself has no public API for other apps; GitHub Models
//             is GitHub's supported way to call AI models with a GitHub account.

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { githubToken } from './github.js';

const DATA_DIR = () => process.env.EDEAN_DATA_DIR || path.join(os.homedir(), '.edean');
const FILE = () => path.join(DATA_DIR(), 'advisors.json');
const GITHUB_MODELS_URL = () => process.env.GITHUB_MODELS_URL || 'https://models.github.ai/inference/chat/completions';

export const DEFAULTS = { claudeModel: 'claude-opus-5', copilotModel: 'openai/gpt-4.1', auto: true };
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

const ADVISOR_SYSTEM = `You are a senior engineer advising a smaller, local coding model that is unsure about something.
Answer the question directly and precisely. Be brief: usually a few sentences or a short list, plus a small code snippet only if it is essential.
If the question lacks information you need, say exactly what is missing. No preamble, no restating the question.`;

let settings = null;
async function load() {
  if (settings) return settings;
  try { settings = JSON.parse(await fs.readFile(FILE(), 'utf8')); } catch { settings = {}; }
  return settings;
}
async function persist() {
  await fs.mkdir(DATA_DIR(), { recursive: true, mode: 0o700 });
  await fs.writeFile(FILE(), JSON.stringify(settings, null, 2), { mode: 0o600 });
  await fs.chmod(FILE(), 0o600).catch(() => {});
}

const anthropicKey = () => settings.anthropicKey || process.env.ANTHROPIC_API_KEY || '';

export async function advisorStatus() {
  await load();
  return {
    auto: settings.auto ?? DEFAULTS.auto,
    claude: { configured: !!anthropicKey(), model: settings.claudeModel || DEFAULTS.claudeModel, keyFromEnv: !settings.anthropicKey && !!process.env.ANTHROPIC_API_KEY },
    copilot: { configured: !!(await githubToken()), model: settings.copilotModel || DEFAULTS.copilotModel },
  };
}

export async function updateAdvisors(input = {}) {
  await load();
  if (typeof input.anthropicKey === 'string') {
    const key = input.anthropicKey.trim();
    if (key && !/^sk-ant-[\w-]{10,}$/.test(key)) throw fail('That doesn\'t look like an Anthropic API key (it starts with sk-ant-).');
    if (key) settings.anthropicKey = key; else delete settings.anthropicKey;
  }
  for (const k of ['claudeModel', 'copilotModel']) {
    if (typeof input[k] === 'string' && input[k].trim()) {
      if (!/^[\w./:-]{2,100}$/.test(input[k].trim())) throw fail(`Invalid model name for ${k}.`);
      settings[k] = input[k].trim();
    }
  }
  if (typeof input.auto === 'boolean') settings.auto = input.auto;
  await persist();
  return advisorStatus();
}

async function askClaude(question) {
  const key = anthropicKey();
  if (!key) throw fail('Add your Anthropic API key in Settings → Advisors to ask Claude.', 409);
  const model = settings.claudeModel || DEFAULTS.claudeModel;
  const client = new Anthropic({ apiKey: key });
  const params = {
    model,
    max_tokens: 16000,
    system: ADVISOR_SYSTEM,
    messages: [{ role: 'user', content: question }],
  };
  if (!/haiku/.test(model)) {
    params.thinking = { type: 'adaptive' };
    params.output_config = { effort: 'high' };
  }
  // If Claude declines on safety grounds, let the API retry on a fallback model in the same call.
  const fallbackCapable = /^claude-(opus-5|fable-5)/.test(model);
  let response;
  try {
    response = fallbackCapable
      ? await client.beta.messages.create({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
      : await client.messages.create(params);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw fail('Anthropic rejected the API key. Check it in Settings → Advisors.', 401);
    if (err instanceof Anthropic.RateLimitError) throw fail('Claude is rate-limited right now. Try again shortly.', 429);
    if (err instanceof Anthropic.BadRequestError) throw fail(`Claude couldn't take the request: ${err.message}`, 400);
    if (err instanceof Anthropic.APIError) throw fail(`Claude API error ${err.status ?? ''}: ${err.message}`, 502);
    throw fail(`Couldn't reach Claude: ${err.message}`, 502);
  }
  if (response.stop_reason === 'refusal') {
    throw fail(`Claude declined to answer${response.stop_details?.explanation ? `: ${response.stop_details.explanation}` : '.'}`, 422);
  }
  const answer = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  return {
    advisor: 'claude',
    model: response.model || model,
    answer: answer || '(no answer)',
    usage: { input: response.usage?.input_tokens || 0, output: response.usage?.output_tokens || 0 },
  };
}

async function askCopilot(question) {
  const token = await githubToken();
  if (!token) throw fail('Connect GitHub in the Workspace to ask Copilot (GitHub Models).', 409);
  const model = settings.copilotModel || DEFAULTS.copilotModel;
  const r = await fetch(GITHUB_MODELS_URL(), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: ADVISOR_SYSTEM }, { role: 'user', content: question }] }),
    signal: AbortSignal.timeout(120000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data.error?.message || data.message || r.statusText;
    if (r.status === 401 || r.status === 403) throw fail(`GitHub Models refused the request (${msg}). Your token needs the "Models: read" permission.`, 401);
    if (r.status === 429) throw fail('GitHub Models rate limit reached. Try again later.', 429);
    throw fail(`GitHub Models error ${r.status}: ${msg}`, 502);
  }
  return {
    advisor: 'copilot',
    model: data.model || model,
    answer: data.choices?.[0]?.message?.content?.trim() || '(no answer)',
    usage: { input: data.usage?.prompt_tokens || 0, output: data.usage?.completion_tokens || 0 },
  };
}

export async function ask({ advisor, question }) {
  await load();
  question = String(question || '').trim();
  if (!question) throw fail('Empty question.');
  if (question.length > 16000) throw fail('That question is too long for an advisor. Keep it focused.', 413);
  if (advisor === 'claude') return askClaude(question);
  if (advisor === 'copilot') return askCopilot(question);
  throw fail('Unknown advisor.');
}

export function _reset() { settings = null; }
