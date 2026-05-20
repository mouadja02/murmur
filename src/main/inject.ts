// src/main/inject.ts
import { Key, keyboard } from '@nut-tree-fork/nut-js';
import { clipboard } from 'electron';
import type { InjectionMethod } from './config/index.js';

keyboard.config.autoDelayMs = 10;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface InjectOptions {
  clipboardRestoreDelayMs: number;
  injectionMethod: InjectionMethod;
}

async function typeText(text: string): Promise<void> {
  await keyboard.type(text);
}

async function pasteViaClipboard(text: string, restoreDelayMs: number): Promise<void> {
  const previous = clipboard.readText();
  clipboard.writeText(text);

  await sleep(30);

  // Verify the clipboard write actually landed before trusting the paste.
  // Some clipboard managers or sandboxes silently drop writes; if the write
  // failed, fallback to typing is better than injecting empty text.
  const written = clipboard.readText();
  if (written !== text) {
    console.warn('[inject] clipboard write unverified — restoring and skipping paste');
    clipboard.writeText(previous);
    throw new Error('clipboard write verification failed');
  }

  try {
    if (process.platform === 'darwin') {
      await keyboard.type(Key.LeftSuper, Key.V);
    } else {
      await keyboard.type(Key.LeftControl, Key.V);
    }
    await sleep(restoreDelayMs);
  } finally {
    clipboard.writeText(previous);
  }
}

export async function pasteAtCursor(text: string, opts: InjectOptions): Promise<void> {
  if (opts.injectionMethod === 'type') {
    await typeText(text);
    return;
  }

  // 'clipboard' or 'auto'
  try {
    await pasteViaClipboard(text, opts.clipboardRestoreDelayMs);
  } catch (err) {
    if (opts.injectionMethod === 'auto') {
      console.warn('[inject] clipboard paste failed, falling back to keyboard.type:', err);
      await typeText(text);
    } else {
      throw err; // 'clipboard' mode: propagate the error
    }
  }
}
