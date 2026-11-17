import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { injectGeneratedText } from '../dist/main/clipboard-injection.js';
import {
  CLIPBOARD_CONTEXT_MAX_AGE_MS,
  createClipboardMonitor,
} from '../dist/main/context/clipboard-monitor.js';

// The clipboard monitor and the paste path share one clipboard. With
// `restore-previous`, Murmur writes the user's previous clipboard text back
// after the paste; that write is Murmur's own and must not turn a skipped
// (concealed) or expired entry into fresh clipboard context (#71).

/**
 * One fake OS clipboard seen by both modules. `copy()` is the user or a
 * password manager; a plain `writeText` (what Murmur does) drops the
 * concealed marker, as a rewrite of the text would on a real clipboard.
 */
function sharedClipboard(initial = '') {
  const state = { text: initial, concealed: false };
  return {
    state,
    copy(text, { concealed = false } = {}) {
      state.text = text;
      state.concealed = concealed;
    },
    monitorAdapter: {
      readText: async () => state.text,
      isConcealed: async () => state.concealed,
    },
    injectionClipboard: {
      readText: async () => state.text,
      writeText: async (text) => {
        state.text = text;
        state.concealed = false;
      },
    },
  };
}

// Stopped after each test, so a failed assertion can't leave a poll timer
// keeping the test process alive.
const monitors = [];
afterEach(() => {
  for (const monitor of monitors.splice(0)) monitor.stop();
});

function setup() {
  const clip = sharedClipboard('on the clipboard at startup');
  const clock = { t: 1_000_000 };
  const monitor = createClipboardMonitor(clip.monitorAdapter, {
    pollMs: 3_600_000,
    now: () => clock.t,
  });
  monitors.push(monitor);
  return { clip, clock, monitor };
}

/**
 * The app's paste path: the real injection module reporting its clipboard
 * writes to the real monitor. A monitor tick is forced while the generated
 * prompt is on the clipboard, which happens on a real 500 ms timer about one
 * paste in three.
 */
function pasteDeps(clip, monitor, { clipboard = clip.injectionClipboard } = {}) {
  return {
    clipboard,
    keyboard: {
      type: async () => {
        await monitor.poll();
      },
    },
    keys: { pasteModifier: 'Ctrl', v: 'V' },
    sleep: async () => {
      await monitor.poll();
    },
    noteOwnWrite: (text) => monitor.ignore(text),
    logger: { warn: () => {} },
  };
}

const RESTORE = {
  injectionMethod: 'clipboard',
  clipboardRestoreDelayMs: 150,
  clipboardRetention: 'restore-previous',
};

const texts = (entries) => entries.map((e) => e.text);

describe('restore-previous paste and clipboard context', () => {
  it('control: a concealed copy is skipped and an ordinary one recorded', async () => {
    const { clip, monitor } = setup();
    await monitor.start();
    clip.copy('ordinary copy');
    await monitor.poll();
    clip.copy('SENTINEL-PASSWORD', { concealed: true });
    await monitor.poll();
    assert.deepEqual(texts(monitor.history(5)), ['ordinary copy']);
  });

  it('does not record a concealed entry that the restore puts back', async () => {
    const { clip, monitor } = setup();
    await monitor.start();
    clip.copy('ordinary copy');
    await monitor.poll();
    clip.copy('SENTINEL-PASSWORD', { concealed: true });
    await monitor.poll();

    await injectGeneratedText('generated prompt', RESTORE, pasteDeps(clip, monitor));
    assert.equal(clip.state.text, 'SENTINEL-PASSWORD', 'the restore did put the text back');
    await monitor.poll();

    assert.deepEqual(texts(monitor.history(5)), ['ordinary copy']);
  });

  it('does not refresh an expired entry that the restore puts back', async () => {
    const { clip, clock, monitor } = setup();
    await monitor.start();
    clip.copy('OLD-ENTRY');
    await monitor.poll();
    clock.t += 2 * CLIPBOARD_CONTEXT_MAX_AGE_MS;
    assert.deepEqual(monitor.history(5), [], 'control: the entry has expired');

    await injectGeneratedText('generated prompt', RESTORE, pasteDeps(clip, monitor));
    await monitor.poll();

    assert.deepEqual(monitor.history(5), []);
  });

  it('does not record the restored text when the paste is abandoned after a failed write check', async () => {
    const { clip, monitor } = setup();
    await monitor.start();
    clip.copy('SENTINEL-PASSWORD', { concealed: true });
    await monitor.poll();

    // The write lands, but the verification read sees something else (a
    // clipboard manager grabbing it, say), so the paste is abandoned and the
    // previous text restored.
    let reads = 0;
    const clipboard = {
      ...clip.injectionClipboard,
      readText: async () => (++reads === 2 ? 'something else' : clip.state.text),
    };
    await assert.rejects(
      injectGeneratedText('generated prompt', RESTORE, pasteDeps(clip, monitor, { clipboard })),
      /verification failed/,
    );
    assert.equal(clip.state.text, 'SENTINEL-PASSWORD');
    await monitor.poll();

    assert.deepEqual(monitor.history(5), []);
  });

  it('still records a new copy made after the paste', async () => {
    const { clip, monitor } = setup();
    await monitor.start();
    clip.copy('SENTINEL-PASSWORD', { concealed: true });
    await monitor.poll();

    await injectGeneratedText('generated prompt', RESTORE, pasteDeps(clip, monitor));
    await monitor.poll();
    clip.copy('copied afterwards');
    await monitor.poll();

    assert.deepEqual(texts(monitor.history(5)), ['copied afterwards']);
  });
});
