import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Pipeline } from '../dist/main/pipeline.js';
import { createRuntime } from '../dist/main/runtime.js';

function makeFakeProvider(model) {
  return {
    config: {
      id: 'ollama',
      displayName: 'Ollama',
      baseUrl: 'http://localhost:11434',
      model,
      apiKey: null,
      temperature: 0.2,
    },
    preflight: async () => null,
    refine: async () => ({ text: 'ok', durationMs: 1 }),
  };
}

function runtimeOpts(tmp, overrides = {}) {
  return {
    userDataDir: tmp,
    argv: ['node', 'murmur', 'serve', '--port', '0', '--mcp-port', '0'],
    requireRecorder: false,
    runPreflight: async () => ({ ok: true, messages: [] }),
    createProvider: (cfg) => makeFakeProvider(cfg.model),
    ...overrides,
  };
}

describe('headless runtime', () => {
  let tmp;

  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'murmur-runtime-'));
    writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ model: 'model-a' }));
  });

  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it('creates a runtime without Electron-only dependencies', async () => {
    const calls = [];
    const runtime = await createRuntime({
      ...runtimeOpts(tmp),
      startControlPanel: async ({ getCurrentConfig }) => {
        calls.push(['control-panel', getCurrentConfig().controlPanelPort]);
        return { port: 1234, url: 'http://localhost:1234', stop: async () => {} };
      },
      startMcpServer: async ({ cfg }) => {
        calls.push(['mcp', cfg.mcpPort]);
        return { port: 1235, url: 'http://localhost:1235/mcp', stop: async () => {} };
      },
    });

    assert.deepEqual(calls, [
      ['control-panel', 0],
      ['mcp', 0],
    ]);
    assert.equal(runtime.controlPanel.url, 'http://localhost:1234');
    assert.equal(runtime.mcpServer.url, 'http://localhost:1235/mcp');
    await runtime.stop();
  });

  it('mcp stub binds an ephemeral port when mcpPort is 0', async () => {
    const runtime = await createRuntime({
      ...runtimeOpts(tmp),
      startControlPanel: async () => ({
        port: 1234,
        url: 'http://127.0.0.1:1234',
        stop: async () => {},
      }),
    });

    assert.ok(runtime.mcpServer.port > 0);
    assert.match(runtime.mcpServer.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    await runtime.stop();
  });

  it('reload updates runtime.provider and runtime.pipeline when idle', async () => {
    let onConfigUpdated;
    const runtime = await createRuntime({
      ...runtimeOpts(tmp),
      startControlPanel: async (deps) => {
        onConfigUpdated = deps.onConfigUpdated;
        return { port: 1234, url: 'http://localhost:1234', stop: async () => {} };
      },
      startMcpServer: async () => ({
        port: 1235,
        url: 'http://localhost:1235/mcp',
        stop: async () => {},
      }),
    });

    const pipelineBefore = runtime.pipeline;
    assert.equal(runtime.provider.config.model, 'model-a');

    writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ model: 'model-b' }));
    onConfigUpdated();

    assert.equal(runtime.provider.config.model, 'model-b');
    assert.notEqual(runtime.pipeline, pipelineBefore);
    await runtime.stop();
  });

  it('defers pipeline replacement while busy and applies reload when idle', async () => {
    let onConfigUpdated;
    const runtime = await createRuntime({
      ...runtimeOpts(tmp),
      startControlPanel: async (deps) => {
        onConfigUpdated = deps.onConfigUpdated;
        return { port: 1234, url: 'http://localhost:1234', stop: async () => {} };
      },
      startMcpServer: async () => ({
        port: 1235,
        url: 'http://localhost:1235/mcp',
        stop: async () => {},
      }),
    });

    const pipelineBefore = runtime.pipeline;
    const busySpy = () => true;
    const origIsBusy = Pipeline.prototype.isBusy;
    Pipeline.prototype.isBusy = busySpy;

    try {
      writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ model: 'model-busy' }));
      onConfigUpdated();

      assert.equal(runtime.provider.config.model, 'model-busy');
      assert.equal(runtime.pipeline, pipelineBefore);

      Pipeline.prototype.isBusy = origIsBusy;
      await new Promise((r) => setTimeout(r, CONFIG_RELOAD_RETRY_MS + 100));

      assert.notEqual(runtime.pipeline, pipelineBefore);
      assert.equal(runtime.provider.config.model, 'model-busy');
    } finally {
      Pipeline.prototype.isBusy = origIsBusy;
    }

    await runtime.stop();
  });

  it('stops control panel when MCP startup fails', async () => {
    let panelStopped = false;
    await assert.rejects(
      () =>
        createRuntime({
          ...runtimeOpts(tmp),
          startControlPanel: async () => ({
            port: 1234,
            url: 'http://localhost:1234',
            stop: async () => {
              panelStopped = true;
            },
          }),
          startMcpServer: async () => {
            throw new Error('mcp startup failed');
          },
        }),
      /mcp startup failed/,
    );
    assert.equal(panelStopped, true);
  });
});

/** Must stay in sync with CONFIG_RELOAD_RETRY_MS in runtime.ts */
const CONFIG_RELOAD_RETRY_MS = 250;
