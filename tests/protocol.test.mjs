import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { findMurmurUrlInArgv, parseMurmurUrl } from '../dist/main/protocol/url.js';

describe('parseMurmurUrl', () => {
  it('parses all known actions (hostname form)', () => {
    assert.equal(parseMurmurUrl('murmur://show'), 'show');
    assert.equal(parseMurmurUrl('murmur://hide'), 'hide');
    assert.equal(parseMurmurUrl('murmur://toggle'), 'toggle');
    assert.equal(parseMurmurUrl('murmur://panel'), 'panel');
    assert.equal(parseMurmurUrl('murmur://quit'), 'quit');
  });

  it('parses slash-prefixed form from strict URL parsers', () => {
    // Some terminals normalise `murmur://show` to `murmur:///show` before
    // handing it to the OS, which puts the action in the pathname.
    assert.equal(parseMurmurUrl('murmur:///show'), 'show');
  });

  it('is case-insensitive on the scheme + action', () => {
    assert.equal(parseMurmurUrl('MURMUR://SHOW'), 'show');
    assert.equal(parseMurmurUrl('Murmur://Hide'), 'hide');
  });

  it('returns null for unknown actions and foreign schemes', () => {
    assert.equal(parseMurmurUrl('murmur://chaos'), null);
    assert.equal(parseMurmurUrl('http://localhost/show'), null);
    assert.equal(parseMurmurUrl('murmur-evil://show'), null);
    assert.equal(parseMurmurUrl(''), null);
    assert.equal(parseMurmurUrl('not a url'), null);
  });
});

describe('findMurmurUrlInArgv', () => {
  it('returns the first murmur:// url in an argv list', () => {
    const argv = [
      '/usr/bin/node',
      '/path/to/murmur.mjs',
      '--flag',
      'murmur://show',
      'ignored-after',
    ];
    assert.equal(findMurmurUrlInArgv(argv), 'murmur://show');
  });

  it('returns null when argv has no protocol url', () => {
    assert.equal(findMurmurUrlInArgv(['electron', '.']), null);
  });

  it('tolerates non-string entries (defensive against process.argv quirks)', () => {
    const argv = ['electron', 42, 'murmur://hide'];
    assert.equal(findMurmurUrlInArgv(argv), 'murmur://hide');
  });
});
