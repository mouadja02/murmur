// src/main/tray.ts
import { deflateSync } from 'node:zlib';
import type { NativeImage } from 'electron';
import { Menu, nativeImage, Tray } from 'electron';

function crc32(buf: Buffer): number {
  const table: number[] = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = (table[(crc ^ (buf[i] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function makeCirclePng(size: number, r: number, g: number, b: number, alpha = 255): Buffer {
  const half = size / 2;
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4); // filter byte + RGBA per pixel
    row[0] = 0; // PNG filter: None
    for (let x = 0; x < size; x++) {
      const cx = x - half + 0.5;
      const cy = y - half + 0.5;
      const pixelAlpha = Math.sqrt(cx * cx + cy * cy) < half - 0.5 ? alpha : 0;
      const o = 1 + x * 4;
      row[o] = r;
      row[o + 1] = g;
      row[o + 2] = b;
      row[o + 3] = pixelAlpha;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA color type
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function makeTrayIcon(r: number, g: number, b: number, alpha = 255): NativeImage {
  // macOS menu bar uses 22x22; other platforms use 16x16.
  const size = process.platform === 'darwin' ? 22 : 16;
  return nativeImage.createFromBuffer(makeCirclePng(size, r, g, b, alpha));
}

// Colors mirror the overlay CSS variables.
// Compute once at module load — avoids PNG synthesis + deflate on every setState call.
const ICON_IDLE = makeTrayIcon(255, 217, 61); // --accent highlighter yellow
const ICON_RECORDING_BRIGHT = makeTrayIcon(248, 113, 113); // --recording red (full)
const ICON_RECORDING_DIM = makeTrayIcon(248, 113, 113, 140); // --recording red (dimmed for pulse)
const ICON_PROCESSING = makeTrayIcon(141, 187, 255); // --focus blue (idle is yellow, so amber would be ambiguous)
const ICON_ERROR = makeTrayIcon(220, 38, 38); // error red (darker, distinct from recording)

// Pulse animation frames: alternate between bright and dim recording icons.
const RECORDING_FRAMES = [ICON_RECORDING_BRIGHT, ICON_RECORDING_DIM];
const PULSE_INTERVAL_MS = 600;

export type TrayIconState = 'idle' | 'recording' | 'processing' | 'error';

export class TrayService {
  private tray: Tray | null = null;
  private isVisible: (() => boolean) | null = null;
  private currentState: TrayIconState = 'idle';
  private pulseTimer: ReturnType<typeof setInterval> | null = null;
  private pulseFrame = 0;
  private callbacks: {
    onShow: () => void;
    onHide: () => void;
    onPanel: () => void;
    onQuit: () => void;
  } | null = null;

  create(opts: {
    onShow: () => void;
    onHide: () => void;
    onPanel: () => void;
    onQuit: () => void;
    isVisible: () => boolean;
  }): void {
    if (this.tray) return; // already created
    this.callbacks = opts;
    this.isVisible = opts.isVisible;
    this.tray = new Tray(ICON_IDLE);
    this.tray.setToolTip('murmur');
    this.rebuildMenu();
    this.tray.on('click', () => this.toggleOverlay());
  }

  setState(state: TrayIconState): void {
    if (!this.tray || this.tray.isDestroyed()) return;
    if (state === this.currentState) return;
    this.currentState = state;
    this.stopPulse();

    if (state === 'recording') {
      this.tray.setImage(ICON_RECORDING_BRIGHT);
      this.startPulse();
    } else if (state === 'processing') {
      this.tray.setImage(ICON_PROCESSING);
    } else if (state === 'error') {
      this.tray.setImage(ICON_ERROR);
      this.tray.setToolTip('murmur - error');
    } else {
      this.tray.setImage(ICON_IDLE);
    }

    if (state !== 'error') {
      this.tray.setToolTip('murmur');
    }

    this.rebuildMenu();
  }

  setVisibility(_visible: boolean): void {
    this.rebuildMenu();
  }

  destroy(): void {
    this.stopPulse();
    if (this.tray && !this.tray.isDestroyed()) this.tray.destroy();
    this.tray = null;
  }

  private startPulse(): void {
    this.pulseFrame = 0;
    this.pulseTimer = setInterval(() => {
      if (!this.tray || this.tray.isDestroyed()) {
        this.stopPulse();
        return;
      }
      this.pulseFrame = (this.pulseFrame + 1) % RECORDING_FRAMES.length;
      this.tray.setImage(RECORDING_FRAMES[this.pulseFrame]!);
    }, PULSE_INTERVAL_MS);
  }

  private stopPulse(): void {
    if (this.pulseTimer !== null) {
      clearInterval(this.pulseTimer);
      this.pulseTimer = null;
    }
  }

  private toggleOverlay(): void {
    if (!this.callbacks || !this.isVisible) return;
    if (this.isVisible()) {
      this.callbacks.onHide();
    } else {
      this.callbacks.onShow();
    }
    this.rebuildMenu();
  }

  private rebuildMenu(): void {
    if (!this.tray || this.tray.isDestroyed() || !this.callbacks || !this.isVisible) return;
    const cb = this.callbacks;
    const visible = this.isVisible(); // query live
    const menu = Menu.buildFromTemplate([
      {
        label: visible ? 'Hide overlay' : 'Show overlay',
        click: () => this.toggleOverlay(),
      },
      { label: 'Open control panel', click: () => cb.onPanel() },
      { type: 'separator' },
      { label: 'Quit Murmur', click: () => cb.onQuit() },
    ]);
    this.tray.setContextMenu(menu);
  }
}
