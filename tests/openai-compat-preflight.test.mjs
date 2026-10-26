import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { OpenAiCompatProvider } from '../dist/main/providers/openai-compat.js';

const CONFIG = {
  id: 'openai-compat',
  displayName: 'OpenAI-compatible',
  baseUrl: 'https://openrouter.ai/api/v1',
  model: 'anthropic/test-model',
  apiKey: 'test-key',
  temperature: 0.2,
};

function provider(overrides = {}) {
  return new OpenAiCompatProvider({ ...CONFIG, ...overrides });
}

describe('OpenAI-compatible preflight', () => {
  for (const slowPart of ['headers', 'body']) {
    it(`allows a large model list with ${slowPart} delayed beyond three seconds`, async (t) => {
      const payload = JSON.stringify({
        data: [
          ...Array.from({ length: 1000 }, (_, i) => ({ id: `vendor/model-${i}` })),
          { id: CONFIG.model },
        ],
      });
      const server = createServer(async (req, res) => {
        assert.equal(req.url, '/api/v1/models');
        assert.equal(req.headers.authorization, 'Bearer test-key');
        if (slowPart === 'headers') await delay(3200);
        if (res.destroyed) return;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write(payload.slice(0, 100));
        if (slowPart === 'body') await delay(3200);
        res.end(payload.slice(100));
      });
      t.after(() => {
        server.closeAllConnections();
        server.close();
      });
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const baseUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
      assert.equal(await provider({ baseUrl }).preflight(), null);
    });
  }

  for (const phase of ['request', 'body']) {
    it(`reports a bounded ${phase} timeout with connection advice for cloud providers`, async (t) => {
      let timeoutMs;
      const controller = new AbortController();
      t.mock.method(AbortSignal, 'timeout', (ms) => {
        timeoutMs = ms;
        return controller.signal;
      });
      const timeout = () => {
        controller.abort(new DOMException('The operation timed out', 'TimeoutError'));
        // Fetch's body reader can report AbortError even when the timeout signal fired.
        throw phase === 'request'
          ? controller.signal.reason
          : new DOMException('The operation was aborted.', 'AbortError');
      };
      t.mock.method(globalThis, 'fetch', async () => {
        if (phase === 'request') timeout();
        return { ok: true, json: timeout };
      });
      const error = await provider().preflight();
      assert.equal(timeoutMs, 30_000);
      assert.match(error, /timed out.*30 seconds/i);
      assert.match(error, /GET \/models/);
      assert.match(error, /connection/i);
      assert.doesNotMatch(error, /local server|LM Studio|not reachable/);
    });
  }

  it('normalizes trailing slashes for preflight, prewarm, and chat requests', async (t) => {
    const urls = [];
    t.mock.method(globalThis, 'fetch', async (url) => {
      urls.push(url);
      if (url.endsWith('/models')) {
        return Response.json({ data: [{ id: CONFIG.model }] });
      }
      return Response.json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
    });
    const p = provider({ baseUrl: `${CONFIG.baseUrl}/` });
    assert.equal(await p.preflight(), null);
    await p.prewarm();
    await p.refine({ systemPrompt: 's', userPrompt: 'u' });
    t.mock.method(globalThis, 'fetch', async (url) => {
      urls.push(url);
      return new Response('data: [DONE]\n\n');
    });
    await p.refineStream({ systemPrompt: 's', userPrompt: 'u' }, { onToken() {} });
    assert.deepEqual(urls, [
      `${CONFIG.baseUrl}/models`,
      ...Array(3).fill(`${CONFIG.baseUrl}/chat/completions`),
    ]);
  });

  for (const status of [401, 403, 429, 500]) {
    it(`reports HTTP ${status} with actionable advice`, async (t) => {
      t.mock.method(globalThis, 'fetch', async () => new Response('', { status }));
      const error = await provider().preflight();
      assert.match(error, new RegExp(`HTTP ${status}`));
      assert.match(error, /GET \/models/);
      assert.match(error, status === 401 || status === 403 ? /API key/i : /try again/i);
      assert.doesNotMatch(error, /LM Studio|local server/);
    });
  }

  it('reports network failures without assuming a local server', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => {
      throw new TypeError('fetch failed');
    });
    const error = await provider().preflight();
    assert.match(error, /fetch failed/);
    assert.match(error, /connection/i);
    assert.doesNotMatch(error, /local server|LM Studio/);
  });

  for (const payload of [null, {}, { data: {} }, { data: [null, {}, { id: 42 }] }]) {
    it(`reports a malformed model list: ${JSON.stringify(payload)}`, async (t) => {
      t.mock.method(globalThis, 'fetch', async () => Response.json(payload));
      assert.match(await provider().preflight(), /invalid model list/i);
    });
  }

  it('reports invalid JSON as a response error', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => new Response('<html>Bad gateway</html>'));
    const error = await provider().preflight();
    assert.match(error, /invalid JSON/i);
    assert.doesNotMatch(error, /not reachable/);
  });

  it('accepts both model-list formats and namespaced IDs', async (t) => {
    for (const payload of [[{ id: CONFIG.model }], { data: [{ id: CONFIG.model }] }]) {
      t.mock.method(globalThis, 'fetch', async () => Response.json(payload));
      assert.equal(await provider().preflight(), null);
      assert.equal(await provider({ model: 'test-model' }).preflight(), null);
    }
  });

  it('keeps missing-model validation and limits the available-model sample', async (t) => {
    t.mock.method(globalThis, 'fetch', async () =>
      Response.json({ data: Array.from({ length: 10 }, (_, i) => ({ id: `model-${i}` })) }),
    );
    const error = await provider().preflight();
    assert.match(error, /not found/);
    assert.match(error, /model-0, model-1, model-2, model-3, model-4/);
    assert.doesNotMatch(error, /model-5/);
  });

  it('reports an empty catalog as a missing model', async (t) => {
    t.mock.method(globalThis, 'fetch', async () => Response.json({ data: [] }));
    assert.match(await provider().preflight(), /not found.*\(none\)/);
  });

  it('still explains a missing version segment before fetching', async (t) => {
    const fetch = t.mock.method(globalThis, 'fetch');
    assert.match(await provider({ baseUrl: 'http://localhost:1234' }).preflight(), /\/v1/);
    assert.equal(fetch.mock.callCount(), 0);
  });
});
