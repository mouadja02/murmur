import type {
  LlmProvider,
  ProviderConfig,
  RefineRequest,
  RefineResponse,
  StopReason,
  StreamRefineOptions,
} from './types.js';
import { createThinkFilter, normalizeStopReason, parseSseStream, stripThink } from './types.js';

interface OpenAiModelsResponse {
  data: { id: string }[];
}

interface OpenAiChatChoice {
  index: number;
  message: { role: string; content: string };
  finish_reason?: string | null;
}

interface OpenAiChatResponse {
  id?: string;
  choices: OpenAiChatChoice[];
}

interface OpenAiStreamDelta {
  choices?: Array<{
    delta: { content?: string };
    finish_reason?: string | null;
  }>;
  /** llama.cpp / vLLM / LM Studio report mid-stream failures this way. */
  error?: { message?: string };
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

  private messages({ systemPrompt, userPrompt, images }: RefineRequest): unknown[] {
    const user = images?.length
      ? [
          { type: 'text', text: userPrompt },
          ...images.map((img) => ({
            type: 'image_url',
            image_url: { url: `data:${img.mimeType};base64,${img.base64}` },
          })),
        ]
      : userPrompt;
    return [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: user },
    ];
  }

  async refine(req: RefineRequest): Promise<RefineResponse> {
    const started = Date.now();

    const body = {
      model: this.config.model,
      stream: false,
      temperature: this.config.temperature,
      messages: this.messages(req),
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
    const choice = data.choices[0];
    const raw = choice?.message?.content ?? '';
    return {
      text: stripThink(raw),
      durationMs: Date.now() - started,
      stopReason: normalizeStopReason(choice?.finish_reason),
    };
  }

  async refineStream(
    req: RefineRequest,
    { onToken }: StreamRefineOptions,
  ): Promise<RefineResponse> {
    const started = Date.now();

    const body = {
      model: this.config.model,
      stream: true,
      temperature: this.config.temperature,
      messages: this.messages(req),
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

    if (!res.body) {
      throw new Error('OpenAI-compat server returned no response body for streaming request');
    }

    let fullText = '';
    let finishReason: StopReason = 'unknown';
    let sawDone = false;
    const visible = createThinkFilter(onToken);

    await parseSseStream(res.body, (_eventType, data) => {
      if (data === '[DONE]') {
        sawDone = true;
        return;
      }
      let parsed: OpenAiStreamDelta;
      try {
        parsed = JSON.parse(data) as OpenAiStreamDelta;
      } catch {
        return; /* skip malformed SSE data lines */
      }
      if (parsed.error) {
        throw new Error(
          `${this.config.displayName} stream error: ${parsed.error.message ?? JSON.stringify(parsed.error)}`,
        );
      }
      const choice = parsed.choices?.[0];
      if (choice?.finish_reason) finishReason = normalizeStopReason(choice.finish_reason);
      const content = choice?.delta?.content;
      if (content) {
        fullText += content;
        visible.push(content);
      }
    });
    // An explicit finish_reason is authoritative; some servers close the stream
    // without a trailing [DONE]. Only a stream with neither was cut off.
    if (!sawDone && finishReason === 'unknown') finishReason = 'aborted';
    visible.flush();

    return {
      text: stripThink(fullText),
      durationMs: Date.now() - started,
      stopReason: finishReason,
    };
  }

  async prewarm(): Promise<number> {
    const started = Date.now();
    try {
      await fetch(`${this.config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          model: this.config.model,
          messages: [{ role: 'user', content: ' ' }],
          max_tokens: 1,
          stream: false,
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      /* non-fatal */
    }
    return Date.now() - started;
  }

  async preflight(): Promise<string | null> {
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
      if (Array.isArray(raw)) {
        models = { data: raw as { id: string }[] };
      } else if (
        raw !== null &&
        typeof raw === 'object' &&
        Array.isArray((raw as Record<string, unknown>).data)
      ) {
        models = raw as OpenAiModelsResponse;
      } else {
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
