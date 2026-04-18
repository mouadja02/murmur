import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import type { ResolvedConfig } from './config/index.js';
import { whisperCliAvailable } from './platform.js';
import type { LlmProvider } from './providers/index.js';

export interface PreflightResult {
  ok: boolean;
  messages: string[];
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
): Promise<PreflightResult> {
  const errors: string[] = [];

  const providerError = await provider.preflight();
  if (providerError) errors.push(providerError);

  if (!whisperCliAvailable(cfg.whisperCliPath)) {
    errors.push(
      `whisper.cpp binary not found at ${cfg.whisperCliPath}.\n` +
        `  Fix: ${setupHint()}\n` +
        `       or set --whisper-cli / WHISPER_CLI_PATH to an existing binary`,
    );
  }

  if (!existsSync(cfg.whisperModelPath)) {
    errors.push(
      `whisper model not found at ${cfg.whisperModelPath}.\n` +
        `  Fix: ${setupHint()}\n` +
        `       or set --whisper-model / WHISPER_MODEL_PATH to an existing .bin file`,
    );
  }

  return { ok: errors.length === 0, messages: errors };
}
