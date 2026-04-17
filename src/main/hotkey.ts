import { EventEmitter } from 'node:events';
import { UiohookKey, uIOhook } from 'uiohook-napi';

export class HotkeyService extends EventEmitter {
  private recording = false;
  private started = false;

  override on(event: 'start' | 'stop', listener: () => void): this {
    return super.on(event, listener);
  }

  override emit(event: 'start' | 'stop'): boolean {
    return super.emit(event);
  }

  start(): void {
    if (this.started) return;
    this.started = true;

    uIOhook.on('keydown', (e) => {
      if (e.keycode === UiohookKey.Space && e.ctrlKey && e.shiftKey && !this.recording) {
        this.recording = true;
        this.emit('start');
      }
    });

    uIOhook.on('keyup', (e) => {
      if (e.keycode === UiohookKey.Space && this.recording) {
        this.recording = false;
        this.emit('stop');
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
