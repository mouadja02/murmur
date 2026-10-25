import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CommandAudioRecorder } from '../dist/main/audio/recorder.js';
import { startMcpServer } from '../dist/main/mcp/server.js';
import { Pipeline } from '../dist/main/pipeline.js';

// Real MCP SDK client -> real Streamable HTTP server on an ephemeral loopback
// port -> real Pipeline with a fake recorder, fake whisper and fake provider.
// Nothing here touches a microphone, a model or a configured provider.

function makeConfig(baseDir) {
  return {
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
    model: 'fake-model',
    apiKey: null,
    temperature: 0.2,
    whisperCliPath: 'whisper-cli',
    whisperModelPath: 'model.bin',
    sampleRate: 16000,
    hotkeyCombo: 'Ctrl+Shift+Space',
    toggleHotkeyCombo: 'Ctrl+Shift+H',
    clipboardRestoreDelayMs: 150,
    systemPrompt: 'BASE PROMPT',
    enabledSkills: [],
    controlPanelPort: 0,
    mcpPort: 0,
    recorderCommand: 'recorder --raw',
    logsDir: path.join(baseDir, 'logs'),
    skillsDir: path.join(baseDir, 'skills'),
    overlayAnchor: 'bottom-center',
    overlayOffsetX: 0,
    overlayOffsetY: -40,
    overlayPosition: null,
    configFilePath: path.join(baseDir, 'config.json'),
  };
}

function makeProvider() {
  return {
    config: {
      id: 'test',
      displayName: 'Test',
      baseUrl: '',
      model: '',
      apiKey: null,
      temperature: 0,
    },
    async refine({ userPrompt }) {
      return { text: `REFINED: ${userPrompt}`, durationMs: 1 };
    },
    async refineStream({ userPrompt }, { onToken }) {
      const text = `REFINED: ${userPrompt}`;
      onToken(text);
      return { text, durationMs: 1 };
    },
    async preflight() {
      return null;
    },
  };
}

/** 1 s of 16 kHz mono 16-bit PCM, above the pipeline's minimum speech length. */
function samplePcm() {
  const pcm = Buffer.alloc(32_000, 0);
  for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(1000, i);
  return pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
}

class FakeRecorder {
  starts = 0;
  stops = 0;
  micOn = false;
  async start() {
    this.starts += 1;
    this.micOn = true;
  }
  async stop() {
    this.stops += 1;
    this.micOn = false;
    return samplePcm();
  }
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`timed out after ${timeoutMs} ms waiting for ${label}`);
}

describe('MCP serve lifecycle (real SDK client)', () => {
  let dir;
  let recorders;
  let pipeline;
  let handle;
  let clients;

  const connect = async () => {
    const client = new Client({ name: 'lifecycle-test', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(handle.url)));
    clients.push(client);
    return client;
  };

  const boot = async (pipelineOverrides = {}) => {
    const cfg = makeConfig(dir);
    pipeline = new Pipeline({
      cfg,
      provider: makeProvider(),
      emitStatus: () => {},
      transcribeAudio: async () => ({ text: 'hello world', stderr: '', durationMs: 1 }),
      createRecorder: () => {
        const recorder = new FakeRecorder();
        recorders.push(recorder);
        return recorder;
      },
      ...pipelineOverrides,
    });
    handle = await startMcpServer({
      cfg,
      getConfig: () => cfg,
      getPipeline: () => pipeline,
      onConfigUpdated: () => {},
    });
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'murmur-mcp-life-'));
    recorders = [];
    clients = [];
    handle = undefined;
  });

  afterEach(async () => {
    for (const client of clients) await client.close().catch(() => undefined);
    if (handle) await handle.stop().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it('control: a timed record and an open-ended record stopped by a second client still work', async () => {
    await boot();
    const caller = await connect();
    const other = await connect();

    const timed = await caller.callTool({ name: 'murmur_record', arguments: { duration_ms: 50 } });
    assert.equal(timed.isError, undefined);
    assert.equal(timed.structuredContent.text, 'REFINED: hello world');

    const open = caller.callTool({ name: 'murmur_record', arguments: {} });
    await waitFor(() => recorders.length === 2 && recorders[1].micOn, 2000, 'second recording');
    await other.callTool({ name: 'murmur_stop_record', arguments: {} });
    const result = await open;
    assert.equal(result.structuredContent.text, 'REFINED: hello world');
    assert.equal(pipeline.isBusy(), false);
  });

  it('stops the microphone and frees the pipeline when the caller times out an open-ended record', async () => {
    await boot();
    const client = await connect();

    await assert.rejects(
      client.callTool({ name: 'murmur_record', arguments: {} }, undefined, { timeout: 300 }),
      /timed out/i,
    );

    await waitFor(() => !pipeline.isBusy(), 1000, 'pipeline to go idle after the caller gave up');
    assert.equal(recorders[0].micOn, false);
    assert.equal(recorders[0].stops, 1);

    const next = await client.callTool({ name: 'murmur_record', arguments: { duration_ms: 50 } });
    assert.equal(next.isError, undefined);
    assert.equal(next.structuredContent.text, 'REFINED: hello world');
  });

  it('stops a timed record that the caller aborts before duration_ms elapses', async () => {
    await boot();
    const client = await connect();
    const controller = new AbortController();

    const call = client.callTool(
      { name: 'murmur_record', arguments: { duration_ms: 30_000 } },
      undefined,
      {
        signal: controller.signal,
      },
    );
    await waitFor(() => recorders.length === 1 && recorders[0].micOn, 2000, 'recording to start');
    controller.abort();
    await assert.rejects(call);

    await waitFor(() => !pipeline.isBusy(), 1000, 'pipeline to go idle after abort');
    assert.equal(recorders[0].micOn, false);
  });

  it('stops the microphone when the HTTP connection drops mid-record', async () => {
    await boot();
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'murmur_record', arguments: {} },
    });
    const req = httpRequest({
      host: '127.0.0.1',
      port: handle.port,
      path: '/mcp',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(body),
      },
    });
    req.on('error', () => {});
    req.end(body);

    await waitFor(() => recorders.length === 1 && recorders[0].micOn, 2000, 'recording to start');
    req.destroy();

    await waitFor(() => !pipeline.isBusy(), 1000, 'pipeline to go idle after disconnect');
    assert.equal(recorders[0].micOn, false);
  });

  it('does not cancel a record when an unrelated request id is cancelled', async () => {
    await boot();
    const client = await connect();

    const open = client.callTool({ name: 'murmur_record', arguments: {} });
    await waitFor(() => recorders.length === 1 && recorders[0].micOn, 2000, 'recording to start');

    const res = await fetch(handle.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 'someone-elses-request' },
      }),
    });
    assert.equal(res.status, 202);
    assert.equal(recorders[0].micOn, true);
    assert.equal(pipeline.isBusy(), true);

    await client.callTool({ name: 'murmur_stop_record', arguments: {} });
    await open;
  });

  it('answers malformed and oversized bodies without reaching the pipeline', async () => {
    await boot();
    const post = (body) =>
      fetch(handle.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body,
      });

    assert.equal((await post('{not json')).status, 400);
    assert.equal((await post(JSON.stringify({ pad: 'x'.repeat(1024 * 1024 + 1) }))).status, 413);
    assert.equal(recorders.length, 0);
  });

  it('rejects inject:true in a headless runtime before the microphone starts', async () => {
    await boot();
    const client = await connect();

    const result = await client.callTool({
      name: 'murmur_record',
      arguments: { duration_ms: 50, inject: true },
    });

    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /injection is unavailable/i);
    assert.equal(recorders.length, 0, 'no recorder should have been created');
    assert.equal(pipeline.isBusy(), false);
  });

  it('stop() resolves promptly while an SDK client is still connected', async () => {
    await boot();
    const client = await connect();
    await client.callTool({ name: 'murmur_list_skills', arguments: {} });

    const stopped = handle.stop().then(() => 'stopped');
    const winner = await Promise.race([
      stopped,
      new Promise((r) => setTimeout(() => r('hung'), 3000)),
    ]);
    assert.equal(winner, 'stopped');
    handle = undefined;
  });

  it('stop() ends an in-flight open-ended record and releases the microphone', async () => {
    await boot();
    const client = await connect();
    const open = client.callTool({ name: 'murmur_record', arguments: {} });
    open.catch(() => {});
    await waitFor(() => recorders.length === 1 && recorders[0].micOn, 2000, 'recording to start');

    const winner = await Promise.race([
      handle.stop().then(() => 'stopped'),
      new Promise((r) => setTimeout(() => r('hung'), 3000)),
    ]);
    handle = undefined;

    assert.equal(winner, 'stopped');
    await waitFor(() => !pipeline.isBusy(), 1000, 'pipeline to go idle after shutdown');
    assert.equal(recorders[0].micOn, false);
  });
});

describe('MCP serve lifecycle (real recorder child process)', () => {
  let dir;
  let pipeline;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'murmur recorder-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A stand-in for SoX: streams silence-ish PCM until killed, or exits early. */
  function fakeRecorderScript(body) {
    const script = path.join(dir, 'fake-recorder.mjs');
    writeFileSync(script, body);
    // splitCommandLine treats backslashes as escapes, so hand it forward slashes.
    const slash = (p) => p.split(path.sep).join('/');
    return `"${slash(process.execPath)}" "${slash(script)}"`;
  }

  function bootWith(commandLine) {
    const cfg = makeConfig(dir);
    pipeline = new Pipeline({
      cfg,
      provider: makeProvider(),
      emitStatus: () => {},
      transcribeAudio: async () => ({ text: 'hello world', stderr: '', durationMs: 1 }),
      createRecorder: () => new CommandAudioRecorder({ commandLine }),
    });
    return pipeline;
  }

  it('rejects the pending record with the recorder stderr when the child exits by itself', async () => {
    bootWith(
      fakeRecorderScript(
        "process.stdout.write(Buffer.alloc(3200)); process.stderr.write('device unplugged'); setTimeout(() => process.exit(3), 100);",
      ),
    );

    await assert.rejects(pipeline.record({}), /recorder exited with code 3[\s\S]*device unplugged/);

    assert.equal(pipeline.isBusy(), false);
  });

  it('kills the recorder process when the caller cancels an open-ended record', async () => {
    const pidFile = path.join(dir, 'pid.txt');
    bootWith(
      fakeRecorderScript(
        `import { writeFileSync } from 'node:fs';
         writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
         setInterval(() => process.stdout.write(Buffer.alloc(3200)), 50);`,
      ),
    );
    const controller = new AbortController();

    const rejected = assert.rejects(pipeline.record({ signal: controller.signal }), /cancelled/);
    await waitFor(() => existsSync(pidFile), 5000, 'recorder child to start');
    const pid = Number(readFileSync(pidFile, 'utf8'));
    controller.abort();
    await rejected;

    await waitFor(
      () => {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
          return true;
        }
      },
      5000,
      'recorder child to exit',
    );
    assert.equal(pipeline.isBusy(), false);
  });
});
