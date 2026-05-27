import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, type BrowserWindow } from 'electron';
import { hideOverlay, showOverlay, toggleOverlayVisibility } from '../overlay/window.js';
import {
  buildProtocolRegistration,
  findMurmurUrlInArgv,
  MURMUR_PROTOCOL,
  type MurmurAction,
  parseMurmurUrl,
} from './url.js';

export type { MurmurAction };
export { findMurmurUrlInArgv, MURMUR_PROTOCOL, parseMurmurUrl };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface ProtocolHandlers {
  getWindow: () => BrowserWindow | null;
  openPanel: () => void;
}

/**
 * Must be called BEFORE `app.whenReady()` to register the custom scheme with
 * Electron. On Windows this writes a HKCU\Software\Classes\murmur entry so
 * OSC-8 hyperlinks in the terminal (e.g. `murmur://show`) re-launch us with
 * the URL as argv. On Linux this writes a .desktop file; on macOS the
 * Info.plist registration does the same job and this call is a no-op.
 */
export function registerProtocol(): void {
  const registration = buildProtocolRegistration({
    defaultApp: Boolean(process.defaultApp),
    execPath: process.execPath,
    electronEntryPath: path.resolve(__dirname, '../index.js'),
    argv: process.argv,
  });

  // Always register instead of returning early. This repairs stale Windows
  // handlers from older dev runs where the extra app argument pointed at a host
  // Electron app (for example Cursor) instead of Murmur's entry script.
  app.setAsDefaultProtocolClient(MURMUR_PROTOCOL, registration.executable, registration.args);
}

/** Run a parsed action against the running window / control panel. */
export function runMurmurAction(action: MurmurAction, deps: ProtocolHandlers): void {
  const win = deps.getWindow();
  switch (action) {
    case 'show':
      if (win) showOverlay(win);
      break;
    case 'hide':
      if (win) hideOverlay(win);
      break;
    case 'toggle':
      if (win) toggleOverlayVisibility(win);
      break;
    case 'panel':
      deps.openPanel();
      break;
    case 'quit':
      app.quit();
      break;
  }
}

/**
 * Wires `second-instance` (Win/Linux) and `open-url` (macOS) events to route
 * any `murmur://...` URL that a *second* launch delivers into our action
 * handler. Must be called once, after `app.whenReady()`.
 *
 * This is the bit that makes the terminal click *not* open a browser tab:
 * clicking `murmur://show` spawns a child process that delivers its argv to
 * the already-running Murmur instance via IPC, then exits silently.
 */
export function wireProtocolEvents(deps: ProtocolHandlers): void {
  app.on('second-instance', (_evt, argv) => {
    const url = findMurmurUrlInArgv(argv);
    if (!url) return;
    const action = parseMurmurUrl(url);
    if (action) runMurmurAction(action, deps);
  });

  app.on('open-url', (evt, url) => {
    const action = parseMurmurUrl(url);
    if (action) {
      evt.preventDefault();
      runMurmurAction(action, deps);
    }
  });
}

/**
 * Handle any `murmur://...` URL that was passed to the first-instance argv
 * (e.g. the user clicked a terminal link while Murmur wasn't running yet).
 */
export function handleFirstInstanceArgv(deps: ProtocolHandlers): void {
  const url = findMurmurUrlInArgv(process.argv);
  if (!url) return;
  const action = parseMurmurUrl(url);
  if (action) runMurmurAction(action, deps);
}
