# Murmur MCP from the shell

Use Murmur as a **Streamable HTTP** MCP server on loopback. Any MCP client that supports HTTP transport can connect to the same endpoint — no Electron overlay required.

## Prerequisites

- Node.js 20+
- Murmur built or installed (`pnpm build` from source, or `npm install -g @mouadja02/murmur`)
- Whisper CLI + model
- A local LLM server
- Headless microphone capture:
  - **Windows / macOS:** SoX (`sox` on `PATH`)
  - **Linux:** ALSA utils (`arecord` on `PATH`)

Override defaults:

```bash
murmur serve --recorder-command "sox -q -d -r 16000 -c 1 -b 16 -e signed-integer -t raw -"
# or
export MURMUR_RECORDER_COMMAND='arecord -q -f S16_LE -r 16000 -c 1 -t raw'
```

## Start the server

```bash
murmur serve --port 7331 --mcp-port 7332
```

| Endpoint | URL |
| --- | --- |
| Control panel | `http://127.0.0.1:7331` |
| MCP (Streamable HTTP) | `http://127.0.0.1:7332/mcp` |

Murmur binds MCP to `127.0.0.1` only. Use `--mcp-port 0` to pick a free port (the bound URL is printed on startup).

Environment override: `MURMUR_MCP_PORT=7332` (same precedence rules as other Murmur env vars).

## MCP tools

| Tool | Purpose |
| --- | --- |
| `murmur_record` | Record, transcribe, refine; returns refined text |
| `murmur_stop_record` | Stop recording when `duration_ms` was omitted |
| `murmur_transcribe` | Transcribe a WAV file; MP3 depends on your `whisper-cli` build (`file_path` must be absolute) |
| `murmur_refine` | Refine text with system prompt + skills |
| `murmur_list_skills` | List skills and enabled flags |
| `murmur_toggle_skill` | Enable/disable/toggle a skill in config |

### `murmur_record` parameters

| Field | Type | Notes |
| --- | --- | --- |
| `duration_ms` | number (optional) | Auto-stop after N ms — **preferred for scripts and agents** |
| `skill_ids` | string[] (optional) | Override enabled skills for this call |
| `inject` | boolean (optional) | Default `false`; keep `false` in `murmur serve` because paste injection is only available through the Electron overlay |

### Example agent instructions

- *"Call murmur_record with duration_ms 4000 and return the refined prompt."*
- *"Transcribe /home/user/audio/note.wav with murmur_transcribe, then murmur_refine the text."*

## Connecting a generic MCP client

Point your client at:

```
http://127.0.0.1:7332/mcp
```

Transport: **Streamable HTTP** (MCP spec name: `streamable-http`). Murmur does not expose stdio MCP in this mode.

**Do not use plain `curl` against `/mcp`.** Streamable HTTP uses MCP session semantics (initialize, JSON-RPC over HTTP streams). Use a real MCP client instead:

- [@modelcontextprotocol/inspector](https://www.npmjs.com/package/@modelcontextprotocol/inspector) — `npx @modelcontextprotocol/inspector` and connect to `http://127.0.0.1:7332/mcp`
- Your IDE's MCP integration ([Cursor](./cursor.md), [Claude Code](./claude-code.md), [VS Code Copilot](./vscode-copilot.md))
- Any SDK example that targets Streamable HTTP

## Health checks (without MCP protocol)

These only verify that something is listening — they do not invoke tools. The `curl` examples are for Linux/macOS shells; in PowerShell, use `Invoke-WebRequest` against the same URLs.

```bash
# Control panel (expect HTML or redirect)
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:7331/

# MCP path exists (expect non-404 from Murmur; exact status depends on method)
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://127.0.0.1:7332/mcp
```

A `404` on `/mcp` usually means Murmur is not running or the port is wrong.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `headless recorder command not found: sox` | Windows: run `winget install --id ChrisBagwell.SoX -e`, restart the terminal, then verify `sox --version`. Otherwise install SoX / `arecord`, or set `MURMUR_RECORDER_COMMAND` |
| `winget` says SoX is installed, but `sox --version` fails | The portable install may be incomplete or not linked into `PATH`. Run `winget uninstall --id ChrisBagwell.SoX -e`, reinstall it, restart the terminal, and verify `sox --version` |
| Port in use | Change `--mcp-port` or free the port |
| `file_path must be absolute` | Pass a full path to `murmur_transcribe` |
| `pipeline is busy` | Only one MCP recording at a time |

## See also

- [Cursor](./cursor.md)
- [Claude Code](./claude-code.md)
- [VS Code Copilot](./vscode-copilot.md)
