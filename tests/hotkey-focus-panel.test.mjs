import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { startControlPanelServer } from '../dist/main/control-panel/server.js';

function makeConfig(overrides = {}) {
  return {
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
    model: 'qwen3:4b',
    apiKey: null,
    temperature: 0.2,
    whisperCliPath: 'C:/whisper.exe',
    whisperModelPath: 'C:/model.bin',
    hotkeyCombo: 'Ctrl+Shift+Space',
    hotkeyMode: 'toggle',
    toggleHotkeyCombo: 'Ctrl+Shift+H',
    clipboardRestoreDelayMs: 150,
    clipboardRetention: 'keep-generated',
    injectionMethod: 'auto',
    focusChangePolicy: 'paste',
    systemPrompt: 'BASE PROMPT',
    enabledSkills: [],
    controlPanelPort: 0,
    mcpPort: 7332,
    logsDir: 'logs',
    overlay: { anchor: 'bottom-center', offsetX: 0, offsetY: -40 },
    overlayAnchor: 'bottom-center',
    overlayOffsetX: 0,
    overlayOffsetY: -40,
    overlayPosition: null,
    ...overrides,
  };
}

describe('control panel: push-to-talk mode and focus-change policy', () => {
  let handle;
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'murmur-cp-hotkey-'));
  });

  afterEach(async () => {
    if (handle) await handle.stop();
    handle = undefined;
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function start(configFilePath) {
    const cfg = makeConfig({ skillsDir: tempDir, configFilePath });
    handle = await startControlPanelServer({
      getCurrentConfig: () => cfg,
      onConfigUpdated: () => {},
      testLlm: async () => ({ ok: true, message: 'mocked' }),
    });
    return (await fetch(`${handle.url}/api/state`)).json();
  }

  async function put(state, body) {
    const res = await fetch(`${handle.url}/api/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Murmur-Token': state.security.csrfToken },
      body: JSON.stringify(body),
    });
    return { res, json: await res.json() };
  }

  it('shows the current values in /api/state', async () => {
    const state = await start(path.join(tempDir, 'config.json'));
    assert.equal(state.config.hotkeyMode, 'toggle');
    assert.equal(state.config.focusChangePolicy, 'paste');
  });

  it('saves valid values to the config file', async () => {
    const file = path.join(tempDir, 'config.json');
    writeFileSync(file, '{}\n', 'utf8');
    const state = await start(file);
    const { res } = await put(state, { hotkeyMode: 'hold', focusChangePolicy: 'copy' });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {
      hotkeyMode: 'hold',
      focusChangePolicy: 'copy',
    });
  });

  it('refuses an unknown policy with 400 instead of reporting "saved"', async () => {
    const file = path.join(tempDir, 'config.json');
    writeFileSync(file, '{}\n', 'utf8');
    const state = await start(file);
    const { res, json } = await put(state, { focusChangePolicy: 'ask', hotkeyMode: 'sticky' });
    assert.equal(res.status, 400);
    assert.deepEqual(Object.keys(json.rejected).sort(), ['focusChangePolicy', 'hotkeyMode']);
    assert.equal(readFileSync(file, 'utf8'), '{}\n');
  });

  it('serves a form whose options are exactly the values the schema accepts', async () => {
    await start(path.join(tempDir, 'config.json'));
    const html = await (await fetch(`${handle.url}/`)).text();
    const optionsOf = (id) => {
      const select = html.match(new RegExp(`<select id="${id}">([\\s\\S]*?)</select>`));
      assert.ok(select, `${id} select exists`);
      return [...select[1].matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
    };
    assert.deepEqual(optionsOf('cfg-hotkeyMode'), ['hold', 'toggle']);
    assert.deepEqual(optionsOf('cfg-focusChangePolicy'), ['copy', 'paste']);
  });

  it('reads and saves both fields from the Hotkeys form script', async () => {
    await start(path.join(tempDir, 'config.json'));
    const js = await (await fetch(`${handle.url}/app.js`)).text();
    // Saving is one path: the save bar reads every section that has unsaved edits.
    const hotkeysSection = /hotkeys:\s*\{[\s\S]*?\n {2}\},/.exec(js)?.[0] ?? '';
    assert.ok(hotkeysSection, 'the save bar has a Hotkeys section');
    for (const key of ['hotkeyMode', 'focusChangePolicy']) {
      const uses = js.match(new RegExp(`\\$\\('#cfg-${key}'\\)\\.value`, 'g')) ?? [];
      // once to fill the form, once to save it
      assert.ok(uses.length >= 2, `${key} is wired to the form (${uses.length} uses)`);
      assert.match(hotkeysSection, new RegExp(`${key}: \\$\\('#cfg-${key}'\\)\\.value`), key);
    }
    assert.match(js, /MURMUR_HOTKEY_MODE/);
    assert.match(js, /MURMUR_FOCUS_CHANGE_POLICY/);
  });
});
