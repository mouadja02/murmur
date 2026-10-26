import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { describe, it } from 'node:test';
import { promisify } from 'node:util';

describe('MCP HTTP request errors', () => {
  it('survives a client disconnecting partway through its upload', async () => {
    // Isolate the server: an unhandled request rejection must fail this test
    // instead of terminating the test runner itself.
    const script = `
      import assert from 'node:assert/strict';
      import { once } from 'node:events';
      import { createConnection } from 'node:net';
      import { setTimeout as delay } from 'node:timers/promises';
      import { startMcpServer } from ${JSON.stringify(new URL('../dist/main/mcp/server.js', import.meta.url).href)};
      const handle = await startMcpServer({
        cfg: { mcpPort: 0 },
        getConfig: () => ({}),
        getPipeline: () => { throw new Error('pipeline must not be called'); },
        onConfigUpdated() {},
      });
      try {
        const socket = createConnection(handle.port, '127.0.0.1');
        await once(socket, 'connect');
        socket.write([
          'POST /mcp HTTP/1.1',
          'Host: 127.0.0.1:' + handle.port,
          'Content-Type: application/json',
          'Content-Length: 10000',
          '',
          '{',
        ].join('\\r\\n'));
        await delay(100);
        socket.destroy();
        await delay(100);
        const response = await fetch(handle.url, { method: 'POST', body: '{' });
        assert.equal(response.status, 400);
        console.log('server survived');
      } finally {
        await handle.stop();
      }
    `;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ['--input-type=module', '-e', script],
      { timeout: 10_000 },
    );
    assert.match(stdout, /server survived/);
  });
});
