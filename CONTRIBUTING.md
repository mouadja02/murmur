# Contributing to Murmur

Thanks for helping. Bug reports with the steps to reproduce them are as useful as code, especially
from macOS and Linux Wayland, which get the least testing (see the README's Known limitations).

## Setup

```bash
git clone https://github.com/mouadja02/murmur.git
cd murmur
pnpm install              # pnpm 9, Node 20+
pnpm setup:whisper        # whisper.cpp and a model, for running the app
pnpm dev                  # build and launch the overlay
```

To work on code and tests without launching the app (or on a machine with no display), skip the
Electron download: `ELECTRON_SKIP_BINARY_DOWNLOAD=1 pnpm install --frozen-lockfile`.

## Before you open a pull request

```bash
pnpm check                # tsc --noEmit and biome check
pnpm build && pnpm test   # tests run against the compiled dist/
```

CI runs the same on Ubuntu and Windows. CI does not launch Electron, so if you changed the overlay,
hotkeys, injection or the control panel UI, say in the PR what you ran by hand.

Tests are plain `node --test` files in `tests/` that import from `dist/`. See
[`tests/README.md`](tests/README.md).

## Conventions

- **Commits** follow `type(scope): summary` (`fix(hotkey): …`, `feat(ui): …`, `docs(readme): …`).
  Explain the why in the body.
- **Settings.** A new config key goes in `src/main/config/schema.ts`, `defaults.ts` and the
  resolver, **and** in the README's settings reference table. `tests/readme-settings.test.mjs`
  fails if the table, the schema, the CLI flags or the environment variables disagree.
- **UI.** The look is "ink on paper": one highlighter-yellow fill for primary actions, blue for
  links and focus, light and dark following the OS, and no purple (a test enforces it). Prefer a
  real improvement to how something works over recolouring it. Text and controls have contrast
  tests in `tests/ui-accessibility.test.mjs`; keep them passing.
- **Privacy.** Anything that sends new data to the LLM provider must be opt-in, off by default, and
  described in the README's Voice & context section.
- **Dependencies** are updated by Dependabot; avoid adding new ones for small conveniences.

## Reporting security issues

Privately, please: see [SECURITY.md](SECURITY.md).
