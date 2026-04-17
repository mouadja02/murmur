import { Key, keyboard } from '@nut-tree-fork/nut-js';
import { clipboard } from 'electron';

keyboard.config.autoDelayMs = 10;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface InjectOptions {
  clipboardRestoreDelayMs: number;
}

export async function pasteAtCursor(text: string, opts: InjectOptions): Promise<void> {
  const previous = clipboard.readText();
  clipboard.writeText(text);

  await sleep(30);
  await keyboard.type(Key.LeftControl, Key.V);

  await sleep(opts.clipboardRestoreDelayMs);
  clipboard.writeText(previous);
}
