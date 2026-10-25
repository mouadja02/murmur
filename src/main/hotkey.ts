import { EventEmitter } from 'node:events';
import { UiohookKey, type UiohookKeyboardEvent, uIOhook } from 'uiohook-napi';
import type { HotkeyMode } from './config/index.js';

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

/**
 * `start`/`stop`: hold mode. `capture`: toggle mode, once per physical press.
 * `toggle`: the separate show/hide-overlay combo.
 */
export type HotkeyEvent = 'start' | 'stop' | 'capture' | 'toggle';

export interface HotkeyConfig {
  ptt: string;
  toggle: string;
  mode?: HotkeyMode;
}

/** The slice of `uIOhook` the service uses; tests pass a fake instead of the global hook. */
export interface KeyHook {
  on(event: 'keydown' | 'keyup', listener: (e: UiohookKeyboardEvent) => void): unknown;
  start(): void;
  stop(): void;
}

export class HotkeyService extends EventEmitter {
  private ptt: ParsedCombo | null = null;
  private toggle: ParsedCombo | null = null;
  private mode: HotkeyMode = 'hold';
  /**
   * What the current physical press of the PTT key emitted, or null while it is
   * up. It also swallows OS key auto-repeat, and lets a press that began in one
   * mode finish in that mode if the mode changes while the key is down.
   */
  private pttPress: 'start' | 'capture' | null = null;
  private toggleHeld = false;
  private started = false;

  constructor(private readonly hook: KeyHook = uIOhook) {
    super();
  }

  override on(event: HotkeyEvent, listener: () => void): this {
    return super.on(event, listener);
  }

  override emit(event: HotkeyEvent): boolean {
    return super.emit(event);
  }

  /** Updates the parsed combos. Safe to call before or after `start()`. */
  configure(cfg: HotkeyConfig): { ptt: ParsedCombo | null; toggle: ParsedCombo | null } {
    this.mode = cfg.mode ?? 'hold';
    this.ptt = parseCombo(cfg.ptt);
    this.toggle = parseCombo(cfg.toggle);
    if (!this.ptt) console.warn(`[hotkey] could not parse PTT combo "${cfg.ptt}"`);
    if (!this.toggle) console.warn(`[hotkey] could not parse toggle combo "${cfg.toggle}"`);
    return { ptt: this.ptt, toggle: this.toggle };
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    this.hook.on('keydown', (e) => {
      if (this.ptt && e.keycode === this.ptt.keyCode && modsMatch(e, this.ptt)) {
        if (this.pttPress === null) {
          // `capture` flips the recording state: the same press starts or stops.
          this.pttPress = this.mode === 'toggle' ? 'capture' : 'start';
          this.emit(this.pttPress);
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

    this.hook.on('keyup', (e) => {
      // Stop on key-up of the PTT key regardless of modifier state — users
      // commonly release modifiers a few ms before the main key.
      if (this.ptt && e.keycode === this.ptt.keyCode && this.pttPress !== null) {
        const press = this.pttPress;
        this.pttPress = null;
        // In toggle mode releasing the key must not end the capture.
        if (press === 'start') this.emit('stop');
      }
      if (this.toggle && e.keycode === this.toggle.keyCode) {
        this.toggleHeld = false;
      }
    });

    this.hook.start();
  }

  shutdown(): void {
    if (!this.started) return;
    this.started = false;
    try {
      this.hook.stop();
    } catch {
      /* ignore */
    }
    this.removeAllListeners();
  }
}
