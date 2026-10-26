import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';
import { startControlPanelServer } from '../dist/main/control-panel/server.js';

const config = {
  provider: 'ollama',
  baseUrl: 'http://localhost:11434',
  model: 'qwen3:4b',
  apiKey: null,
  temperature: 0.2,
  whisperCliPath: 'whisper-cli',
  whisperModelPath: 'model.bin',
  hotkeyCombo: 'Ctrl+Shift+Space',
  hotkeyMode: 'hold',
  toggleHotkeyCombo: 'Ctrl+Shift+H',
  clipboardRestoreDelayMs: 150,
  clipboardRetention: 'keep-generated',
  injectionMethod: 'auto',
  systemPrompt: 'BASE PROMPT',
  enabledSkills: [],
  controlPanelPort: 0,
  mcpPort: 7332,
  recorderCommand: 'sox',
  logsDir: 'logs',
  skillsDir: 'skills',
  overlayAnchor: 'bottom-center',
  overlayOffsetX: 0,
  overlayOffsetY: 0,
  overlayPosition: null,
  configFilePath: 'config.json',
};

describe('control panel request hardening', () => {
  let handle;

  afterEach(async () => {
    if (handle) await handle.stop();
    handle = undefined;
  });

  const boot = async () => {
    handle = await startControlPanelServer({
      getCurrentConfig: () => config,
      onConfigUpdated: () => {},
      testLlm: async () => ({ ok: true, message: 'mocked' }),
    });
    const state = await (await fetch(`${handle.url}/api/state`)).json();
    return state.security.csrfToken;
  };

  it('rejects a request body over 1 MiB with 413 instead of buffering it', async () => {
    const token = await boot();
    const res = await fetch(`${handle.url}/api/test/llm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Murmur-Token': token },
      body: JSON.stringify({ padding: 'x'.repeat(2 * 1024 * 1024) }),
    });
    assert.equal(res.status, 413);
    assert.match((await res.json()).error, /too large/);
  });

  it('still accepts an ordinary body', async () => {
    const token = await boot();
    const res = await fetch(`${handle.url}/api/test/llm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Murmur-Token': token },
      body: JSON.stringify({}),
    });
    assert.notEqual(res.status, 413);
    assert.notEqual(res.status, 400);
  });

  it('keeps invalid JSON a 400', async () => {
    const token = await boot();
    const res = await fetch(`${handle.url}/api/test/llm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Murmur-Token': token },
      body: '{not json',
    });
    assert.equal(res.status, 400);
  });

  it('marks the token cookie HttpOnly', async () => {
    await boot();
    const res = await fetch(`${handle.url}/`);
    const cookie = res.headers.get('set-cookie') ?? '';
    assert.match(cookie, /^murmur_token=/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
  });
});

describe('overlay status announcements', () => {
  it('exposes the status chip as a polite live region', () => {
    const html = readFileSync(new URL('../dist/renderer/index.html', import.meta.url), 'utf8');
    assert.match(html, /<div id="status-chip"[^>]*role="status"[^>]*aria-live="polite"/);
  });
});
