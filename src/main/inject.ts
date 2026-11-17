// src/main/inject.ts
import { Key, keyboard } from '@nut-tree-fork/nut-js';
import { clipboard } from 'electron';
import { injectGeneratedText } from './clipboard-injection.js';
import type { ClipboardRetention, InjectionMethod } from './config/index.js';
import { createProgressiveInjector, type ProgressiveInjector } from './progressive-inject.js';

keyboard.config.autoDelayMs = 10;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface InjectOptions {
  clipboardRestoreDelayMs: number;
  clipboardRetention: ClipboardRetention;
  injectionMethod: InjectionMethod;
}

/**
 * `noteOwnWrite` is told about each text Murmur puts on the clipboard (the
 * prompt, and the restored previous text) before it is written.
 */
export async function pasteAtCursor(
  text: string,
  opts: InjectOptions,
  noteOwnWrite: (text: string) => void,
): Promise<void> {
  await injectGeneratedText(text, opts, {
    clipboard,
    keyboard,
    keys: {
      pasteModifier: process.platform === 'darwin' ? Key.LeftSuper : Key.LeftControl,
      v: Key.V,
    },
    sleep,
    noteOwnWrite,
    logger: console,
  });
}

export function createTypedProgressiveInjector(): ProgressiveInjector {
  return createProgressiveInjector({
    typeFn: (text: string) => keyboard.type(text),
  });
}
