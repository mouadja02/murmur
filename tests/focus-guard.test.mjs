import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Pipeline } from '../dist/main/pipeline.js';
import {
  createProgressiveInjector,
  guardProgressiveInjector,
} from '../dist/main/progressive-inject.js';
import { IPC_ERROR, IPC_STATUS } from '../dist/shared/ipc.js';

const TOKENS = ['Rename ', 'getUser ', 'to ', 'fetchUser, ', 'but do not ', 'touch the tests.'];
const FULL = TOKENS.join('');
// Sentinels that must never reach a log file: they stand in for window titles/handles.
const EDITOR = 'win:EDITOR-7731';
const SLACK = 'win:SLACK-9154';

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
    progressiveInjection: false,
    vadEnabled: false,
    queueMaxDepth: 3,
    focusChangePolicy: 'copy',
    logMode: 'metadata-only',
    ...overrides,
  };
}

function samplePcm() {
  const pcm = Buffer.alloc(32_000, 0);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(1000, i);
  return pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
}

/**
 * Fakes only: `world.foreground` is the "active window" the pipeline sees, the
 * editor string is what injection/typing append to, and nothing touches the real
 * keyboard, clipboard or windows.
 */
function setup(baseDir, { cfg = {}, foreground = EDITOR, foregroundFails = false } = {}) {
  const world = {
    foreground,
    foregroundFails,
    editor: '',
    clipboard: [],
    injected: [],
    notices: [],
    statuses: [],
    gates: [],
  };
  const provider = {
    config: { id: 'test', displayName: 'Test', baseUrl: '', model: '', apiKey: null },
    async refine() {
      throw new Error('not used');
    },
    async refineStream(_req, { onToken }) {
      if (world.holdRefinement) await new Promise((resolve) => world.gates.push(resolve));
      for (const token of TOKENS) {
        onToken(token);
        await new Promise((r) => setImmediate(r));
      }
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
        if (channel === IPC_ERROR && payload.notice) world.notices.push(payload.message);
      },
    },
  };
  const pipeline = new Pipeline({
    cfg: makeConfig(baseDir, cfg),
    provider,
    getWindow: () => window,
    transcribeAudio: async () => ({ text: 'rename it', stderr: '', durationMs: 1 }),
    getForegroundWindow: async () => {
      if (world.foregroundFails) throw new Error('window query failed');
      return world.foreground;
    },
    createProgressiveInjector: () =>
      createProgressiveInjector({
        typeFn: async (text) => {
          world.editor += text;
        },
      }),
    inject: async (text) => {
      world.injected.push(text);
      world.editor += text;
    },
    copyToClipboard: async (text) => {
      world.clipboard.push(text);
    },
  });
  return { pipeline, world };
}

async function dictate(pipeline, world, { switchTo } = {}) {
  pipeline.start();
  if (switchTo !== undefined) {
    // The capture-start window query is in flight; let it settle, then switch.
    await new Promise((r) => setImmediate(r));
    world.foreground = switchTo;
  }
  await pipeline.handleAudioChunk(samplePcm());
}

function lastTimings(logsDir) {
  const dirs = readdirSync(logsDir).sort();
  return JSON.parse(readFileSync(path.join(logsDir, dirs.at(-1), 'timings.json'), 'utf8'));
}

function allLogText(logsDir) {
  return readdirSync(logsDir)
    .flatMap((d) => readdirSync(path.join(logsDir, d)).map((f) => path.join(logsDir, d, f)))
    .map((f) => readFileSync(f, 'utf8'))
    .join('\n');
}

describe('focus guard before insertion', () => {
  let base;
  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'murmur-focus-'));
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('control: pastes when the same window is still in front', async () => {
    const { pipeline, world } = setup(base);
    await dictate(pipeline, world);
    assert.deepEqual(world.injected, [FULL]);
    assert.deepEqual(world.clipboard, []);
    assert.deepEqual(world.notices, []);
  });

  it('copies instead of pasting when the foreground window changed during processing', async () => {
    const { pipeline, world } = setup(base);
    await dictate(pipeline, world, { switchTo: SLACK });
    assert.deepEqual(world.injected, [], 'nothing may be inserted into the new window');
    assert.equal(world.editor, '');
    assert.deepEqual(world.clipboard, [FULL]);
    assert.equal(world.notices.length, 1);
    assert.match(world.notices[0], /window/i);
    assert.equal(world.statuses.at(-1), 'done');
  });

  it('pastes anyway under focusChangePolicy "paste"', async () => {
    const { pipeline, world } = setup(base, { cfg: { focusChangePolicy: 'paste' } });
    await dictate(pipeline, world, { switchTo: SLACK });
    assert.deepEqual(world.injected, [FULL]);
    assert.deepEqual(world.clipboard, []);
  });

  it('treats an unknown window at capture start as unchanged', async () => {
    const { pipeline, world } = setup(base, { foreground: null });
    await dictate(pipeline, world, { switchTo: SLACK });
    assert.deepEqual(world.injected, [FULL]);
  });

  it('treats an unknown window at insertion time as unchanged', async () => {
    const { pipeline, world } = setup(base);
    pipeline.start();
    await new Promise((r) => setImmediate(r));
    world.foreground = null;
    await pipeline.handleAudioChunk(samplePcm());
    assert.deepEqual(world.injected, [FULL]);
  });

  it('treats a failing window query as unchanged', async () => {
    const { pipeline, world } = setup(base);
    pipeline.start();
    await new Promise((r) => setImmediate(r));
    world.foregroundFails = true;
    await pipeline.handleAudioChunk(samplePcm());
    assert.deepEqual(world.injected, [FULL]);
  });

  it('records only that focus changed, never the window identity', async () => {
    const { pipeline, world } = setup(base, { cfg: { logMode: 'full' } });
    await dictate(pipeline, world, { switchTo: SLACK });
    const logsDir = path.join(base, 'logs');
    assert.equal(lastTimings(logsDir).focusChanged, 1);
    const everything = allLogText(logsDir);
    assert.ok(!everything.includes('EDITOR-7731'), 'start window leaked into a log');
    assert.ok(!everything.includes('SLACK-9154'), 'new window leaked into a log');
  });

  it('progressive typing: types nothing into a window the user moved to', async () => {
    const { pipeline, world } = setup(base, { cfg: { progressiveInjection: true } });
    await dictate(pipeline, world, { switchTo: SLACK });
    assert.equal(world.editor, '', 'no keystroke may reach the other window');
    assert.deepEqual(world.clipboard, [FULL], 'the whole prompt is copied instead');
    assert.equal(world.notices.length, 1);
  });

  it('progressive typing: control, same window types every chunk in order', async () => {
    const { pipeline, world } = setup(base, { cfg: { progressiveInjection: true } });
    await dictate(pipeline, world);
    assert.equal(world.editor, FULL);
    assert.deepEqual(world.clipboard, []);
  });

  it('each queued capture is checked against the window it was started in', async () => {
    const { pipeline, world } = setup(base);
    world.holdRefinement = true;
    // Dictation 1 starts in the editor and goes to processing.
    pipeline.start();
    await new Promise((r) => setImmediate(r));
    const first = pipeline.handleAudioChunk(samplePcm());
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(world.gates.length, 1);

    // The user moves to Slack and starts dictation 2 there (queued behind 1).
    world.foreground = SLACK;
    pipeline.toggle();
    await new Promise((r) => setImmediate(r));
    pipeline.toggle();
    await pipeline.handleAudioChunk(samplePcm());

    world.holdRefinement = false;
    world.gates.shift()();
    await first;
    await new Promise((r) => setTimeout(r, 50));

    // 1 began in the editor but Slack is in front now: copied. 2 began in Slack: inserted.
    assert.deepEqual(world.clipboard, [FULL]);
    assert.deepEqual(world.injected, [FULL]);
  });
});

describe('guardProgressiveInjector', () => {
  function typedInto(sink) {
    return createProgressiveInjector({
      typeFn: async (text) => {
        sink.push(text);
      },
    });
  }

  it('releases buffered tokens in order once the first check allows typing', async () => {
    const sink = [];
    let checks = 0;
    const guarded = guardProgressiveInjector(typedInto(sink), async () => {
      checks++;
      await new Promise((r) => setTimeout(r, 10));
      return true;
    });
    guarded.pushToken('a');
    guarded.pushToken('b');
    guarded.pushToken('c');
    const result = await guarded.flush();
    assert.deepEqual(sink, ['a', 'b', 'c']);
    assert.equal(result.typed, 'abc');
    assert.equal(checks, 1, 'the window is queried once per run, not per token');
    assert.equal(guarded.blocked(), false);
  });

  it('drops every token when the check refuses, and reports it', async () => {
    const sink = [];
    const guarded = guardProgressiveInjector(typedInto(sink), async () => false);
    guarded.pushToken('a');
    guarded.pushToken('b');
    const result = await guarded.flush();
    assert.deepEqual(sink, []);
    assert.equal(result.typed, '');
    assert.equal(result.failed, false);
    assert.equal(guarded.blocked(), true);
  });

  it('abort() while the check is pending types nothing', async () => {
    const sink = [];
    const guarded = guardProgressiveInjector(typedInto(sink), async () => {
      await new Promise((r) => setTimeout(r, 20));
      return true;
    });
    guarded.pushToken('a');
    const result = await guarded.abort();
    assert.deepEqual(sink, []);
    assert.equal(result.typed, '');
  });

  it('a check that throws allows typing (unknown window is unchanged)', async () => {
    const sink = [];
    const guarded = guardProgressiveInjector(typedInto(sink), async () => {
      throw new Error('no window API');
    });
    guarded.pushToken('a');
    await guarded.flush();
    assert.deepEqual(sink, ['a']);
  });
});
