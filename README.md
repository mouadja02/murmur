# Murmur

Voice-first prompt engineering for vibe coders. A circular floating overlay sits on top of your desktop. Click it (or hold a global hotkey), talk, and a refined prompt gets pasted at your cursor.

> **Status:** early Phase 1. Windows-only. Local-only by default. The overlay is functional, the LLM provider is pluggable (Ollama / LM Studio / any OpenAI-compatible local server), and config can be supplied via CLI flags or an on-disk config file in your user data directory.

---

## What it does

1. A small circular logo button floats on your desktop, always on top.
2. Either **click the button** or **hold `Ctrl + Shift + Space`** (default hotkey) to start recording.
3. While recording, the button expands into a pill and a soundbar reacts to your voice.
4. On release / second click, Murmur:
   - saves the captured 16 kHz mono PCM as WAV,
   - transcribes it locally with `whisper.cpp` and `ggml-base.en.bin`,
   - sends the transcription to your configured local LLM with a hardcoded "code prompt engineer" system prompt,
   - pastes the refined text at your current cursor position via clipboard + `Ctrl+V`,
   - restores your previous clipboard contents.
5. Every session is written to a timestamped folder under `logs/` for inspection.

Every `pnpm dev` launch shows a **terminal banner** summarising provider / hotkeys / skills / system-prompt / control-panel URL, and hands you an interactive menu to continue, edit the system prompt inline, or jump straight into the browser-based **control panel** (see below).

---

## Control panel

Murmur ships with a small local control panel so you never have to hand-edit `config.json`.

- Served on `http://localhost:7331` (configurable via `--control-panel-port` or the `controlPanelPort` config field). Port `0` picks a free port and logs the URL.
- Opens in three ways:
  1. From the pre-launch menu in the terminal ("Open control panel in browser").
  2. Right-click the floating overlay → **Open control panel**.
  3. Paste the URL printed by `pnpm dev` into your browser yourself.
- **All edits persist to `%APPDATA%\murmur\config.json`** and hot-reload into the running app (providers are re-created, hotkeys are re-registered, the overlay tooltip refreshes) — no restart needed.

Tabs:

| Tab | What you can do |
| --- | --- |
| **System prompt** | View and edit the active prompt that wraps every transcription. Character count, reset-to-default, save. |
| **Skills** | List / add / rename / edit / delete skills. Per-skill enable toggle; enabled skills are concatenated under an `Active Skills` section in the composed system prompt. |
| **Provider** | Switch provider, base URL, model, API key, temperature. One-click presets for Ollama / LM Studio / llama.cpp server. **Test connection** button pings the provider and reports latency. |
| **Whisper** | Paths to `whisper-cli.exe` and the `ggml-*.bin` model. |
| **Hotkeys** | Push-to-talk combo + toggle combo. Live validation. |
| **Paths** | Logs dir, skills dir, and the resolved config file path (read-only). |

The composed system prompt (base prompt + enabled skills) is previewed live in the **System prompt** tab so you can see exactly what the LLM will receive.

---

## Skills

Skills are small Markdown files that get layered onto the base system prompt when enabled. Perfect for "always talk like a senior Go reviewer", "bias toward concise output", or project-specific vocabulary.

Location: `skillsDir` (defaults to `./skills` in the project). On first launch Murmur seeds two example skills so the directory isn't empty.

Format — each skill is one `.md` file with YAML-ish frontmatter and a Markdown body:

```markdown
---
id: concise-output
name: Concise output
description: Trim filler, keep the prompt to the point.
---

Prefer terse, structured prompts. No hedging, no apologies, no restating the
question. Use bullet lists for constraints and acceptance criteria.
```

Rules:
- `id` is the filename (without `.md`) and must be unique.
- `name` and `description` are what you see in the control panel.
- Body content is what gets appended to the final system prompt, under an `Active Skills` header, only when the skill's toggle is on.

You can also author / edit / delete skills entirely from the control panel UI — files are written back to `skillsDir` so they're version-controllable.

---

## Supported LLM providers

Murmur talks to local model servers only. You pick one of two providers; the second one covers practically every local OpenAI-compatible server.

| Provider | `--provider` value | Default base URL | Notes |
| --- | --- | --- | --- |
| **Ollama** (native) | `ollama` | `http://localhost:11434` | Uses `/api/generate` with `think:false`, works great with `qwen3:4b`. |
| **OpenAI-compatible** | `openai-compat` | `http://localhost:1234/v1` | Works with **LM Studio**, **llama.cpp server**, **vLLM**, **text-generation-webui (oobabooga)**, **Jan**, **KoboldCpp**, and Ollama's own `/v1` endpoint. Uses `/chat/completions`. |

> The `openai-compat` provider expects you to pass the **full** base URL including the `/v1` segment — Murmur does not append it for you.

### Quick examples

Ollama (default):

```powershell
ollama pull qwen3:4b
pnpm dev
```

LM Studio:

```powershell
# In LM Studio: load a model, click "Start Server" (port 1234)
pnpm dev --provider openai-compat --base-url http://localhost:1234/v1 --model qwen/qwen3-1.7b
```

llama.cpp server:

```powershell
# llama-server -m models/qwen3-4b.Q4_K_M.gguf --port 8080
pnpm dev --provider openai-compat --base-url http://localhost:8080/v1 --model qwen3
```

Generic OpenAI-compatible with API key:

```powershell
pnpm dev --provider openai-compat --base-url http://localhost:5000/v1 --model my-model --api-key sk-xxx
```

---

## Prerequisites

- **Windows 10/11 x64.** macOS and Linux are out of scope right now.
- **Node.js 20+** and **pnpm** on `PATH`.
- A local LLM server running (Ollama, LM Studio, llama.cpp server, etc. — see table above).
- A working microphone set as your Windows default input device.
- PowerShell 5.1+ (ships with Windows) for the whisper setup script.

---

## Install

```powershell
git clone https://github.com/mouadja02/murmur.git
cd murmur

pnpm install

# Downloads whisper-cli.exe and ggml-base.en.bin into ./bin/whisper/
pnpm setup:whisper
```

The first launch creates a config file at `%APPDATA%\murmur\config.json` populated with sensible defaults. You can edit it freely, or override per-launch via CLI flags (see below).

---

## Configuration

Murmur resolves configuration from three sources, in this precedence order:

1. **CLI flags** (highest)
2. **User config file** at `app.getPath('userData')/config.json`
   - Windows: `%APPDATA%\murmur\config.json`
   - Override location with `--config <path>`
3. **`.env`** in the working directory (legacy / dev convenience)
4. **Built-in defaults** (lowest)

### CLI flags

Just append flags after `pnpm dev`:

```powershell
pnpm dev --provider openai-compat --base-url http://localhost:1234/v1 --model qwen/qwen3-1.7b
```

(The `dev` script auto-injects the `--` separator that tells Electron to stop parsing its own switches, so the space-separated form Just Works. If you ever invoke `electron .` directly, prefer `--key=value` syntax to avoid Chromium's own command-line parser eating values.)

| Flag | Purpose |
| --- | --- |
| `--provider <ollama \| openai-compat>` | Which provider implementation to use |
| `--base-url <url>` | Provider HTTP base URL |
| `--model <id>` | Model identifier on the provider |
| `--api-key <key>` | Bearer token (`openai-compat` only) |
| `--temperature <float>` | Sampling temperature (default `0.2`) |
| `--whisper-cli <path>` | Path to `whisper-cli.exe` |
| `--whisper-model <path>` | Path to a `ggml-*.bin` model file |
| `--hotkey <combo>` | Push-to-talk combo (default `Ctrl+Shift+Space`) |
| `--toggle-hotkey <combo>` | Show/hide overlay combo (default `Ctrl+Shift+H`) |
| `--logs-dir <path>` | Per-session logs directory |
| `--overlay-anchor <bottom-center \| bottom-right \| top-right \| free>` | Where to dock the overlay |
| `--overlay-offset-x <px>` / `--overlay-offset-y <px>` | Overlay offset from the anchor |
| `--overlay-position <x,y>` | Force a free-floating screen position; auto-set when you drag the pill |
| `--system-prompt <text>` | Override the active system prompt for this launch (skills are still merged on top) |
| `--skills-dir <path>` | Where to read / write skill `.md` files (default `./skills`) |
| `--enabled-skills <a,b,c>` | Comma-separated skill IDs to force-enable for this launch |
| `--control-panel-port <n>` | Port for the local control panel (default `7331`; `0` = pick free) |
| `--config <path>` | Override the config file location |
| `--print-config` | Print the resolved config and exit |
| `-h`, `--help` | Show help and exit |

Combo strings parse from `Ctrl+Shift+Space` form. Modifiers accept `Ctrl` / `Control`, `Shift`, `Alt` / `Option`, `Cmd` / `Win` / `Meta` / `Super`. Keys accept letters (`A`-`Z`), digits, `Space`, `Enter`, `Tab`, `Escape`, `F1`-`F12`, etc.

### Config file schema

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
  "systemPrompt": "You refine a raw voice transcription into a high-quality prompt...",
  "enabledSkills": [],
  "controlPanelPort": 7331
}
```

Any field can be omitted; missing fields fall through to defaults. `overlay.position` is written automatically the first time you drag the pill — at that point `overlay.anchor` is also flipped to `"free"` so the new spot survives restarts. Right-click → **Reset position** clears it.

`systemPrompt`, `enabledSkills`, and `controlPanelPort` are all editable directly from the control panel; changes are written back to this file atomically.

### Environment variables (legacy)

Still supported, mostly for development:

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

---

## Run

```powershell
pnpm dev
```

This compiles, copies the renderer assets, and launches the overlay. On launch, Murmur runs a preflight that checks:
- the configured provider is reachable,
- the configured `model` is present (via `/api/tags` for Ollama, `/v1/models` for OpenAI-compatible servers),
- `whisperCliPath` and `whisperModelPath` both exist.

If any check fails, Murmur prints a clear error and exits. Fix it and re-run.

### Using it

1. Click into the editor / app where you want the prompt pasted (Cursor, ChatGPT, a terminal, whatever).
2. Either:
   - Click the floating Murmur logo, or
   - Hold `Ctrl + Shift + Space`.
3. Talk. Bars react to your voice in real time.
4. Click again or release the hotkey. The overlay walks through `recording → transcribing → refining → injecting → done`.
5. The refined prompt appears at your cursor.

### Overlay interactions

| Action | Behaviour |
| --- | --- |
| **Click** the logo | Toggles recording (start / stop) |
| **Hold** PTT combo (default `Ctrl+Shift+Space`) | Push-to-talk: records while held, processes on release |
| **Tap** toggle combo (default `Ctrl+Shift+H`) | Show / hide the overlay (works whether visible or hidden — it's the "reopen" path too) |
| **Drag** anywhere on the visible pill | Moves the overlay; position is saved to `config.json` and survives restart |
| **Right-click** the pill | Native context menu: **Open control panel**, Hide, Reset position, the active provider/model/base URL/hotkeys, Quit |
| **Hover** the overlay | Tooltip with provider · model · base URL · both hotkeys · interaction hints |

The toggle hotkey and PTT hotkey are independent. If you forget the toggle combo and have already hidden the overlay, re-running `pnpm dev` always brings it back at the saved position.

### Stopping

- Right-click the pill → **Quit Murmur**, or
- Hit `Ctrl+C` in the `pnpm dev` terminal, or
- `taskkill /F /IM electron.exe`

---

## Logs

Every invocation writes to a timestamped folder under `logsDir`:

```
logs/2026-04-17T19-28-01-234Z/
  audio.wav
  transcription.txt
  system-prompt.txt
  refined.txt
  whisper-stderr.log
  timings.json
```

`timings.json` includes `provider`, `audioDurationMs`, `transcribeMs`, `refineMs`, `injectMs`, `totalMs`. That's your ground truth for how the pipeline is performing on your hardware.

---

## Latency

Targets from `architecture.md` §3.5 (mid-tier PC, small prompts):

| Stage | Target |
| --- | --- |
| Hotkey → recording start | < 50 ms |
| STT (~5 s of speech) | 200–400 ms (Parakeet) — current `whisper-base.en` will be slower on CPU |
| LLM refinement (~200 tok out, `qwen3:4b`) | 800–1500 ms |
| Injection | < 100 ms |

Typical short utterance ("refactor this function to use async await") on a mid-tier laptop: **~2–4 s end-to-end**, dominated by `refineMs`. Cold-start on the first request is markedly worse because the model hasn't been loaded into RAM/VRAM yet.

---

## Useful scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Clean + compile + launch Electron |
| `pnpm build` | Clean + compile only (no launch) |
| `pnpm clean` | Remove `dist/` |
| `pnpm check` | `tsc --noEmit` + `biome check .` |
| `pnpm format` | `biome format --write .` |
| `pnpm setup:whisper` | Download `whisper-cli.exe` + `ggml-base.en.bin` |

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
