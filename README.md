# Murmur — Phase 0 Spike

Voice-first prompt engineering for vibe coders. Hold a key, talk, and a refined prompt gets pasted at your cursor.

> **Scope:** This repository is the Phase 0 weekend spike described in `architecture.md`.
> It proves the end-to-end path `mic → STT → LLM refine → paste`. It is **Windows-only** for now, uses a single hardcoded model, has no UI polish, no tray, no skills system, and is not packaged. Everything here is disposable.

---

## What it does

1. You hold `Ctrl + Shift + Space`.
2. Murmur captures 16 kHz mono PCM from your default input device while the combo is held.
3. On release (release of `Space`), recording stops and the WAV is saved locally.
4. `whisper-cli.exe` transcribes the WAV with `ggml-base.en.bin`.
5. The raw transcription is sent to a local Ollama model (`qwen3:4b` by default) with a hardcoded "code prompt engineer" system prompt.
6. The refined text is pasted at your current cursor position via clipboard + `Ctrl+V`, and your previous clipboard contents are restored.
7. Every session is written to `logs/<timestamp>/` — `audio.wav`, `transcription.txt`, `system-prompt.txt`, `refined.txt`, `whisper-stderr.log`, `timings.json`, and `error.txt` if anything blew up.

---

## Prerequisites

- **Windows 10/11 x64.** The spike uses Win32 clipboard + `uiohook-napi` + `whisper-bin-x64`. macOS and Linux are explicitly out of scope for Phase 0.
- **Node.js 20+** and **pnpm** on `PATH`.
- **Ollama** running locally with the model pulled:
  ```powershell
  # install from https://ollama.com
  ollama pull qwen3:4b
  ollama serve   # (Ollama's default launcher usually starts this automatically)
  ```
- A working microphone set as the Windows default input device.
- PowerShell 5.1+ (ships with Windows) for the setup script.

---

## Install

```powershell
git clone https://github.com/mouadja02/murmur.git murmur
cd murmur

pnpm install

# Downloads whisper-cli.exe and ggml-base.en.bin into ./bin/whisper/
pnpm setup:whisper

# Create your local config
Copy-Item .env.example .env
```

`pnpm setup:whisper` prints the exact `WHISPER_CLI_PATH` / `WHISPER_MODEL_PATH` values to paste into `.env` if the defaults don't match your extract layout.

Default `.env`:

```
OLLAMA_URL=http://localhost:11434
LLM_MODEL=qwen3:4b
WHISPER_CLI_PATH=./bin/whisper/whisper-cli.exe
WHISPER_MODEL_PATH=./bin/whisper/models/ggml-base.en.bin
```

---

## Run

```powershell
pnpm dev
```

This compiles TypeScript, copies the renderer HTML, and launches Electron.
The small window shows the current status. The window does not need to be focused — the hotkey is global.

On launch, Murmur runs a preflight check:
- Ollama reachable at `OLLAMA_URL`
- `LLM_MODEL` is present in `ollama list`
- `WHISPER_CLI_PATH` and `WHISPER_MODEL_PATH` both exist

If any check fails, the app prints a clear message and exits. Fix the reported issue and re-run.

### Using it

1. Click into the editor / app where you want the prompt pasted (Cursor, ChatGPT, a terminal, whatever).
2. Hold `Ctrl + Shift + Space` and talk.
3. Release the combo. Status in the Murmur window walks through `recording → transcribing → refining → injecting → done`.
4. The refined prompt appears at your cursor.

### Stopping

- Close the Murmur window, or
- Hit `Ctrl+C` in the `pnpm dev` terminal, or
- Nuke it: `taskkill /F /IM electron.exe` in PowerShell.

---

## Logs

Every invocation writes to a new timestamped folder under `./logs/`:

```
logs/2026-04-17T19-28-01-234Z/
  audio.wav
  transcription.txt
  system-prompt.txt
  refined.txt
  whisper-stderr.log
  timings.json
```

Read `timings.json` to see where time was actually spent on your machine. Example fields: `audioDurationMs`, `transcribeMs`, `refineMs`, `injectMs`, `totalMs`.

---

## Latency

Spec targets from `architecture.md` §3.5 (mid-tier PC, small prompts):

| Stage | Target |
| --- | --- |
| Hotkey → recording start | < 50 ms |
| STT (~5 s of speech) | 200–400 ms (Parakeet) — Phase 0 uses `whisper-base.en` and will be slower on CPU |
| LLM refinement (~200 tok out, `qwen3:4b`) | 800–1500 ms |
| Injection | < 100 ms |

**Measured on the spike:** numbers vary massively by CPU and whether `qwen3:4b` is warm in VRAM/RAM. Read `logs/<ts>/timings.json` after your first few runs — that's your ground truth. A typical short utterance ("refactor this function to use async await") on a mid-tier laptop lands in **~2–4 s end-to-end**, dominated by `refineMs`.

We don't stream anything yet, so every stage is strictly sequential — that's the biggest lever for Phase 1.

---

## Known rough edges (Phase 1 candidates)

1. **No streaming anywhere.** STT runs to completion before the LLM sees a single token; the LLM runs to completion before we paste. Streaming STT + streaming LLM + streaming injection is the single biggest latency win on the board.
2. **Model cold-start dominates first-run latency.** If `qwen3:4b` isn't already loaded in Ollama, `refineMs` includes model load. We should pre-warm on app start (`POST /api/generate` with an empty prompt or `keep_alive`).
3. **Paste-based injection only, no typing fallback.** We clobber the clipboard for ~150 ms; some apps (rare, but e.g. some terminals, password fields) either block `Ctrl+V` or paste with unwanted formatting. Target-aware injection (Section 7 of the spec) needs a real implementation with a typing fallback.
4. **No VAD, no silence trimming.** The WAV is whatever you captured, head-to-tail. Trailing "uhh" and dead air gets transcribed and fed to the LLM, which hurts both latency and refinement quality. `whisper.cpp` has built-in VAD flags; we should use them or run WebRTC VAD in the renderer.
5. **Renderer uses the deprecated `ScriptProcessorNode`.** It works fine for a spike but is scheduled for removal and runs on the main thread, which can cause audio glitches under load. Move to `AudioWorklet` before shipping anything real.

Bonus honorable mentions (not top-5 but worth logging):
- Hotkey is hardcoded and conflicts with any other global `Ctrl+Shift+Space` binding.
- No retry on transient Ollama errors; we just surface `error` and reset.
- No indication in the target app that injection is happening — `pasteAtCursor` assumes the previously focused window is still the one that should receive the paste.
- Clipboard restore is a fixed 150 ms delay; a slow paste target can lose the restoration race.
- `whisper-stderr.log` is kept per-session but never surfaced to the user.

---

## Useful scripts

| Command | What it does |
| --- | --- |
| `pnpm dev` | Compile + launch Electron |
| `pnpm build` | Compile only (no launch) |
| `pnpm check` | `tsc --noEmit` + `biome check .` |
| `pnpm format` | `biome format --write .` |
| `pnpm setup:whisper` | Download `whisper-cli.exe` + `ggml-base.en.bin` |

---

## License

Unlicensed. This is a spike. Don't build anything load-bearing on top of it.
