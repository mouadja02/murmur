import { existsSync } from 'node:fs';
import process from 'node:process';
import type { ResolvedConfig } from './config/index.js';
import type { LlmProvider } from './providers/index.js';

export interface PreflightResult {
  ok: boolean;
  messages: string[];
}

/** The right `setup:whisper` invocation depending on how the user installed murmur. */
function setupHint(): string {
  // When installed globally or via npx the pnpm script isn't available.
  // Detect whether we're running inside a pnpm workspace (dev/source checkout).
  const isDevCheckout =
    process.env.npm_execpath?.includes('pnpm') || process.env.npm_lifecycle_script !== undefined;
  if (isDevCheckout) return 'pnpm setup:whisper';
  return 'npx @mouadja02/murmur setup:whisper';
}

export async function runPreflight(
  cfg: ResolvedConfig,
  provider: LlmProvider,
): Promise<PreflightResult> {
  const errors: string[] = [];

  const providerError = await provider.preflight();
  if (providerError) errors.push(providerError);

  if (!existsSync(cfg.whisperCliPath)) {
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
