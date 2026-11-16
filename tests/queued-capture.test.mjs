import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { Pipeline } from '../dist/main/pipeline.js';

/**
 * A capture can be requested while the pipeline is busy with something else:
 * a dictation being processed, Refine last, or Insert raw. Whoever asked (the
 * pill, a toggle press or a hold-to-talk press) has the microphone open from
 * that moment, so the pipeline must take the capture over when the busy work
 * ends. These tests drive the real Pipeline from dist/ with fake renderer
 * start/stop, provider, inserter and clipboard: no microphone, no desktop.
 */

/** Longer than any "go idle" linger the pipeline schedules after done or an error (1.5 s / 2.5 s). */
const STATUS_LINGER_PAST = 3_000;

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

/** 1 s of 16-bit mono PCM at 16 kHz (above the minimum speech length). */
function samplePcm() {
  const pcm = Buffer.alloc(32_000, 0);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(1000, i);
  return pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
}

/**
 * Fakes whose slow steps wait for the test: `world.refineGates` holds each
 * in-flight refinement, `world.injectGates` each in-flight insertion.
 * `world.refineMode` / `world.injectMode` switch a step to 'gated' or 'fail'.
 */
function setup(baseDir) {
  let takes = 0;
  const world = {
    starts: [],
    stops: 0,
    injected: [],
    statuses: [],
    refineMode: 'immediate',
    injectMode: 'immediate',
    refineGates: [],
    injectGates: [],
  };
  const provider = {
    config: { id: 'test', displayName: 'Test', baseUrl: '', model: '', apiKey: null },
    async refine() {
      throw new Error('not used');
    },
    async refineStream(req) {
      if (world.refineMode === 'gated') await new Promise((r) => world.refineGates.push(r));
      if (world.refineMode === 'fail') throw new Error('Test provider unreachable');
      return { text: `REFINED: ${req.userPrompt}`, durationMs: 1, stopReason: 'end' };
    },
    async preflight() {
      return null;
    },
  };
  const pipeline = new Pipeline({
    cfg: makeConfig(baseDir),
    provider,
    emitStatus: (s) => world.statuses.push(s),
    requestRendererStart: (autoStop) => world.starts.push(autoStop),
    requestRendererStop: () => {
      world.stops++;
    },
    transcribeAudio: async () => {
      takes++;
      return { text: `take ${takes}`, stderr: '', durationMs: 1 };
    },
    inject: async (text) => {
      if (world.injectMode === 'gated') await new Promise((r) => world.injectGates.push(r));
      if (world.injectMode === 'fail') throw new Error('paste failed');
      world.injected.push(text);
    },
    copyToClipboard: async () => {},
  });
  return { pipeline, world };
}

/** Waits (bounded) until `cond()` holds; fails the test instead of hanging. */
async function until(cond, what) {
  for (let i = 0; i < 500; i++) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
  assert.fail(`timed out waiting for: ${what}`);
}

/** Dictates once with a click and waits for the result to be inserted. */
async function dictateOnce(pipeline, world) {
  pipeline.toggle();
  pipeline.toggle();
  await pipeline.handleAudioChunk(samplePcm());
  await until(() => world.injected.length === 1, 'first dictation inserted');
}

describe('a capture started while Refine last is running', () => {
  let base;
  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'murmur-queued-capture-'));
    mock.timers.enable({ apis: ['setTimeout'] });
  });
  afterEach(() => {
    mock.timers.reset();
    rmSync(base, { recursive: true, force: true });
  });

  it('control: with nothing queued, Refine last leaves the pipeline idle', async () => {
    const { pipeline, world } = setup(base);
    await dictateOnce(pipeline, world);
    await pipeline.refineLast();
    assert.equal(pipeline.isIdle(), true);
    assert.equal(pipeline.isRecording(), false);
    assert.deepEqual(world.starts, [true]);
  });

  it('becomes the live recording when Refine last finishes, and the next click stops it', async () => {
    const { pipeline, world } = setup(base);
    await dictateOnce(pipeline, world);
    world.refineMode = 'gated';
    const refining = pipeline.refineLast();
    await until(() => world.refineGates.length === 1, 'refine-last waiting on the provider');

    pipeline.toggle(); // the pill is clicked: the microphone opens
    assert.equal(world.starts.length, 2, 'the renderer was told to record');

    world.refineGates.shift()();
    await refining;

    assert.equal(pipeline.isRecording(), true, 'the open microphone is the live recording');
    assert.equal(world.statuses.at(-1), 'recording');
    mock.timers.tick(STATUS_LINGER_PAST); // a stale "go idle" timer must not fire
    assert.equal(world.statuses.at(-1), 'recording', 'the overlay still shows the open microphone');
    const startsBeforeStop = world.starts.length;

    pipeline.toggle(); // the user means "stop"
    assert.equal(world.stops, 2, 'that click stopped the capture');
    assert.equal(world.starts.length, startsBeforeStop, 'and did not open a second one');

    world.refineMode = 'immediate';
    await pipeline.handleAudioChunk(samplePcm());
    await until(() => world.injected.length === 3, 'second dictation inserted');
    assert.deepEqual(world.injected, ['REFINED: take 1', 'REFINED: take 1', 'REFINED: take 2']);
    assert.equal(pipeline.isIdle(), true, 'nothing is left busy');
  });

  it('runs a capture that was started and stopped during Refine last once it finishes', async () => {
    const { pipeline, world } = setup(base);
    await dictateOnce(pipeline, world);
    world.refineMode = 'gated';
    const refining = pipeline.refineLast();
    await until(() => world.refineGates.length === 1, 'refine-last waiting on the provider');

    pipeline.toggle(); // start
    pipeline.toggle(); // stop
    await pipeline.handleAudioChunk(samplePcm()); // its audio arrives and is queued

    world.refineMode = 'immediate';
    world.refineGates.shift()();
    await refining;
    await until(() => world.injected.length === 3, 'queued dictation inserted');

    assert.deepEqual(world.injected, ['REFINED: take 1', 'REFINED: take 1', 'REFINED: take 2']);
    assert.equal(pipeline.isIdle(), true);
  });

  it('is handed over when Refine last fails as well', async () => {
    const { pipeline, world } = setup(base);
    await dictateOnce(pipeline, world);
    world.refineMode = 'gated';
    const refining = pipeline.refineLast();
    const failure = assert.rejects(refining, /unreachable/);
    await until(() => world.refineGates.length === 1, 'refine-last waiting on the provider');

    pipeline.toggle();
    world.refineMode = 'fail';
    world.refineGates.shift()();
    await failure;

    assert.equal(pipeline.isRecording(), true);
    mock.timers.tick(STATUS_LINGER_PAST);
    assert.equal(
      world.statuses.at(-1),
      'recording',
      'the error linger must not hide the microphone',
    );
    pipeline.toggle();
    world.refineMode = 'immediate';
    await pipeline.handleAudioChunk(samplePcm());
    await until(() => world.injected.length === 2, 'second dictation inserted');
    assert.equal(pipeline.isIdle(), true);
  });
});

describe('a capture started while Insert raw is running', () => {
  let base;
  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'murmur-queued-capture-'));
    mock.timers.enable({ apis: ['setTimeout'] });
  });
  afterEach(() => {
    mock.timers.reset();
    rmSync(base, { recursive: true, force: true });
  });

  /** Leaves the pipeline with an error whose words Insert raw can still insert. */
  async function failedDictation(pipeline, world) {
    world.refineMode = 'fail';
    pipeline.toggle();
    pipeline.toggle();
    await pipeline.handleAudioChunk(samplePcm());
    await until(() => pipeline.canInsertRaw(), 'a failed dictation to recover');
    world.refineMode = 'immediate';
  }

  it('becomes the live recording when Insert raw finishes', async () => {
    const { pipeline, world } = setup(base);
    await failedDictation(pipeline, world);
    world.injectMode = 'gated';
    const inserting = pipeline.insertRaw();
    await until(() => world.injectGates.length === 1, 'insert raw waiting on the inserter');

    pipeline.toggle(); // the pill is clicked: the microphone opens
    world.injectGates.shift()();
    await inserting;

    assert.equal(pipeline.isRecording(), true);
    assert.equal(world.statuses.at(-1), 'recording');
    mock.timers.tick(STATUS_LINGER_PAST);
    assert.equal(world.statuses.at(-1), 'recording', 'the overlay still shows the open microphone');
    const startsBeforeStop = world.starts.length;
    pipeline.toggle();
    assert.equal(world.starts.length, startsBeforeStop);

    world.injectMode = 'immediate';
    await pipeline.handleAudioChunk(samplePcm());
    await until(() => world.injected.length === 2, 'second dictation inserted');
    assert.deepEqual(world.injected, ['take 1', 'REFINED: take 2']);
    assert.equal(pipeline.isIdle(), true);
  });

  it('is handed over when Insert raw fails as well', async () => {
    const { pipeline, world } = setup(base);
    await failedDictation(pipeline, world);
    world.injectMode = 'gated';
    const inserting = pipeline.insertRaw();
    const failure = assert.rejects(inserting, /paste failed/);
    await until(() => world.injectGates.length === 1, 'insert raw waiting on the inserter');

    pipeline.toggle();
    world.injectMode = 'fail';
    world.injectGates.shift()();
    await failure;

    assert.equal(pipeline.isRecording(), true);
    mock.timers.tick(STATUS_LINGER_PAST);
    assert.equal(
      world.statuses.at(-1),
      'recording',
      'the error linger must not hide the microphone',
    );
    pipeline.toggle();
    world.injectMode = 'immediate';
    await pipeline.handleAudioChunk(samplePcm());
    await until(() => world.injected.length === 1, 'second dictation inserted');
    assert.equal(pipeline.isIdle(), true);
  });
});

describe('a hold-to-talk press while a dictation is processing', () => {
  let base;
  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'murmur-queued-capture-'));
    mock.timers.enable({ apis: ['setTimeout'] });
  });
  afterEach(() => {
    mock.timers.reset();
    rmSync(base, { recursive: true, force: true });
  });

  /** Starts a dictation and leaves it waiting on the provider. */
  async function firstDictationInFlight(pipeline, world) {
    world.refineMode = 'gated';
    pipeline.start('ptt');
    const first = pipeline.handleAudioChunk(samplePcm());
    await until(() => world.refineGates.length === 1, 'first dictation waiting on the provider');
    return { first };
  }

  it('queues a capture instead of being dropped, and inserts both dictations in order', async () => {
    const { pipeline, world } = setup(base);
    const { first } = await firstDictationInFlight(pipeline, world);
    assert.deepEqual(world.starts, [false]);

    pipeline.start('ptt'); // key down
    assert.deepEqual(world.starts, [false, false], 'the renderer was told to record, no auto-stop');
    pipeline.stop(); // key up
    assert.equal(world.stops, 1, 'release ended the queued capture');
    await pipeline.handleAudioChunk(samplePcm()); // its audio arrives and is queued

    world.refineMode = 'immediate';
    world.refineGates.shift()();
    await first;
    await until(() => world.injected.length === 2, 'both dictations inserted');

    assert.deepEqual(world.injected, ['REFINED: take 1', 'REFINED: take 2']);
    assert.equal(pipeline.isIdle(), true);
  });

  it('keeps recording when the dictation finishes before the key is released', async () => {
    const { pipeline, world } = setup(base);
    const { first } = await firstDictationInFlight(pipeline, world);

    pipeline.start('ptt'); // key down, still held
    world.refineMode = 'immediate';
    world.refineGates.shift()();
    await first;

    assert.equal(pipeline.isRecording(), true, 'the held key is now the live recording');
    mock.timers.tick(STATUS_LINGER_PAST);
    assert.equal(world.statuses.at(-1), 'recording');
    pipeline.stop(); // key up
    assert.equal(world.stops, 1);
    await pipeline.handleAudioChunk(samplePcm());
    await until(() => world.injected.length === 2, 'both dictations inserted');
    assert.deepEqual(world.injected, ['REFINED: take 1', 'REFINED: take 2']);
    assert.equal(pipeline.isIdle(), true);
  });

  it('opens only one capture however many presses arrive before the release', async () => {
    const { pipeline, world } = setup(base);
    await firstDictationInFlight(pipeline, world);

    pipeline.start('ptt');
    pipeline.start('ptt');
    assert.deepEqual(world.starts, [false, false]);
  });

  it('control: a release with nothing queued does not ask the renderer to stop', async () => {
    const { pipeline, world } = setup(base);
    await firstDictationInFlight(pipeline, world);

    pipeline.stop();
    assert.equal(world.stops, 0);
  });

  it('is queued behind Refine last too', async () => {
    const { pipeline, world } = setup(base);
    await dictateOnce(pipeline, world);
    world.refineMode = 'gated';
    const refining = pipeline.refineLast();
    await until(() => world.refineGates.length === 1, 'refine-last waiting on the provider');

    pipeline.start('ptt');
    pipeline.stop();
    await pipeline.handleAudioChunk(samplePcm());

    world.refineMode = 'immediate';
    world.refineGates.shift()();
    await refining;
    await until(() => world.injected.length === 3, 'queued dictation inserted');
    assert.deepEqual(world.injected, ['REFINED: take 1', 'REFINED: take 1', 'REFINED: take 2']);
    assert.equal(pipeline.isIdle(), true);
  });
});
