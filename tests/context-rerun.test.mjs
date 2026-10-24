import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { captureContext } from '../dist/main/context/index.js';
import { Pipeline } from '../dist/main/pipeline.js';
import { loadSkills } from '../dist/main/skills.js';

// Re-runs (Refine last / Retry) must send only the context the *current*
// settings allow, to the *current* provider endpoint.

const SENTINEL = 'CLIPBOARD-SENTINEL-hunter2';
const LOCAL = ['local', 'http://localhost:11434'];
const CLOUD = ['openai-compat', 'https://api.example.com/v1'];

const CONTEXT_ON = {
  contextCapture: true,
  clipboardContextEntries: 2,
  screenshotContext: true,
  appSkillRoutes: [],
};
const CONTEXT_OFF = {
  contextCapture: false,
  clipboardContextEntries: 0,
  screenshotContext: false,
  appSkillRoutes: [],
};

function makeConfig(baseDir, settings) {
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
    systemPrompt: 'BASE PROMPT',
    enabledSkills: [],
    recorderCommand: 'sox -q -d -r 16000 -c 1 -b 16 -e signed-integer -t raw -',
    logsDir: path.join(baseDir, 'logs'),
    skillsDir: path.join(baseDir, 'skills'),
    ...settings,
  };
}

/** Provider fake that records every request; the first `failures` calls throw. */
function recordingProvider([id, baseUrl], requests, failures = 0) {
  let remaining = failures;
  return {
    config: { id, displayName: id, baseUrl, model: '', apiKey: null, temperature: 0 },
    async refine() {
      throw new Error('unused');
    },
    async refineStream(req) {
      requests.push({ providerId: id, ...req });
      if (remaining-- > 0) throw new Error('provider down');
      return { text: 'ok', durationMs: 1 };
    },
    async preflight() {
      return null;
    },
  };
}

/** Real `captureContext` over invented sources, so the stored shape is the production one. */
function captureWith(settings) {
  return () =>
    captureContext(settings, {
      activeWindow: async () => ({ processName: 'Code', windowTitle: 'app.ts', os: 'Windows' }),
      clipboard: (n) =>
        [
          { text: SENTINEL, timestamp: 2 },
          { text: 'SECOND-ENTRY', timestamp: 1 },
        ].slice(0, n),
      screenshot: async () => ({ base64: 'AAAA', mimeType: 'image/jpeg', width: 10, height: 10 }),
    });
}

function samplePcm() {
  const pcm = Buffer.alloc(32_000, 0);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(1000, i);
  return pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
}

describe('Pipeline re-run context', () => {
  let tempBase;

  beforeEach(() => {
    tempBase = mkdtempSync(path.join(tmpdir(), 'murmur-rerun-'));
  });

  afterEach(() => {
    rmSync(tempBase, { recursive: true, force: true });
  });

  function build(settings, provider) {
    const cfg = makeConfig(tempBase, settings);
    loadSkills(cfg.skillsDir);
    return new Pipeline({
      cfg,
      provider,
      requestRendererStart: () => {},
      transcribeAudio: async () => ({ text: 'fix it', stderr: '', durationMs: 1 }),
      inject: async () => {},
      captureContext: captureWith(settings),
    });
  }

  async function dictate(pipeline) {
    pipeline.start();
    await pipeline.handleAudioChunk(samplePcm());
  }

  it('refineLast keeps reusing the stored context while settings and provider are unchanged', async () => {
    const requests = [];
    const pipeline = build(CONTEXT_ON, recordingProvider(LOCAL, requests));
    await dictate(pipeline);
    await pipeline.refineLast();

    assert.match(requests[1].systemPrompt, new RegExp(SENTINEL));
    assert.match(requests[1].systemPrompt, /app=Code/);
    assert.equal(requests[1].images.length, 1);
  });

  it('refineLast sends no stored context once every context option is off', async () => {
    const requests = [];
    const a = build(CONTEXT_ON, recordingProvider(LOCAL, requests));
    await dictate(a);
    assert.match(requests[0].systemPrompt, new RegExp(SENTINEL));

    const b = build(CONTEXT_OFF, recordingProvider(LOCAL, requests));
    b.inheritFrom(a);
    await b.refineLast();

    assert.equal(requests[1].systemPrompt.includes(SENTINEL), false);
    assert.equal(requests[1].systemPrompt.includes('## Context'), false);
    assert.deepEqual(requests[1].images, []);
  });

  it('refineLast sends only the context parts the current settings still allow', async () => {
    const requests = [];
    const a = build(CONTEXT_ON, recordingProvider(LOCAL, requests));
    await dictate(a);

    const b = build(
      { ...CONTEXT_OFF, clipboardContextEntries: 1 },
      recordingProvider(LOCAL, requests),
    );
    b.inheritFrom(a);
    await b.refineLast();

    const prompt = requests[1].systemPrompt;
    assert.match(prompt, new RegExp(SENTINEL));
    assert.equal(prompt.includes('SECOND-ENTRY'), false);
    assert.equal(prompt.includes('app=Code'), false);
    assert.deepEqual(requests[1].images, []);
  });

  it('refineLast drops all stored context when the provider endpoint changed', async () => {
    const requests = [];
    const a = build(CONTEXT_ON, recordingProvider(LOCAL, requests));
    await dictate(a);

    // Same context settings, but the user switched to a cloud provider.
    const b = build(CONTEXT_ON, recordingProvider(CLOUD, requests));
    b.inheritFrom(a);
    await b.refineLast();

    assert.equal(requests[1].providerId, 'openai-compat');
    assert.equal(requests[1].systemPrompt.includes(SENTINEL), false);
    assert.equal(requests[1].systemPrompt.includes('app=Code'), false);
    assert.deepEqual(requests[1].images, []);
  });

  it('retry sends no stored context once the options are off', async () => {
    const requests = [];
    const a = build(CONTEXT_ON, recordingProvider(LOCAL, requests, 1));
    await dictate(a);
    assert.match(requests[0].systemPrompt, new RegExp(SENTINEL));

    const b = build(CONTEXT_OFF, recordingProvider(LOCAL, requests));
    b.inheritFrom(a);
    await b.retry();

    assert.equal(requests.length, 2);
    assert.equal(requests[1].systemPrompt.includes(SENTINEL), false);
    assert.deepEqual(requests[1].images, []);
  });

  it('retry sends no stored context after switching to another provider', async () => {
    const requests = [];
    const a = build(CONTEXT_ON, recordingProvider(LOCAL, requests, 1));
    await dictate(a);

    const b = build(CONTEXT_ON, recordingProvider(CLOUD, requests));
    b.inheritFrom(a);
    await b.retry();

    assert.equal(requests.length, 2);
    assert.equal(requests[1].providerId, 'openai-compat');
    assert.equal(requests[1].systemPrompt.includes(SENTINEL), false);
    assert.deepEqual(requests[1].images, []);
  });

  it('retry keeps the context while settings and provider are unchanged', async () => {
    const requests = [];
    const a = build(CONTEXT_ON, recordingProvider(LOCAL, requests, 1));
    await dictate(a);
    await a.retry();

    assert.match(requests[1].systemPrompt, new RegExp(SENTINEL));
    assert.equal(requests[1].images.length, 1);
  });

  it('does not bring discarded context back when the options are turned on again', async () => {
    const requests = [];
    const a = build(CONTEXT_ON, recordingProvider(LOCAL, requests));
    await dictate(a);
    const off = build(CONTEXT_OFF, recordingProvider(LOCAL, requests));
    off.inheritFrom(a);
    const on = build(CONTEXT_ON, recordingProvider(LOCAL, requests));
    on.inheritFrom(off);
    await on.refineLast();

    assert.equal(requests[1].systemPrompt.includes(SENTINEL), false);
    assert.deepEqual(requests[1].images, []);
  });

  it('still routes skills by the stored app although its title is no longer shared', async () => {
    const requests = [];
    const a = build(CONTEXT_ON, recordingProvider(LOCAL, requests));
    await dictate(a);

    const routed = {
      ...CONTEXT_OFF,
      appSkillRoutes: [{ match: 'code', enable: ['code-context'], disable: [] }],
    };
    const b = build(routed, recordingProvider(LOCAL, requests));
    b.inheritFrom(a);
    await b.refineLast();

    assert.match(requests[1].systemPrompt, /### Code context/);
    assert.equal(requests[1].systemPrompt.includes('app=Code'), false);
  });
});
