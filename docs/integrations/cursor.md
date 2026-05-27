# Murmur + Cursor

Connect Cursor to a local Murmur MCP server so Agent can record voice, transcribe files, refine text, and manage skills without the Electron overlay.

## Prerequisites

- Node.js 20+
- Murmur installed (`npm install -g @mouadja02/murmur` or `npx @mouadja02/murmur`)
- Whisper CLI + model (first run or `murmur setup:whisper`)
- A local LLM server (Ollama recommended)
- Headless microphone capture:
  - **Windows / macOS:** [SoX](http://sox.sourceforge.net/) (`sox` on `PATH`)
  - **Linux:** ALSA utils (`arecord` on `PATH`)

Override the recorder with `--recorder-command` or `MURMUR_RECORDER_COMMAND` if your binary lives elsewhere.

## Start Murmur

In a dedicated terminal (leave it running):

```bash
murmur serve --port 7331 --mcp-port 7332
```

On success you should see:

```
[murmur] control panel: http://localhost:7331
[murmur] MCP server: http://127.0.0.1:7332/mcp
```

## Configure Cursor

Create or edit **project** config at `.cursor/mcp.json` (recommended, can be committed for the team) or **global** config at `~/.cursor/mcp.json`.

### `.cursor/mcp.json` (Streamable HTTP)

```json
{
  "mcpServers": {
    "murmur": {
      "url": "http://127.0.0.1:7332/mcp"
    }
  }
}
```

Cursor treats a `url` without `command` as **Streamable HTTP** — the same transport Murmur implements.

Restart Cursor (or reload MCP from **Settings → Tools & MCP**) after saving the file.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `murmur_record` | Record from the microphone, transcribe, refine, return text |
| `murmur_stop_record` | Stop an active recording started without `duration_ms` |
| `murmur_transcribe` | Transcribe a WAV file; MP3 depends on your `whisper-cli` build (`file_path` must be absolute) |
| `murmur_refine` | Refine arbitrary text with the active system prompt + skills |
| `murmur_list_skills` | List skills and enabled state |
| `murmur_toggle_skill` | Enable, disable, or toggle a skill by `skill_id` |

### Recording tips

- **Prefer `duration_ms`** on `murmur_record` for a single tool call (e.g. `duration_ms: 5000`).
- Without `duration_ms`, call `murmur_stop_record` when you are done speaking.
- `inject` defaults to `false` and should stay `false` in `murmur serve`; paste injection is only available through the Electron overlay.
- Optional `skill_ids` overrides which skills apply for that call.

In Agent chat, ask Cursor to use Murmur tools explicitly, e.g. *"Call murmur_record with duration_ms 6000 and use the result as my prompt."*

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Server shows disconnected | Confirm `murmur serve` is running; check **Settings → Tools & MCP** |
| `headless recorder command not found: sox` | Windows: run `winget install --id ChrisBagwell.SoX -e`, restart the terminal, then verify `sox --version`. Otherwise install SoX / `arecord`, or set `--recorder-command` |
| Tools missing after edit | Restart Cursor — MCP config is loaded at startup |
| `pipeline is busy` | Wait for the current recording/processing to finish |

## See also

- [Claude Code](./claude-code.md)
- [VS Code Copilot](./vscode-copilot.md)
- [Shell / generic MCP clients](./shell.md)
