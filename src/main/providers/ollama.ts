import type {
  LlmProvider,
  ProviderConfig,
  RefineRequest,
  RefineResponse,
  StopReason,
  StreamRefineOptions,
} from './types.js';
import { createThinkFilter, normalizeStopReason, stripThink } from './types.js';

interface OllamaTagsResponse {
  models: { name: string; model?: string }[];
}

interface OllamaGenerateResponse {
  response: string;
  done: boolean;
  done_reason?: string | null;
  error?: string;
}

export class OllamaProvider implements LlmProvider {
  constructor(public readonly config: ProviderConfig) {}

  async refine({ systemPrompt, userPrompt, images }: RefineRequest): Promise<RefineResponse> {
    const started = Date.now();

    const body = {
      model: this.config.model,
      system: systemPrompt,
      prompt: userPrompt,
      ...(images?.length ? { images: images.map((img) => img.base64) } : {}),
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
    return {
      text: stripThink(data.response),
      durationMs: Date.now() - started,
      stopReason: data.done ? normalizeStopReason(data.done_reason ?? 'done') : 'aborted',
    };
  }

  async refineStream(
    { systemPrompt, userPrompt, images }: RefineRequest,
    { onToken }: StreamRefineOptions,
  ): Promise<RefineResponse> {
    const started = Date.now();

    const body = {
      model: this.config.model,
      system: systemPrompt,
      prompt: userPrompt,
      ...(images?.length ? { images: images.map((img) => img.base64) } : {}),
      stream: true,
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

    if (!res.body) {
      throw new Error('Ollama returned no response body for streaming request');
    }

    let fullText = '';
    const visible = createThinkFilter(onToken);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let doneReason: StopReason = 'unknown';
    let sawDone = false;

    const handleLine = (line: string) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      const chunk = JSON.parse(trimmed) as OllamaGenerateResponse;
      // Ollama reports failures mid-stream (e.g. model OOM) as {"error": "..."}
      // with HTTP 200; without this they surfaced as "empty refinement".
      if (chunk.error) throw new Error(`Ollama: ${chunk.error}`);
      if (chunk.done) sawDone = true;
      if (chunk.done_reason) doneReason = normalizeStopReason(chunk.done_reason);
      if (chunk.response) {
        fullText += chunk.response;
        visible.push(chunk.response);
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) handleLine(line);
      }
      handleLine(buffer + decoder.decode());
    } finally {
      reader.releaseLock();
    }
    if (!sawDone) doneReason = 'aborted';
    else if (doneReason === 'unknown') doneReason = 'end';
    visible.flush();

    return {
      text: stripThink(fullText),
      durationMs: Date.now() - started,
      stopReason: doneReason,
    };
  }

  async prewarm(): Promise<number> {
    const started = Date.now();
    try {
      await fetch(`${this.config.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.config.model,
          prompt: '',
          keep_alive: '5m',
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
      if (
        raw !== null &&
        typeof raw === 'object' &&
        Array.isArray((raw as Record<string, unknown>).models)
      ) {
        tags = raw as OllamaTagsResponse;
      } else {
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
