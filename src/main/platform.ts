import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Is `bin` a bare command (just a name, no path separators)?
 * Bare commands are resolved against the system `PATH` at runtime.
 */
export function isBareCommand(bin: string): boolean {
  return !bin.includes(path.sep) && !bin.includes('/') && !bin.includes('\\');
}

/**
 * Returns true if `commandOrPath` exists on disk or is a bare command on `PATH`.
 */
export function commandAvailable(commandOrPath: string): boolean {
  if (existsSync(commandOrPath)) return true;
  if (isBareCommand(commandOrPath)) return isOnPath(commandOrPath);
  return false;
}

/**
 * Returns true if `bin` is a bare command resolvable on the system `PATH`.
 * Uses `where` on Windows, `command -v` elsewhere. Both exit non-zero when
 * the command is not found.
 */
export function isOnPath(bin: string): boolean {
  if (!isBareCommand(bin)) return false;
  if (process.platform === 'win32') {
    const res = spawnSync('where', [bin], { stdio: 'ignore' });
    return res.status === 0;
  }
  // `command -v` is the POSIX-portable way; needs a shell to interpret it.
  const res = spawnSync('command', ['-v', bin], { stdio: 'ignore', shell: true });
  return res.status === 0;
}

/**
 * Returns true if the configured whisper binary is reachable — either as an
 * existing file (absolute path or cwd-relative) or as a bare command on `PATH`.
 *
 * Shared by the pre-launch auto-setup and the Electron-side preflight so they
 * agree on what "installed" means.
 */
export function whisperCliAvailable(cliPath: string): boolean {
  return commandAvailable(cliPath);
}
