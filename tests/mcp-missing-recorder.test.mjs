import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { CommandAudioRecorder } from '../dist/main/audio/recorder.js';
import { createMurmurMcpServer } from '../dist/main/mcp/server.js';
import { Pipeline } from '../dist/main/pipeline.js';
import { checkRecorderCommand } from '../dist/main/preflight.js';

// #78: the overlay app serves murmur_record from the same MCP endpoint as
// `murmur serve`, but it never ran the recorder preflight. These tests wire a
// real Pipeline and a real CommandAudioRecorder the way createMainPipeline()
// in src/main/index.ts does, with a recorder command that is not installed.

const MISSING = 'murmur-test-no-such-recorder-5d1e';

function makeCfg(dir) {
  return {
    provider: 'ollama',
    baseUrl: 'http://127.0.0.1:9',
    model: 'fake',
    apiKey: null,
    temperature: 0,
    whisperCliPath: path.join(dir, 'whisper-cli'),
    whisperModelPath: path.join(dir, 'model.bin'),
    sampleRate: 16000,
    hotkeyCombo: 'Ctrl+Shift+Space',
    toggleHotkeyCombo: 'Ctrl+Shift+H',
    clipboardRestoreDelayMs: 150,
    systemPrompt: 'BASE',
    enabledSkills: [],
    controlPanelPort: 0,
    mcpPort: 0,
    recorderCommand: `${MISSING} -q -t raw -`,
    logsDir: path.join(dir, 'logs'),
    skillsDir: path.join(dir, 'skills'),
    overlayAnchor: 'bottom-center',
    overlayOffsetX: 0,
    overlayOffsetY: -40,
    overlayPosition: null,
    configFilePath: path.join(dir, 'config.json'),
  };
}

function neverCalledProvider() {
  const fail = async () => {
    throw new Error('provider must not be called when the recorder cannot start');
  };
  return {
    config: { id: 'test', displayName: 'Test', baseUrl: '', model: '', apiKey: null },
    refine: fail,
    refineStream: fail,
    preflight: async () => null,
  };
}

describe('murmur_record with a missing recorder command', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'murmur-missing-rec-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns a tool error that names the command and the fix, and frees the pipeline', async () => {
    const cfg = makeCfg(dir);
    const pipeline = new Pipeline({
      cfg,
      provider: neverCalledProvider(),
      transcribeAudio: async () => {
        throw new Error('whisper must not run when the recorder cannot start');
      },
      createRecorder: () => new CommandAudioRecorder({ commandLine: cfg.recorderCommand }),
    });
    const server = createMurmurMcpServer({
      getConfig: () => cfg,
      onConfigUpdated: () => {},
      getPipeline: () => pipeline,
    });

    const result = await server.callToolForTest('murmur_record', { duration_ms: 50 });

    assert.equal(result.isError, true);
    const text = result.content[0].text;
    assert.match(text, new RegExp(`recorder command not found: ${MISSING}\\b`));
    assert.match(text, /install SoX/);
    assert.match(text, /--recorder-command/);
    assert.doesNotMatch(text, /^spawn \S+ ENOENT$/);
    assert.equal(pipeline.isBusy(), false);
  });
});

describe('checkRecorderCommand', () => {
  it('reports a recorder command that is not installed', () => {
    const problem = checkRecorderCommand(`${MISSING} -q`);
    assert.match(problem, new RegExp(`recorder command not found: ${MISSING}\\b`));
    assert.match(problem, /install SoX/);
  });

  it('reports an unparseable recorder command', () => {
    assert.match(checkRecorderCommand('sox "unterminated'), /invalid recorder command/);
  });

  it('accepts an installed recorder command, also when quoted', () => {
    assert.equal(checkRecorderCommand(`"${process.execPath}" -e ""`), null);
  });
});
