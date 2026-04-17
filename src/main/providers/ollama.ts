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
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Ollama /api/generate HTTP ${res.status}: ${errText}`);
    }

    const data = (await res.json()) as OllamaGenerateResponse;
    return { text: stripThink(data.response), durationMs: Date.now() - started };
  }

  async preflight(): Promise<string | null> {
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
      tags = (await res.json()) as OllamaTagsResponse;
    } catch (err) {
      return (
        `Ollama not reachable at ${this.config.baseUrl} (${(err as Error).message}). ` +
        'Install from https://ollama.com and run: ollama serve'
      );
    }

    const wanted = this.config.model;
    const has = tags.models.some(
      (m) => m.name === wanted || m.name.startsWith(`${wanted}-`) || m.name.startsWith(`${wanted}:`),
    );
    if (!has) {
      return `LLM model '${wanted}' not found in Ollama. Pull it with: ollama pull ${wanted}`;
    }

    return null;
  }
}
