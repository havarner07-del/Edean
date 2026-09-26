# Edean

Edean is a private chat app for your own coding AI. It works like Venice: you get a clean chat interface, and your conversations stay private. The difference is that Edean is tuned for one thing, writing code. It runs against a model you host yourself, so your code never goes to a third-party AI company.

- **Private by design.** Conversations are stored only in your browser's local storage, and the server keeps nothing. It binds to `localhost` by default and loads no CDNs, trackers or analytics. You can set an optional password.
- **Coding-focused.** A tuned system prompt comes with six modes: **Build · Debug · Explain · Review · Refactor · Tests**.
- **Built for code.** Syntax highlighting, one-click **Copy** and **Download** on every code block (the file name comes from the path comment), and code-file attachments by clicking or drag-and-drop.
- **Built-in compiler.** Write and run **Python, JavaScript, TypeScript, Java, C, C++, Go, Rust, Ruby, PHP and Bash**, then press **Advice**. Your model reviews the code, including the output or error from your last run, and writes its notes on a **Notepad** beside the editor.
- **Works with any local model server** that has an OpenAI-compatible API, such as Ollama, LM Studio, llama.cpp or vLLM.
- **Handles "thinking" models.** Output inside `<think>` tags and reasoning fields (Qwen3, DeepSeek-R1) is shown in a collapsible "Reasoning" section.
- **Login screen.** A password protects the app. It starts as `0000`; change it in **Settings → Password**.
- **Agent.** Tell it what you want and it does the work itself. It first asks **Claude how to do it**, then follows that plan: it opens **your own code in a folder on your computer** (or a GitHub repository, or creates a new one), writes and edits the files, runs them, fixes what breaks, and commits. Claude can also **review the finished changes**, and every task can be **undone** with one click. It asks before running commands or pushing, unless you let it work on its own.
- **Workspace (VS Code-style).** Open your GitHub repositories and edit them in Monaco, the editor inside VS Code. You get an Explorer, tabs, Save / Save All, a diff view, Source Control (commit & push), branches, pull requests, dependencies, Run/Output, a command palette, a blue status bar, and an AI panel that proposes changes you can apply. Point it at Edean's own repository and it can improve itself through branches and pull requests.
- **Advisors: Claude & Copilot.** When the local model is unsure, it asks Claude or GitHub Models one short question instead of guessing, then finishes its answer. This keeps paid usage to a few hundred tokens instead of whole conversations.
- **Save chats to Google Drive.** Connect your Google account and pick a folder. Chats are then saved there as files instead of on your computer.
- **Desktop executable with a System Check.** Double-click Edean to start it. It shows a green or red light for everything it needs (the AI engine, a coding model, each compiler), and an **Install all missing** button that sets up whatever is missing.
- A dark-blue HUD theme, plus streaming responses, a Stop button, Regenerate, message editing, chat search, and chat export and delete. The layout also works on mobile.

## Quick start: double-click Edean.exe

1. **Get `Edean.exe`.** Open this repository's [**Releases → Edean (latest build)**](../../releases/tag/edean-latest) and download **Edean.exe**. It's built automatically on every push, and there are also `Edean-macos` and `edean-linux` versions.
2. **Double-click it.** Edean opens in its own app window. There's no browser tab, address bar or console window, and it has its own icon in the taskbar.
3. **Sign in** with the password `0000`, then change it in **Settings → Password**.
4. The **Systems check** panel opens if anything is missing:
   - 🟢 means ready and 🔴 means missing.
   - **Install all missing** installs the AI engine (Ollama), downloads a coding model and sets up the compilers. The model download is several GB.

A few things to know:
- **Quitting:** close the Edean window, or use **Settings → Quit Edean**. Double-clicking `Edean.exe` while it's already running just opens another window.
- **The window:** it's Microsoft Edge (built into Windows) or Google Chrome running in *app mode*, with a separate profile just for Edean. If neither is installed, Edean opens in your default browser instead, and quits after it has been closed for 15 minutes.
- **The first launch:** Windows SmartScreen may say "Windows protected your PC", because the app isn't code-signed. Click **More info → Run anyway**.
- **Settings:** put an `edean.env` file next to `Edean.exe` (start from `edean.env.example`).
- **Problems:** check `%USERPROFILE%\.edean\edean.log`. Startup errors are also shown in a message box.

**Updating:** open **Settings → Updates** and click **Check for updates**. Edean also checks quietly when it starts, and shows a green dot on Settings when there's something new.

Click **Update now** and Edean:
1. downloads the newest build for your computer from the repository's "Edean (latest build)" release,
2. verifies it (size and SHA-256 checksum),
3. swaps it in for the running program and restarts,
4. reloads your window into the new version. You stay signed in.

If the repository is **private**, connect GitHub in the Workspace first (the token needs *Contents: read*), so Edean can see the releases.

When running from source, the same button runs `git pull` (and `npm install` if dependencies changed) and restarts. In Docker, use `docker compose pull && docker compose up -d --build`.

**Build it yourself** (needs Node.js 22+): `npm install`, then either
- `npm run build:exe` for your own computer, or
- `npm run build:exe:win` to build `dist/Edean.exe` from any OS. This downloads the official Node.js for Windows and verifies it against its checksum.

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

## Signing in

Edean opens on a login screen:
- The password starts as **`0000`**. Change it in **Settings → Password**. It's stored as a salted hash in `~/.edean/auth.json`.
- You can also set `APP_PASSWORD` in your settings file to fix the password there.
- Sessions last 30 days. **Sign out** is in Settings.
- Repeated wrong passwords are slowed down.
- If Edean is reachable from your network while still using `0000`, the code runner, installer, GitHub access and advisors switch themselves off until you pick your own password.

## Agent: tell it what to build

Open the **Agent** tab and describe what you want, for example *"Create a Python app that tracks my expenses in a CSV, with tests, in a new private repo called expense-tracker"*. The agent then works like a developer at a terminal:

1. It **asks Claude how to do the job** (see *Plan with Claude* below) and follows that plan.
2. It opens **a folder on your computer**, an existing repository, or **creates a new one** on GitHub.
3. It looks around (lists, reads and searches files), then **writes and edits files**.
4. It **runs** the program or its tests, reads the output, and fixes problems until it works.
5. If **Claude reviews** is on, Claude checks the changes and the agent fixes anything Claude finds.
6. It **commits and pushes**. On existing repositories it works on a new branch and **opens a pull request**. In a folder on your computer it only commits when you ask.
7. It finishes with a summary: what it did and how to run it.

### Working on your own code

Click **Open folder…** in the Agent bar and pick the folder of your project (for example `C:\Users\you\code\my-app`), or just tell the agent *"open C:\Users\you\code\my-app and …"*. The agent then reads and edits the files **directly in that folder**:
- If the folder is a git repository, it can create a branch, commit with your own git (and your name), push if the folder has a remote, and open a pull request if that remote is on GitHub.
- If it isn't a git repository, the files are simply changed in place.
- **Undo.** Before the agent first changes a file in a task, Edean saves a copy in `~/.edean/backups`. When the task finishes, **Undo these changes** puts every file it wrote, edited or deleted back the way it was (the last 20 tasks are kept). Changes made by commands it ran, such as installed packages, aren't undone.
- **Show folder** opens the folder in Explorer / Finder.
- For safety it won't open a whole drive, your whole home folder, system folders, or Edean's own data folder.

### Plan with Claude

With **Plan with Claude** ticked (the default), the agent doesn't start by guessing. It first sends Claude your instruction plus a compact picture of the project (the file list, the README and manifest files, and files your instruction mentions), and asks **how** to do it. Claude answers with an approach, the exact steps (which files to create or change and what goes in them), how to verify it, and pitfalls. The plan appears as **Claude's plan** in the log, and the local model then writes all the code itself, following it step by step.

With **Claude reviews** ticked, when the agent thinks it's finished, Claude gets the diff of its changes. If Claude replies that it looks good, you're done; otherwise the agent gets Claude's list of problems and fixes them before its final summary.

This way Claude does the thinking once, in a few thousand tokens, and your free local model does the long work of writing, running and fixing. Planning uses Claude when an Anthropic API key is set, otherwise Copilot (GitHub Models); without either, the agent simply works without a plan. Untick the boxes to skip either step.

Every step shows up in the log. Click a step to see the file it wrote, the edit it made (in red and green), or the command output.

You're in control:
- **Approvals.** By default the agent asks before it **runs a command, creates a repository, pushes, or opens a pull request**. Choose **Allow**, **Allow all for this task**, or **Deny**. If you deny, it's told and works around it.
- **Work on its own.** Tick this to let it do everything without asking.
- **Stop** ends the current task at any time.
- **New session** clears the conversation. The work stays in the project.

More details:
- **Where the work happens.** A GitHub project is a folder in `~/.edean/projects/<owner>/<repo>`, downloaded from GitHub. Its commits go back through the GitHub API, so git doesn't need to be installed. A folder you opened is edited in place.
- **Without GitHub.** If GitHub isn't connected, the agent can still build a project in a local-only folder.
- **Reviewing the work.** **Open in Workspace** shows the project in the VS Code-style editor.
- **Getting help.** If an advisor is set up, the agent can ask Claude or Copilot a short question when it's stuck.

**Which model?** The agent works best with models that support *tool calling*. `qwen2.5-coder` and `qwen3-coder` do, as do most recent coding models in Ollama. Models without tool calling still work through a simpler text format, but less reliably.

The agent also needs more working memory than chat. When Edean starts Ollama itself, it sets `OLLAMA_CONTEXT_LENGTH=32768`. If you run Ollama yourself, set that variable too. Bigger models (14B–32B) plan and fix things much better than 7B ones.

## Workspace: your repositories, VS Code-style

Open the **Workspace** tab.

1. **Connect GitHub.** Create a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) for the repositories you want to use, with these permissions:
   - Contents: read & write
   - Pull requests: read & write
   - Models: read (only needed for the Copilot advisor)

   Paste it into the Workspace. It's kept in `~/.edean/github.json` (readable only by you), and the browser never sees it.
2. **Open a repository** from the list.

What works like VS Code:

| Feature | How |
|---|---|
| Explorer | Folders, new file (＋), rename ✎, delete 🗑. Modified files are shown in yellow (M), new files in green (U). |
| Editor | Monaco (the VS Code editor): syntax highlighting, IntelliSense for JS/TS, find/replace (<kbd>Ctrl</kbd>+<kbd>F</kbd>), minimap, multi-cursor |
| Save | <kbd>Ctrl</kbd>+<kbd>S</kbd>, or **Save** (a ● on the tab means unsaved). Saved changes are kept in this browser, per repository and branch, until you commit. |
| Source Control | Lists your changes. Click one for a side-by-side diff, ↺ discards it, and **Commit & Push** makes one commit on GitHub (<kbd>Ctrl</kbd>+<kbd>Enter</kbd> in the message box) |
| Branches | Switch branch, or create one with ＋ (your uncommitted changes come along, like `git switch -c`) |
| Pull requests | Open a PR from the current branch into the default branch, and see open PRs |
| Dependencies | From GitHub's dependency graph, or from `package.json`, `requirements.txt`, `go.mod` or `Cargo.toml` |
| Run | <kbd>F5</kbd> runs the current file with the built-in runner. Output appears in the panel, with an input box for stdin. |
| Export | Download the current file, download the branch as a `.zip`, or send the file to the Compiler tab |
| Command palette | <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>P</kbd> for all commands, and <kbd>Ctrl</kbd>+<kbd>P</kbd> to go to a file |

**Edean AI panel (right side):**
- Ask about the repository, or ask for a change. It sees the file list and the open file.
- Each file it proposes gets an **Apply to …** button. Applying adds the file to your changes and opens a diff, so you review it before committing.
- To have Edean **improve itself**, open Edean's own repository and create a branch, for example `edean/better-search`.
- Then ask for the change, apply it, commit, and open a pull request. You stay in control of what gets merged.

## Advisors: Claude and Copilot

Your local model does most of the work for free. When it isn't confident about something specific, it can pause and write `ASK(claude): …` or `ASK(copilot): …`:
- Edean sends only that one short question to the advisor.
- It shows the exchange as a collapsible **Asked Claude · 51 tokens** note.
- It hands the answer back to the local model, which finishes the reply.

This spends a small number of paid tokens on exactly the part it was stuck on, instead of sending the whole conversation to a paid model. Each assistant reply also has **Ask Claude** / **Ask Copilot** buttons for a second opinion.

| Advisor | Uses | Setup |
|---|---|---|
| **Claude** | Anthropic's API through the official `@anthropic-ai/sdk`. The default model is `claude-opus-5`, with adaptive thinking. | Paste your [Anthropic API key](https://console.anthropic.com/settings/keys) in **Settings → Advisors** (or set `ANTHROPIC_API_KEY`). |
| **Copilot** | [GitHub Models](https://github.com/marketplace/models), GitHub's AI inference API (default model `openai/gpt-4.1`). GitHub Copilot itself has no public API for other apps, so this is GitHub's supported way to call AI models with your GitHub account. | Connect GitHub in the Workspace with a token that has the **Models: read** permission. |

More on the Claude settings:
- For Claude requests, Edean turns on the API's server-side **fallback** (`fallbacks: "default"`). If Claude declines a request for safety reasons, the API retries it on a fallback model within the same call, instead of failing.
- You can change either advisor's model, or turn automatic asking off, in **Settings → Advisors**.

## Saving chats to Google Drive

By default, chats are saved only in your browser. To keep them in your own Google Drive instead, click **Saved in this browser** at the bottom of the sidebar (or open **Settings → Chat storage**) and follow the steps:

1. **One-time Google setup (about 5 minutes).** Google requires every app that uses Drive to have an OAuth client, and this one belongs to you:
   - Create a project in the [Google Cloud Console](https://console.cloud.google.com/projectcreate).
   - Turn on the **Google Drive API** for it.
   - In **Google Auth Platform**, choose **External** and add your Google address as a **test user**.
   - Create a client of type **Desktop app**, then paste its Client ID and secret into Edean. They're stored only on your computer.
2. **Sign in with Google.** Google warns that the app "hasn't been verified". That's expected for your own private app, so click **Continue**.
3. **Pick a folder.** Name a new folder (default "Edean Chats"), or reuse one Edean made before.

After that:
- Each chat is saved to that folder as a `.json` file named like `2026-09-26 My chat title.json`, which you can download from Drive.
- Changes save automatically a second or two after each message. The sidebar shows **All chats saved**, **Saving…** or **Not saved — retrying**.
- Deleted chats go to Drive's trash.
- If you already had chats in the browser, Edean offers to move them to Drive and then removes them from this computer.
- Only chats go to Drive. Your settings, compiler code and notepad notes stay in the browser.

**Privacy:**
- Edean asks only for the `drive.file` permission, so it can see and change only the files and folders it created, nothing else in your Drive. (That's also why you can reuse only folders Edean made. You can still move or rename that folder in Drive afterwards.)
- The sign-in token is kept in `~/.edean/google-drive.json`, readable only by your user account. Your browser never receives it.
- **Disconnect** revokes Edean's access. Your chats stay in the Drive folder.

While your Google app is in "Testing" mode, Google expires the sign-in after 7 days. Edean then asks you to sign in again, and your chats remain safe in Drive. To avoid this, click **Publish app** on the Google Auth Platform **Audience** page. For a personal app, Google doesn't require a review.

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

The runner turns itself off if Edean is reachable from your network while still using the default password. Set `CODE_RUNNER=off` to disable it entirely.

## Configuration

Copy `.env.example` to `.env` and adjust the settings, or pass them as environment variables:

| Variable        | Default                       | Purpose |
|-----------------|-------------------------------|---------|
| `LLM_BASE_URL`  | `http://127.0.0.1:11434/v1`   | OpenAI-compatible API of your model server |
| `LLM_API_KEY`   | *(empty)*                     | Only needed if your backend requires one |
| `DEFAULT_MODEL` | `qwen2.5-coder:7b`            | Model selected on first launch |
| `PORT`          | `3000`                        | |
| `HOST`          | `127.0.0.1`                   | Use `0.0.0.0` to reach Edean from other devices |
| `CODE_RUNNER`   | `auto`                        | `auto`: the runner is on unless Edean is reachable from the network without a password. `on` or `off` force it either way |
| `RUN_TIMEOUT_MS` | `10000`                      | Time limit for each program run (`COMPILE_TIMEOUT_MS` defaults to 30000) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | *(empty)* | Your Google OAuth client for Drive storage (or paste them in the app) |
| `EDEAN_DATA_DIR` | `~/.edean`                   | Where Edean keeps its settings: password hash, Google Drive and GitHub connections, advisor keys |
| `APP_PASSWORD`  | *(empty → `0000` until you change it)* | Fixes the login password |
| `ANTHROPIC_API_KEY` | *(empty)*                 | Claude advisor key (or paste it in Settings) |
| `EDEAN_GITHUB_TOKEN` | *(empty)*                | GitHub token for the Workspace (or paste it in the app) |

The executable reads these from `edean.env` next to it. When running from source, Edean reads them from `.env`.

Environment variables work too. For example, `LLM_BASE_URL=http://127.0.0.1:1234/v1 npm start` uses LM Studio.

The system prompt, temperature, maximum output tokens and theme can be changed in **Settings** inside the app. These settings are stored per browser.

## How privacy works

```
Browser (chats in localStorage) ──► Edean server (relay, no logs) ──► your model server
                                          │
                                          └─► code runner (temp folder, deleted after each run)
```

The Edean server only relays each request to your model and streams the reply back. It does not save or log prompts, responses, or the code you run. If you connect Google Drive, chats go straight from Edean to your own Drive folder and are not stored on this computer. All chat history lives in your browser. Clearing site data, or using **Settings → Delete all chats**, removes it. **Export all chats** saves your chats as a JSON backup.

## Project layout

```
launcher.js         What the executable runs: loads settings, starts the AI engine and the server, opens the browser
server.js           Node server: static files, /api/models, /api/chat relay, /api/run, /api/setup
runner.js           Compiles and runs programs with time and output limits
toolchains.js       Detects Ollama and the compilers (runs them, so broken stubs don't count)
auth.js             Login screen, sessions, password changes
github.js           GitHub API for the Workspace (repos, branches, files, commits, PRs, dependencies)
advisors.js         Claude (Anthropic SDK) and Copilot (GitHub Models) advisors
updater.js          In-app updates (release download + swap + restart, or git pull)
agent.js            Coding agent: plan with Claude, tools (repos, folders, files, commands, commit/push, PRs), approvals, review, undo
drive.js            Google Drive chat storage (OAuth sign-in, folder, save/load/delete chats)
setup.js            System check + one-click installer (winget / Homebrew / apt / dnf / pacman, model download)
scripts/build-exe.mjs  Packs everything into one executable (Node single-executable app)
public/index.html   App shell
public/app.js       Chat view, settings, view switching
public/compiler.js  Compiler tab: editor, Run, Advice and the Notepad
public/systems.js   Systems check panel
public/drive.js     Chat storage / Google Drive panel
public/agent-ui.js  Agent tab: instructions, step log, approvals, plans and reviews, folder picker, undo
public/workspace.js VS Code-style Workspace (Monaco editor, explorer, source control, AI panel)
public/lib.js       Shared helpers: markdown and code rendering, streaming, storage
public/prompts.js   System prompt, modes, advice prompt, starter programs
public/styles.css   HUD theme (dark blue) and light theme
```

## Development

```bash
npm run dev   # restarts on file changes
npm test
```
