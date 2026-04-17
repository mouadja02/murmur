import { Key, keyboard } from '@nut-tree-fork/nut-js';
import { clipboard } from 'electron';
import { CONFIG } from '../shared/constants.js';

keyboard.config.autoDelayMs = 10;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function pasteAtCursor(text: string): Promise<void> {
  const previous = clipboard.readText();
  clipboard.writeText(text);

  await sleep(30);

  await keyboard.type(Key.LeftControl, Key.V);

  await sleep(CONFIG.clipboardRestoreDelayMs);
  clipboard.writeText(previous);
}
