import { clipboard } from 'electron';
import { type ClipboardEntry, createClipboardMonitor } from './clipboard-monitor.js';

export type { ClipboardEntry };

// Raw clipboard formats that password managers set on a copied secret:
// macOS (nspasteboard.org) and Windows (clipboard history / cloud clipboard opt-out).
const CONCEALED_FORMATS = [
  'org.nspasteboard.ConcealedType',
  'ExcludeClipboardContentFromMonitorProcessing',
];

const monitor = createClipboardMonitor({
  readText: () => clipboard.readText(),
  async isConcealed() {
    for (const format of CONCEALED_FORMATS) {
      if (await clipboard.has(`electron application/osclipboard;format="${format}"`)) return true;
    }
    return false;
  },
});

export function ignoreClipboardText(text: string): void {
  monitor.ignore(text);
}

export function startClipboardMonitoring(): void {
  void monitor.start();
}

export function stopClipboardMonitoring(): void {
  monitor.stop();
}

export function getClipboardHistory(count: number): ClipboardEntry[] {
  return monitor.history(count);
}

export function clearClipboardHistory(): void {
  monitor.clear();
}
