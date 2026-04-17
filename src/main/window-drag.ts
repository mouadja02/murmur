import { type BrowserWindow, screen } from 'electron';

const POLL_INTERVAL_MS = 16;

interface DragState {
  win: BrowserWindow;
  offsetX: number;
  offsetY: number;
  timer: NodeJS.Timeout;
}

let active: DragState | null = null;

export function beginWindowDrag(win: BrowserWindow): void {
  endWindowDrag();
  if (win.isDestroyed()) return;
  const cursor = screen.getCursorScreenPoint();
  const [winX, winY] = win.getPosition();
  active = {
    win,
    offsetX: cursor.x - winX,
    offsetY: cursor.y - winY,
    timer: setInterval(() => {
      if (!active || active.win.isDestroyed()) {
        endWindowDrag();
        return;
      }
      const c = screen.getCursorScreenPoint();
      active.win.setPosition(c.x - active.offsetX, c.y - active.offsetY);
    }, POLL_INTERVAL_MS),
  };
}

export function endWindowDrag(): void {
  if (!active) return;
  clearInterval(active.timer);
  active = null;
}

export function isWindowDragActive(): boolean {
  return active !== null;
}
