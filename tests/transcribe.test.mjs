import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { cleanTranscription, whisperThreadCount } from '../dist/main/transcribe.js';

describe('whisperThreadCount', () => {
  it('uses half the logical cores, clamped to 4..16', () => {
    assert.equal(whisperThreadCount(2), 4);
    assert.equal(whisperThreadCount(8), 4);
    assert.equal(whisperThreadCount(20), 10);
    assert.equal(whisperThreadCount(64), 16);
  });
});

describe('cleanTranscription', () => {
  it('reduces whisper silence / noise annotations to an empty string', () => {
    for (const raw of ['[BLANK_AUDIO]', ' [ Silence ] ', '(upbeat music)', '[MUSIC]\n(coughs)']) {
      assert.equal(cleanTranscription(raw), '', raw);
    }
  });

  it('keeps real speech and strips annotations around it', () => {
    assert.equal(
      cleanTranscription('[BLANK_AUDIO]\n Add a retry button. (coughs) Thanks.'),
      'Add a retry button. Thanks.',
    );
  });

  it('leaves ordinary parentheses alone', () => {
    assert.equal(
      cleanTranscription('Call foo (the helper) twice.'),
      'Call foo (the helper) twice.',
    );
  });

  it('preserves bracketed code, placeholders, and Markdown links', () => {
    const speech =
      'Use items[0], dict["key"], playlist[music], [user_id], and [music](https://example.com).';
    assert.equal(cleanTranscription(speech), speech);
  });

  it('removes known bracketed noise annotations while preserving code', () => {
    assert.equal(
      cleanTranscription('[ Silence ] Set items[0] to [user_id]. [applause]'),
      'Set items[0] to [user_id].',
    );
  });
});
