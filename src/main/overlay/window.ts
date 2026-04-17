import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, screen } from 'electron';
import type { OverlayAnchor, OverlayPosition, ResolvedConfig } from '../config/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const OVERLAY_WIDTH = 320;
// Extra vertical room above the pill so the hover tooltip (which sits
// `bottom: 100%` of the pill) renders fully inside the window bounds.
export const OVERLAY_HEIGHT = 180;

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

  placeOverlay(win, cfg);
  win.loadFile(path.join(__dirname, '../../renderer/index.html'));

  return win;
}

/**
 * Places the overlay according to anchor + offsets, or to a saved free
 * position when anchor === 'free' and a position was persisted. The free
 * position is clamped to the current display so a saved position from a
 * disconnected monitor doesn't park the window off-screen.
 */
export function placeOverlay(win: BrowserWindow, cfg: ResolvedConfig): void {
  if (cfg.overlayAnchor === 'free' && cfg.overlayPosition) {
    const { x, y } = clampToScreen(cfg.overlayPosition, win);
    win.setPosition(x, y);
    return;
  }
  positionOverlayByAnchor(win, cfg.overlayAnchor, cfg.overlayOffsetX, cfg.overlayOffsetY);
}

export function positionOverlayByAnchor(
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

function clampToScreen(pos: OverlayPosition, win: BrowserWindow): OverlayPosition {
  const [w, h] = win.getSize();
  const display = screen.getDisplayNearestPoint({ x: pos.x, y: pos.y });
  const a = display.workArea;
  const x = Math.min(Math.max(pos.x, a.x), a.x + a.width - w);
  const y = Math.min(Math.max(pos.y, a.y), a.y + a.height - h);
  return { x, y };
}

export function showOverlay(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  if (!win.isVisible()) win.showInactive();
}

export function hideOverlay(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  if (win.isVisible()) win.hide();
}

export function toggleOverlayVisibility(win: BrowserWindow): boolean {
  if (win.isDestroyed()) return false;
  if (win.isVisible()) {
    win.hide();
    return false;
  }
  win.showInactive();
  return true;
}
