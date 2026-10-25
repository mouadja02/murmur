import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Pipeline } from '../dist/main/pipeline.js';
import { createProgressiveInjector } from '../dist/main/progressive-inject.js';
import { loadSkills } from '../dist/main/skills.js';
import { IPC_ERROR, IPC_STATUS } from '../dist/shared/ipc.js';

const TOKENS = ['Rename ', 'getUser ', 'to ', 'fetchUser ', 'but do not ', 'touch the tests.'];
const FULL = TOKENS.join('');
const TRANSCRIPTION = 'rename get user to fetch user but do not touch the tests';

function makeConfig(baseDir, overrides = {}) {
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
    progressiveInjection: true,
    ...overrides,
  };
}

/** 1 s of 16-bit mono PCM at 16 kHz (above the minimum speech length). */
function samplePcm() {
  const pcm = Buffer.alloc(32_000, 0);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(1000, i);
  return pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
}

/**
 * A pipeline wired to fakes only: a string "editor" that progressive typing
 * and `inject` append to, a clipboard log, and a provider whose behaviour the
 * test switches per call.
 */
function setup(baseDir, { typeFails = () => false, copyFails = false, cfg = {} } = {}) {
  const cfgFull = makeConfig(baseDir, cfg);
  loadSkills(cfgFull.skillsDir);
  const world = {
    editor: '',
    clipboard: [],
    injected: [],
    providerCalls: 0,
    statuses: [],
    errors: [],
    // Per-call behaviour: 'ok' | { failAfter: n } | { reject: Error } | 'wedged-length'
    nextRefine: 'ok',
    typeFails,
    transcribeFails: false,
  };
  const provider = {
    config: { id: 'test', displayName: 'Test', baseUrl: '', model: '', apiKey: null },
    async refine() {
      throw new Error('not used');
    },
    async refineStream(_req, { onToken }) {
      world.providerCalls++;
      const mode = world.nextRefine;
      if (typeof mode === 'object' && 'reject' in mode) throw mode.reject;
      const limit =
        typeof mode === 'object' && 'failAfter' in mode ? mode.failAfter : TOKENS.length;
      for (const token of TOKENS.slice(0, limit)) {
        onToken(token);
        // Let the (async) typing chain run between chunks, as a network stream would.
        await new Promise((r) => setImmediate(r));
      }
      if (limit < TOKENS.length) throw new Error('stream connection reset');
      return { text: FULL, durationMs: 1, stopReason: 'end' };
    },
    async preflight() {
      return null;
    },
  };
  const window = {
    webContents: {
      send(channel, payload) {
        if (channel === IPC_STATUS) world.statuses.push(payload);
        if (channel === IPC_ERROR) world.errors.push(payload);
      },
    },
  };
  const pipeline = new Pipeline({
    cfg: cfgFull,
    provider,
    getWindow: () => window,
    transcribeAudio: async () => {
      if (world.transcribeFails) throw new Error('whisper crashed');
      return { text: TRANSCRIPTION, stderr: '', durationMs: 1 };
    },
    createProgressiveInjector: () =>
      createProgressiveInjector({
        typeFn: async (text) => {
          if (world.typeFails(text)) throw new Error('keyboard.type rejected');
          world.editor += text;
        },
      }),
    inject: async (text) => {
      world.injected.push(text);
      world.editor += text;
    },
    copyToClipboard: async (text) => {
      if (copyFails) throw new Error('clipboard busy');
      world.clipboard.push(text);
    },
  });
  return { pipeline, world, cfg: cfgFull };
}

async function dictate(pipeline) {
  pipeline.start();
  await pipeline.handleAudioChunk(samplePcm());
}

function lastStatus(world) {
  return world.statuses.at(-1);
}

function lastTimings(cfg) {
  const dirs = readdirSync(cfg.logsDir).sort();
  return JSON.parse(readFileSync(path.join(cfg.logsDir, dirs.at(-1), 'timings.json'), 'utf8'));
}

describe('progressive insertion failure recovery', () => {
  let base;

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'murmur-recovery-'));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('stops typing at a failed chunk, copies the full prompt and does not report done', async () => {
    const { pipeline, world, cfg } = setup(base, { typeFails: (t) => t === 'but do not ' });

    await dictate(pipeline);

    // Nothing after the failed chunk is typed, so "do not" cannot silently vanish.
    assert.equal(world.editor, 'Rename getUser to fetchUser ');
    assert.deepEqual(world.clipboard, [FULL]);
    assert.equal(world.statuses.includes('done'), false);
    assert.equal(lastStatus(world), 'error');
    assert.equal(world.errors.length, 1);
    assert.match(world.errors[0].message, /typing stopped/i);
    assert.match(world.errors[0].message, /clipboard/i);
    assert.equal(lastTimings(cfg).outcome, 'partial-insert');
  });

  it('copies the prompt even when the very first chunk cannot be typed', async () => {
    const { pipeline, world } = setup(base, { typeFails: () => true });

    await dictate(pipeline);

    assert.equal(world.editor, '');
    assert.deepEqual(world.clipboard, [FULL]);
    assert.equal(lastStatus(world), 'error');
  });

  it('says so when the prompt could not be copied either', async () => {
    const { pipeline, world } = setup(base, { typeFails: (t) => t === 'to ', copyFails: true });

    await dictate(pipeline);

    assert.equal(world.editor, 'Rename getUser ');
    assert.equal(lastStatus(world), 'error');
    assert.match(world.errors[0].message, /could not be copied/i);
  });

  it('after a stream failure, Retry copies the prompt instead of typing over the partial text', async () => {
    const { pipeline, world } = setup(base);
    world.nextRefine = { failAfter: 4 };

    await dictate(pipeline);

    assert.equal(world.editor, 'Rename getUser to fetchUser ');
    assert.equal(lastStatus(world), 'error');
    assert.match(world.errors[0].message, /already typed/i);
    assert.deepEqual(world.clipboard, []);

    world.nextRefine = 'ok';
    await pipeline.retry();

    // The prefix is not typed a second time; the full prompt waits on the clipboard.
    assert.equal(world.editor, 'Rename getUser to fetchUser ');
    assert.deepEqual(world.clipboard, [FULL]);
    assert.equal(lastStatus(world), 'done');
    const notice = world.errors.at(-1);
    assert.equal(notice.notice, true);
    assert.match(notice.message, /clipboard/i);
  });

  it('Refine last after a partial insertion is also clipboard-only, once', async () => {
    const { pipeline, world } = setup(base, { typeFails: (t) => t === 'to ' });

    await dictate(pipeline);
    assert.equal(world.editor, 'Rename getUser ');
    world.clipboard.length = 0;

    await pipeline.refineLast();
    assert.equal(world.editor, 'Rename getUser ');
    assert.deepEqual(world.clipboard, [FULL]);
    assert.equal(world.errors.at(-1).notice, true);

    // The warning was delivered; the next run is a normal one again.
    world.clipboard.length = 0;
    world.typeFails = () => false;
    await pipeline.refineLast();
    assert.equal(world.editor, `Rename getUser ${FULL}`);
    assert.deepEqual(world.clipboard, []);
  });

  it('a fresh dictation after a failed one still types normally', async () => {
    const { pipeline, world } = setup(base, { typeFails: (t) => t === 'to ' });
    await dictate(pipeline);
    world.editor = '';
    world.clipboard.length = 0;
    world.typeFails = () => false;

    await dictate(pipeline);

    assert.equal(world.editor, FULL);
    assert.deepEqual(world.clipboard, []);
    assert.equal(lastStatus(world), 'done');
  });

  it('leftover text from an older dictation does not make a new dictation copy-only', async () => {
    const { pipeline, world } = setup(base, { typeFails: (t) => t === 'to ' });
    await dictate(pipeline); // dictation A leaves partial text behind
    world.editor = '';
    world.clipboard.length = 0;
    world.typeFails = () => false;

    // Dictation B fails before anything is typed.
    world.nextRefine = { reject: new Error('Test unreachable') };
    await dictate(pipeline);
    assert.equal(world.editor, '');

    world.nextRefine = 'ok';
    await pipeline.retry();

    // B's own retry types normally: nothing of B is in the target.
    assert.equal(world.editor, FULL);
    assert.deepEqual(world.clipboard, []);
    assert.equal(lastStatus(world), 'done');
  });

  it('keeps the warning when a copy-only Retry fails again before delivering', async () => {
    const { pipeline, world } = setup(base);
    world.nextRefine = { failAfter: 2 };
    await dictate(pipeline);
    assert.equal(world.editor, 'Rename getUser ');

    world.nextRefine = { reject: new Error('Test unreachable') };
    await pipeline.retry();
    world.nextRefine = 'ok';
    await pipeline.retry();

    assert.equal(world.editor, 'Rename getUser ');
    assert.deepEqual(world.clipboard, [FULL]);
  });

  it('a complete progressive run is still reported as done and leaves the clipboard alone', async () => {
    const { pipeline, world } = setup(base);

    await dictate(pipeline);

    assert.equal(world.editor, FULL);
    assert.deepEqual(world.clipboard, []);
    assert.equal(lastStatus(world), 'done');
    assert.equal(world.errors.length, 0);
  });

  it('keeps the partial-insertion warning when the pipeline is rebuilt by a config reload', async () => {
    const { pipeline, world } = setup(base, { typeFails: (t) => t === 'to ' });
    await dictate(pipeline);
    world.clipboard.length = 0;

    const { pipeline: rebuilt, world: rebuiltWorld } = setup(base);
    rebuilt.inheritFrom(pipeline);
    await rebuilt.refineLast();

    assert.equal(rebuiltWorld.editor, '');
    assert.deepEqual(rebuiltWorld.clipboard, [FULL]);
  });
});

describe('insert raw transcription', () => {
  let base;

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'murmur-raw-'));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('inserts the exact transcription after a refinement failure without calling the provider', async () => {
    const { pipeline, world } = setup(base, { cfg: { progressiveInjection: false } });
    world.nextRefine = { reject: new Error('Test unreachable') };

    await dictate(pipeline);

    assert.equal(lastStatus(world), 'error');
    assert.equal(world.errors[0].canInsertRaw, true);
    assert.equal(pipeline.canInsertRaw(), true);
    const callsBefore = world.providerCalls;

    await pipeline.insertRaw();

    assert.deepEqual(world.injected, [TRANSCRIPTION]);
    assert.equal(world.providerCalls, callsBefore);
    assert.equal(lastStatus(world), 'done');
    assert.equal(pipeline.canInsertRaw(), false);
  });

  it('does not offer an earlier failure words once a later dictation fails before transcription', async () => {
    const { pipeline, world } = setup(base, { cfg: { progressiveInjection: false } });
    world.nextRefine = { reject: new Error('Test unreachable') };
    await dictate(pipeline);
    assert.equal(pipeline.canInsertRaw(), true);

    world.transcribeFails = true;
    await dictate(pipeline);

    // The older dictation's words must never be inserted for this failure.
    assert.equal(world.errors.at(-1).canInsertRaw, false);
    assert.equal(pipeline.canInsertRaw(), false);
    await assert.rejects(pipeline.insertRaw(), /no transcription/i);
    assert.deepEqual(world.injected, []);
  });

  it('copies the transcription to the clipboard when insertion itself fails', async () => {
    const { pipeline, world } = setup(base, { cfg: { progressiveInjection: false } });
    world.nextRefine = { reject: new Error('Test unreachable') };
    await dictate(pipeline);

    const failing = new Pipeline({
      cfg: setup(base).cfg,
      provider: {
        config: { id: 'test', displayName: 'Test', baseUrl: '', model: '', apiKey: null },
      },
      inject: async () => {
        throw new Error('paste failed');
      },
      copyToClipboard: async (text) => {
        world.clipboard.push(text);
      },
    });
    failing.inheritFrom(pipeline);

    await assert.rejects(failing.insertRaw(), /paste failed/);
    assert.deepEqual(world.clipboard, [TRANSCRIPTION]);
    assert.equal(failing.canInsertRaw(), true);
  });

  it('is clipboard-only when a progressive run already left text in the target', async () => {
    const { pipeline, world } = setup(base, { typeFails: (t) => t === 'to ' });
    await dictate(pipeline);
    world.clipboard.length = 0;
    assert.equal(pipeline.canInsertRaw(), true);

    await pipeline.insertRaw();

    assert.deepEqual(world.injected, []);
    assert.deepEqual(world.clipboard, [TRANSCRIPTION]);
    assert.equal(world.errors.at(-1).notice, true);
  });

  it('refuses while a capture is in flight', async () => {
    const { pipeline, world } = setup(base, { cfg: { progressiveInjection: false } });
    world.nextRefine = { reject: new Error('Test unreachable') };
    await dictate(pipeline);

    pipeline.start();

    assert.equal(pipeline.canInsertRaw(), false);
    await assert.rejects(pipeline.insertRaw(), /busy/i);
  });
});
