# Murmur + VS Code Copilot

Connect GitHub Copilot in VS Code to a local Murmur MCP server so the agent can record voice, transcribe files, refine text, and manage skills without the Electron overlay.

## Prerequisites

- VS Code with GitHub Copilot and MCP support enabled
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

## Configure VS Code

Create or edit MCP configuration:

- **Workspace:** `.vscode/mcp.json` (share with the team via git)
- **User:** run **MCP: Open User Configuration** from the Command Palette

### `.vscode/mcp.json`

```json
{
  "servers": {
    "murmur": {
      "type": "http",
      "url": "http://127.0.0.1:7332/mcp"
    }
  }
}
```

VS Code tries **HTTP Stream** (Streamable HTTP) first, then falls back to SSE if needed. Murmur speaks Streamable HTTP on `/mcp`.

Start the server from the MCP UI (play button above the entry in `mcp.json`) or enable **chat.mcp.autostart** in settings. Enable the Murmur tools in the Copilot chat tools picker before asking the agent to record.

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

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `fetch failed` / server won't start | Ensure `murmur serve` is running; check MCP output channel |
| `headless recorder command not found: sox` | Windows: run `winget install --id ChrisBagwell.SoX -e`, restart the terminal, then verify `sox --version`. Otherwise install SoX / `arecord`, or set `--recorder-command` |
| Tools not visible in chat | Enable **MCP Server: murmur** in the Copilot tools menu |
| `pipeline is busy` | Wait for the current recording/processing to finish |

Official reference: [MCP configuration in VS Code](https://code.visualstudio.com/docs/copilot/reference/mcp-configuration).

## See also

- [Cursor](./cursor.md)
- [Claude Code](./claude-code.md)
- [Shell / generic MCP clients](./shell.md)
