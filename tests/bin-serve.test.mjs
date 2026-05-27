import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const binPath = path.join(process.cwd(), 'bin', 'murmur.mjs');

describe('bin/murmur.mjs serve routing', () => {
  it('routes serve to dist/main/serve.js before Electron', () => {
    const source = readFileSync(binPath, 'utf8');

    assert.match(source, /userArgs\[0\]\s*===\s*['"]serve['"]/);

    const serveIdx = source.indexOf("userArgs[0] === 'serve'");
    const electronRequireIdx = source.indexOf("require_('electron')");
    assert.ok(serveIdx >= 0, 'serve branch marker not found');
    assert.ok(electronRequireIdx >= 0, 'electron require marker not found');
    assert.ok(serveIdx < electronRequireIdx, 'serve branch must appear before require_(electron)');

    assert.match(source, /dist['"],\s*['"]main['"],\s*['"]serve\.js/);
  });
});
