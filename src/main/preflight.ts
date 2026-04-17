import { existsSync } from 'node:fs';
import { CONFIG } from '../shared/constants.js';

export interface PreflightResult {
  ok: boolean;
  messages: string[];
}

interface OllamaTagsResponse {
  models: { name: string; model?: string }[];
}

export async function runPreflight(): Promise<PreflightResult> {
  const errors: string[] = [];

  let tagsResponse: OllamaTagsResponse | null = null;
  try {
    const res = await fetch(`${CONFIG.ollamaUrl}/api/tags`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      errors.push(
        `Ollama at ${CONFIG.ollamaUrl} responded with HTTP ${res.status}. ` +
          'Is the server running? Start it with: ollama serve',
      );
    } else {
      tagsResponse = (await res.json()) as OllamaTagsResponse;
    }
  } catch (err) {
    errors.push(
      `Ollama not reachable at ${CONFIG.ollamaUrl} (${(err as Error).message}). ` +
        'Install from https://ollama.com and run: ollama serve',
    );
  }

  if (tagsResponse) {
    const has = tagsResponse.models.some(
      (m) =>
        m.name === CONFIG.llmModel ||
        m.name.startsWith(`${CONFIG.llmModel}-`) ||
        m.name.startsWith(`${CONFIG.llmModel}:`),
    );
    if (!has) {
      errors.push(
        `LLM model '${CONFIG.llmModel}' not found in Ollama. ` +
          `Pull it with: ollama pull ${CONFIG.llmModel}`,
      );
    }
  }

  if (!existsSync(CONFIG.whisperCliPath)) {
    errors.push(
      `whisper.cpp binary not found at ${CONFIG.whisperCliPath}. ` +
        'Run: pnpm setup:whisper  (and make sure .env points to the downloaded paths)',
    );
  }

  if (!existsSync(CONFIG.whisperModelPath)) {
    errors.push(
      `whisper model not found at ${CONFIG.whisperModelPath}. ` +
        'Run: pnpm setup:whisper  (and make sure .env points to the downloaded paths)',
    );
  }

  return { ok: errors.length === 0, messages: errors };
}
