import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, screen } from 'electron';
import type { OverlayAnchor, ResolvedConfig } from '../config/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const OVERLAY_WIDTH = 320;
export const OVERLAY_HEIGHT = 96;

export function createOverlayWindow(cfg: ResolvedConfig): BrowserWindow {
  const win = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    skipTaskbar: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    focusable: true,
    show: false,
    title: 'murmur',
    webPreferences: {
      preload: path.join(__dirname, '../preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Default to click-through; the renderer turns it off on hover.
  win.setIgnoreMouseEvents(true, { forward: true });

  positionOverlay(win, cfg.overlayAnchor, cfg.overlayOffsetX, cfg.overlayOffsetY);
  win.loadFile(path.join(__dirname, '../../renderer/index.html'));

  return win;
}

export function positionOverlay(
  win: BrowserWindow,
  anchor: OverlayAnchor,
  offsetX: number,
  offsetY: number,
): void {
  if (anchor === 'free') return;
  const display = screen.getPrimaryDisplay();
  const work = display.workArea;
  const [w, h] = win.getSize();
  let x = work.x;
  let y = work.y;
  switch (anchor) {
    case 'bottom-center':
      x = work.x + Math.round((work.width - w) / 2) + offsetX;
      y = work.y + work.height - h - offsetY;
      break;
    case 'bottom-right':
      x = work.x + work.width - w - offsetX;
      y = work.y + work.height - h - offsetY;
      break;
    case 'top-right':
      x = work.x + work.width - w - offsetX;
      y = work.y + offsetY;
      break;
  }
  win.setPosition(x, y);
}
