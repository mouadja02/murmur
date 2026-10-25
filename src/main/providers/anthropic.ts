import type {
  LlmProvider,
  ProviderConfig,
  RefineRequest,
  RefineResponse,
  StopReason,
  StreamRefineOptions,
} from './types.js';
import { createThinkFilter, normalizeStopReason, parseSseStream, stripThink } from './types.js';

interface AnthropicContentBlock {
  type: 'text' | string;
  text?: string;
}

interface AnthropicMessagesResponse {
  id?: string;
  content: AnthropicContentBlock[];
  stop_reason?: string | null;
}

interface AnthropicModelItem {
  id: string;
  display_name?: string;
}

interface AnthropicModelsResponse {
  data: AnthropicModelItem[];
}

interface AnthropicStreamEvent {
  type: string;
  delta?: { type?: string; text?: string; stop_reason?: string | null };
  index?: number;
  error?: { type?: string; message?: string };
}

/**
 * Anthropic Claude provider.
 *
 * Base URL convention: the user supplies the root including `/v1`
 * (e.g. `https://api.anthropic.com/v1`). The provider appends
 * `/messages` and `/models` to form the full endpoint URLs, which
 * mirrors the openai-compat pattern and keeps presets unambiguous.
 *
 * Required: `config.apiKey` must be a valid Anthropic API key.
 *
 * Online provider — audio transcriptions and refined prompts
 * leave your machine and are processed on Anthropic's servers.
 */
export class AnthropicProvider implements LlmProvider {
  constructor(public readonly config: ProviderConfig) {}

  private maxOutputTokens(userPrompt: string): number {
    // Keep enough room for long dictations while respecting a predictable
    // upper bound for providers with smaller context windows.
    return Math.min(8192, Math.max(2048, Math.ceil(userPrompt.length / 2)));
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.config.apiKey ?? '',
      'anthropic-version': '2023-06-01',
    };
  }

  private messages({ userPrompt, images }: RefineRequest): unknown[] {
    const content = images?.length
      ? [
          ...images.map((img) => ({
            type: 'image',
            source: { type: 'base64', media_type: img.mimeType, data: img.base64 },
          })),
          { type: 'text', text: userPrompt },
        ]
      : userPrompt;
    return [{ role: 'user', content }];
  }

  async refine(req: RefineRequest): Promise<RefineResponse> {
    const started = Date.now();

    const body = {
      model: this.config.model,
      max_tokens: this.maxOutputTokens(req.userPrompt),
      temperature: this.config.temperature,
      system: req.systemPrompt,
      messages: this.messages(req),
    };

    const res = await fetch(`${this.config.baseUrl}/messages`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Anthropic /messages HTTP ${res.status}: ${errText}`);
    }

    const data = (await res.json()) as AnthropicMessagesResponse;
    const raw = data.content.find((b) => b.type === 'text')?.text ?? '';
    return {
      text: stripThink(raw),
      durationMs: Date.now() - started,
      stopReason: normalizeStopReason(data.stop_reason),
    };
  }

  async refineStream(
    req: RefineRequest,
    { onToken }: StreamRefineOptions,
  ): Promise<RefineResponse> {
    const started = Date.now();

    const body = {
      model: this.config.model,
      max_tokens: this.maxOutputTokens(req.userPrompt),
      temperature: this.config.temperature,
      system: req.systemPrompt,
      stream: true,
      messages: this.messages(req),
    };

    const res = await fetch(`${this.config.baseUrl}/messages`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Anthropic /messages HTTP ${res.status}: ${errText}`);
    }

    if (!res.body) {
      throw new Error('Anthropic returned no response body for streaming request');
    }

    let fullText = '';
    let stopReason: StopReason = 'unknown';
    let sawMessageStop = false;
    const visible = createThinkFilter(onToken);

    await parseSseStream(res.body, (_eventType, data) => {
      let event: AnthropicStreamEvent;
      try {
        event = JSON.parse(data) as AnthropicStreamEvent;
      } catch {
        return; /* skip malformed SSE data lines */
      }
      // e.g. overloaded_error mid-stream; surface it instead of reporting an
      // "empty refinement".
      if (event.type === 'error') {
        throw new Error(
          `Anthropic stream error: ${event.error?.type ?? 'error'}: ${event.error?.message ?? ''}`,
        );
      }
      if (event.type === 'message_delta' && event.delta?.stop_reason) {
        stopReason = normalizeStopReason(event.delta.stop_reason);
      }
      if (event.type === 'message_stop') {
        sawMessageStop = true;
      }
      if (event.type === 'content_block_delta' && event.delta?.text) {
        fullText += event.delta.text;
        visible.push(event.delta.text);
      }
    });
    if (!sawMessageStop) stopReason = 'aborted';
    visible.flush();

    return {
      text: stripThink(fullText),
      durationMs: Date.now() - started,
      stopReason,
    };
  }

  async prewarm(): Promise<number> {
    const started = Date.now();
    try {
      await fetch(`${this.config.baseUrl}/messages`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          model: this.config.model,
          max_tokens: 1,
          messages: [{ role: 'user', content: ' ' }],
        }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      /* non-fatal */
    }
    return Date.now() - started;
  }

  async preflight(): Promise<string | null> {
    if (!this.config.apiKey) {
      return 'Anthropic requires an API key. Get one at https://console.anthropic.com/settings/api-keys';
    }

    let models: AnthropicModelsResponse;
    try {
      // The list is paginated (20 per page by default); without a high limit a
      // perfectly valid model can be reported as "not found" and block launch.
      const res = await fetch(`${this.config.baseUrl}/models?limit=1000`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        return (
          `Anthropic API returned HTTP ${res.status}. ` +
          'Check that your API key is valid and has the Messages permission.'
        );
      }
      models = (await res.json()) as AnthropicModelsResponse;
    } catch (err) {
      return (
        `Anthropic not reachable at ${this.config.baseUrl} ` +
        `(${(err as Error).message}). Check your internet connection.`
      );
    }

    const wanted = this.config.model;
    const available = models.data.map((m) => m.id);
    if (!available.some((id) => id === wanted || id.startsWith(wanted))) {
      const sample = available.slice(0, 5).join(', ');
      return (
        `Model '${wanted}' not found in Anthropic. ` +
        `Available (first 5): ${sample || '(none returned)'}`
      );
    }

    return null;
  }
}
