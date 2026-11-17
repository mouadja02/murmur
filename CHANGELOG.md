# Changelog

All notable changes to Murmur. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project follows [Semantic Versioning](https://semver.org/). Releases before 1.0.0 are
listed on the [GitHub releases page](https://github.com/mouadja02/murmur/releases).

## [Unreleased]

## [1.0.2] - 2026-11-18

### Fixed

- Holding the push-to-talk hotkey while a dictation is still being processed now queues the next
  dictation, as the README describes, instead of silently dropping what you said. Releasing the key
  ends the queued capture; it was previously ignored in the default `hold` mode.
- A capture started (by clicking the pill or pressing a toggle-mode hotkey) while **Refine last** or
  **Insert raw** was running is now taken over when that finishes. Before, the microphone stayed
  open while the overlay showed idle, a capture that was also stopped in that window was never
  processed, and the pipeline reported busy (blocking config reloads and MCP calls) until the
  next click.
- A quoted Windows recorder path such as `"C:\Program Files (x86)\sox-14-4-2\sox.exe"` (in
  `--recorder-command`, `MURMUR_RECORDER_COMMAND` or `recorderCommand`) keeps its backslashes
  instead of becoming `C:Program Files (x86)sox-14-4-2sox.exe`. Inside quotes, a backslash now
  only escapes the quote character, following the Windows argument rules.
- `murmur_record` with a recorder that is not installed (for example SoX missing when the agent
  uses the overlay app's MCP endpoint) now names the missing command and how to fix it, instead of
  `spawn sox ENOENT`. The overlay app warns about a missing recorder at startup, and the README
  and integration guides say that its `murmur_record` needs the recorder too.
- With `clipboardRetention: restore-previous` and clipboard context on, the text Murmur puts back
  after a paste is no longer recorded as a new copy. Before, a password-manager entry that had been
  skipped as concealed, or an entry older than 5 minutes, could come back as clipboard context and
  be sent to the model with the next dictation.
- In the default `metadata-only` log mode, `timings.json` no longer contains an `app` field. That
  name is cut from the active window's title (it can be part of a document name), so it is now
  written only in `full` mode. The README no longer calls it a process name.

### Changed

- Updated Electron to 45.3.1, the MCP SDK to 1.32.2, dotenv to 18.0.10 and Biome to 2.6.4.

## [1.0.1] - 2026-10-26

### Fixed

- OpenAI-compatible startup checks now allow 30 seconds for large model catalogs (such as
  OpenRouter's) and report timeout, authentication and response-format errors with relevant advice.
- Trailing slashes in OpenAI-compatible base URLs no longer produce double slashes in requests.
- Interrupted MCP uploads no longer terminate Murmur with an unhandled connection error.
- Transcription cleanup preserves bracketed code, placeholders and Markdown links while still
  removing recognized non-speech annotations.
- Unfinished `<think>` blocks are removed from final and partial provider responses, matching
  the filtering already applied to streamed tokens.

### Changed

- Updated Electron to 45.0.0, dotenv to 18.0.9 and Biome to 2.6.2. Biome's new Markdown and YAML
  formatters are disabled to preserve the repository's existing formatting scope.

## [1.0.0] - 2026-10-26

The first stable release: the overlay, control panel, MCP server and docs now match each other.
Config keys, CLI flags, environment variables, the `murmur://` URL scheme and the MCP tool names
(`murmur_record`, `murmur_stop_record`, `murmur_transcribe`, `murmur_refine`) are the 1.x contract;
a breaking change to any of them will wait for 2.0.

### Added

- **Toggle push-to-talk.** `hotkeyMode: "toggle"` (`--hotkey-mode`, `MURMUR_HOTKEY_MODE`): press the
  hotkey once to start and again to stop.
- **Focus guard.** If the active window changed between the start of a capture and the insertion,
  the prompt is copied instead of pasted into the wrong window (`focusChangePolicy`, default `copy`).
- **Redesigned control panel and overlay toast**: grouped navigation, one save bar for every
  section, switches and sliders with units, hotkey recording, light and dark following the OS.
- **Settings reference in the README** listing every config key with its default, CLI flag,
  environment variable and place in the panel, checked against the code by a test.
- **README sections** for Voice & context (what is captured, when, where it goes) and Known
  limitations; a placeholder for a real before/after dictation.
- `CHANGELOG.md`, `SECURITY.md` and `CONTRIBUTING.md`.

### Changed

- **New visual identity**: ink on paper with a highlighter-yellow fill and blue for links and
  focus, applied to the logo, README banner, architecture diagram, tray icon and terminal banner.
  The banner and diagram have light and dark variants. There is no purple anywhere, and a test
  keeps it that way.
- **Tagline**: "voice-first prompt engineering for coding agents" (was "for vibe coders").
- The tray icon is yellow when idle and blue while processing (was purple and amber).
- The README describes v0.7+ behaviour: streaming, VAD, tray, queueing and prewarm are no longer
  listed as missing; the log-mode text and config precedence now match the code; the blueprint
  latency figures were removed in favour of how to read your own `timings.json`.

### Fixed

- Skills: creating a skill never overwrites an existing one, edits and deletes act on the file the
  skill was loaded from, and example skills you delete stay deleted.
- The control panel rejected nothing when a request body was huge; bodies over 1 MiB now get a
  413 (the MCP server already had this limit).
- The `murmur_token` cookie is now `HttpOnly`.
- The overlay status chip is announced to screen readers as a polite live region.
- `uiohook-napi` is loaded lazily so the test suite runs on headless Linux.

### Known limitations

See the README's [Known limitations](README.md#known-limitations). The ones most likely to matter:
macOS and Wayland have had the least real-device testing, log folders are not pruned, and the
whisper.cpp and model downloads are not pinned to a version or checksum.
