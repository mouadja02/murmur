import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { captureContext } from '../dist/main/context/index.js';
import { Pipeline } from '../dist/main/pipeline.js';
import { loadSkills } from '../dist/main/skills.js';

// `metadata-only` promises no content on disk. The app name Murmur captures is
// cut from the end of the window title, so it can be part of a document name:
// it must not be written in that mode (#79).

const TITLE_FRAGMENT = 'Confidential-Merger-Memo.docx';

// Context sharing is off; only an app route reads the window, so nothing about
// it goes to the provider, and nothing should be persisted either.
const ROUTES_ONLY = {
  contextCapture: false,
  clipboardContextEntries: 0,
  screenshotContext: false,
  appSkillRoutes: [{ match: 'merger', enable: [], disable: [] }],
};

function makeConfig(baseDir, logMode) {
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
    logMode,
    ...ROUTES_ONLY,
  };
}

function fakeProvider(requests) {
  return {
    config: {
      id: 'local',
      displayName: 'local',
      baseUrl: 'http://localhost:11434',
      model: '',
      apiKey: null,
      temperature: 0,
    },
    async refine() {
      throw new Error('unused');
    },
    async refineStream(req) {
      requests.push(req);
      return { text: 'ok', durationMs: 1 };
    },
    async preflight() {
      return null;
    },
  };
}

function samplePcm() {
  const pcm = Buffer.alloc(32_000, 0);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(1000, i);
  return pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
}

/** Every file under `dir`, with its text. */
function sessionFiles(dir) {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const file = path.join(entry.parentPath ?? entry.path, entry.name);
      return { name: path.relative(dir, file), text: readFileSync(file, 'latin1') };
    });
}

describe('session logs and the captured app name', () => {
  let tempBase;

  beforeEach(() => {
    tempBase = mkdtempSync(path.join(tmpdir(), 'murmur-session-privacy-'));
  });

  afterEach(() => {
    rmSync(tempBase, { recursive: true, force: true });
  });

  async function dictate(logMode) {
    const cfg = makeConfig(tempBase, logMode);
    loadSkills(cfg.skillsDir);
    const requests = [];
    const pipeline = new Pipeline({
      cfg,
      provider: fakeProvider(requests),
      requestRendererStart: () => {},
      transcribeAudio: async () => ({ text: 'fix it', stderr: '', durationMs: 1 }),
      inject: async () => {},
      captureContext: () =>
        captureContext(ROUTES_ONLY, {
          activeWindow: async () => ({
            processName: TITLE_FRAGMENT,
            windowTitle: `Q3 merger plan - ${TITLE_FRAGMENT}`,
            os: 'Windows',
          }),
          clipboard: () => [],
          screenshot: async () => null,
        }),
    });
    pipeline.start();
    await pipeline.handleAudioChunk(samplePcm());

    const sessions = readdirSync(cfg.logsDir);
    assert.equal(sessions.length, 1, 'one dictation, one session folder');
    const dir = path.join(cfg.logsDir, sessions[0]);
    return { requests, dir, files: sessionFiles(dir) };
  }

  it('metadata-only: no session file contains text taken from the window title', async () => {
    const { requests, files } = await dictate('metadata-only');

    assert.equal(requests.length, 1, 'the dictation was refined');
    assert.equal(
      requests[0].systemPrompt.includes(TITLE_FRAGMENT),
      false,
      'control: context sharing is off, so nothing went to the provider',
    );
    assert.ok(
      files.some((f) => f.name === 'timings.json'),
      'control: timings.json was written',
    );
    for (const file of files) {
      assert.equal(file.text.includes(TITLE_FRAGMENT), false, `${file.name} holds title text`);
    }
    const timings = JSON.parse(files.find((f) => f.name === 'timings.json').text);
    assert.equal('app' in timings, false);
  });

  it('full: timings.json still names the app', async () => {
    const { dir } = await dictate('full');
    const timings = JSON.parse(readFileSync(path.join(dir, 'timings.json'), 'utf8'));
    assert.equal(timings.app, TITLE_FRAGMENT);
  });
});
