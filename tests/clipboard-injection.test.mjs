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
