// Electron-free so the polling rules can be tested under plain node;
// `clipboard.ts` wires it to Electron's clipboard.

export interface ClipboardEntry {
  text: string;
  timestamp: number;
}

export interface ClipboardAdapter {
  readText(): Promise<string>;
  /**
   * True when whatever owns the clipboard marked its content as sensitive
   * (password managers do, so clipboard managers skip it).
   */
  isConcealed(): Promise<boolean>;
}

export interface ClipboardMonitorOptions {
  pollMs?: number;
  now?: () => number;
}

/** Entries older than this are no longer shared as context. */
export const CLIPBOARD_CONTEXT_MAX_AGE_MS = 5 * 60_000;

const MAX_ENTRY_LENGTH = 500;
const MAX_HISTORY_SIZE = 5;
const MAX_OWN_WRITES = 10;

export function createClipboardMonitor(
  adapter: ClipboardAdapter,
  { pollMs = 500, now = Date.now }: ClipboardMonitorOptions = {},
) {
  const history: ClipboardEntry[] = [];
  let lastText: string | null = null;
  let interval: NodeJS.Timeout | null = null;
  let polling = false;

  // Text Murmur itself put on the clipboard (pasted prompts). Without this the
  // previous refined prompt would come back as "clipboard context" next time.
  const ownWrites: string[] = [];

  /**
   * True when `text` must not be recorded: it is flagged as concealed, or the
   * clipboard changed during the check (the next poll handles the newer copy).
   * The clipboard is read again after the format check so the flag is known to
   * belong to this text. If the platform can't answer, the text is recorded
   * (the age limit still bounds what is shared).
   */
  async function isConcealedText(text: string): Promise<boolean> {
    try {
      return (await adapter.isConcealed()) || (await adapter.readText()) !== text;
    } catch {
      return false;
    }
  }

  async function poll(): Promise<void> {
    if (polling) return;
    polling = true;
    try {
      const text = await adapter.readText();
      if (text && text !== lastText) {
        lastText = text;
        if (ownWrites.includes(text)) return;
        if (await isConcealedText(text)) return;
        history.unshift({ text: text.slice(0, MAX_ENTRY_LENGTH), timestamp: now() });
        if (history.length > MAX_HISTORY_SIZE) history.pop();
      }
    } catch {
    } finally {
      polling = false;
    }
  }

  return {
    ignore(text: string): void {
      ownWrites.push(text);
      if (ownWrites.length > MAX_OWN_WRITES) ownWrites.shift();
    },

    /** Resolves once the initial clipboard content has been noted (not recorded). */
    start(): Promise<void> {
      if (interval) return Promise.resolve();
      // The read is async since Electron 44; `polling` keeps a slow read from
      // overlapping the next tick and from racing the initial seed read.
      polling = true;
      lastText = null;
      const seeded = adapter
        .readText()
        .then((text) => {
          lastText = text;
        })
        .catch(() => {})
        .finally(() => {
          polling = false;
        });
      interval = setInterval(poll, pollMs);
      return seeded;
    },

    /** Stops polling and forgets everything captured, so re-enabling starts empty. */
    stop(): void {
      if (interval) {
        clearInterval(interval);
        interval = null;
      }
      history.length = 0;
      lastText = null;
    },

    poll,

    /** Up to `count` newest entries copied within the last `maxAgeMs`. */
    history(count: number, maxAgeMs = CLIPBOARD_CONTEXT_MAX_AGE_MS): ClipboardEntry[] {
      const cutoff = now() - maxAgeMs;
      return history.filter((entry) => entry.timestamp >= cutoff).slice(0, count);
    },

    clear(): void {
      history.length = 0;
    },
  };
}
