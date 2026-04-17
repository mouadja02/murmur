import { EventEmitter } from 'node:events';
import { UiohookKey, type UiohookKeyboardEvent, uIOhook } from 'uiohook-napi';

interface ParsedCombo {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  meta: boolean;
  keyCode: number;
  raw: string;
}

const KEY_ALIASES: Record<string, keyof typeof UiohookKey> = {
  SPACE: 'Space',
  ESC: 'Escape',
  ESCAPE: 'Escape',
  ENTER: 'Enter',
  RETURN: 'Enter',
  TAB: 'Tab',
  BACKSPACE: 'Backspace',
};

function lookupKey(token: string): number | null {
  const upper = token.toUpperCase();
  const aliased = KEY_ALIASES[upper] ?? (upper as keyof typeof UiohookKey);
  const code = (UiohookKey as Record<string, number>)[aliased];
  if (typeof code === 'number') return code;
  // Last-resort: try the token as-is in case the user wrote `F1` etc.
  const direct = (UiohookKey as Record<string, number>)[token];
  return typeof direct === 'number' ? direct : null;
}

export function parseCombo(combo: string): ParsedCombo | null {
  const parts = combo
    .split('+')
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length === 0) return null;

  let ctrl = false;
  let shift = false;
  let alt = false;
  let meta = false;
  let keyCode: number | null = null;

  for (const p of parts) {
    const lower = p.toLowerCase();
    if (lower === 'ctrl' || lower === 'control') ctrl = true;
    else if (lower === 'shift') shift = true;
    else if (lower === 'alt' || lower === 'option') alt = true;
    else if (lower === 'meta' || lower === 'cmd' || lower === 'win' || lower === 'super') {
      meta = true;
    } else {
      const code = lookupKey(p);
      if (code !== null) keyCode = code;
    }
  }
  if (keyCode === null) return null;
  return { ctrl, shift, alt, meta, keyCode, raw: combo };
}

function modsMatch(e: UiohookKeyboardEvent, c: ParsedCombo): boolean {
  return (
    Boolean(e.ctrlKey) === c.ctrl &&
    Boolean(e.shiftKey) === c.shift &&
    Boolean(e.altKey) === c.alt &&
    Boolean(e.metaKey) === c.meta
  );
}

export interface HotkeyConfig {
  ptt: string;
  toggle: string;
}

export class HotkeyService extends EventEmitter {
  private ptt: ParsedCombo | null = null;
  private toggle: ParsedCombo | null = null;
  private recording = false;
  private toggleHeld = false;
  private started = false;

  override on(event: 'start' | 'stop' | 'toggle', listener: () => void): this {
    return super.on(event, listener);
  }

  override emit(event: 'start' | 'stop' | 'toggle'): boolean {
    return super.emit(event);
  }

  /** Updates the parsed combos. Safe to call before or after `start()`. */
  configure(cfg: HotkeyConfig): { ptt: ParsedCombo | null; toggle: ParsedCombo | null } {
    this.ptt = parseCombo(cfg.ptt);
    this.toggle = parseCombo(cfg.toggle);
    if (!this.ptt) console.warn(`[hotkey] could not parse PTT combo "${cfg.ptt}"`);
    if (!this.toggle) console.warn(`[hotkey] could not parse toggle combo "${cfg.toggle}"`);
    return { ptt: this.ptt, toggle: this.toggle };
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    uIOhook.on('keydown', (e) => {
      if (this.ptt && e.keycode === this.ptt.keyCode && modsMatch(e, this.ptt)) {
        if (!this.recording) {
          this.recording = true;
          this.emit('start');
        }
        return;
      }
      if (this.toggle && e.keycode === this.toggle.keyCode && modsMatch(e, this.toggle)) {
        if (!this.toggleHeld) {
          this.toggleHeld = true;
          this.emit('toggle');
        }
      }
    });

    uIOhook.on('keyup', (e) => {
      // Stop on key-up of the PTT key regardless of modifier state — users
      // commonly release modifiers a few ms before the main key.
      if (this.ptt && e.keycode === this.ptt.keyCode && this.recording) {
        this.recording = false;
        this.emit('stop');
      }
      if (this.toggle && e.keycode === this.toggle.keyCode) {
        this.toggleHeld = false;
      }
    });

    uIOhook.start();
  }

  shutdown(): void {
    if (!this.started) return;
    this.started = false;
    try {
      uIOhook.stop();
    } catch {
      /* ignore */
    }
    this.removeAllListeners();
  }
}
