import { existsSync } from 'node:fs';
import type { ResolvedConfig } from './config/index.js';
import type { LlmProvider } from './providers/index.js';

export interface PreflightResult {
  ok: boolean;
  messages: string[];
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
      `whisper.cpp binary not found at ${cfg.whisperCliPath}. ` +
        'Run: pnpm setup:whisper  (or set --whisper-cli / WHISPER_CLI_PATH)',
    );
  }

  if (!existsSync(cfg.whisperModelPath)) {
    errors.push(
      `whisper model not found at ${cfg.whisperModelPath}. ` +
        'Run: pnpm setup:whisper  (or set --whisper-model / WHISPER_MODEL_PATH)',
    );
  }

  return { ok: errors.length === 0, messages: errors };
}
