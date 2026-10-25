import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Pipeline } from '../dist/main/pipeline.js';

function makeConfig(baseDir) {
  return {
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
    model: 'qwen3:4b',
    apiKey: null,
    temperature: 0.2,
    whisperCliPath: 'C:/whisper.exe',
    whisperModelPath: 'C:/model.bin',
    sampleRate: 16000,
    clipboardRestoreDelayMs: 150,
    clipboardRetention: 'keep-generated',
    injectionMethod: 'auto',
    systemPrompt: 'BASE PROMPT',
    enabledSkills: [],
    logsDir: path.join(baseDir, 'logs'),
    skillsDir: path.join(baseDir, 'skills'),
    progressiveInjection: false,
    vadEnabled: false,
    queueMaxDepth: 3,
  };
}

function samplePcm() {
  const pcm = Buffer.alloc(32_000, 0);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(1000, i);
  return pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
}

/** A pipeline whose refinement waits until the test releases it. */
function setup(baseDir) {
  const world = { starts: [], stops: 0, injected: [], gates: [] };
  const provider = {
    config: { id: 'test', displayName: 'Test', baseUrl: '', model: '', apiKey: null },
    async refine() {
      throw new Error('not used');
    },
    async refineStream() {
      await new Promise((resolve) => world.gates.push(resolve));
      return { text: 'refined', durationMs: 1, stopReason: 'end' };
    },
    async preflight() {
      return null;
    },
  };
  const pipeline = new Pipeline({
    cfg: makeConfig(baseDir),
    provider,
    requestRendererStart: (autoStop) => world.starts.push(autoStop),
    requestRendererStop: () => {
      world.stops++;
    },
    transcribeAudio: async () => ({ text: 'spoken words', stderr: '', durationMs: 1 }),
    inject: async (text) => {
      world.injected.push(text);
    },
    copyToClipboard: async () => {},
  });
  return { pipeline, world };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

describe('hotkey toggle capture', () => {
  let base;
  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'murmur-hotkey-capture-'));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('a hotkey toggle press from idle starts a capture that VAD silence will not end', () => {
    const { pipeline, world } = setup(base);
    pipeline.toggle('hotkey-toggle');
    assert.equal(pipeline.isRecording(), true);
    assert.deepEqual(world.starts, [false]);
  });

  it('the next press stops it', () => {
    const { pipeline, world } = setup(base);
    pipeline.toggle('hotkey-toggle');
    pipeline.toggle('hotkey-toggle');
    assert.equal(world.stops, 1);
  });

  it('control: click-to-record still auto-stops on silence', () => {
    const { pipeline, world } = setup(base);
    pipeline.toggle();
    assert.deepEqual(world.starts, [true]);
  });

  it('control: hold mode start() is unchanged (no auto-stop)', () => {
    const { pipeline, world } = setup(base);
    pipeline.start();
    assert.deepEqual(world.starts, [false]);
  });

  it('a press while the previous dictation is processing queues a new capture instead of dropping it', async () => {
    const { pipeline, world } = setup(base);
    pipeline.toggle('hotkey-toggle');
    // The renderer does not wait for processing to finish, so neither does this.
    const first = pipeline.handleAudioChunk(samplePcm());
    await settle();
    assert.equal(world.gates.length, 1, 'first dictation is waiting on the provider');
    assert.equal(pipeline.isRecording(), false);

    pipeline.toggle('hotkey-toggle'); // starts a background capture
    assert.deepEqual(world.starts, [false, false]);
    pipeline.toggle('hotkey-toggle'); // stops it
    assert.equal(world.stops, 1);
    await pipeline.handleAudioChunk(samplePcm()); // its audio arrives and is queued

    world.gates.shift()(); // first refinement completes, queued one runs
    await settle();
    assert.equal(world.gates.length, 1, 'the queued dictation reached the provider');
    world.gates.shift()();
    await first;
    await settle();
    assert.deepEqual(world.injected, ['refined', 'refined']);
  });
});
