import { getActiveWindow } from '@nut-tree-fork/nut-js';

export interface WindowContext {
  processName: string;
  windowTitle: string;
  os: string;
}

const MAX_TITLE_LENGTH = 100;

function getOsName(): string {
  switch (process.platform) {
    case 'win32':
      return 'Windows';
    case 'darwin':
      return 'macOS';
    case 'linux':
      return 'Linux';
    default:
      return process.platform;
  }
}

function extractProcessName(title: string): string {
  const patterns = [
    /(?:-\s*)([^-\s]+)$/,
    /(?:—\s*)([^—\s]+)$/,
    /(?:\|\s*)([^|]+)$/,
    /(?:•\s*)([^•]+)$/,
  ];

  for (const pattern of patterns) {
    const match = title.match(pattern);
    if (match?.[1]) {
      return match[1].trim();
    }
  }

  return 'unknown';
}

/**
 * Opaque identity of the window in front, for comparing "same window as when
 * the capture started" and nothing else. It is the native handle, not the
 * title: editors rewrite titles as you type (an unsaved marker, a new file).
 * Null when the platform cannot say (e.g. some Wayland sessions).
 */
export async function getForegroundWindowId(
  getWindow: () => Promise<unknown> = getActiveWindow,
): Promise<string | null> {
  try {
    // nut-js keeps the handle on the instance but types it private.
    const handle = ((await getWindow()) as { windowHandle?: unknown } | null)?.windowHandle;
    if (typeof handle === 'number' || typeof handle === 'bigint') return String(handle);
    return typeof handle === 'string' && handle !== '' ? handle : null;
  } catch {
    return null;
  }
}

export async function captureActiveWindow(): Promise<WindowContext | null> {
  try {
    const window = await getActiveWindow();
    const title = await window.title;

    return {
      processName: extractProcessName(title),
      windowTitle: title.slice(0, MAX_TITLE_LENGTH),
      os: getOsName(),
    };
  } catch (err) {
    console.warn('[context] failed to capture active window:', err);
    return null;
  }
}
