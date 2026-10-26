# Security policy

## Reporting a vulnerability

Please report security problems privately, not in a public issue:

**<https://github.com/mouadja02/murmur/security/advisories/new>** (GitHub private vulnerability reporting).

Include what you found, how to reproduce it, and the Murmur version. You will get an
acknowledgement, and a fix or a clear answer on whether it is in scope, as soon as it can be done;
this is a small project maintained by one person, so there is no fixed response time.

## Supported versions

Only the latest 1.x release gets fixes.

## What Murmur protects, and what it doesn't

- **Local only.** The control panel (default port 7331) and the MCP server (default port 7332)
  listen on `127.0.0.1`. The control panel checks the `Host` and `Origin` headers and requires a
  per-run token header on every state-changing request, so a web page you visit cannot change your
  settings through DNS rebinding or a cross-site request.
- **No telemetry.** While running, Murmur's only outbound request is to the LLM endpoint you
  configured (and a skill import, from a URL you paste). Setup downloads whisper.cpp and its model
  once.
- **Audio stays local.** Transcription runs on your machine. The text of your dictation, and any
  context you turned on (window title, clipboard entries, a screenshot), goes to your configured
  LLM provider. With a hosted provider that means it leaves your machine; the panel shows a
  Local / Cloud / Network badge and a warning for hostnames.
- **`full` log mode keeps what you said.** In `full` mode a session folder contains audio, the
  transcription, prompts and context. The default `metadata-only` mode does not. Protect or delete
  those folders as you would any recording.
- **The API key is stored in `config.json` in plain text**, in your user-data directory, readable by
  your OS account. Prefer the `LLM_API_KEY` environment variable if that matters to you.
- **Any local process can reach the MCP server.** It has no authentication, because MCP clients on
  the same machine connect to it directly. Anything running as you can call `murmur_record` and
  turn the microphone on, so treat it like any other local service. Run `murmur serve` only when you
  want it.

## Known gaps

These are documented in the README's Known limitations rather than hidden: the whisper.cpp and
model downloads are fetched over HTTPS from their upstream projects but are not pinned to a version
or checksum, and the headless recorder command and the executables named in `config.json` are
trusted to be what you configured.
