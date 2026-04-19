import type { LlmProvider, ProviderConfig, RefineRequest, RefineResponse } from './types.js';
import { stripThink } from './types.js';

interface OllamaTagsResponse {
  models: { name: string; model?: string }[];
}

interface OllamaGenerateResponse {
  response: string;
  done: boolean;
}

export class OllamaProvider implements LlmProvider {
  constructor(public readonly config: ProviderConfig) {}

  async refine({ systemPrompt, userPrompt }: RefineRequest): Promise<RefineResponse> {
    const started = Date.now();

    const body = {
      model: this.config.model,
      system: systemPrompt,
      prompt: userPrompt,
      stream: false,
      think: false,
      options: {
        temperature: this.config.temperature,
      },
    };

    const res = await fetch(`${this.config.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Ollama /api/generate HTTP ${res.status}: ${errText}`);
    }

    const data = (await res.json()) as OllamaGenerateResponse;
    return { text: stripThink(data.response), durationMs: Date.now() - started };
  }

  async preflight(): Promise<string | null> {
    // Warn early if the base URL looks like an OpenAI-compat server (e.g. LM
    // Studio on :1234) rather than a real Ollama instance.  Ollama's default
    // port is 11434; anything that ends with /v1 is almost certainly wrong.
    const urlLower = this.config.baseUrl.toLowerCase().replace(/\/$/, '');
    if (urlLower.endsWith('/v1') || urlLower.endsWith(':1234')) {
      return (
        `The base URL '${this.config.baseUrl}' looks like an OpenAI-compatible server ` +
        `(e.g. LM Studio), not an Ollama instance. ` +
        `Switch provider to "openai-compat" in the control panel, or point the URL at your Ollama server ` +
        `(default: http://localhost:11434).`
      );
    }

    let tags: OllamaTagsResponse;
    try {
      const res = await fetch(`${this.config.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) {
        return (
          `Ollama at ${this.config.baseUrl} responded with HTTP ${res.status}. ` +
          'Is the server running? Start it with: ollama serve'
        );
      }
      const raw = (await res.json()) as unknown;
      // Normalise: Ollama always returns { models: [...] }.  Guard defensively
      // in case the endpoint returns a different shape (e.g. the user pointed
      // the base URL at a non-Ollama server by mistake).
      if (
        raw !== null &&
        typeof raw === 'object' &&
        Array.isArray((raw as Record<string, unknown>).models)
      ) {
        tags = raw as OllamaTagsResponse;
      } else {
        // Can't verify the model list — skip the check rather than crash.
        return null;
      }
    } catch (err) {
      return (
        `Ollama not reachable at ${this.config.baseUrl} (${(err as Error).message}). ` +
        'Install from https://ollama.com and run: ollama serve'
      );
    }

    const wanted = this.config.model;
    const has = tags.models.some(
      (m) =>
        m.name === wanted || m.name.startsWith(`${wanted}-`) || m.name.startsWith(`${wanted}:`),
    );
    if (!has) {
      return `LLM model '${wanted}' not found in Ollama. Pull it with: ollama pull ${wanted}`;
    }

    return null;
  }
}
