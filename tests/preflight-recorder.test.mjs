import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { runPreflight } from '../dist/main/preflight.js';

const provider = {
  preflight: async () => null,
};

function makeCfg(dir, overrides = {}) {
  return {
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
    model: 'qwen3:4b',
    apiKey: null,
    temperature: 0.2,
    whisperCliPath: 'node',
    whisperModelPath: path.join(dir, 'model.bin'),
    sampleRate: 16000,
    hotkeyCombo: 'Ctrl+Shift+Space',
    toggleHotkeyCombo: 'Ctrl+Shift+H',
    clipboardRestoreDelayMs: 150,
    overlayAnchor: 'bottom-center',
    overlayOffsetX: 0,
    overlayOffsetY: 24,
    overlayPosition: null,
    systemPrompt: 'BASE',
    enabledSkills: [],
    controlPanelPort: 7331,
    mcpPort: 7332,
    recorderCommand: 'node -e ""',
    logsDir: dir,
    skillsDir: dir,
    configFilePath: path.join(dir, 'config.json'),
    ...overrides,
  };
}

describe('runPreflight requireRecorder', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'murmur-preflight-'));
    writeFileSync(path.join(dir, 'model.bin'), '');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports invalid recorder command strings', async () => {
    const result = await runPreflight(makeCfg(dir, { recorderCommand: '   ' }), provider, {
      requireRecorder: true,
    });

    assert.equal(result.ok, false);
    assert.match(result.messages.join('\n'), /invalid recorder command/i);
  });

  it('reports missing recorder binaries', async () => {
    const result = await runPreflight(
      makeCfg(dir, { recorderCommand: 'definitely-not-a-real-recorder-a1b2c3 --raw' }),
      provider,
      { requireRecorder: true },
    );

    assert.equal(result.ok, false);
    assert.match(result.messages.join('\n'), /headless recorder command not found/i);
    assert.match(result.messages.join('\n'), /definitely-not-a-real-recorder-a1b2c3/);
  });
});
