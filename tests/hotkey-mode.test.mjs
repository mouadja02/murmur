import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { describe, it } from 'node:test';
import { HotkeyService } from '../dist/main/hotkey.js';

// uiohook-napi is never loaded here: on a headless Linux runner importing it throws
// (no X display), and these tests must not install a real global hook anywhere.
const UiohookKey = { K: 37, H: 35, Space: 57 };

/** A stand-in for uIOhook: tests push key events through it. */
function fakeHook() {
  const emitter = new EventEmitter();
  return {
    on: (event, listener) => emitter.on(event, listener),
    start() {},
    stop() {},
    down: (keycode, mods = {}) => emitter.emit('keydown', { keycode, ...mods }),
    up: (keycode, mods = {}) => emitter.emit('keyup', { keycode, ...mods }),
  };
}

const CTRL_ALT = { ctrlKey: true, altKey: true };
const KEY = UiohookKey.K;

function setup(mode) {
  const hook = fakeHook();
  const service = new HotkeyService(hook, UiohookKey);
  service.configure({ ptt: 'Ctrl+Alt+K', toggle: 'Ctrl+Shift+H', mode });
  const events = [];
  for (const name of ['start', 'stop', 'capture', 'toggle']) {
    service.on(name, () => events.push(name));
  }
  service.start();
  return { hook, service, events };
}

describe('HotkeyService push-to-talk mode', () => {
  it('hold (default): key-down starts, key-up stops, repeats are ignored', () => {
    const { hook, events } = setup(undefined);
    hook.down(KEY, CTRL_ALT);
    hook.down(KEY, CTRL_ALT); // OS auto-repeat
    hook.up(KEY);
    assert.deepEqual(events, ['start', 'stop']);
  });

  it('toggle: each physical press emits one capture event and key-up is ignored', () => {
    const { hook, events } = setup('toggle');
    hook.down(KEY, CTRL_ALT);
    hook.down(KEY, CTRL_ALT); // auto-repeat while held
    hook.down(KEY, CTRL_ALT);
    hook.up(KEY);
    assert.deepEqual(events, ['capture']);
    hook.down(KEY, CTRL_ALT);
    hook.up(KEY);
    assert.deepEqual(events, ['capture', 'capture']);
  });

  it('toggle: never emits start or stop', () => {
    const { hook, events } = setup('toggle');
    for (let i = 0; i < 3; i++) {
      hook.down(KEY, CTRL_ALT);
      hook.up(KEY);
    }
    assert.equal(events.filter((e) => e === 'start' || e === 'stop').length, 0);
    assert.equal(events.length, 3);
  });

  it('toggle: a press without the modifiers does nothing', () => {
    const { hook, events } = setup('toggle');
    hook.down(KEY, { ctrlKey: true });
    hook.up(KEY);
    assert.deepEqual(events, []);
  });

  it('a capture started in hold mode still stops on key-up after a switch to toggle', () => {
    const { hook, service, events } = setup('hold');
    hook.down(KEY, CTRL_ALT);
    service.configure({ ptt: 'Ctrl+Alt+K', toggle: 'Ctrl+Shift+H', mode: 'toggle' });
    hook.up(KEY);
    assert.deepEqual(events, ['start', 'stop']);
  });

  it('the overlay toggle combo is unaffected by the mode', () => {
    const { hook, events } = setup('toggle');
    hook.down(UiohookKey.H, { ctrlKey: true, shiftKey: true });
    hook.up(UiohookKey.H);
    assert.deepEqual(events, ['toggle']);
  });
});
