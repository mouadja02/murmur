// tests/provider-prewarm.test.mjs
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const BASE_CONFIG = {
  displayName: 'Test', baseUrl: '', model: 'test-model', apiKey: null, temperature: 0.2,
};

describe('OllamaProvider.prewarm', () => {
  it('POSTs /api/generate with empty prompt and keep_alive, returns latency ms', async () => {
    const { OllamaProvider } = await import('../dist/main/providers/ollama.js');
    const calls = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      calls.push({ url: String(url), body: JSON.parse(opts?.body ?? '{}') });
      return { ok: true, json: async () => ({ response: '', done: true }) };
    };
    const p = new OllamaProvider({ ...BASE_CONFIG, id: 'ollama', baseUrl: 'http://localhost:11434' });
    const ms = await p.prewarm();
    globalThis.fetch = origFetch;

    assert.ok(typeof ms === 'number' && ms >= 0, 'returns latency number');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].url.endsWith('/api/generate'));
    assert.equal(calls[0].body.keep_alive, '5m');
    assert.equal(calls[0].body.prompt, '');
  });
});

describe('OpenAiCompatProvider.prewarm', () => {
  it('POSTs /chat/completions with max_tokens=1, returns latency ms', async () => {
    const { OpenAiCompatProvider } = await import('../dist/main/providers/openai-compat.js');
    const calls = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      calls.push({ url: String(url), body: JSON.parse(opts?.body ?? '{}') });
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { role: 'assistant', content: ' ' } }] }),
      };
    };
    const p = new OpenAiCompatProvider({
      ...BASE_CONFIG, id: 'openai-compat', baseUrl: 'http://localhost:1234/v1',
    });
    const ms = await p.prewarm();
    globalThis.fetch = origFetch;

    assert.ok(typeof ms === 'number' && ms >= 0);
    assert.ok(calls[0].url.endsWith('/chat/completions'));
    assert.equal(calls[0].body.max_tokens, 1);
  });
});

describe('AnthropicProvider.prewarm', () => {
  it('POSTs /messages with max_tokens=1, returns latency ms', async () => {
    const { AnthropicProvider } = await import('../dist/main/providers/anthropic.js');
    const calls = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = async (url, opts) => {
      calls.push({ url: String(url), body: JSON.parse(opts?.body ?? '{}') });
      return {
        ok: true,
        json: async () => ({ content: [{ type: 'text', text: ' ' }] }),
      };
    };
    const p = new AnthropicProvider({
      ...BASE_CONFIG, id: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKey: 'key',
    });
    const ms = await p.prewarm();
    globalThis.fetch = origFetch;

    assert.ok(typeof ms === 'number' && ms >= 0);
    assert.ok(calls[0].url.endsWith('/messages'));
    assert.equal(calls[0].body.max_tokens, 1);
  });
});
