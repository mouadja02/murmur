import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  CLIPBOARD_CONTEXT_MAX_AGE_MS,
  createClipboardMonitor,
} from '../dist/main/context/clipboard-monitor.js';

// A scriptable clipboard: `copy()` is what the user (or a password manager) does.
function fakeClipboard(initial = '') {
  const state = { text: initial, concealed: false, concealedChecks: 0 };
  return {
    state,
    adapter: {
      readText: async () => state.text,
      isConcealed: async () => {
        state.concealedChecks++;
        return state.concealed;
      },
    },
    copy(text, { concealed = false } = {}) {
      state.text = text;
      state.concealed = concealed;
    },
  };
}

function setup(initial) {
  const clip = fakeClipboard(initial);
  const clock = { t: 1_000_000 };
  const monitor = createClipboardMonitor(clip.adapter, { pollMs: 3_600_000, now: () => clock.t });
  return { clip, clock, monitor };
}

const texts = (entries) => entries.map((e) => e.text);

describe('clipboard context monitor', () => {
  it('records copied text newest first and ignores what was already on the clipboard', async () => {
    const { clip, monitor } = setup('already there');
    await monitor.start();
    clip.copy('first');
    await monitor.poll();
    clip.copy('second');
    await monitor.poll();
    assert.deepEqual(texts(monitor.history(5)), ['second', 'first']);

    monitor.stop();
  });

  it('does not record text Murmur wrote itself', async () => {
    const { clip, monitor } = setup();
    await monitor.start();
    monitor.ignore('REFINED PROMPT');
    clip.copy('REFINED PROMPT');
    await monitor.poll();
    assert.deepEqual(monitor.history(5), []);

    monitor.stop();
  });

  it('does not record an entry the platform marks as concealed', async () => {
    const { clip, monitor } = setup();
    await monitor.start();
    clip.copy('hunter2-password', { concealed: true });
    await monitor.poll();
    clip.copy('plain error message');
    await monitor.poll();
    assert.deepEqual(texts(monitor.history(5)), ['plain error message']);

    monitor.stop();
  });

  it('keeps a concealed entry out even after a later poll sees the same text again', async () => {
    const { clip, monitor } = setup();
    await monitor.start();
    clip.copy('totp-123456', { concealed: true });
    await monitor.poll();
    await monitor.poll();
    assert.deepEqual(monitor.history(5), []);

    monitor.stop();
  });

  it('records the entry when the concealed-format check itself fails', async () => {
    const clip = fakeClipboard();
    clip.adapter.isConcealed = async () => {
      throw new Error('format query unsupported');
    };
    const monitor = createClipboardMonitor(clip.adapter, { pollMs: 3_600_000 });
    await monitor.start();
    clip.copy('ordinary text');
    await monitor.poll();
    assert.deepEqual(texts(monitor.history(5)), ['ordinary text']);

    monitor.stop();
  });

  it('only returns entries younger than the age limit', async () => {
    const { clip, clock, monitor } = setup();
    await monitor.start();
    clip.copy('old');
    await monitor.poll();
    clock.t += CLIPBOARD_CONTEXT_MAX_AGE_MS + 1;
    clip.copy('fresh');
    await monitor.poll();
    assert.deepEqual(texts(monitor.history(5)), ['fresh']);
    assert.deepEqual(texts(monitor.history(5, CLIPBOARD_CONTEXT_MAX_AGE_MS * 10)), [
      'fresh',
      'old',
    ]);

    monitor.stop();
  });

  it('keeps an entry exactly at the age limit and drops it one millisecond later', async () => {
    const { clip, clock, monitor } = setup();
    await monitor.start();
    clip.copy('edge');
    await monitor.poll();

    clock.t += CLIPBOARD_CONTEXT_MAX_AGE_MS;
    assert.deepEqual(texts(monitor.history(5)), ['edge']);
    clock.t += 1;
    assert.deepEqual(monitor.history(5), []);

    monitor.stop();
  });

  it('forgets the history when monitoring stops, so re-enabling starts empty', async () => {
    const { clip, monitor } = setup();
    await monitor.start();
    clip.copy('copied while enabled');
    await monitor.poll();
    assert.equal(monitor.history(5).length, 1);

    monitor.stop();
    assert.deepEqual(monitor.history(5), []);

    await monitor.start();
    assert.deepEqual(monitor.history(5), []);
    monitor.stop();
  });

  it('does not record the clipboard content that was already there when monitoring restarts', async () => {
    const { clip, monitor } = setup();
    await monitor.start();
    clip.copy('copied earlier');
    await monitor.poll();
    monitor.stop();

    await monitor.start();
    await monitor.poll();
    assert.deepEqual(monitor.history(5), []);

    monitor.stop();
  });
});
