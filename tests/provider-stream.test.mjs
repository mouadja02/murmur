import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { AnthropicProvider } from '../dist/main/providers/anthropic.js';
import { OllamaProvider } from '../dist/main/providers/ollama.js';
import { OpenAiCompatProvider } from '../dist/main/providers/openai-compat.js';
import { createThinkFilter, parseSseStream, stripThink } from '../dist/main/providers/types.js';

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

/** A Response whose body arrives in the given string chunks. */
function chunkedResponse(chunks) {
  const enc = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

function serve(chunks) {
  globalThis.fetch = async () => chunkedResponse(chunks);
}

const CFG = { displayName: 'Test', model: 'm', apiKey: 'k', temperature: 0 };
const REQ = { systemPrompt: 's', userPrompt: 'u' };

function collect(filterInput) {
  const out = [];
  const f = createThinkFilter((t) => out.push(t));
  for (const c of filterInput) f.push(c);
  f.flush();
  return out.join('');
}

describe('createThinkFilter', () => {
  it('passes plain text through unchanged', () => {
    assert.equal(collect(['Hello ', 'world']), 'Hello world');
  });

  it('drops a think block and the whitespace after it', () => {
    assert.equal(collect(['<think>plan stuff</think>\n\nFinal answer']), 'Final answer');
  });

  it('handles tags split across chunks', () => {
    assert.equal(
      collect(['<th', 'ink>secret', ' reasoning</thi', 'nk>', '\nVisible', ' text']),
      'Visible text',
    );
  });

  it('does not swallow a lone "<" that is not a think tag', () => {
    assert.equal(collect(['a <', 'b> c']), 'a <b> c');
    assert.equal(collect(['x <thi']), 'x <thi');
  });

  it('emits nothing for an unterminated think block', () => {
    assert.equal(collect(['<think>still thinking']), '');
  });
});

describe('stripThink', () => {
  it('drops unfinished reasoning from final and partial responses', () => {
    assert.equal(stripThink('<think>internal reasoning'), '');
    assert.equal(stripThink('Visible answer <think>internal reasoning'), 'Visible answer');
    assert.equal(stripThink('<think>first</think>Answer<think>unfinished'), 'Answer');
  });

  it('preserves ordinary angle brackets and removes completed reasoning blocks', () => {
    assert.equal(stripThink('Compare a < b and x <thing>.'), 'Compare a < b and x <thing>.');
    assert.equal(stripThink('<think>reason</think>\nAnswer'), 'Answer');
  });
});

describe('parseSseStream', () => {
  it('parses CRLF-delimited events and a final event without a blank line', async () => {
    const events = [];
    await parseSseStream(
      chunkedResponse(['data: one\r\n\r\ndata: t', 'wo\r', '\n\r\ndata: three']).body,
      (_type, data) => events.push(data),
    );
    assert.deepEqual(events, ['one', 'two', 'three']);
  });
});

describe('streaming providers', () => {
  it('does not return unfinished reasoning that was hidden from streamed tokens', async () => {
    const p = new OpenAiCompatProvider({ ...CFG, id: 'openai-compat', baseUrl: 'http://x/v1' });
    const raw = 'Visible answer<think>internal reasoning';
    serve([
      `data: ${JSON.stringify({ choices: [{ delta: { content: raw }, finish_reason: 'length' }] })}\n\n`,
      'data: [DONE]\n\n',
    ]);
    const tokens = [];
    const result = await p.refineStream(REQ, { onToken: (token) => tokens.push(token) });
    assert.equal(tokens.join(''), 'Visible answer');
    assert.equal(result.text, 'Visible answer');
    assert.equal(result.stopReason, 'length');

    globalThis.fetch = async () =>
      Response.json({ choices: [{ message: { content: raw }, finish_reason: 'stop' }] });
    assert.equal((await p.refine(REQ)).text, 'Visible answer');
  });

  it('openai-compat hides <think> from tokens and reports a normal stop', async () => {
    const delta = (content, finish_reason) =>
      `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason }] })}\n\n`;
    serve([
      delta('<think>hmm'),
      delta('</think>\n'),
      delta('Fix the bug', 'stop'),
      'data: [DONE]\n\n',
    ]);
    const tokens = [];
    const p = new OpenAiCompatProvider({ ...CFG, id: 'openai-compat', baseUrl: 'http://x/v1' });
    const res = await p.refineStream(REQ, { onToken: (t) => tokens.push(t) });
    assert.equal(tokens.join(''), 'Fix the bug');
    assert.equal(res.text, 'Fix the bug');
    assert.equal(res.stopReason, 'end');
  });

  it('openai-compat reports length-limited responses and streams without [DONE]', async () => {
    const p = new OpenAiCompatProvider({ ...CFG, id: 'openai-compat', baseUrl: 'http://x/v1' });
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [
            { message: { role: 'assistant', content: 'partial' }, finish_reason: 'length' },
          ],
        }),
      );
    const truncated = await p.refine(REQ);
    assert.equal(truncated.text, 'partial');
    assert.equal(truncated.stopReason, 'length');
    globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'complete' }, finish_reason: 'stop' }],
        }),
      );
    const complete = await p.refine(REQ);
    assert.equal(complete.text, 'complete');
    assert.equal(complete.stopReason, 'end');

    const chunk = (content, finish_reason) =>
      `data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason }] })}\n\n`;
    serve([chunk('partial', 'length'), 'data: [DONE]\n\n']);
    const streamedTruncated = await p.refineStream(REQ, { onToken: () => {} });
    assert.equal(streamedTruncated.text, 'partial');
    assert.equal(streamedTruncated.stopReason, 'length');

    // No [DONE] but an explicit finish_reason: the server finished, just tersely.
    serve([chunk('complete', 'stop')]);
    const noDone = await p.refineStream(REQ, { onToken: () => {} });
    assert.equal(noDone.stopReason, 'end');

    // Neither [DONE] nor a finish_reason: the connection dropped mid-stream.
    serve([chunk('partial')]);
    const aborted = await p.refineStream(REQ, { onToken: () => {} });
    assert.equal(aborted.stopReason, 'aborted');
  });

  it('openai-compat surfaces mid-stream errors', async () => {
    serve([`data: ${JSON.stringify({ error: { message: 'context overflow' } })}\n\n`]);
    const p = new OpenAiCompatProvider({ ...CFG, id: 'openai-compat', baseUrl: 'http://x/v1' });
    await assert.rejects(p.refineStream(REQ, { onToken: () => {} }), /context overflow/);
  });

  it('ollama surfaces {"error"} lines and reads a final line without newline', async () => {
    serve([`${JSON.stringify({ error: 'model requires more memory' })}\n`]);
    const p = new OllamaProvider({ ...CFG, id: 'ollama', baseUrl: 'http://x' });
    await assert.rejects(p.refineStream(REQ, { onToken: () => {} }), /more memory/);

    serve([
      `${JSON.stringify({ response: 'Hello', done: false })}\n`,
      JSON.stringify({ response: ' there', done: true }),
    ]);
    const res = await p.refineStream(REQ, { onToken: () => {} });
    assert.equal(res.text, 'Hello there');
  });

  it('ollama reports length-limited responses and streams without a done chunk', async () => {
    const p = new OllamaProvider({ ...CFG, id: 'ollama', baseUrl: 'http://x' });
    serve([JSON.stringify({ response: 'partial', done: true, done_reason: 'length' })]);
    const truncated = await p.refine(REQ);
    assert.equal(truncated.stopReason, 'length');

    serve([`${JSON.stringify({ response: 'partial', done: true, done_reason: 'length' })}\n`]);
    const streamedTruncated = await p.refineStream(REQ, { onToken: () => {} });
    assert.equal(streamedTruncated.stopReason, 'length');

    serve([`${JSON.stringify({ response: 'partial', done: false })}\n`]);
    const aborted = await p.refineStream(REQ, { onToken: () => {} });
    assert.equal(aborted.stopReason, 'aborted');
  });

  it('anthropic surfaces stream error events', async () => {
    serve([
      `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })}\n\n`,
    ]);
    const p = new AnthropicProvider({ ...CFG, id: 'anthropic', baseUrl: 'http://x/v1' });
    await assert.rejects(
      p.refineStream(REQ, { onToken: () => {} }),
      /overloaded_error: Overloaded/,
    );
  });

  it('anthropic reports max-token responses in streaming and non-streaming calls', async () => {
    const p = new AnthropicProvider({ ...CFG, id: 'anthropic', baseUrl: 'http://x/v1' });
    serve([
      JSON.stringify({ content: [{ type: 'text', text: 'partial' }], stop_reason: 'max_tokens' }),
    ]);
    const truncated = await p.refine(REQ);
    assert.equal(truncated.stopReason, 'length');

    const event = (type, payload) => `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
    serve([
      event('content_block_delta', {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'partial' },
      }),
      event('message_delta', { type: 'message_delta', delta: { stop_reason: 'max_tokens' } }),
      event('message_stop', { type: 'message_stop' }),
    ]);
    const streamedTruncated = await p.refineStream(REQ, { onToken: () => {} });
    assert.equal(streamedTruncated.stopReason, 'length');

    serve([
      event('content_block_delta', {
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'complete' },
      }),
      event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
      event('message_stop', { type: 'message_stop' }),
    ]);
    const complete = await p.refineStream(REQ, { onToken: () => {} });
    assert.equal(complete.text, 'complete');
    assert.equal(complete.stopReason, 'end');
  });

  it('anthropic scales the output-token budget for long dictations', async () => {
    let requestBody;
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'complete' }],
          stop_reason: 'end_turn',
        }),
        { status: 200 },
      );
    };
    const p = new AnthropicProvider({ ...CFG, id: 'anthropic', baseUrl: 'http://x/v1' });
    const result = await p.refine({ ...REQ, userPrompt: 'long dictation '.repeat(1_000) });
    assert.equal(result.stopReason, 'end');
    assert.ok(requestBody.max_tokens > 1024);
  });

  it('anthropic preflight asks for the full model list', async () => {
    let url = '';
    globalThis.fetch = async (u) => {
      url = String(u);
      return new Response(JSON.stringify({ data: [{ id: 'm' }] }), { status: 200 });
    };
    const p = new AnthropicProvider({ ...CFG, id: 'anthropic', baseUrl: 'http://x/v1' });
    assert.equal(await p.preflight(), null);
    assert.match(url, /\/models\?limit=1000$/);
  });
});
