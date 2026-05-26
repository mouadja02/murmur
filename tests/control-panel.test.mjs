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
    clipboardRetention: 'keep-generated',
    injectionMethod: 'auto',
    systemPrompt: 'BASE PROMPT',
    enabledSkills: [],
    controlPanelPort: 0,
    logMode: 'metadata-only',
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

    const token = (await (await fetch(`${handle.url}/api/state`)).json()).security.csrfToken;
    const res = await fetch(`${handle.url}/api/test/llm`, {
      method: 'POST',
      headers: { 'X-Murmur-Token': token },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.message, 'connection refused');
    assert.equal(body.latencyMs, 7);
  });

  it('does not allow cross-origin reads or wildcard CORS', async () => {
    const cfg = makeFakeConfig({ skillsDir: tempDir });
    handle = await startControlPanelServer({
      getCurrentConfig: () => cfg,
      onConfigUpdated: () => {},
      testLlm: async () => ({ ok: true, message: 'mocked' }),
    });

    const sameOrigin = await fetch(`${handle.url}/api/state`);
    assert.equal(sameOrigin.headers.get('access-control-allow-origin'), null);

    const crossOrigin = await fetch(`${handle.url}/api/state`, {
      headers: { Origin: 'https://evil.example' },
    });
    assert.equal(crossOrigin.status, 403);
  });

  it('requires the per-session token for state-changing API calls', async () => {
    const cfg = makeFakeConfig({ skillsDir: tempDir });
    let tested = false;
    handle = await startControlPanelServer({
      getCurrentConfig: () => cfg,
      onConfigUpdated: () => {},
      testLlm: async () => {
        tested = true;
        return { ok: true, message: 'mocked' };
      },
    });

    const missingToken = await fetch(`${handle.url}/api/test/llm`, { method: 'POST' });
    assert.equal(missingToken.status, 403);
    assert.equal(tested, false);

    const state = await (await fetch(`${handle.url}/api/state`)).json();
    const withToken = await fetch(`${handle.url}/api/test/llm`, {
      method: 'POST',
      headers: { 'X-Murmur-Token': state.security.csrfToken },
    });
    assert.equal(withToken.status, 200);
    assert.equal(tested, true);
  });

  it('rejects side-effectful overlay GET routes', async () => {
    const cfg = makeFakeConfig({ skillsDir: tempDir });
    let shown = false;
    handle = await startControlPanelServer({
      getCurrentConfig: () => cfg,
      onConfigUpdated: () => {},
      testLlm: async () => ({ ok: true, message: 'mocked' }),
      showOverlay: () => {
        shown = true;
      },
    });

    const res = await fetch(`${handle.url}/overlay/show`);
    assert.equal(res.status, 405);
    assert.equal(shown, false);
  });

  it('rejects traversal-style skill ids through the API', async () => {
    const cfg = makeFakeConfig({ skillsDir: tempDir });
    handle = await startControlPanelServer({
      getCurrentConfig: () => cfg,
      onConfigUpdated: () => {},
      testLlm: async () => ({ ok: true, message: 'mocked' }),
    });

    const state = await (await fetch(`${handle.url}/api/state`)).json();
    const headers = {
      'Content-Type': 'application/json',
      'X-Murmur-Token': state.security.csrfToken,
    };

    const create = await fetch(`${handle.url}/api/skills`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: '../evil', name: 'evil', content: 'nope' }),
    });
    assert.equal(create.status, 400);

    const del = await fetch(`${handle.url}/api/skills/%2e%2e%2fevil`, {
      method: 'DELETE',
      headers,
    });
    assert.equal(del.status, 400);
  });
});
