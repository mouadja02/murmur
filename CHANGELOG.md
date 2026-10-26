# Changelog

All notable changes to Murmur. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project follows [Semantic Versioning](https://semver.org/). Releases before 1.0.0 are
listed on the [GitHub releases page](https://github.com/mouadja02/murmur/releases).

## [1.0.0] - unreleased

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
