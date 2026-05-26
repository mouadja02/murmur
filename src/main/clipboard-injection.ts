import type { ClipboardRetention, InjectionMethod } from './config/index.js';

export interface ClipboardAdapter {
  readText(): string;
  writeText(text: string): void;
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
  logger?: Pick<Console, 'warn'>;
}

export interface ClipboardInjectionOptions {
  clipboardRestoreDelayMs: number;
  clipboardRetention: ClipboardRetention;
  injectionMethod: InjectionMethod;
}

function writeGeneratedToClipboard(clipboard: ClipboardAdapter, text: string): void {
  clipboard.writeText(text);
}

async function pasteViaClipboard(
  text: string,
  opts: ClipboardInjectionOptions,
  deps: ClipboardInjectionDeps,
): Promise<void> {
  const previous = deps.clipboard.readText();
  writeGeneratedToClipboard(deps.clipboard, text);

  await deps.sleep(30);

  const written = deps.clipboard.readText();
  if (written !== text) {
    if (opts.clipboardRetention === 'restore-previous') deps.clipboard.writeText(previous);
    throw new Error('clipboard write verification failed');
  }

  try {
    await deps.keyboard.type(deps.keys.pasteModifier, deps.keys.v);
    await deps.sleep(opts.clipboardRestoreDelayMs);
  } finally {
    if (opts.clipboardRetention === 'restore-previous') deps.clipboard.writeText(previous);
  }
}

export async function injectGeneratedText(
  text: string,
  opts: ClipboardInjectionOptions,
  deps: ClipboardInjectionDeps,
): Promise<void> {
  if (opts.injectionMethod === 'type') {
    writeGeneratedToClipboard(deps.clipboard, text);
    await deps.keyboard.type(text);
    return;
  }

  try {
    await pasteViaClipboard(text, opts, deps);
  } catch (err) {
    if (opts.injectionMethod !== 'auto') throw err;
    deps.logger?.warn('[inject] clipboard paste failed, falling back to keyboard.type:', err);
    writeGeneratedToClipboard(deps.clipboard, text);
    await deps.keyboard.type(text);
  }
}
