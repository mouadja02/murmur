import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { startControlPanelServer } from '../dist/main/control-panel/server.js';

function makeFakeConfig(overrides = {}) {
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
    controlPanelPort: 0,
    logsDir: 'logs',
    skillsDir: overrides.skillsDir ?? 'skills',
    overlay: { anchor: 'bottom-center', offsetX: 0, offsetY: -40 },
    overlayAnchor: 'bottom-center',
    overlayOffsetX: 0,
    overlayOffsetY: -40,
    overlayPosition: null,
    configFilePath: overrides.configFilePath ?? 'C:/fake/config.json',
    ...overrides,
  };
}

describe('control-panel server', () => {
  let handle;
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'murmur-cp-'));
  });

  afterEach(async () => {
    if (handle) await handle.stop();
    handle = undefined;
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('boots on an ephemeral port and serves the SPA shell', async () => {
    const cfg = makeFakeConfig({ skillsDir: tempDir });
    handle = await startControlPanelServer({
      getCurrentConfig: () => cfg,
      onConfigUpdated: () => {},
      testLlm: async () => ({ ok: true, message: 'mocked', latencyMs: 1 }),
    });
    assert.ok(handle.port > 0, 'port is assigned');
    assert.match(handle.url, /^http:\/\/localhost:\d+$/);

    const homeRes = await fetch(`${handle.url}/`);
    assert.equal(homeRes.status, 200);
    const html = await homeRes.text();
    assert.match(html, /<title>.*murmur/i);
  });

  it('exposes GET /api/state with config / skills / composedSystemPrompt / providers', async () => {
    const cfg = makeFakeConfig({ skillsDir: tempDir });
    handle = await startControlPanelServer({
      getCurrentConfig: () => cfg,
      onConfigUpdated: () => {},
      testLlm: async () => ({ ok: true, message: 'mocked' }),
    });

    const res = await fetch(`${handle.url}/api/state`);
    assert.equal(res.status, 200);
    const body = await res.json();

    for (const key of ['config', 'skills', 'composedSystemPrompt', 'providers']) {
      assert.ok(key in body, `/api/state includes ${key}`);
    }
    assert.equal(body.config.provider, 'ollama');
    assert.ok(Array.isArray(body.skills));
    assert.ok(Array.isArray(body.providers));
  });

  it('redacts apiKey in GET /api/state output', async () => {
    const cfg = makeFakeConfig({ skillsDir: tempDir, apiKey: 'super-secret-token' });
    handle = await startControlPanelServer({
      getCurrentConfig: () => cfg,
      onConfigUpdated: () => {},
      testLlm: async () => ({ ok: true, message: 'mocked' }),
    });

    const body = await (await fetch(`${handle.url}/api/state`)).json();
    assert.notEqual(body.config.apiKey, 'super-secret-token');
    assert.equal(body.config.apiKeySet, true);
  });

  it('POST /api/test/llm forwards the deps.testLlm result', async () => {
    const cfg = makeFakeConfig({ skillsDir: tempDir });
    handle = await startControlPanelServer({
      getCurrentConfig: () => cfg,
      onConfigUpdated: () => {},
      testLlm: async () => ({ ok: false, message: 'connection refused', latencyMs: 7 }),
    });

    const res = await fetch(`${handle.url}/api/test/llm`, { method: 'POST' });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.message, 'connection refused');
    assert.equal(body.latencyMs, 7);
  });
});
