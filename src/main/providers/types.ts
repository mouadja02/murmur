export type ProviderId = 'ollama' | 'openai-compat' | 'anthropic';

export interface ProviderConfig {
  id: ProviderId;
  displayName: string;
  baseUrl: string;
  model: string;
  apiKey: string | null;
  temperature: number;
}

/** Screenshot attached to a refine request. */
export interface ImageAttachment {
  /** Raw base64, no `data:` prefix. */
  base64: string;
  mimeType: string;
}

export interface RefineRequest {
  systemPrompt: string;
  userPrompt: string;
  /** Optional screenshots for vision-capable models (opt-in `screenshotContext`). */
  images?: ImageAttachment[];
}

export type StopReason = 'end' | 'length' | 'aborted' | 'unknown';

export interface RefineResponse {
  text: string;
  durationMs: number;
  /** Normalized provider completion reason used by the pipeline safety gate. */
  stopReason: StopReason;
}

export function normalizeStopReason(reason: string | null | undefined): StopReason {
  switch (reason) {
    case 'stop':
    case 'end_turn':
    case 'stop_sequence':
    case 'done':
    case 'eos':
      return 'end';
    case 'length':
    case 'max_tokens':
      return 'length';
    case 'abort':
    case 'aborted':
    case 'cancelled':
      return 'aborted';
    default:
      return 'unknown';
  }
}

export interface StreamRefineOptions {
  onToken: (token: string) => void;
}

export interface LlmProvider {
  readonly config: ProviderConfig;
  refine(req: RefineRequest): Promise<RefineResponse>;
  refineStream(req: RefineRequest, opts: StreamRefineOptions): Promise<RefineResponse>;
  /**
   * Verifies the provider is reachable and `config.model` is available.
   * Returns `null` if everything is fine, otherwise a human-readable error
   * message intended for the preflight log.
   */
  preflight(): Promise<string | null>;
  /**
   * Fires a silent no-op request to pre-load the model into memory.
   * Must not throw — errors are logged and swallowed by the caller.
   * Returns wall-clock latency in milliseconds.
   */
  prewarm?(): Promise<number>;
}

export const THINK_BLOCK = /<think>[\s\S]*?<\/think>/g;

export function stripThink(text: string): string {
  return text.replace(THINK_BLOCK, '').trim();
}

const THINK_OPEN = '<think>';
const THINK_CLOSE = '</think>';

export interface ThinkFilter {
  push(chunk: string): void;
  /** Emit any held-back text once the stream has ended. */
  flush(): void;
}

/**
 * Streaming counterpart of {@link stripThink}: forwards visible text to
 * `onToken` while swallowing `<think>…</think>` blocks, even when the tags are
 * split across chunks. Leading whitespace before the first visible token is
 * dropped, matching `stripThink`'s trim.
 *
 * Without this, reasoning models (qwen3 / DeepSeek-R1 on LM Studio or
 * llama.cpp) stream their chain of thought into the overlay preview and —
 * with progressive injection — type it straight into the user's editor.
 */
export function createThinkFilter(onToken: (token: string) => void): ThinkFilter {
  let pending = '';
  let inThink = false;
  let started = false;

  const emit = (text: string) => {
    const out = started ? text : text.trimStart();
    if (!out) return;
    started = true;
    onToken(out);
  };

  /** Length of the longest suffix of `s` that is a proper prefix of `tag`. */
  const partialTagLength = (s: string, tag: string) => {
    for (let n = Math.min(s.length, tag.length - 1); n > 0; n--) {
      if (tag.startsWith(s.slice(-n))) return n;
    }
    return 0;
  };

  return {
    push(chunk) {
      pending += chunk;
      while (pending) {
        if (inThink) {
          const end = pending.indexOf(THINK_CLOSE);
          if (end < 0) {
            pending = pending.slice(pending.length - partialTagLength(pending, THINK_CLOSE));
            return;
          }
          pending = pending.slice(end + THINK_CLOSE.length);
          inThink = false;
          continue;
        }
        const start = pending.indexOf(THINK_OPEN);
        if (start >= 0) {
          emit(pending.slice(0, start));
          pending = pending.slice(start + THINK_OPEN.length);
          inThink = true;
          continue;
        }
        const hold = partialTagLength(pending, THINK_OPEN);
        emit(pending.slice(0, pending.length - hold));
        pending = pending.slice(pending.length - hold);
        return;
      }
    },
    flush() {
      if (!inThink) emit(pending);
      pending = '';
    },
  };
}

export async function parseSseStream(
  body: ReadableStream<Uint8Array>,
  onEvent: (eventType: string, data: string) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const dispatch = (event: string) => {
    let eventType = 'message';
    let data = '';
    for (const line of event.split('\n')) {
      if (line.startsWith('event:')) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        data += (data ? '\n' : '') + line.slice(5).trim();
      }
    }
    if (data) onEvent(eventType, data);
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // Some servers (and proxies in front of llama.cpp / vLLM) use CRLF.
      // Without normalising, no "\n\n" boundary is ever found and the whole
      // response is silently dropped.
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');

      const events = buffer.split('\n\n');
      buffer = events.pop() ?? '';
      for (const event of events) dispatch(event);
    }
    // A final event without a trailing blank line is still an event.
    buffer = (buffer + decoder.decode()).replace(/\r\n/g, '\n');
    if (buffer.trim()) dispatch(buffer);
  } finally {
    reader.releaseLock();
  }
}
