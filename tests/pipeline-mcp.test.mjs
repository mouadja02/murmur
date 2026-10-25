import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Pipeline } from '../dist/main/pipeline.js';
import { OpenAiCompatProvider } from '../dist/main/providers/openai-compat.js';
import { loadSkills } from '../dist/main/skills.js';

function makeFakeConfig(overrides = {}) {
  const baseDir = overrides._baseDir ?? mkdtempSync(path.join(tmpdir(), 'murmur-pipe-'));
  return {
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
    model: 'qwen3:4b',
    apiKey: null,
    temperature: 0.2,
    whisperCliPath: 'C:/whisper.exe',
    whisperModelPath: 'C:/model.bin',
    sampleRate: 16000,
    hotkeyCombo: 'Ctrl+Shift+Space',
    toggleHotkeyCombo: 'Ctrl+Shift+H',
    clipboardRestoreDelayMs: 150,
    systemPrompt: 'BASE PROMPT',
    enabledSkills: [],
    controlPanelPort: 7331,
    mcpPort: 7332,
    recorderCommand: 'sox -q -d -r 16000 -c 1 -b 16 -e signed-integer -t raw -',
    logsDir: path.join(baseDir, 'logs'),
    skillsDir: path.join(baseDir, 'skills'),
    overlay: { anchor: 'bottom-center', offsetX: 0, offsetY: -40 },
    overlayAnchor: 'bottom-center',
    overlayOffsetX: 0,
    overlayOffsetY: -40,
    overlayPosition: null,
    configFilePath: 'C:/fake/config.json',
    _baseDir: baseDir,
    ...overrides,
  };
}

function makeFakeProvider(refinements) {
  return {
    config: {
      id: 'test',
      displayName: 'Test',
      baseUrl: '',
      model: '',
      apiKey: null,
      temperature: 0,
    },
    async refine({ systemPrompt, userPrompt }) {
      refinements.push({ systemPrompt, userPrompt });
      return { text: `REFINED: ${userPrompt}`, durationMs: 1 };
    },
    async refineStream({ systemPrompt, userPrompt }, { onToken }) {
      refinements.push({ systemPrompt, userPrompt });
      const text = `REFINED: ${userPrompt}`;
      for (const word of text.split(' ')) {
        onToken(`${word} `);
      }
      return { text, durationMs: 1 };
    },
    async preflight() {
      return null;
    },
  };
}

/** 16-bit mono PCM, 1 s at 16 kHz (above the pipeline's minimum speech length). */
function samplePcm(bytes = 32_000) {
  const pcm = Buffer.alloc(bytes, 0);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(1000, i);
  return pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
}

describe('Pipeline MCP / headless', () => {
  let tempBase;

  beforeEach(() => {
    tempBase = mkdtempSync(path.join(tmpdir(), 'murmur-pipe-'));
  });

  afterEach(() => {
    if (tempBase) rmSync(tempBase, { recursive: true, force: true });
  });

  it('processPcm with inject:false returns refined text without injecting', async () => {
    const cfg = makeFakeConfig({ _baseDir: tempBase });
    loadSkills(cfg.skillsDir);
    const statuses = [];
    const injections = [];
    const refinements = [];
    const provider = makeFakeProvider(refinements);

    const pipeline = new Pipeline({
      cfg,
      provider,
      emitStatus: (s) => statuses.push(s),
      transcribeAudio: async () => ({
        text: 'hello world',
        stderr: '',
        durationMs: 1,
      }),
      inject: async (text) => {
        injections.push(text);
      },
    });

    const result = await pipeline.processPcm(samplePcm(), { inject: false });

    assert.equal(result.text, 'REFINED: hello world');
    assert.equal(result.transcription, 'hello world');
    assert.ok(result.sessionDir);
    assert.equal(injections.length, 0);
    assert.deepEqual(
      statuses.filter((s) => s !== 'idle'),
      ['transcribing-streaming', 'refining-streaming', 'done'],
    );
  });

  it('does not inject a truncated provider response as a successful refinement', async () => {
    const cfg = makeFakeConfig({ _baseDir: tempBase });
    loadSkills(cfg.skillsDir);
    const originalFetch = globalThis.fetch;
    const injections = [];
    const clipboard = [];
    const statuses = [];
    const event = {
      choices: [{ delta: { content: 'partial output' }, finish_reason: 'length' }],
    };
    globalThis.fetch = async () =>
      new Response(`data: ${JSON.stringify(event)}\n\ndata: [DONE]\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    try {
      const pipeline = new Pipeline({
        cfg,
        provider: new OpenAiCompatProvider({
          id: 'openai-compat',
          displayName: 'Test',
          baseUrl: 'http://provider/v1',
          model: 'm',
          apiKey: null,
          temperature: 0,
        }),
        transcribeAudio: async () => ({ text: 'spoken request', stderr: '', durationMs: 1 }),
        inject: async (text) => injections.push(text),
        copyToClipboard: async (text) => clipboard.push(text),
        emitStatus: (status) => statuses.push(status),
      });

      await assert.rejects(pipeline.processPcm(samplePcm()), (err) => {
        assert.equal(err.name, 'IncompleteRefinementError');
        assert.equal(err.stopReason, 'length');
        assert.equal(err.partialText, 'partial output');
        assert.equal(err.transcription, 'spoken request');
        assert.equal(err.copiedToClipboard, true);
        return true;
      });
      assert.deepEqual(injections, []);
      assert.deepEqual(clipboard, ['partial output']);
      assert.equal(statuses.includes('done'), false);
      assert.equal(statuses.at(-1), 'error');
      assert.equal(pipeline.hasLastTranscription(), true);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('keeps typing progressively and still rejects a truncated stream', async () => {
    const cfg = makeFakeConfig({ _baseDir: tempBase, progressiveInjection: true });
    loadSkills(cfg.skillsDir);
    const provider = makeFakeProvider([]);
    provider.refineStream = async (_req, { onToken }) => {
      onToken('partial ');
      onToken('output');
      return { text: 'partial output', durationMs: 1, stopReason: 'length' };
    };
    const typed = [];
    const clipboard = [];
    const pipeline = new Pipeline({
      cfg,
      provider,
      transcribeAudio: async () => ({ text: 'spoken request', stderr: '', durationMs: 1 }),
      createProgressiveInjector: () => ({
        pushToken: (token) => typed.push(token),
        flush: async () => ({ typed: 'partial output', failed: false }),
        abort: async () => ({ typed: 'partial output', failed: false }),
      }),
      copyToClipboard: async (text) => clipboard.push(text),
    });

    await assert.rejects(pipeline.processPcm(samplePcm()), { name: 'IncompleteRefinementError' });
    assert.deepEqual(typed, ['partial ', 'output']);
    assert.deepEqual(clipboard, ['partial output']);
  });

  it('returns the spoken words with a failure that happens after transcription', async () => {
    const cfg = makeFakeConfig({ _baseDir: tempBase });
    loadSkills(cfg.skillsDir);
    const provider = makeFakeProvider([]);
    const unreachable = new Error('Test unreachable');
    provider.refineStream = async () => {
      throw unreachable;
    };
    const pipeline = new Pipeline({
      cfg,
      provider,
      transcribeAudio: async () => ({ text: 'spoken request', stderr: '', durationMs: 1 }),
    });

    await assert.rejects(pipeline.processPcm(samplePcm(), { inject: false }), (err) => {
      assert.equal(err.name, 'DictationError');
      assert.equal(err.message, 'Test unreachable');
      assert.equal(err.transcription, 'spoken request');
      assert.equal(err.cause, unreachable);
      return true;
    });
  });

  it('does not attach words to a failure before transcription', async () => {
    const cfg = makeFakeConfig({ _baseDir: tempBase });
    loadSkills(cfg.skillsDir);
    const pipeline = new Pipeline({
      cfg,
      provider: makeFakeProvider([]),
      transcribeAudio: async () => {
        throw new Error('whisper crashed');
      },
    });

    await assert.rejects(pipeline.processPcm(samplePcm(), { inject: false }), (err) => {
      assert.equal(err.name, 'Error');
      assert.equal(err.transcription, undefined);
      return true;
    });
  });

  it('leaves the clipboard alone for a truncated headless record or refine', async () => {
    const cfg = makeFakeConfig({ _baseDir: tempBase });
    loadSkills(cfg.skillsDir);
    const provider = makeFakeProvider([]);
    const truncated = { text: 'partial output', durationMs: 1, stopReason: 'length' };
    provider.refine = async () => truncated;
    provider.refineStream = async () => truncated;
    const clipboard = [];
    const pipeline = new Pipeline({
      cfg,
      provider,
      transcribeAudio: async () => ({ text: 'spoken request', stderr: '', durationMs: 1 }),
      copyToClipboard: async (text) => clipboard.push(text),
    });

    await assert.rejects(pipeline.processPcm(samplePcm(), { inject: false }), (err) => {
      assert.equal(err.name, 'IncompleteRefinementError');
      assert.equal(err.partialText, 'partial output');
      assert.equal(err.copiedToClipboard, false);
      return true;
    });
    await assert.rejects(pipeline.refineText('raw request'), {
      name: 'IncompleteRefinementError',
    });
    assert.deepEqual(clipboard, []);
  });

  it('refineText with skillIds composes skills without mutating cfg.enabledSkills', async () => {
    const cfg = makeFakeConfig({ _baseDir: tempBase, enabledSkills: [] });
    loadSkills(cfg.skillsDir);
    const refinements = [];
    const pipeline = new Pipeline({
      cfg,
      provider: makeFakeProvider(refinements),
    });

    const before = [...cfg.enabledSkills];
    const refined = await pipeline.refineText('raw text', { skillIds: ['concise-output'] });

    assert.equal(refined, 'REFINED: raw text');
    assert.deepEqual(cfg.enabledSkills, before);
    assert.match(refinements[0].systemPrompt, /## Active skills/);
    assert.match(refinements[0].systemPrompt, /### Concise output/);
  });

  it('record auto-stops, rejects concurrent calls, and resolves refined text', async () => {
    const cfg = makeFakeConfig({ _baseDir: tempBase });
    loadSkills(cfg.skillsDir);
    const refinements = [];
    const pcm = samplePcm();

    let activeRecorder = null;
    const pipeline = new Pipeline({
      cfg,
      provider: makeFakeProvider(refinements),
      transcribeAudio: async () => ({
        text: 'dictated',
        stderr: '',
        durationMs: 1,
      }),
      createRecorder: () => {
        const recorder = {
          async start() {
            if (activeRecorder) throw new Error('recorder already active');
            activeRecorder = recorder;
          },
          async stop() {
            activeRecorder = null;
            return pcm;
          },
        };
        return recorder;
      },
    });

    const first = pipeline.record({ durationMs: 1, inject: false });
    await assert.rejects(() => pipeline.record({ durationMs: 1 }), /already/i);
    const result = await first;

    assert.equal(result.text, 'REFINED: dictated');
    assert.equal(result.transcription, 'dictated');
    assert.equal(activeRecorder, null);
  });

  it('stopRecording rejects when no active headless recording', async () => {
    const cfg = makeFakeConfig({ _baseDir: tempBase });
    const pipeline = new Pipeline({
      cfg,
      provider: makeFakeProvider([]),
      createRecorder: () => ({
        async start() {},
        async stop() {
          return samplePcm();
        },
      }),
    });

    await assert.rejects(() => pipeline.stopRecording(), /no active recording/i);
  });

  it('open-ended record() rejects when stopRecording fails and allows recovery', async () => {
    const cfg = makeFakeConfig({ _baseDir: tempBase });
    loadSkills(cfg.skillsDir);
    const pcm = samplePcm();
    let failTranscribe = true;

    const pipeline = new Pipeline({
      cfg,
      provider: makeFakeProvider([]),
      transcribeAudio: async () => {
        if (failTranscribe) {
          failTranscribe = false;
          throw new Error('whisper blew up');
        }
        return { text: 'recovered', stderr: '', durationMs: 1 };
      },
      createRecorder: () => ({
        async start() {},
        async stop() {
          return pcm;
        },
      }),
    });

    const recordPromise = pipeline.record({ inject: false });
    await Promise.resolve();

    await assert.rejects(pipeline.stopRecording(), /whisper blew up/i);
    await assert.rejects(recordPromise, /whisper blew up/i);
    assert.equal(pipeline.isIdle(), true);

    const result = await pipeline.record({ durationMs: 1, inject: false });
    assert.equal(result.text, 'REFINED: recovered');
  });

  it('record() cleans up when recorder.start() fails and allows a later record()', async () => {
    const cfg = makeFakeConfig({ _baseDir: tempBase });
    loadSkills(cfg.skillsDir);
    const pcm = samplePcm();
    let failNextStart = true;

    const pipeline = new Pipeline({
      cfg,
      provider: makeFakeProvider([]),
      transcribeAudio: async () => ({
        text: 'recovered',
        stderr: '',
        durationMs: 1,
      }),
      createRecorder: () => ({
        async start() {
          if (failNextStart) {
            failNextStart = false;
            throw new Error('mic unavailable');
          }
        },
        async stop() {
          return pcm;
        },
      }),
    });

    await assert.rejects(() => pipeline.record({ durationMs: 1 }), /mic unavailable/i);
    assert.equal(pipeline.isIdle(), true);

    const result = await pipeline.record({ durationMs: 1, inject: false });
    assert.equal(result.text, 'REFINED: recovered');
  });

  describe('headless recording lifetime', () => {
    function lifetimePipeline(extra = {}) {
      const cfg = makeFakeConfig({ _baseDir: tempBase });
      const recorders = [];
      const pipeline = new Pipeline({
        cfg,
        provider: makeFakeProvider([]),
        transcribeAudio: async () => ({ text: 'dictated', stderr: '', durationMs: 1 }),
        createRecorder: () => {
          const recorder = {
            starts: 0,
            stops: 0,
            exitListener: null,
            async start() {
              recorder.starts += 1;
            },
            async stop() {
              recorder.stops += 1;
              return samplePcm();
            },
            onUnexpectedExit(listener) {
              recorder.exitListener = listener;
            },
          };
          recorders.push(recorder);
          return recorder;
        },
        ...extra,
      });
      return { pipeline, recorders };
    }

    const tick = () => new Promise((resolve) => setImmediate(resolve));

    it('aborting an open-ended record stops the recorder, rejects it and frees the pipeline', async () => {
      const { pipeline, recorders } = lifetimePipeline();
      const controller = new AbortController();

      const rejected = assert.rejects(pipeline.record({ signal: controller.signal }), /cancelled/i);
      await tick();
      assert.equal(pipeline.isBusy(), true);

      controller.abort();
      await rejected;

      assert.equal(recorders[0].stops, 1);
      assert.equal(pipeline.isBusy(), false);
      const [cancelled] = readdirSync(path.join(tempBase, 'logs'));
      const timings = JSON.parse(
        readFileSync(path.join(tempBase, 'logs', cancelled, 'timings.json'), 'utf8'),
      );
      assert.equal(timings.outcome, 'cancelled');
      const next = await pipeline.record({ durationMs: 1 });
      assert.equal(next.text, 'REFINED: dictated');
    });

    it('rejects a record whose signal is already aborted without creating a recorder', async () => {
      const { pipeline, recorders } = lifetimePipeline();

      await assert.rejects(pipeline.record({ signal: AbortSignal.abort() }), /cancelled/i);

      assert.equal(recorders.length, 0);
      assert.equal(pipeline.isBusy(), false);
    });

    it('aborting a timed record cancels it before the timer fires', async () => {
      const { pipeline, recorders } = lifetimePipeline();
      const controller = new AbortController();

      const rejected = assert.rejects(
        pipeline.record({ durationMs: 60_000, signal: controller.signal }),
        /cancelled/i,
      );
      await tick();
      controller.abort();
      await rejected;

      assert.equal(recorders[0].stops, 1);
      assert.equal(pipeline.isBusy(), false);
    });

    it('ignores an abort that arrives after the recorder was told to stop', async () => {
      const { pipeline, recorders } = lifetimePipeline();
      const controller = new AbortController();

      const pending = pipeline.record({ signal: controller.signal });
      await tick();
      const stopped = pipeline.stopRecording();
      controller.abort();

      assert.equal((await pending).text, 'REFINED: dictated');
      assert.equal((await stopped).text, 'REFINED: dictated');
      assert.equal(recorders[0].stops, 1);
    });

    it('stopRecording also resolves a timed record that is still waiting on its timer', async () => {
      const { pipeline } = lifetimePipeline();

      const timed = pipeline.record({ durationMs: 60_000 });
      await tick();
      await pipeline.stopRecording();

      assert.equal((await timed).text, 'REFINED: dictated');
      assert.equal(pipeline.isBusy(), false);
    });

    it('stops an open-ended record at maxRecordMs and flags it', async () => {
      const { pipeline, recorders } = lifetimePipeline({ maxRecordMs: 40 });

      const result = await pipeline.record({});

      assert.equal(result.text, 'REFINED: dictated');
      assert.equal(result.stoppedAtLimit, true);
      assert.equal(recorders[0].stops, 1);
      assert.equal(pipeline.isBusy(), false);
    });

    it('clamps a longer duration_ms to maxRecordMs but leaves a shorter one alone', async () => {
      const { pipeline } = lifetimePipeline({ maxRecordMs: 40 });

      const clamped = await pipeline.record({ durationMs: 60_000 });
      assert.equal(clamped.stoppedAtLimit, true);

      const timed = await pipeline.record({ durationMs: 5 });
      assert.equal(timed.stoppedAtLimit, undefined);
    });

    it('rejects the pending record with the recorder error when it exits on its own', async () => {
      const { pipeline, recorders } = lifetimePipeline();

      const rejected = assert.rejects(
        pipeline.record({}),
        /recorder exited with code 2.*device unplugged/s,
      );
      await tick();
      recorders[0].exitListener(
        new Error('recorder exited with code 2. stderr:\ndevice unplugged'),
      );
      await rejected;

      assert.equal(pipeline.isBusy(), false);
      assert.equal(recorders[0].stops, 0, 'the dead recorder is not stopped again');
    });

    it('rejects inject:true without a text inserter before creating the recorder', async () => {
      const { pipeline, recorders } = lifetimePipeline();

      await assert.rejects(
        pipeline.record({ durationMs: 1, inject: true }),
        /injection is unavailable/i,
      );

      assert.equal(recorders.length, 0);
      assert.equal(pipeline.isBusy(), false);
    });
  });
});

describe('Pipeline overlay path', () => {
  let tempBase;

  beforeEach(() => {
    tempBase = mkdtempSync(path.join(tmpdir(), 'murmur-pipe-'));
  });

  afterEach(() => {
    if (tempBase) rmSync(tempBase, { recursive: true, force: true });
  });

  it('start() triggers renderer start; handleAudioChunk injects with full status flow', async () => {
    const cfg = makeFakeConfig({ _baseDir: tempBase });
    loadSkills(cfg.skillsDir);
    const statuses = [];
    const rendererStarts = [];
    const injections = [];

    const pipeline = new Pipeline({
      cfg,
      provider: makeFakeProvider([]),
      emitStatus: (s) => statuses.push(s),
      requestRendererStart: () => rendererStarts.push(true),
      requestRendererStop: () => {
        throw new Error('renderer stop should not run in this test');
      },
      transcribeAudio: async () => ({
        text: 'overlay speech',
        stderr: '',
        durationMs: 1,
      }),
      inject: async (text) => injections.push(text),
    });

    pipeline.start();
    assert.equal(rendererStarts.length, 1);

    await pipeline.handleAudioChunk(samplePcm());

    assert.equal(injections.length, 1);
    assert.equal(injections[0], 'REFINED: overlay speech');
    assert.deepEqual(
      statuses.filter((s) => s !== 'idle' && s !== 'recording'),
      ['transcribing-streaming', 'refining-streaming', 'injecting', 'done'],
    );
  });

  it('stop() is ignored during headless recording and does not call renderer stop', async () => {
    const cfg = makeFakeConfig({ _baseDir: tempBase });
    const rendererStops = [];
    const pcm = samplePcm();

    const pipeline = new Pipeline({
      cfg,
      provider: makeFakeProvider([]),
      transcribeAudio: async () => ({
        text: 'dictated',
        stderr: '',
        durationMs: 1,
      }),
      requestRendererStop: () => rendererStops.push(true),
      createRecorder: () => ({
        async start() {},
        async stop() {
          return pcm;
        },
      }),
    });

    const pending = pipeline.record({ durationMs: 50, inject: false });
    pipeline.stop();
    assert.equal(rendererStops.length, 0);

    await pending;
    assert.equal(rendererStops.length, 0);
  });

  it('treats an empty transcription as no speech: no refine, no inject, no error', async () => {
    const cfg = makeFakeConfig({ _baseDir: tempBase });
    loadSkills(cfg.skillsDir);
    const statuses = [];
    const refinements = [];
    const injections = [];
    const sent = [];

    const pipeline = new Pipeline({
      cfg,
      provider: makeFakeProvider(refinements),
      emitStatus: (s) => statuses.push(s),
      getWindow: () => ({ webContents: { send: (ch, payload) => sent.push([ch, payload]) } }),
      requestRendererStart: () => {},
      transcribeAudio: async () => ({ text: '', stderr: '', durationMs: 1 }),
      inject: async (text) => injections.push(text),
    });

    pipeline.start();
    await pipeline.handleAudioChunk(samplePcm());

    assert.equal(refinements.length, 0);
    assert.equal(injections.length, 0);
    assert.equal(statuses.includes('error'), false);
    assert.equal(statuses.at(-1), 'idle');
    assert.equal(
      sent.some(([ch]) => ch === 'murmur:error'),
      false,
    );
    assert.equal(pipeline.isIdle(), true);
    assert.equal(pipeline.hasLastTranscription(), false);
  });

  it('skips whisper entirely for an accidental tap', async () => {
    const cfg = makeFakeConfig({ _baseDir: tempBase });
    let transcribed = false;
    const pipeline = new Pipeline({
      cfg,
      provider: makeFakeProvider([]),
      transcribeAudio: async () => {
        transcribed = true;
        return { text: 'should not run', stderr: '', durationMs: 1 };
      },
    });

    // 100 ms of audio
    await assert.rejects(pipeline.processPcm(samplePcm(3_200), { inject: false }), {
      name: 'NoSpeechError',
    });
    assert.equal(transcribed, false);
  });

  it('refineLast uses the currently enabled skills and blocks new captures', async () => {
    const cfg = makeFakeConfig({ _baseDir: tempBase, enabledSkills: [] });
    loadSkills(cfg.skillsDir);
    const refinements = [];
    let release;
    const provider = makeFakeProvider(refinements);
    const pipeline = new Pipeline({
      cfg,
      provider,
      requestRendererStart: () => {
        throw new Error('capture must not start while refine-last runs');
      },
      transcribeAudio: async () => ({ text: 'first take', stderr: '', durationMs: 1 }),
      inject: async () => {},
    });

    await pipeline.processPcm(samplePcm(), { inject: false });

    // User enables a skill in the panel, then hits "Refine last".
    cfg.enabledSkills = ['concise-output'];
    const gate = new Promise((r) => {
      release = r;
    });
    provider.refineStream = async ({ systemPrompt, userPrompt }) => {
      refinements.push({ systemPrompt, userPrompt });
      await gate;
      return { text: `AGAIN: ${userPrompt}`, durationMs: 1 };
    };
    const pending = pipeline.refineLast();
    await Promise.resolve();

    assert.equal(pipeline.isBusy(), true);
    pipeline.start(); // ignored while busy
    release();
    assert.equal(await pending, 'AGAIN: first take');
    assert.match(refinements.at(-1).systemPrompt, /### Concise output/);
    assert.equal(pipeline.isIdle(), true);
  });

  it('inheritFrom carries refine-last history into a rebuilt pipeline', async () => {
    const cfg = makeFakeConfig({ _baseDir: tempBase });
    loadSkills(cfg.skillsDir);
    const old = new Pipeline({
      cfg,
      provider: makeFakeProvider([]),
      transcribeAudio: async () => ({ text: 'keep me', stderr: '', durationMs: 1 }),
    });
    await old.processPcm(samplePcm(), { inject: false });

    const refinements = [];
    const rebuilt = new Pipeline({ cfg, provider: makeFakeProvider(refinements) });
    assert.equal(rebuilt.hasLastTranscription(), false);
    rebuilt.inheritFrom(old);
    assert.equal(rebuilt.hasLastTranscription(), true);
    await rebuilt.refineLast();
    assert.equal(refinements.at(-1).userPrompt, 'keep me');
  });

  it('VAD gate drops a quiet capture before whisper runs', async () => {
    const cfg = makeFakeConfig({ _baseDir: tempBase, vadEnabled: true, vadThresholdDb: -40 });
    let transcribed = false;
    const pipeline = new Pipeline({
      cfg,
      provider: makeFakeProvider([]),
      transcribeAudio: async () => {
        transcribed = true;
        return { text: 'you', stderr: '', durationMs: 1 };
      },
    });
    const quiet = Buffer.alloc(32_000);
    for (let i = 0; i < quiet.length; i += 2) quiet.writeInt16LE(i % 4 ? 30 : -30, i); // ~-60 dBFS
    await assert.rejects(pipeline.processPcm(quiet, { inject: false }), { name: 'NoSpeechError' });
    assert.equal(transcribed, false);

    // samplePcm() is a constant 1000 (~-30 dBFS): passes the gate.
    const result = await pipeline.processPcm(samplePcm(), { inject: false });
    assert.equal(result.transcription, 'you');
  });

  it('click-to-record listens, flips to recording on speech, and auto-stops on silence', async () => {
    const cfg = makeFakeConfig({ _baseDir: tempBase, vadEnabled: true });
    const statuses = [];
    const starts = [];
    let stops = 0;
    const pipeline = new Pipeline({
      cfg,
      provider: makeFakeProvider([]),
      emitStatus: (s) => statuses.push(s),
      requestRendererStart: (autoStop) => starts.push(autoStop),
      requestRendererStop: () => {
        stops++;
      },
      transcribeAudio: async () => ({ text: 'x', stderr: '', durationMs: 1 }),
      inject: async () => {},
    });

    pipeline.toggle();
    assert.deepEqual(starts, [true]);
    assert.equal(statuses.at(-1), 'vad-listening');
    pipeline.speechStarted();
    assert.equal(statuses.at(-1), 'recording');

    pipeline.vadSilence();
    pipeline.toggle(); // user clicks at the same moment: must not stop twice
    assert.equal(stops, 1);
    await pipeline.handleAudioChunk(samplePcm());
    assert.ok(statuses.includes('done'));
  });

  it('keeps a capture started during processing alive after processing finishes', async () => {
    // Reproduces a real session log: the user clicked to keep talking while
    // the previous dictation was refining; that one finished first.
    const cfg = makeFakeConfig({ _baseDir: tempBase });
    loadSkills(cfg.skillsDir);
    const injections = [];
    let releaseFirst;
    let calls = 0;
    const pipeline = new Pipeline({
      cfg,
      provider: makeFakeProvider([]),
      requestRendererStart: () => {},
      requestRendererStop: () => {},
      transcribeAudio: async () => {
        calls++;
        if (calls === 1) await new Promise((r) => (releaseFirst = r));
        return { text: `take ${calls}`, stderr: '', durationMs: 1 };
      },
      inject: async (t) => injections.push(t),
    });

    pipeline.toggle(); // first capture
    pipeline.toggle(); // stop it
    const first = pipeline.handleAudioChunk(samplePcm());
    await new Promise((r) => setImmediate(r));
    pipeline.toggle(); // second capture starts while the first is processing
    releaseFirst();
    await first;

    // First finished; the second capture must now be the live recording.
    assert.equal(pipeline.isRecording(), true);
    pipeline.toggle(); // user stops the second capture
    await pipeline.handleAudioChunk(samplePcm());
    assert.deepEqual(injections, ['REFINED: take 1', 'REFINED: take 2']);
    assert.equal(pipeline.isIdle(), true);
  });

  it('push-to-talk asks the renderer not to auto-stop', () => {
    const starts = [];
    const pipeline = new Pipeline({
      cfg: makeFakeConfig({ _baseDir: tempBase }),
      provider: makeFakeProvider([]),
      requestRendererStart: (autoStop) => starts.push(autoStop),
    });
    pipeline.start();
    assert.deepEqual(starts, [false]);
  });

  it('feeds captured context, routed skills and images to the provider; refine-last reuses it', async () => {
    const cfg = makeFakeConfig({
      _baseDir: tempBase,
      enabledSkills: [],
      appSkillRoutes: [{ match: 'code', enable: ['code-context'], disable: [] }],
      contextCapture: true,
      clipboardContextEntries: 0,
      screenshotContext: true,
    });
    loadSkills(cfg.skillsDir);
    const requests = [];
    const provider = makeFakeProvider([]);
    provider.refineStream = async (req) => {
      requests.push(req);
      return { text: 'ok', durationMs: 1 };
    };
    let captures = 0;
    const pipeline = new Pipeline({
      cfg,
      provider,
      requestRendererStart: () => {},
      transcribeAudio: async () => ({ text: 'fix it', stderr: '', durationMs: 1 }),
      inject: async () => {},
      captureContext: async () => {
        captures++;
        const window = { processName: 'Code', windowTitle: 'app.ts', os: 'Windows' };
        const screenshot = { base64: 'AAAA', mimeType: 'image/jpeg', width: 10, height: 10 };
        return {
          window,
          block: '<!-- context: app=Code -->',
          images: [{ base64: 'AAAA', mimeType: 'image/jpeg' }],
          shared: { window, clipboard: [], screenshot },
        };
      },
    });

    pipeline.start();
    await pipeline.handleAudioChunk(samplePcm());
    assert.equal(captures, 1);
    assert.match(requests[0].systemPrompt, /### Code context/);
    assert.match(requests[0].systemPrompt, /## Context[\s\S]*app=Code/);
    assert.deepEqual(requests[0].images, [{ base64: 'AAAA', mimeType: 'image/jpeg' }]);

    await pipeline.refineLast();
    assert.equal(captures, 1, 'refine-last reuses the original context');
    assert.match(requests[1].systemPrompt, /app=Code/);
  });

  it('a failing context capture does not break the dictation', async () => {
    const cfg = makeFakeConfig({ _baseDir: tempBase });
    loadSkills(cfg.skillsDir);
    const injections = [];
    const pipeline = new Pipeline({
      cfg,
      provider: makeFakeProvider([]),
      requestRendererStart: () => {},
      transcribeAudio: async () => ({ text: 'still works', stderr: '', durationMs: 1 }),
      inject: async (t) => injections.push(t),
      captureContext: async () => {
        throw new Error('no accessibility permission');
      },
    });
    pipeline.start();
    await pipeline.handleAudioChunk(samplePcm());
    assert.deepEqual(injections, ['REFINED: still works']);
  });

  it('processPcm() defaults inject to true and emits injecting status', async () => {
    const cfg = makeFakeConfig({ _baseDir: tempBase });
    loadSkills(cfg.skillsDir);
    const statuses = [];
    const injections = [];

    const pipeline = new Pipeline({
      cfg,
      provider: makeFakeProvider([]),
      emitStatus: (s) => statuses.push(s),
      transcribeAudio: async () => ({
        text: 'spoken',
        stderr: '',
        durationMs: 1,
      }),
      inject: async (text) => injections.push(text),
    });

    await pipeline.processPcm(samplePcm());

    assert.equal(injections.length, 1);
    assert.ok(statuses.includes('injecting'));
  });
});

describe('Pipeline capture sample rate', () => {
  let tempBase;

  beforeEach(() => {
    tempBase = mkdtempSync(path.join(tmpdir(), 'murmur-pipe-'));
  });

  afterEach(() => {
    if (tempBase) rmSync(tempBase, { recursive: true, force: true });
  });

  /** Runs 3 s of 16 kHz PCM (what the renderer and headless recorder deliver). */
  async function run(cfgOverrides) {
    const cfg = makeFakeConfig({ _baseDir: tempBase, logMode: 'full', ...cfgOverrides });
    let headerRate = null;
    const pipeline = new Pipeline({
      cfg,
      provider: makeFakeProvider([]),
      emitStatus: () => {},
      transcribeAudio: async (wavPath) => {
        headerRate = readFileSync(wavPath).readUInt32LE(24);
        return { text: 'hello world', stderr: '', durationMs: 1 };
      },
      inject: async () => {},
    });
    const result = await pipeline.processPcm(samplePcm(96_000), { inject: false });
    const timings = JSON.parse(readFileSync(path.join(result.sessionDir, 'timings.json'), 'utf8'));
    return { headerRate, timings };
  }

  it('labels the WAV 16000 Hz even when cfg.sampleRate says otherwise', async () => {
    const { headerRate } = await run({ sampleRate: 48000 });
    assert.equal(headerRate, 16000);
  });

  it('measures duration at 16 kHz even when cfg.sampleRate says otherwise', async () => {
    const { timings } = await run({ sampleRate: 48000 });
    assert.equal(timings.audioDurationMs, 3000);
  });

  it('is unchanged for the default 16 kHz config', async () => {
    const { headerRate, timings } = await run({});
    assert.equal(headerRate, 16000);
    assert.equal(timings.audioDurationMs, 3000);
  });
});
