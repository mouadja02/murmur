#!/usr/bin/env node
// Murmur CLI entrypoint.
//
// When users `npm install -g @mouadja02/murmur` (or run `npx @mouadja02/murmur`),
// this script is the executable. It runs the interactive pre-launch banner, then
// spawns Electron with the packaged main process bundle. CWD is preserved so
// relative paths (logs/, skills/) resolve where the user expects them.
//
// Special sub-commands (e.g. `setup:whisper`) are intercepted here before
// Electron is involved, so they work from any directory.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgRoot = path.resolve(__dirname, '..');

const userArgs = process.argv.slice(2);

// ── Sub-command: setup:whisper ────────────────────────────────────────────────
// `npx @mouadja02/murmur setup:whisper` dispatches to the cross-platform
// setup script without needing a checkout or a pnpm workspace.
if (userArgs[0] === 'setup:whisper') {
  const setupScript = path.join(pkgRoot, 'scripts', 'setup-whisper.mjs');
  if (!existsSync(setupScript)) {
    console.error('[murmur] setup script not found at', setupScript);
    process.exit(1);
  }
  const child = spawnSync(process.execPath, [setupScript, ...userArgs.slice(1)], {
    stdio: 'inherit',
    cwd: process.cwd(),
  });
  process.exit(child.status ?? 0);
}

const preLaunchPath = path.join(pkgRoot, 'dist', 'main', 'cli', 'pre-launch.js');
const electronEntry = path.join(pkgRoot, 'dist', 'main', 'index.js');

if (!existsSync(preLaunchPath) || !existsSync(electronEntry)) {
  console.error('[murmur] the package is missing its compiled dist/ output.');
  console.error("        If you're running from a git checkout, run `pnpm build` first.");
  process.exit(1);
}

const skipPrelaunch =
  userArgs.includes('--no-prelaunch') ||
  userArgs.includes('--quiet') ||
  userArgs.includes('--help') ||
  userArgs.includes('-h') ||
  userArgs.includes('--print-config') ||
  !process.stdin.isTTY;

if (!skipPrelaunch) {
  const pre = spawnSync(process.execPath, [preLaunchPath, ...userArgs], {
    stdio: 'inherit',
  });
  if (pre.status !== 0) process.exit(pre.status ?? 1);
}

let electronBinary;
try {
  const require_ = createRequire(import.meta.url);
  electronBinary = require_('electron');
} catch (err) {
  console.error('[murmur] could not resolve the Electron binary:', err?.message ?? err);
  console.error('        Install electron or reinstall murmur.');
  process.exit(1);
}

if (typeof electronBinary !== 'string' || !existsSync(electronBinary)) {
  console.error(`[murmur] Electron binary not found at ${electronBinary ?? '(unresolved)'}`);
  process.exit(1);
}

const child = spawn(electronBinary, [electronEntry, '--', ...userArgs], {
  stdio: 'inherit',
  // electron.exe on Windows is a plain PE binary, not a .cmd wrapper, so we do
  // NOT need shell:true when invoking it via the path returned by require('electron').
  shell: false,
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});

child.on('error', (err) => {
  console.error('[murmur] failed to spawn Electron:', err);
  process.exit(1);
});
