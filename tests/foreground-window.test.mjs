import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getForegroundWindowId } from '../dist/main/context/window.js';

// These use fake window objects; the real desktop is never queried.
describe('getForegroundWindowId', () => {
  it('identifies a window by its native handle, not its title', async () => {
    const a = await getForegroundWindowId(async () => ({ windowHandle: 4242, title: 'main.ts' }));
    const b = await getForegroundWindowId(async () => ({ windowHandle: 4242, title: '● main.ts' }));
    assert.equal(a, '4242');
    assert.equal(a, b, 'an editor rewriting its title must not look like another window');
  });

  it('tells different windows apart', async () => {
    const a = await getForegroundWindowId(async () => ({ windowHandle: 1 }));
    const b = await getForegroundWindowId(async () => ({ windowHandle: 2 }));
    assert.notEqual(a, b);
  });

  it('does not leak the title into the identity', async () => {
    const id = await getForegroundWindowId(async () => ({
      windowHandle: 7,
      title: 'SECRET-DOC-TITLE',
    }));
    assert.ok(!String(id).includes('SECRET'));
  });

  it('returns null when the platform gives no handle', async () => {
    assert.equal(await getForegroundWindowId(async () => ({})), null);
    assert.equal(await getForegroundWindowId(async () => null), null);
    assert.equal(await getForegroundWindowId(async () => ({ windowHandle: '' })), null);
  });

  it('returns null instead of throwing when the window query fails', async () => {
    const id = await getForegroundWindowId(async () => {
      throw new Error('no window API on this session');
    });
    assert.equal(id, null);
  });
});
