// tests/pcm.test.mjs
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { floatsToInt16PCM, downsample } from '../dist/shared/pcm.js';

describe('floatsToInt16PCM', () => {
  it('converts +1.0 to max positive int16', () => {
    const result = floatsToInt16PCM([new Float32Array([1.0])]);
    assert.equal(result[0], 0x7fff);
  });

  it('converts -1.0 to max negative int16', () => {
    const result = floatsToInt16PCM([new Float32Array([-1.0])]);
    assert.equal(result[0], -0x8000);
  });

  it('clamps values outside [-1, 1]', () => {
    const result = floatsToInt16PCM([new Float32Array([2.0, -2.0])]);
    assert.equal(result[0], 0x7fff);
    assert.equal(result[1], -0x8000);
  });

  it('concatenates multiple chunks in order', () => {
    const result = floatsToInt16PCM([new Float32Array([0.5]), new Float32Array([-0.5])]);
    assert.equal(result.length, 2);
    assert.ok(result[0] > 0);
    assert.ok(result[1] < 0);
  });
});

describe('downsample', () => {
  it('returns original when rates are equal', () => {
    const input = new Int16Array([1, 2, 3, 4]);
    const result = downsample(input, 16000, 16000);
    assert.deepEqual(Array.from(result), [1, 2, 3, 4]);
  });

  it('halves sample count for 2x ratio', () => {
    const input = new Int16Array([100, 200, 300, 400, 500, 600]);
    const result = downsample(input, 32000, 16000);
    assert.equal(result.length, 3);
    assert.equal(result[0], 100);
    assert.equal(result[1], 300);
    assert.equal(result[2], 500);
  });

  it('handles non-integer ratios without crashing', () => {
    const input = new Int16Array(441);
    input.fill(1000);
    const result = downsample(input, 44100, 16000);
    assert.ok(result.length > 0);
    assert.ok(result.every((v) => v === 1000));
  });
});
