import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sanitizePartial } from '../dist/main/config/schema.js';

describe('sanitizePartial', () => {
  it('returns an empty object for non-object input', () => {
    assert.deepEqual(sanitizePartial(null, 'test'), {});
    assert.deepEqual(sanitizePartial('nope', 'test'), {});
    assert.deepEqual(sanitizePartial(42, 'test'), {});
  });

  it('keeps known scalar fields and drops unknown ones', () => {
    const out = sanitizePartial(
      {
        provider: 'ollama',
        baseUrl: 'http://localhost:11434',
        model: 'qwen3:4b',
        temperature: 0.3,
        bogusField: 'ignored',
      },
      'test',
    );
    assert.equal(out.provider, 'ollama');
    assert.equal(out.baseUrl, 'http://localhost:11434');
    assert.equal(out.model, 'qwen3:4b');
    assert.equal(out.temperature, 0.3);
    assert.equal('bogusField' in out, false);
  });

  it('rejects an unknown provider value', () => {
    const out = sanitizePartial({ provider: 'not-a-provider' }, 'test');
    assert.equal(out.provider, undefined);
  });

  it('filters enabledSkills to strings only', () => {
    const out = sanitizePartial({ enabledSkills: ['a', 1, 'b', null, 'c'] }, 'test');
    assert.deepEqual(out.enabledSkills, ['a', 'b', 'c']);
  });

  it('validates controlPanelPort range', () => {
    assert.equal(sanitizePartial({ controlPanelPort: 7331 }, 'test').controlPanelPort, 7331);
    assert.equal(sanitizePartial({ controlPanelPort: 0 }, 'test').controlPanelPort, 0);
    assert.equal(sanitizePartial({ controlPanelPort: -1 }, 'test').controlPanelPort, undefined);
    assert.equal(sanitizePartial({ controlPanelPort: 999999 }, 'test').controlPanelPort, undefined);
    assert.equal(sanitizePartial({ controlPanelPort: 'nope' }, 'test').controlPanelPort, undefined);
  });

  it('accepts nested overlay block', () => {
    const out = sanitizePartial(
      { overlay: { anchor: 'bottom-right', offsetX: 10, offsetY: 20 } },
      'test',
    );
    assert.deepEqual(out.overlay, { anchor: 'bottom-right', offsetX: 10, offsetY: 20 });
  });
});
