# Murmur + Claude Code

Connect Claude Code to a local Murmur MCP server so the agent can record voice, transcribe files, refine text, and manage skills without the Electron overlay.

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

The control panel is optional for MCP use but useful for editing the system prompt and skills.

## Configure Claude Code

Add Murmur to your MCP settings. Use **project** scope (`.mcp.json` in the repo root, committed for the team) or **user** scope (`~/.claude.json`).

### Project `.mcp.json`

```json
{
  "mcpServers": {
    "murmur": {
      "type": "http",
      "url": "http://127.0.0.1:7332/mcp"
    }
  }
}
```

### CLI alternative

```bash
claude mcp add murmur --transport http http://127.0.0.1:7332/mcp
```

Restart Claude Code after changing MCP configuration. Confirm the server appears with `claude mcp list`.

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

- **Prefer `duration_ms`** on `murmur_record` for a single tool call (e.g. `duration_ms: 5000` for ~5 seconds).
- Without `duration_ms`, call `murmur_stop_record` when you are done speaking.
- `inject` defaults to `false` and should stay `false` in `murmur serve`; paste injection is only available through the Electron overlay.
- Optional `skill_ids` overrides which skills apply for that call.

Example prompt for Claude Code: *"Use murmur_record with duration_ms 8000 and return the refined prompt."*

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| MCP connection refused | Ensure `murmur serve` is running and port `7332` is free |
| `headless recorder command not found: sox` | Windows: run `winget install --id ChrisBagwell.SoX -e`, restart the terminal, then verify `sox --version`. Otherwise install SoX / `arecord`, or set `--recorder-command` |
| Whisper / model errors | Run `murmur setup:whisper` or fix paths in the control panel |
| LLM errors | Start Ollama (`ollama serve`) or your configured provider |
| `pipeline is busy` | Wait for the current recording/processing to finish |

## See also

- [Cursor](./cursor.md)
- [VS Code Copilot](./vscode-copilot.md)
- [Shell / generic MCP clients](./shell.md)
