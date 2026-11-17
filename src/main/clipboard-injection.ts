import type { ClipboardRetention, InjectionMethod } from './config/index.js';

export interface ClipboardAdapter {
  readText(): string | Promise<string>;
  writeText(text: string): void | Promise<void>;
}

export interface KeyboardAdapter {
  type(...keysOrText: unknown[]): Promise<unknown>;
}

export interface ClipboardInjectionDeps {
  clipboard: ClipboardAdapter;
  keyboard: KeyboardAdapter;
  keys: {
    pasteModifier: unknown;
    v: unknown;
  };
  sleep: (ms: number) => Promise<void>;
  /**
   * Told about every text this module is about to put on the clipboard (the
   * generated prompt and, with `restore-previous`, the text it puts back), so
   * the clipboard-context monitor does not record Murmur's own writes as copies.
   */
  noteOwnWrite: (text: string) => void;
  logger?: Pick<Console, 'warn'>;
}

export interface ClipboardInjectionOptions {
  clipboardRestoreDelayMs: number;
  clipboardRetention: ClipboardRetention;
  injectionMethod: InjectionMethod;
}

/** Every clipboard write goes through here, announced before it lands. */
async function writeOwnText(deps: ClipboardInjectionDeps, text: string): Promise<void> {
  deps.noteOwnWrite(text);
  await deps.clipboard.writeText(text);
}

async function pasteViaClipboard(
  text: string,
  opts: ClipboardInjectionOptions,
  deps: ClipboardInjectionDeps,
): Promise<void> {
  const previous = await deps.clipboard.readText();
  await writeOwnText(deps, text);

  await deps.sleep(30);

  const written = await deps.clipboard.readText();
  if (written !== text) {
    if (opts.clipboardRetention === 'restore-previous') await writeOwnText(deps, previous);
    throw new Error('clipboard write verification failed');
  }

  try {
    await deps.keyboard.type(deps.keys.pasteModifier, deps.keys.v);
    await deps.sleep(opts.clipboardRestoreDelayMs);
  } finally {
    // Putting the previous text back is Murmur's write too: seen as a fresh
    // copy, a concealed or expired entry would become clipboard context again.
    if (opts.clipboardRetention === 'restore-previous') await writeOwnText(deps, previous);
  }
}

export async function injectGeneratedText(
  text: string,
  opts: ClipboardInjectionOptions,
  deps: ClipboardInjectionDeps,
): Promise<void> {
  if (opts.injectionMethod === 'type') {
    await writeOwnText(deps, text);
    await deps.keyboard.type(text);
    return;
  }

  try {
    await pasteViaClipboard(text, opts, deps);
  } catch (err) {
    if (opts.injectionMethod !== 'auto') throw err;
    deps.logger?.warn('[inject] clipboard paste failed, falling back to keyboard.type:', err);
    await writeOwnText(deps, text);
    await deps.keyboard.type(text);
  }
}
