# Edean

Edean is a private chat app for your own coding AI. It works like Venice: you get a clean chat interface, and your conversations stay private. The difference is that Edean is tuned for one thing, writing code. It runs against a model you host yourself, so your code never goes to a third-party AI company.

- **Private by design.** Conversations are stored only in your browser's local storage, and the server keeps nothing. It binds to `localhost` by default and loads no CDNs, trackers or analytics. You can set an optional password.
- **Coding-focused.** A tuned system prompt comes with six modes: **Build · Debug · Explain · Review · Refactor · Tests**.
- **Built for code.** Syntax highlighting, one-click **Copy** and **Download** on every code block (the file name comes from the path comment), and code-file attachments by clicking or drag-and-drop.
- **Works with any local model server** that has an OpenAI-compatible API, such as Ollama, LM Studio, llama.cpp or vLLM.
- **Handles "thinking" models.** Output inside `<think>` tags and reasoning fields (Qwen3, DeepSeek-R1) is shown in a collapsible "Reasoning" section.
- Streaming responses, a Stop button, Regenerate, message editing, chat search, export and delete, and light and dark themes. The layout also works on mobile.

## Quick start with Ollama

1. Install [Ollama](https://ollama.com) and pull a coding model:

   ```bash
   ollama pull qwen2.5-coder:7b
   ```

2. Run Edean (requires Node.js 20 or newer):

   ```bash
   npm install
   npm start
   ```

3. Open <http://localhost:3000>.

## Or run everything with Docker

```bash
docker compose up -d
docker compose exec ollama ollama pull qwen2.5-coder:7b
```

Then open <http://localhost:3000>. To use an NVIDIA GPU, uncomment the `deploy` block in `docker-compose.yml`.

## Which model should I use?

Choose by how much memory your GPU has (VRAM), or your RAM if you don't have a GPU:

| Your hardware         | Suggested model (Ollama tag)              |
|-----------------------|-------------------------------------------|
| 8 GB / laptop         | `qwen2.5-coder:7b`                        |
| 16–24 GB              | `qwen2.5-coder:14b`, `deepseek-coder-v2:16b` |
| 24–48 GB              | `qwen2.5-coder:32b`, `qwen3-coder:30b`, `codestral` |
| Autocomplete-sized    | `qwen2.5-coder:1.5b`                      |

Every model you have pulled appears in the model menu at the top of the app. Newer coding models come out regularly, so check the Ollama library for the latest ones.

## Configuration

Copy `.env.example` to `.env` and adjust the settings, or pass them as environment variables:

| Variable        | Default                       | Purpose |
|-----------------|-------------------------------|---------|
| `LLM_BASE_URL`  | `http://127.0.0.1:11434/v1`   | OpenAI-compatible API of your model server |
| `LLM_API_KEY`   | *(empty)*                     | Only needed if your backend requires one |
| `DEFAULT_MODEL` | `qwen2.5-coder:7b`            | Model selected on first launch |
| `PORT`          | `3000`                        | |
| `HOST`          | `127.0.0.1`                   | Use `0.0.0.0` to reach Edean from other devices |
| `APP_PASSWORD`  | *(empty)*                     | Turns on a login prompt (any username). **Set this before exposing Edean on a network.** |

Node reads these variables from the environment. For example: `LLM_BASE_URL=http://127.0.0.1:1234/v1 npm start` to use LM Studio.

The system prompt, temperature, maximum output tokens and theme can be changed in **Settings** inside the app. These settings are stored per browser.

## How privacy works

```
Browser (chats in localStorage) ──► Edean server (relay, no logs) ──► your model server
```

The Edean server only relays each request to your model and streams the reply back. It does not save or log prompts or responses. All chat history lives in your browser. Clearing site data, or using **Settings → Delete all chats**, removes it. **Export all chats** saves your chats as a JSON backup.

## Project layout

```
server.js           Node server: static files + /api/models + /api/chat relay
public/index.html   App shell
public/app.js       Chat UI, streaming, storage, markdown + code rendering
public/prompts.js   Coding system prompt, modes and starter prompts
public/styles.css   Styles (light/dark)
test/               Server tests (npm test)
```

## Development

```bash
npm run dev   # restarts on file changes
npm test
```
