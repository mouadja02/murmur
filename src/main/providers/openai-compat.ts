import type { LlmProvider, ProviderConfig, RefineRequest, RefineResponse } from './types.js';
import { stripThink } from './types.js';

interface OpenAiModelsResponse {
  data: { id: string }[];
}

interface OpenAiChatChoice {
  index: number;
  message: { role: string; content: string };
  finish_reason?: string;
}

interface OpenAiChatResponse {
  id?: string;
  choices: OpenAiChatChoice[];
}

/**
 * OpenAI Chat Completions compatible provider. Works with:
 * - LM Studio (default base URL: http://localhost:1234/v1)
 * - llama.cpp server (default: http://localhost:8080/v1)
 * - vLLM, text-generation-webui (oobabooga), Jan, KoboldCpp, etc.
 * - Ollama's OpenAI-compat endpoint (http://localhost:11434/v1)
 *
 * Note: the user supplies the FULL base URL including the `/v1` segment.
 * We don't try to be clever about appending it.
 */
export class OpenAiCompatProvider implements LlmProvider {
  constructor(public readonly config: ProviderConfig) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) h.Authorization = `Bearer ${this.config.apiKey}`;
    return h;
  }

  async refine({ systemPrompt, userPrompt }: RefineRequest): Promise<RefineResponse> {
    const started = Date.now();

    const body = {
      model: this.config.model,
      stream: false,
      temperature: this.config.temperature,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    };

    const res = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`${this.config.displayName} chat/completions HTTP ${res.status}: ${errText}`);
    }

    const data = (await res.json()) as OpenAiChatResponse;
    const raw = data.choices[0]?.message?.content ?? '';
    return { text: stripThink(raw), durationMs: Date.now() - started };
  }

  async preflight(): Promise<string | null> {
    let models: OpenAiModelsResponse;
    try {
      const res = await fetch(`${this.config.baseUrl}/models`, {
        method: 'GET',
        headers: this.headers(),
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) {
        return (
          `${this.config.displayName} at ${this.config.baseUrl} responded ` +
          `with HTTP ${res.status} on GET /models. Is the server running and ` +
          `is the base URL correct? (LM Studio default: http://localhost:1234/v1)`
        );
      }
      models = (await res.json()) as OpenAiModelsResponse;
    } catch (err) {
      return (
        `${this.config.displayName} not reachable at ${this.config.baseUrl} ` +
        `(${(err as Error).message}). Check that the local server is running ` +
        `and that --base-url matches.`
      );
    }

    const wanted = this.config.model;
    const ids = models.data.map((m) => m.id);
    const has = ids.some((id) => id === wanted || id.endsWith(`/${wanted}`));
    if (!has) {
      const sample = ids.slice(0, 5).join(', ');
      return (
        `Model '${wanted}' not found at ${this.config.baseUrl}. ` +
        `Available (first 5): ${sample || '(none)'}`
      );
    }

    return null;
  }
}
