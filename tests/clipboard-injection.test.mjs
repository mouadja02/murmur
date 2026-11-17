import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { injectGeneratedText } from '../dist/main/clipboard-injection.js';

function fakeDeps({ initialClipboard = 'previous', failVerification = false } = {}) {
  let clipboardText = initialClipboard;
  const calls = [];
  return {
    calls,
    deps: {
      clipboard: {
        readText: () =>
          failVerification && clipboardText === 'generated' ? 'not-generated' : clipboardText,
        writeText: (text) => {
          calls.push(['clipboard.writeText', text]);
          clipboardText = text;
        },
      },
      keyboard: {
        type: async (...keys) => {
          calls.push(['keyboard.type', ...keys]);
        },
      },
      keys: { pasteModifier: 'Ctrl', v: 'V' },
      sleep: async () => {},
      noteOwnWrite: () => {},
      logger: { warn: () => {} },
    },
    getClipboard: () => clipboardText,
  };
}

describe('clipboard injection', () => {
  it('keeps the generated prompt on the clipboard after paste by default', async () => {
    const { deps, calls, getClipboard } = fakeDeps();

    await injectGeneratedText(
      'generated',
      {
        injectionMethod: 'clipboard',
        clipboardRestoreDelayMs: 150,
        clipboardRetention: 'keep-generated',
      },
      deps,
    );

    assert.equal(getClipboard(), 'generated');
    assert.deepEqual(calls, [
      ['clipboard.writeText', 'generated'],
      ['keyboard.type', 'Ctrl', 'V'],
    ]);
  });

  it('can restore the previous clipboard when configured', async () => {
    const { deps, getClipboard } = fakeDeps();

    await injectGeneratedText(
      'generated',
      {
        injectionMethod: 'clipboard',
        clipboardRestoreDelayMs: 150,
        clipboardRetention: 'restore-previous',
      },
      deps,
    );

    assert.equal(getClipboard(), 'previous');
  });

  it('copies generated text even when using direct typing mode', async () => {
    const { deps, calls, getClipboard } = fakeDeps();

    await injectGeneratedText(
      'generated',
      {
        injectionMethod: 'type',
        clipboardRestoreDelayMs: 150,
        clipboardRetention: 'keep-generated',
      },
      deps,
    );

    assert.equal(getClipboard(), 'generated');
    assert.deepEqual(calls, [
      ['clipboard.writeText', 'generated'],
      ['keyboard.type', 'generated'],
    ]);
  });

  it('keeps generated text available when auto mode falls back to typing', async () => {
    const { deps, calls, getClipboard } = fakeDeps({ failVerification: true });

    await injectGeneratedText(
      'generated',
      {
        injectionMethod: 'auto',
        clipboardRestoreDelayMs: 150,
        clipboardRetention: 'keep-generated',
      },
      deps,
    );

    assert.equal(getClipboard(), 'generated');
    assert.deepEqual(calls, [
      ['clipboard.writeText', 'generated'],
      ['clipboard.writeText', 'generated'],
      ['keyboard.type', 'generated'],
    ]);
  });
});

describe('clipboard injection with an async clipboard (Electron 44+)', () => {
  // Electron 44 made clipboard.readText/writeText return promises. A write only
  // lands after a macrotask, so code that does not await it reads stale text.
  function asyncClipboardDeps(initial = 'previous') {
    let text = initial;
    const calls = [];
    return {
      calls,
      getClipboard: () => text,
      deps: {
        clipboard: {
          readText: () => new Promise((resolve) => setImmediate(() => resolve(text))),
          writeText: (t) =>
            new Promise((resolve) =>
              setImmediate(() => {
                calls.push(['clipboard.writeText', t]);
                text = t;
                resolve();
              }),
            ),
        },
        keyboard: {
          type: async (...keys) => {
            calls.push(['keyboard.type', ...keys]);
          },
        },
        keys: { pasteModifier: 'Ctrl', v: 'V' },
        sleep: async () => {},
        noteOwnWrite: () => {},
        logger: { warn: () => {} },
      },
    };
  }

  it('pastes after the write has landed instead of falling back to typing', async () => {
    const { deps, calls, getClipboard } = asyncClipboardDeps();

    await injectGeneratedText(
      'generated',
      {
        injectionMethod: 'clipboard',
        clipboardRestoreDelayMs: 0,
        clipboardRetention: 'keep-generated',
      },
      deps,
    );

    assert.equal(getClipboard(), 'generated');
    assert.deepEqual(calls, [
      ['clipboard.writeText', 'generated'],
      ['keyboard.type', 'Ctrl', 'V'],
    ]);
  });

  it('restores the previous text once the paste is done', async () => {
    const { deps, getClipboard } = asyncClipboardDeps();

    await injectGeneratedText(
      'generated',
      {
        injectionMethod: 'clipboard',
        clipboardRestoreDelayMs: 0,
        clipboardRetention: 'restore-previous',
      },
      deps,
    );

    assert.equal(getClipboard(), 'previous');
  });

  it('has written the text to the clipboard by the time direct typing mode returns', async () => {
    const { deps, getClipboard } = asyncClipboardDeps();

    await injectGeneratedText(
      'generated',
      { injectionMethod: 'type', clipboardRestoreDelayMs: 0, clipboardRetention: 'keep-generated' },
      deps,
    );

    assert.equal(getClipboard(), 'generated');
  });
});
