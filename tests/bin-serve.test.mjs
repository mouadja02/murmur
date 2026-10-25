import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

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

describe('murmur serve informational flags', () => {
  let home;

  beforeEach(() => {
    // A space in the path mirrors "C:\Users\First Last\AppData".
    home = mkdtempSync(path.join(tmpdir(), 'murmur serve home-'));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function runServe(...flags) {
    return spawnSync(process.execPath, [binPath, 'serve', ...flags], {
      cwd: home,
      encoding: 'utf8',
      timeout: 20_000,
      env: {
        ...process.env,
        APPDATA: home,
        XDG_CONFIG_HOME: home,
        HOME: home,
        USERPROFILE: home,
        // A closed port: if serve ever reached preflight it would fail loudly.
        OLLAMA_BASE_URL: 'http://127.0.0.1:1',
      },
    });
  }

  it('--help prints usage and exits 0 without writing config or probing', () => {
    const res = runServe('--help', '--port', '0', '--mcp-port', '0');

    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Usage:/);
    assert.doesNotMatch(res.stdout + res.stderr, /preflight|fatal/i);
    assert.equal(existsSync(path.join(home, 'murmur', 'config.json')), false);
  });

  it('--print-config prints the resolved config and exits 0 without writing it', () => {
    const res = runServe('--print-config', '--port', '0', '--mcp-port', '0');

    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /"mcpPort": 0/);
    assert.match(res.stdout, /written: false/);
    assert.doesNotMatch(res.stdout + res.stderr, /preflight|fatal/i);
    assert.equal(existsSync(path.join(home, 'murmur', 'config.json')), false);
  });
});
