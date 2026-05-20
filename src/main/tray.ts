// src/main/tray.ts
import { deflateSync } from 'node:zlib';
import { Menu, nativeImage, Tray } from 'electron';
import type { NativeImage } from 'electron';

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

function makeCirclePng(size: number, r: number, g: number, b: number): Buffer {
  const half = size / 2;
  const rows: Buffer[] = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 4); // filter byte + RGBA per pixel
    row[0] = 0; // PNG filter: None
    for (let x = 0; x < size; x++) {
      const cx = x - half + 0.5;
      const cy = y - half + 0.5;
      const alpha = Math.sqrt(cx * cx + cy * cy) < half - 0.5 ? 255 : 0;
      const o = 1 + x * 4;
      row[o] = r; row[o + 1] = g; row[o + 2] = b; row[o + 3] = alpha;
    }
    rows.push(row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA color type
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), // PNG signature
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.concat(rows))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function makeTrayIcon(r: number, g: number, b: number): NativeImage {
  // macOS menu bar uses 22×22; other platforms use 16×16.
  const size = process.platform === 'darwin' ? 22 : 16;
  return nativeImage.createFromBuffer(makeCirclePng(size, r, g, b));
}

// Colors mirror the overlay CSS variables.
const ICON_IDLE = () => makeTrayIcon(167, 139, 250);      // --accent purple
const ICON_RECORDING = () => makeTrayIcon(248, 113, 113); // --recording red
const ICON_PROCESSING = () => makeTrayIcon(251, 191, 36); // --processing yellow

export type TrayIconState = 'idle' | 'recording' | 'processing';

export class TrayService {
  private tray: Tray | null = null;
  private overlayVisible = true;
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
    this.callbacks = opts;
    this.overlayVisible = opts.isVisible();
    this.tray = new Tray(ICON_IDLE());
    this.tray.setToolTip('murmur');
    this.rebuildMenu();
    this.tray.on('click', () => this.toggleOverlay());
  }

  setState(state: TrayIconState): void {
    if (!this.tray || this.tray.isDestroyed()) return;
    if (state === 'recording') this.tray.setImage(ICON_RECORDING());
    else if (state === 'processing') this.tray.setImage(ICON_PROCESSING());
    else this.tray.setImage(ICON_IDLE());
  }

  setVisibility(visible: boolean): void {
    this.overlayVisible = visible;
    this.rebuildMenu();
  }

  destroy(): void {
    if (this.tray && !this.tray.isDestroyed()) this.tray.destroy();
    this.tray = null;
  }

  private toggleOverlay(): void {
    if (!this.callbacks) return;
    if (this.overlayVisible) {
      this.callbacks.onHide();
    } else {
      this.callbacks.onShow();
    }
    this.overlayVisible = !this.overlayVisible;
    this.rebuildMenu();
  }

  private rebuildMenu(): void {
    if (!this.tray || this.tray.isDestroyed() || !this.callbacks) return;
    const cb = this.callbacks;
    const menu = Menu.buildFromTemplate([
      {
        label: this.overlayVisible ? 'Hide overlay' : 'Show overlay',
        click: () => this.toggleOverlay(),
      },
      { label: 'Open control panel', click: () => cb.onPanel() },
      { type: 'separator' },
      { label: 'Quit Murmur', click: () => cb.onQuit() },
    ]);
    this.tray.setContextMenu(menu);
  }
}
