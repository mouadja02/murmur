import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createProgressiveInjector } from '../dist/main/progressive-inject.js';

describe('createProgressiveInjector', () => {
  it('types tokens in order via the provided typeFn', async () => {
    const typed = [];
    const injector = createProgressiveInjector({
      typeFn: async (text) => {
        typed.push(text);
      },
    });

    injector.pushToken('Hello ');
    injector.pushToken('world');
    await injector.flush();

    assert.deepEqual(typed, ['Hello ', 'world']);
  });

  it('flush resolves after all queued tokens are typed', async () => {
    let gate;
    const gatePromise = new Promise((resolve) => {
      gate = resolve;
    });
    let callCount = 0;
    const injector = createProgressiveInjector({
      typeFn: (text) => {
        callCount++;
        if (callCount === 2) {
          return gatePromise;
        }
        return Promise.resolve();
      },
    });

    injector.pushToken('a');
    injector.pushToken('b');
    injector.pushToken('c');

    let flushed = false;
    const flushPromise = injector.flush().then(() => {
      flushed = true;
    });

    await new Promise((r) => setTimeout(r, 20));
    assert.equal(flushed, false);
    gate();
    await flushPromise;
    assert.equal(flushed, true);
  });

  it('abort prevents further tokens from being typed', async () => {
    const typed = [];
    const injector = createProgressiveInjector({
      typeFn: async (text) => {
        await new Promise((r) => setTimeout(r, 10));
        typed.push(text);
      },
    });

    injector.pushToken('a');
    injector.pushToken('b');
    injector.abort();
    injector.pushToken('c');

    await new Promise((r) => setTimeout(r, 50));
    assert.equal(typed.includes('c'), false);
  });

  it('flush reports what was typed when every chunk succeeds', async () => {
    const injector = createProgressiveInjector({ typeFn: async () => {} });

    injector.pushToken('Hello ');
    injector.pushToken('world');

    assert.deepEqual(await injector.flush(), { typed: 'Hello world', failed: false });
  });

  it('stops at the first typeFn rejection instead of skipping the chunk', async () => {
    const error = new Error('focus lost');
    const typed = [];
    const injector = createProgressiveInjector({
      typeFn: async (text) => {
        if (text === 'c') throw error;
        typed.push(text);
      },
    });

    for (const token of ['a', 'b', 'c', 'd', 'e']) injector.pushToken(token);
    const result = await injector.flush();

    assert.deepEqual(typed, ['a', 'b']);
    assert.deepEqual(result, { typed: 'ab', failed: true, error });
  });

  it('keeps reporting the failure to later flushes and ignores later tokens', async () => {
    const typed = [];
    const injector = createProgressiveInjector({
      typeFn: async (text) => {
        if (text === 'a') throw new Error('boom');
        typed.push(text);
      },
    });

    injector.pushToken('a');
    assert.equal((await injector.flush()).failed, true);
    injector.pushToken('b');
    const second = await injector.flush();

    assert.equal(second.failed, true);
    assert.deepEqual(typed, []);
  });

  it('abort waits for the chunk being typed and reports what reached the target', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const typed = [];
    const injector = createProgressiveInjector({
      typeFn: async (text) => {
        if (text === 'b') await gate;
        typed.push(text);
      },
    });

    injector.pushToken('a');
    injector.pushToken('b');
    injector.pushToken('c');
    await new Promise((r) => setTimeout(r, 10));
    const aborted = injector.abort();
    release();
    const result = await aborted;

    assert.deepEqual(typed, ['a', 'b']);
    assert.deepEqual(result, { typed: 'ab', failed: false });
  });
});
