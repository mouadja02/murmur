// src/main/inject.ts
import { Key, keyboard } from '@nut-tree-fork/nut-js';
import { clipboard } from 'electron';
import { injectGeneratedText } from './clipboard-injection.js';
import type { ClipboardRetention, InjectionMethod } from './config/index.js';

keyboard.config.autoDelayMs = 10;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface InjectOptions {
  clipboardRestoreDelayMs: number;
  clipboardRetention: ClipboardRetention;
  injectionMethod: InjectionMethod;
}

export async function pasteAtCursor(text: string, opts: InjectOptions): Promise<void> {
  await injectGeneratedText(text, opts, {
    clipboard,
    keyboard,
    keys: {
      pasteModifier: process.platform === 'darwin' ? Key.LeftSuper : Key.LeftControl,
      v: Key.V,
    },
    sleep,
    logger: console,
  });
}
