import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { recorderNotFoundMessage, splitCommandLine } from './audio/command.js';
import type { ResolvedConfig } from './config/index.js';
import { commandAvailable, whisperCliAvailable } from './platform.js';
import type { LlmProvider } from './providers/index.js';

export interface PreflightResult {
  ok: boolean;
  messages: string[];
}

export interface PreflightOptions {
  requireRecorder?: boolean;
}

/** The right `setup:whisper` invocation depending on how the user installed murmur. */
function setupHint(): string {
  // If the user is running from a dev checkout (there's a package.json in cwd
  // and pnpm is the execpath), `pnpm setup:whisper` works. In all other cases
  // (global npm install, npx, or any other cwd) use the npx form.
  const hasPkgJson = existsSync(path.join(process.cwd(), 'package.json'));
  const isPnpmRun = process.env.npm_execpath?.includes('pnpm') ?? false;
  return hasPkgJson && isPnpmRun ? 'pnpm setup:whisper' : 'npx @mouadja02/murmur setup:whisper';
}

export async function runPreflight(
  cfg: ResolvedConfig,
  provider: LlmProvider,
  opts: PreflightOptions = {},
): Promise<PreflightResult> {
  const errors: string[] = [];

  const providerError = await provider.preflight();
  if (providerError) errors.push(providerError);

  if (!whisperCliAvailable(cfg.whisperCliPath)) {
    errors.push(
      `whisper.cpp binary not found at ${cfg.whisperCliPath}.\n` +
        `  Fix: ${setupHint()}\n` +
        `       or pass --whisper-cli, or set whisperCliPath in config.json\n` +
        `       (WHISPER_CLI_PATH only applies while config.json has no whisperCliPath)`,
    );
  }

  if (!existsSync(cfg.whisperModelPath)) {
    errors.push(
      `whisper model not found at ${cfg.whisperModelPath}.\n` +
        `  Fix: ${setupHint()}\n` +
        `       or pass --whisper-model, or set whisperModelPath in config.json\n` +
        `       (WHISPER_MODEL_PATH only applies while config.json has no whisperModelPath)`,
    );
  }

  if (opts.requireRecorder) {
    const recorderProblem = checkRecorderCommand(cfg.recorderCommand);
    if (recorderProblem) errors.push(recorderProblem);
  }

  return { ok: errors.length === 0, messages: errors };
}

/**
 * Null when the recorder command parses and its executable exists; otherwise
 * what is wrong and how to fix it. `murmur serve` refuses to start on it; the
 * overlay only warns, because the recorder serves nothing but MCP `murmur_record`
 * there (dictation uses the overlay's own microphone capture).
 */
export function checkRecorderCommand(recorderCommand: string): string | null {
  let recorderBin: string;
  try {
    [recorderBin] = splitCommandLine(recorderCommand);
  } catch (err) {
    return `invalid recorder command: ${(err as Error).message}`;
  }
  if (commandAvailable(recorderBin)) return null;
  return `headless ${recorderNotFoundMessage(recorderBin)}`;
}
