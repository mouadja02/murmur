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
    // Early check: warn if the user likely forgot the /v1 suffix.
    // LM Studio / llama.cpp / vLLM all require it.
    if (!/\/v\d+\/?$/.test(this.config.baseUrl.replace(/\/$/, ''))) {
      return (
        `Base URL '${this.config.baseUrl}' does not end with a version segment like /v1. ` +
        `Most OpenAI-compatible servers require it — e.g. http://localhost:1234/v1`
      );
    }

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
      const raw = (await res.json()) as unknown;
      // Defensively normalise the response — some servers return the models list
      // directly as an array, others wrap it in { data: [...] }, and some (e.g.
      // LM Studio when the path is wrong) return an object with no data at all.
      if (Array.isArray(raw)) {
        models = { data: raw as { id: string }[] };
      } else if (
        raw !== null &&
        typeof raw === 'object' &&
        Array.isArray((raw as Record<string, unknown>).data)
      ) {
        models = raw as OpenAiModelsResponse;
      } else {
        // Server returned something we don't recognise.  Treat as "can't verify
        // model list" but don't hard-block — the server might still work fine.
        return null;
      }
    } catch (err) {
      return (
        `${this.config.displayName} not reachable at ${this.config.baseUrl} ` +
        `(${(err as Error).message}). Check that the local server is running ` +
        `and that --base-url matches.\n` +
        `Tip: for LM Studio include the /v1 segment: http://<host>:1234/v1`
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
