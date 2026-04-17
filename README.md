<p align="center">
  <img src="docs/banner.svg" alt="Murmur — voice-first prompt engineering for vibe coders" width="100%"/>
</p>

<p align="center">
  <a href="https://github.com/mouadja02/murmur/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/mouadja02/murmur/actions/workflows/ci.yml/badge.svg"/></a>
  <a href="https://github.com/mouadja02/murmur/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/mouadja02/murmur?include_prereleases&sort=semver"/></a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-Windows%2010%2B-0078D6"/>
  <img alt="Node" src="https://img.shields.io/badge/node-20%2B-339933"/>
  <img alt="License" src="https://img.shields.io/badge/license-unlicensed-lightgrey"/>
</p>

---

## What is Murmur?

Murmur is a tiny floating button that sits on top of your desktop. You **tap it and talk**, and a few seconds later a clean, structured prompt appears exactly where your cursor is — in Cursor, ChatGPT, a terminal, a GitHub issue, anywhere.

Under the hood, your voice is transcribed **on your own machine** (with `whisper.cpp`), then rewritten into a high-quality prompt by **your own local LLM** (Ollama, LM Studio, llama.cpp server — your choice). Nothing ever leaves your computer.

Think of it as:

> "I know what I want, I just don't want to type it."

---

## See it in 30 seconds

1. **A small pill floats on your desktop.** Always on top. Drag it anywhere.
2. **Click it (or hold `Ctrl+Shift+Space`) and talk.** A soundbar reacts while you speak.
3. **Release.** The pill walks through *recording → transcribing → refining → injecting → done*.
4. **The refined prompt appears at your cursor.** Your original clipboard is restored a moment later.

You stay in flow. No context switch. No "open app, paste, reformat, paste again."

---

## Get started

You need **Windows 10/11**, **Node.js 20+**, **pnpm**, a working microphone, and a local LLM server running somewhere (see the table further down if you're not sure which).

```powershell
git clone https://github.com/mouadja02/murmur.git
cd murmur
pnpm install
pnpm setup:whisper   # downloads whisper-cli.exe + ggml-base.en.bin (~150 MB)
pnpm dev
```

That's it. The first run creates `%APPDATA%\murmur\config.json` with sensible defaults and prints a banner in the terminal. Grab the **control panel URL** it shows (default `http://localhost:7331`) to tweak things in a browser without touching JSON.

> If you don't have a local LLM yet, the fastest path is:
> ```powershell
> # Install Ollama from https://ollama.com, then:
> ollama pull qwen3:4b
> ```
> Murmur targets `qwen3:4b` on Ollama by default.

---

## How it works

<p align="center">
  <img src="docs/architecture.svg" alt="Murmur architecture diagram" width="100%"/>
</p>

Four stages, strictly local:

| Stage | What happens |
| --- | --- |
| **Capture** | The overlay records 16 kHz mono PCM while you hold the hotkey (or between two clicks). |
| **Transcribe** | `whisper.cpp` turns the WAV into text on your CPU. |
| **Refine** | Your local LLM rewrites the transcription into a structured prompt using your active system prompt + enabled skills. |
| **Inject** | Murmur copies the refined text, fires `Ctrl+V` at your current cursor, then restores whatever was on your clipboard before. |

Every session gets a timestamped folder under `logs/` with the WAV, the raw transcription, the exact prompt sent to the LLM, and the refined output — so you can debug anything after the fact.

---

## Features at a glance

- **One-click or push-to-talk** — click the pill, or hold `Ctrl+Shift+Space`.
- **Drag anywhere** — pill position is saved and survives restart.
- **Toggle hotkey** — `Ctrl+Shift+H` hides / shows the overlay from any app.
- **Right-click menu** — open the control panel, reset position, quit.
- **Control panel on localhost** — browser-based UI for system prompt, skills, provider, hotkeys, and paths. Changes hot-reload without restarting.
- **Skills as Markdown** — drop `.md` files into `./skills/`, toggle them on/off from the panel. Version-controllable, shareable.
- **Terminal pre-launch banner** — every `pnpm dev` shows your current setup and offers a one-key menu to edit the prompt or jump to the panel.
- **Provider agnostic** — Ollama native API, any OpenAI-compatible server (LM Studio, llama.cpp server, vLLM, Jan, KoboldCpp, oobabooga, …).
- **100 % local** — no telemetry, no outbound network calls except to the LLM server you configured.
- **Session logs** — every run writes audio + timings + prompts to `logs/<timestamp>/` for full traceability.

---

## The control panel

Open it from the overlay (right-click → **Open control panel**), from the pre-launch terminal menu, or by pasting `http://localhost:7331` into your browser.

| Tab | What you can do |
| --- | --- |
| **System prompt** | Live-edit the active prompt and see the composed preview (base + enabled skills). |
| **Skills** | Add, edit, rename, delete skills. One click to enable/disable each. |
| **Provider** | Switch provider, base URL, model, API key. One-click presets for Ollama / LM Studio / llama.cpp. **Test connection** button reports latency. |
| **Whisper** | Point to a different `whisper-cli.exe` or `.bin` model. |
| **Hotkeys** | Bind push-to-talk and toggle combos with live validation. |
| **Paths** | Logs dir, skills dir, and the resolved config file path. |

Every save writes back to `%APPDATA%\murmur\config.json` atomically and hot-reloads in the running app — no restart needed.

---

## Skills

Skills are small Markdown files that layer onto your base system prompt when enabled. Perfect for *"always talk like a senior Go reviewer"*, *"bias toward concise output"*, or project-specific vocabulary.

Each skill lives at `skills/<id>.md`:

```markdown
---
id: concise-output
name: Concise output
description: Trim filler, keep the prompt to the point.
---

Prefer terse, structured prompts. Use bullets for constraints.
No hedging, no apologies, no restating the question.
```

You can author them in your editor (they're git-friendly) or in the control panel's **Skills** tab. Enabled skills are concatenated under an `## Active skills` header in the prompt sent to the LLM.

---

## LLM providers

Pick one. The `openai-compat` provider covers practically every local server that speaks the OpenAI chat-completions dialect.

| Provider | `--provider` | Default base URL | Known-good servers |
| --- | --- | --- | --- |
| **Ollama (native)** | `ollama` | `http://localhost:11434` | Ollama. Uses `/api/generate` with `think:false`. |
| **OpenAI-compatible** | `openai-compat` | `http://localhost:1234/v1` | LM Studio, llama.cpp server, vLLM, Jan, KoboldCpp, oobabooga, Ollama's own `/v1` endpoint. |

> `openai-compat` expects the **full** base URL including `/v1` — Murmur will not append it for you.

### Quick recipes

```powershell
# Ollama (default)
ollama pull qwen3:4b
pnpm dev

# LM Studio — load a model, click "Start Server"
pnpm dev --provider openai-compat --base-url http://localhost:1234/v1 --model qwen/qwen3-1.7b

# llama.cpp server
# llama-server -m models/qwen3-4b.Q4_K_M.gguf --port 8080
pnpm dev --provider openai-compat --base-url http://localhost:8080/v1 --model qwen3

# Generic, with an API key
pnpm dev --provider openai-compat --base-url http://localhost:5000/v1 --model my-model --api-key sk-xxx
```

---

## Overlay cheatsheet

| Action | Behaviour |
| --- | --- |
| **Click** the pill | Toggles recording (start / stop) |
| **Hold** `Ctrl+Shift+Space` | Push-to-talk: records while held, processes on release |
| **Tap** `Ctrl+Shift+H` | Show / hide the overlay from anywhere |
| **Drag** the pill | Moves it; the new position survives restart |
| **Right-click** the pill | Context menu: open control panel · hide · reset position · quit |
| **Hover** the pill | Tooltip with provider · model · both hotkeys · hints |

---

## Session logs

Every invocation writes to `logs/<ISO-timestamp>/`:

```
logs/2026-04-17T19-28-01-234Z/
├── audio.wav             # exactly what Whisper received
├── transcription.txt     # Whisper's raw output
├── system-prompt.txt     # base + enabled skills, as sent
├── refined.txt           # what got pasted
├── whisper-stderr.log
└── timings.json          # audioDurationMs, transcribeMs, refineMs, injectMs, totalMs
```

`timings.json` is your ground truth for end-to-end latency — see **Latency** below.

---

## Power-user reference

<details>
<summary><strong>CLI flags</strong></summary>

CLI flags trump the config file. Append them after `pnpm dev`:

```powershell
pnpm dev --provider openai-compat --base-url http://localhost:1234/v1 --model qwen/qwen3-1.7b
```

| Flag | Purpose |
| --- | --- |
| `--provider <ollama \| openai-compat>` | Provider implementation |
| `--base-url <url>` | Provider HTTP base URL |
| `--model <id>` | Model identifier on the provider |
| `--api-key <key>` | Bearer token (`openai-compat` only) |
| `--temperature <float>` | Sampling temperature (default `0.2`) |
| `--whisper-cli <path>` | Path to `whisper-cli.exe` |
| `--whisper-model <path>` | Path to a `ggml-*.bin` model file |
| `--hotkey <combo>` | Push-to-talk combo (default `Ctrl+Shift+Space`) |
| `--toggle-hotkey <combo>` | Show/hide combo (default `Ctrl+Shift+H`) |
| `--logs-dir <path>` | Per-session logs directory |
| `--skills-dir <path>` | Skill `.md` files directory (default `./skills`) |
| `--enabled-skills <a,b,c>` | Comma-separated skill IDs to force-enable for this launch |
| `--system-prompt <text>` | Override the active system prompt (skills still layer on top) |
| `--control-panel-port <n>` | Control-panel port (default `7331`; `0` = pick free) |
| `--overlay-anchor <bottom-center \| bottom-right \| top-right \| free>` | Docking corner |
| `--overlay-offset-x <px>` / `--overlay-offset-y <px>` | Offset from the anchor |
| `--overlay-position <x,y>` | Force a free-floating position |
| `--config <path>` | Override the config file location |
| `--print-config` | Print resolved config and exit |
| `-h`, `--help` | Show help and exit |

Combo strings parse from `Ctrl+Shift+Space` form. Modifiers: `Ctrl`/`Control`, `Shift`, `Alt`/`Option`, `Cmd`/`Win`/`Meta`/`Super`. Keys: `A`–`Z`, digits, `Space`, `Enter`, `Tab`, `Escape`, `F1`–`F12`, and friends.

</details>

<details>
<summary><strong>Config file schema</strong></summary>

`%APPDATA%\murmur\config.json` (auto-created on first run with absolute paths from your install):

```json
{
  "provider": "ollama",
  "baseUrl": "http://localhost:11434",
  "model": "qwen3:4b",
  "apiKey": null,
  "temperature": 0.2,
  "whisperCliPath": "C:\\path\\to\\bin\\whisper\\whisper-cli.exe",
  "whisperModelPath": "C:\\path\\to\\bin\\whisper\\models\\ggml-base.en.bin",
  "sampleRate": 16000,
  "hotkeyCombo": "Ctrl+Shift+Space",
  "toggleHotkeyCombo": "Ctrl+Shift+H",
  "clipboardRestoreDelayMs": 150,
  "overlay": {
    "anchor": "bottom-center",
    "offsetX": 0,
    "offsetY": 24,
    "position": null
  },
  "logsDir": "C:\\path\\to\\logs",
  "skillsDir": "C:\\path\\to\\skills",
  "systemPrompt": "You refine a raw voice transcription …",
  "enabledSkills": [],
  "controlPanelPort": 7331
}
```

Any field can be omitted; missing fields fall through to defaults. `overlay.position` is written the first time you drag the pill — at that point `overlay.anchor` flips to `"free"` so the new spot survives restarts. Right-click → **Reset position** clears it.

</details>

<details>
<summary><strong>Environment variables (legacy, dev-only)</strong></summary>

Still supported for development workflows:

| Variable | Maps to |
| --- | --- |
| `LLM_PROVIDER` | `provider` |
| `LLM_BASE_URL` (or `OLLAMA_URL`) | `baseUrl` |
| `LLM_MODEL` | `model` |
| `LLM_API_KEY` | `apiKey` |
| `LLM_TEMPERATURE` | `temperature` |
| `WHISPER_CLI_PATH` | `whisperCliPath` |
| `WHISPER_MODEL_PATH` | `whisperModelPath` |
| `MURMUR_HOTKEY` | `hotkeyCombo` |
| `MURMUR_TOGGLE_HOTKEY` | `toggleHotkeyCombo` |
| `MURMUR_LOGS_DIR` | `logsDir` |

</details>

<details>
<summary><strong>Latency targets</strong></summary>

From `architecture.md` §3.5 (mid-tier PC, small prompts):

| Stage | Target |
| --- | --- |
| Hotkey → recording start | < 50 ms |
| STT (~5 s of speech) | 200–400 ms (Parakeet) — `whisper-base.en` is slower on CPU |
| LLM refinement (~200 tok out, `qwen3:4b`) | 800–1500 ms |
| Injection | < 100 ms |

Typical short utterance ("refactor this function to use async await") on a mid-tier laptop: **~2–4 s end-to-end**, dominated by `refineMs`. Cold-start on the first request is markedly worse because the model hasn't been loaded into RAM/VRAM yet.

</details>

---

## Contributing

### Scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Clean + compile + launch Electron (with the pre-launch CLI) |
| `pnpm build` | Clean + compile only (no launch) |
| `pnpm check` | `tsc --noEmit` + `biome check .` |
| `pnpm format` | `biome format --write .` |
| `pnpm test` | Run the Node built-in test suite against `dist/` |
| `pnpm test:ci` | `pnpm build && pnpm test` |
| `pnpm clean` | Remove `dist/` |
| `pnpm setup:whisper` | Download `whisper-cli.exe` + `ggml-base.en.bin` |

### CI

Every push and every PR to `main` runs the **CI** workflow (`.github/workflows/ci.yml`) on both Ubuntu and Windows:

1. `pnpm install --frozen-lockfile`
2. `pnpm check` (typecheck + lint)
3. `pnpm build`
4. `pnpm test`

A red check blocks merge. Keep it green.

### Releases

Releases are driven by git tags. To cut a new version:

```powershell
# 1. Bump the version in package.json
pnpm version patch        # or minor / major

# 2. Push the commit + tag
git push origin main --follow-tags
```

The **Release** workflow (`.github/workflows/release.yml`) then:

1. Checks out the tagged commit.
2. Verifies `package.json` version matches the tag.
3. Runs `pnpm check` + `pnpm test:ci`.
4. Builds the app and zips `dist/ + scripts/ + skills/ + package.json + lockfile + README + logo` into `murmur-v<version>-win-x64.zip`.
5. Creates a GitHub Release with auto-generated notes (from PR titles since the previous tag) and attaches the zip.

You can also trigger the workflow manually from the Actions tab with a `tag` input (useful for re-releases).

> The package is marked `"private": true` — Murmur ships as a downloadable bundle on GitHub Releases, not as an npm package. Flip `"private"` off and remove it if/when the project becomes a consumable library.

### Dependabot

`.github/dependabot.yml` opens weekly npm PRs (split into `dev-dependencies` and `runtime-dependencies` groups) and monthly `github-actions` PRs.

---

## Known rough edges

1. **No streaming anywhere.** Each stage is strictly sequential. Streaming STT + streaming LLM + streaming injection is the biggest pending latency win.
2. **Model cold-start dominates first-run latency.** Pre-warming the model on app start (`keep_alive`) is queued.
3. **Paste-based injection only**, no per-target typing fallback.
4. **No VAD / silence trimming.** Trailing "uhh" and dead air get transcribed and fed to the LLM.
5. **Renderer uses the deprecated `ScriptProcessorNode`.** Move to `AudioWorklet` before any non-spike build.
6. **No tray icon.** Hide / show is handled by the toggle hotkey and the right-click context menu; restart re-shows the overlay if you ever lose the toggle binding. A tray fallback is queued.
7. **Off-screen drag is auto-clamped on relaunch.** The saved free position is clamped to the nearest connected display's work area on launch, so a saved position from a now-disconnected monitor doesn't strand the overlay.
8. **Single utterance at a time.** Concurrent recordings are dropped; queueing is not implemented.

---

## License

Unlicensed. Pre-1.0; APIs and config will change.
