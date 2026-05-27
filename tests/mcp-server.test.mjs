import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { createMurmurMcpServer, startMcpServer } from '../dist/main/mcp/server.js';

function cfg(dir) {
  return {
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
    model: 'qwen3:4b',
    apiKey: null,
    temperature: 0.2,
    whisperCliPath: 'whisper-cli',
    whisperModelPath: 'model.bin',
    sampleRate: 16000,
    hotkeyCombo: 'Ctrl+Shift+Space',
    toggleHotkeyCombo: 'Ctrl+Shift+H',
    clipboardRestoreDelayMs: 150,
    systemPrompt: 'BASE',
    enabledSkills: [],
    controlPanelPort: 0,
    mcpPort: 0,
    recorderCommand: 'recorder --raw',
    logsDir: dir,
    skillsDir: dir,
    overlayAnchor: 'bottom-center',
    overlayOffsetX: 0,
    overlayOffsetY: -40,
    overlayPosition: null,
    configFilePath: path.join(dir, 'config.json'),
  };
}

function idlePipeline(overrides = {}) {
  return { isBusy: () => false, ...overrides };
}

function busyPipeline(overrides = {}) {
  return { isBusy: () => true, ...overrides };
}

describe('Murmur MCP tool handlers', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'murmur-mcp-'));
    writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ enabledSkills: [] }));
    writeFileSync(
      path.join(dir, 'concise-output.md'),
      '---\nid: concise-output\nname: Concise output\ndescription: Shorten\n---\n\nShorten text.\n',
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('records through the pipeline with inject false by default', async () => {
    const calls = [];
    const server = createMurmurMcpServer({
      getConfig: () => cfg(dir),
      onConfigUpdated: () => {},
      getPipeline: () =>
        idlePipeline({
          record: async (opts) => {
            calls.push(opts);
            return { text: 'refined voice', transcription: 'raw', sessionDir: '/tmp/s' };
          },
        }),
    });

    const result = await server.callToolForTest('murmur_record', { duration_ms: 5 });

    assert.equal(result.structuredContent.text, 'refined voice');
    assert.deepEqual(calls, [{ durationMs: 5, skillIds: undefined, inject: false }]);
    assert.equal(result.isError, undefined);
  });

  it('refines text with skill overrides', async () => {
    const server = createMurmurMcpServer({
      getConfig: () => cfg(dir),
      onConfigUpdated: () => {},
      getPipeline: () =>
        idlePipeline({
          refineText: async (text, opts) => `${text}:${opts.skillIds.join(',')}`,
        }),
    });

    const result = await server.callToolForTest('murmur_refine', {
      text: 'raw',
      skill_ids: ['concise-output'],
    });

    assert.equal(result.structuredContent.text, 'raw:concise-output');
  });

  it('returns tool error for invalid refine arguments', async () => {
    const server = createMurmurMcpServer({
      getConfig: () => cfg(dir),
      onConfigUpdated: () => {},
      getPipeline: () =>
        idlePipeline({
          refineText: async () => {
            throw new Error('should not refine invalid args');
          },
        }),
    });

    const result = await server.callToolForTest('murmur_refine', {});

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /text/i);
  });

  it('refines text when pipeline returns an object shape', async () => {
    const server = createMurmurMcpServer({
      getConfig: () => cfg(dir),
      onConfigUpdated: () => {},
      getPipeline: () =>
        idlePipeline({
          refineText: async () => ({ text: 'object refined' }),
        }),
    });

    const result = await server.callToolForTest('murmur_refine', { text: 'raw' });
    assert.equal(result.structuredContent.text, 'object refined');
  });

  it('rejects refine while pipeline is busy', async () => {
    const server = createMurmurMcpServer({
      getConfig: () => cfg(dir),
      onConfigUpdated: () => {},
      getPipeline: () =>
        busyPipeline({
          refineText: async () => {
            throw new Error('should not refine while busy');
          },
        }),
    });

    const result = await server.callToolForTest('murmur_refine', { text: 'raw' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /busy/i);
  });

  it('rejects transcribe while pipeline is busy', async () => {
    const server = createMurmurMcpServer({
      getConfig: () => cfg(dir),
      onConfigUpdated: () => {},
      getPipeline: () =>
        busyPipeline({
          transcribeFile: async () => {
            throw new Error('should not transcribe while busy');
          },
        }),
    });

    const result = await server.callToolForTest('murmur_transcribe', {
      file_path: 'C:/audio/sample.wav',
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /busy/i);
  });

  it('rejects toggle while pipeline is busy', async () => {
    let reloaded = false;
    const server = createMurmurMcpServer({
      getConfig: () => cfg(dir),
      onConfigUpdated: () => {
        reloaded = true;
      },
      getPipeline: () => busyPipeline(),
    });

    const result = await server.callToolForTest('murmur_toggle_skill', {
      skill_id: 'concise-output',
      enabled: true,
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /busy/i);
    assert.equal(reloaded, false);
  });

  it('rejects relative file paths for transcribe', async () => {
    const server = createMurmurMcpServer({
      getConfig: () => cfg(dir),
      onConfigUpdated: () => {},
      getPipeline: () =>
        idlePipeline({
          transcribeFile: async () => {
            throw new Error('should not be called');
          },
        }),
    });

    const result = await server.callToolForTest('murmur_transcribe', {
      file_path: 'relative/audio.wav',
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /absolute/i);
  });

  it('lists skills with enabled state', async () => {
    const config = cfg(dir);
    config.enabledSkills = ['concise-output'];
    const server = createMurmurMcpServer({
      getConfig: () => config,
      onConfigUpdated: () => {},
      getPipeline: () => idlePipeline(),
    });

    const result = await server.callToolForTest('murmur_list_skills', {});
    const skills = result.structuredContent.skills;
    assert.ok(Array.isArray(skills));
    const concise = skills.find((s) => s.id === 'concise-output');
    assert.ok(concise, 'concise-output skill is listed');
    assert.equal(concise.enabled, true);
    assert.equal(concise.name, 'Concise output');
    assert.ok(concise.filePath.endsWith('concise-output.md'));
  });

  it('lists skills while pipeline is busy', async () => {
    const server = createMurmurMcpServer({
      getConfig: () => cfg(dir),
      onConfigUpdated: () => {},
      getPipeline: () => busyPipeline(),
    });

    const result = await server.callToolForTest('murmur_list_skills', {});
    assert.notEqual(result.isError, true);
    assert.ok(Array.isArray(result.structuredContent.skills));
  });

  it('toggles skills in the config file and calls reload', async () => {
    let reloaded = false;
    const server = createMurmurMcpServer({
      getConfig: () => cfg(dir),
      onConfigUpdated: () => {
        reloaded = true;
      },
      getPipeline: () => idlePipeline(),
    });

    const result = await server.callToolForTest('murmur_toggle_skill', {
      skill_id: 'concise-output',
      enabled: true,
    });

    const raw = JSON.parse(readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.deepEqual(raw.enabledSkills, ['concise-output']);
    assert.equal(result.structuredContent.enabled, true);
    assert.equal(reloaded, true);
  });

  it('toggles skill off when enabled is omitted and skill is currently enabled', async () => {
    const config = cfg(dir);
    config.enabledSkills = ['concise-output'];
    let reloaded = false;
    const server = createMurmurMcpServer({
      getConfig: () => config,
      onConfigUpdated: () => {
        reloaded = true;
      },
      getPipeline: () => idlePipeline(),
    });

    const result = await server.callToolForTest('murmur_toggle_skill', {
      skill_id: 'concise-output',
    });

    const raw = JSON.parse(readFileSync(path.join(dir, 'config.json'), 'utf8'));
    assert.deepEqual(raw.enabledSkills, []);
    assert.equal(result.structuredContent.enabled, false);
    assert.equal(reloaded, true);
  });

  it('returns tool error for invalid skill_id', async () => {
    const server = createMurmurMcpServer({
      getConfig: () => cfg(dir),
      onConfigUpdated: () => {},
      getPipeline: () => idlePipeline(),
    });

    const result = await server.callToolForTest('murmur_toggle_skill', {
      skill_id: 'INVALID ID',
      enabled: true,
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /invalid skill id/i);
  });

  it('returns tool error when skill is not found', async () => {
    const server = createMurmurMcpServer({
      getConfig: () => cfg(dir),
      onConfigUpdated: () => {},
      getPipeline: () => idlePipeline(),
    });

    const result = await server.callToolForTest('murmur_toggle_skill', {
      skill_id: 'missing-skill',
      enabled: true,
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /not found/i);
  });

  it('returns tool error when config persistence fails', async () => {
    let reloaded = false;
    const server = createMurmurMcpServer({
      getConfig: () => cfg(dir),
      onConfigUpdated: () => {
        reloaded = true;
      },
      getPipeline: () => idlePipeline(),
      updateConfigFile: () => false,
    });

    const result = await server.callToolForTest('murmur_toggle_skill', {
      skill_id: 'concise-output',
      enabled: true,
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /persist/i);
    assert.equal(reloaded, false);
  });

  it('returns tool error when stop_record has no active recording', async () => {
    const server = createMurmurMcpServer({
      getConfig: () => cfg(dir),
      onConfigUpdated: () => {},
      getPipeline: () =>
        idlePipeline({
          stopRecording: async () => {
            throw new Error('no active recording');
          },
        }),
    });

    const result = await server.callToolForTest('murmur_stop_record', {});
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /no active recording/i);
  });

  it('allows stop_record while pipeline is busy', async () => {
    let stopped = false;
    const server = createMurmurMcpServer({
      getConfig: () => cfg(dir),
      onConfigUpdated: () => {},
      getPipeline: () =>
        busyPipeline({
          stopRecording: async () => {
            stopped = true;
            return { text: 'done', transcription: 'x', sessionDir: '/tmp' };
          },
        }),
    });

    const result = await server.callToolForTest('murmur_stop_record', {});
    assert.notEqual(result.isError, true);
    assert.equal(stopped, true);
  });
});

describe('startMcpServer HTTP', () => {
  let handle;
  let httpDir;

  afterEach(async () => {
    if (handle) await handle.stop();
    handle = undefined;
    if (httpDir) {
      rmSync(httpDir, { recursive: true, force: true });
      httpDir = undefined;
    }
  });

  it('binds an ephemeral port when mcpPort is 0', async () => {
    httpDir = mkdtempSync(path.join(tmpdir(), 'murmur-mcp-http-'));
    handle = await startMcpServer({
      cfg: { ...cfg(httpDir), mcpPort: 0 },
      getConfig: () => cfg(httpDir),
      getPipeline: () => idlePipeline(),
      onConfigUpdated: () => {},
    });

    assert.ok(handle.port > 0);
    assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
  });

  it('returns 404 JSON for non-/mcp paths', async () => {
    httpDir = mkdtempSync(path.join(tmpdir(), 'murmur-mcp-http-'));
    handle = await startMcpServer({
      cfg: { ...cfg(httpDir), mcpPort: 0 },
      getConfig: () => cfg(httpDir),
      getPipeline: () => idlePipeline(),
      onConfigUpdated: () => {},
    });

    const res = await fetch(`${handle.url.replace('/mcp', '/')}`);
    assert.equal(res.status, 404);
    const body = await res.json();
    assert.deepEqual(body, { error: 'not found' });
  });

  it('creates a fresh MCP server per HTTP request', async () => {
    httpDir = mkdtempSync(path.join(tmpdir(), 'murmur-mcp-http-'));
    let created = 0;
    handle = await startMcpServer({
      cfg: { ...cfg(httpDir), mcpPort: 0 },
      getConfig: () => cfg(httpDir),
      getPipeline: () => idlePipeline(),
      onConfigUpdated: () => {},
      onMcpServerCreated: () => {
        created += 1;
      },
    });

    await Promise.all([
      fetch(handle.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: {} }),
      }),
      fetch(handle.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 2, params: {} }),
      }),
    ]);

    assert.equal(created, 2);
  });
});
