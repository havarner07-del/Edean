# Edean

Edean is a private chat app for your own coding AI. It works like Venice: you get a clean chat interface, and your conversations stay private. The difference is that Edean is tuned for one thing, writing code. It runs against a model you host yourself, so your code never goes to a third-party AI company.

- **Private by design.** Conversations are stored only in your browser's local storage, and the server keeps nothing. It binds to `localhost` by default and loads no CDNs, trackers or analytics. You can set an optional password.
- **Coding-focused.** A tuned system prompt comes with six modes: **Build · Debug · Explain · Review · Refactor · Tests**.
- **Built for code.** Syntax highlighting, one-click **Copy** and **Download** on every code block (the file name comes from the path comment), and code-file attachments by clicking or drag-and-drop.
- **Built-in compiler.** Write and run **Python, JavaScript, TypeScript, Java, C, C++, Go, Rust, Ruby, PHP and Bash**, then press **Advice**. Your model reviews the code, including the output or error from your last run, and writes its notes on a **Notepad** beside the editor.
- **Works with any local model server** that has an OpenAI-compatible API, such as Ollama, LM Studio, llama.cpp or vLLM.
- **Handles "thinking" models.** Output inside `<think>` tags and reasoning fields (Qwen3, DeepSeek-R1) is shown in a collapsible "Reasoning" section.
- **Desktop executable with a System Check.** Double-click Edean to start it. It shows a green or red light for everything it needs (the AI engine, a coding model, each compiler), and an **Install all missing** button that sets up whatever is missing.
- A dark-blue HUD theme, plus streaming responses, a Stop button, Regenerate, message editing, chat search, and chat export and delete. The layout also works on mobile.

## Quick start: the Edean app

1. Get the executable for your computer:
   - **Download it:** open this repo's **Actions** tab, open the latest **Build executables** run, and download `Edean-windows`, `Edean-macos` or `Edean-linux` from **Artifacts**. You can also run the workflow yourself with **Run workflow**.
   - **Or build it yourself** (needs Node.js 22+): `npm install && npm run build:exe` creates `dist/Edean.exe` on Windows, `dist/Edean` on macOS or `dist/edean` on Linux.
2. Double-click it. A small window opens (keep it open while you use Edean), and Edean opens in your browser.
3. The **Systems check** panel opens automatically if anything is missing:
   - 🟢 means ready and 🔴 means missing.
   - Click **Install all missing** to install everything, or click **Install** on a single row. Progress appears live in the panel.
   - The first run downloads the AI engine (Ollama) and a coding model, which is several GB.
   - You can open the panel again at any time from **System check** at the bottom of the sidebar.

How the installer works on each system:

| System  | Uses | Notes |
|---------|------|-------|
| Windows | `winget` (built into Windows 10/11) | Installers may show a Windows permission prompt (UAC). |
| macOS   | [Homebrew](https://brew.sh) | Install Homebrew first if you don't have it. C and C++ come from Apple's Command Line Tools, which have their own installer window. |
| Linux   | `apt`, `dnf` or `pacman` | Needs admin rights. Edean uses passwordless `sudo` or a graphical `pkexec` prompt when it can. Otherwise it shows you the exact command to run. |

To change settings in the executable, put an `edean.env` file next to it. `edean.env.example` ships alongside the executable.

The executables aren't code-signed. The first time you open one, Windows SmartScreen may say "Windows protected your PC" (click **More info → Run anyway**), and macOS may block it (right-click it → **Open**).

## Run from source

Requires Node.js 22 or newer.

```bash
npm install
npm start          # starts Edean and opens your browser (same as the executable)
```

You can also double-click **Start Edean.bat** (Windows) or **Start Edean.command** (macOS/Linux). `npm run serve` starts only the server, without opening a browser.

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

## The Compiler tab

Switch to **Compiler** at the top of the app.

1. Pick a language, write code in the editor, and put any program input in the **Input** tab (stdin).
2. Press **Run** (<kbd>Ctrl</kbd>+<kbd>Enter</kbd>). Output, errors, the exit code and the run time appear in **Output**.
3. Press **Advice** (<kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>Enter</kbd>). Your model gets the code, the input and the result of your last run, and writes a short note on the **Notepad**. It points out bugs, explains errors and suggests improvements. You can type a specific question above the notes first.
4. When a note includes a corrected program, click **Use in editor** to load it, then run it again. <kbd>Ctrl</kbd>+<kbd>Z</kbd> undoes the replacement.

Code blocks in chat replies have an **Open in compiler** button too.

The editor has syntax highlighting, line numbers, Tab and Shift+Tab indenting, and auto-indent. Press <kbd>Esc</kbd> and then <kbd>Tab</kbd> to move focus out of the editor. Your code for each language, your input and your notes are all saved in your browser.

### Which languages can run

Programs run on the machine that runs Edean, using the toolchains installed there:

| Language   | Needs      | Language | Needs            |
|------------|------------|----------|------------------|
| Python     | `python3`  | Go       | `go`             |
| JavaScript | *(Node.js)* | Rust    | `rustc`          |
| TypeScript | Node.js ≥ 22.6 | Ruby  | `ruby`           |
| Java       | `java` (JDK 11+) | PHP | `php`            |
| C / C++    | `gcc` / `g++` | Bash  | `bash`           |

Languages that aren't installed show as "(not installed)". You can still use **Advice** with them. The Docker image includes all of them.

### Safety

Code runs as your user, with a fresh temporary folder for each run, a time limit (10 s by default; 20 s for Java), an output cap, and at most 2 runs at once. Everything the program started is killed when it finishes. Programs don't receive environment variables that look like secrets, such as `LLM_API_KEY` or `APP_PASSWORD`. **Programs are not otherwise sandboxed.** For real isolation, run Edean with Docker. The compose file also limits memory and process counts.

The runner turns itself off if Edean is reachable from your network without `APP_PASSWORD`. Set `CODE_RUNNER=off` to disable it entirely.

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
| `CODE_RUNNER`   | `auto`                        | `auto`: the runner is on unless Edean is reachable from the network without a password. `on` or `off` force it either way |
| `RUN_TIMEOUT_MS` | `10000`                      | Time limit for each program run (`COMPILE_TIMEOUT_MS` defaults to 30000) |

The executable reads these from `edean.env` next to it. When running from source, Edean reads them from `.env`.

Environment variables work too. For example, `LLM_BASE_URL=http://127.0.0.1:1234/v1 npm start` uses LM Studio.

The system prompt, temperature, maximum output tokens and theme can be changed in **Settings** inside the app. These settings are stored per browser.

## How privacy works

```
Browser (chats in localStorage) ──► Edean server (relay, no logs) ──► your model server
                                          │
                                          └─► code runner (temp folder, deleted after each run)
```

The Edean server only relays each request to your model and streams the reply back. It does not save or log prompts, responses, or the code you run. All chat history lives in your browser. Clearing site data, or using **Settings → Delete all chats**, removes it. **Export all chats** saves your chats as a JSON backup.

## Project layout

```
launcher.js         What the executable runs: loads settings, starts the AI engine and the server, opens the browser
server.js           Node server: static files, /api/models, /api/chat relay, /api/run, /api/setup
runner.js           Compiles and runs programs with time and output limits
toolchains.js       Detects Ollama and the compilers (runs them, so broken stubs don't count)
setup.js            System check + one-click installer (winget / Homebrew / apt / dnf / pacman, model download)
scripts/build-exe.mjs  Packs everything into one executable (Node single-executable app)
public/index.html   App shell
public/app.js       Chat view, settings, view switching
public/compiler.js  Compiler tab: editor, Run, Advice and the Notepad
public/systems.js   Systems check panel
public/lib.js       Shared helpers: markdown and code rendering, streaming, storage
public/prompts.js   System prompt, modes, advice prompt, starter programs
public/styles.css   HUD theme (dark blue) and light theme
```

## Development

```bash
npm run dev   # restarts on file changes
npm test
```
