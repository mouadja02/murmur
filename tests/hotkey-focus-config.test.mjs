import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { HELP_TEXT, loadConfig } from '../dist/main/config/index.js';
import { describeRejected, sanitizePartial } from '../dist/main/config/schema.js';

const ENV_NAME = /^(LLM_|MURMUR_|WHISPER_|OLLAMA_URL$)/;

/** Resolve with every Murmur-related env var cleared, then `vars` applied. */
function resolve({ file, env = {}, argv = [] } = {}) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'murmur-hotkey-cfg-'));
  const saved = {};
  for (const key of Object.keys(process.env)) {
    if (!ENV_NAME.test(key)) continue;
    saved[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, env);
  try {
    if (file) writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(file));
    return loadConfig({ userDataDir: tmp, argv: ['node', 'test', ...argv] });
  } finally {
    for (const key of Object.keys(process.env)) {
      if (ENV_NAME.test(key)) delete process.env[key];
    }
    Object.assign(process.env, saved);
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe('hotkeyMode', () => {
  it('defaults to hold, so existing installs behave as before', () => {
    assert.equal(resolve().resolved.hotkeyMode, 'hold');
  });

  it('reads the config file, the env var and the CLI flag, with CLI > file > env', () => {
    assert.equal(resolve({ file: { hotkeyMode: 'toggle' } }).resolved.hotkeyMode, 'toggle');
    assert.equal(resolve({ env: { MURMUR_HOTKEY_MODE: 'toggle' } }).resolved.hotkeyMode, 'toggle');
    assert.equal(resolve({ argv: ['--hotkey-mode', 'toggle'] }).resolved.hotkeyMode, 'toggle');
    const both = resolve({
      file: { hotkeyMode: 'hold' },
      env: { MURMUR_HOTKEY_MODE: 'toggle' },
    });
    assert.equal(both.resolved.hotkeyMode, 'hold');
    assert.equal(both.valueSources.hotkeyMode, 'file');
    const cli = resolve({ file: { hotkeyMode: 'hold' }, argv: ['--hotkey-mode=toggle'] });
    assert.equal(cli.resolved.hotkeyMode, 'toggle');
  });

  it('ignores an unknown env value instead of switching modes', () => {
    assert.equal(resolve({ env: { MURMUR_HOTKEY_MODE: 'sticky' } }).resolved.hotkeyMode, 'hold');
  });

  it('rejects an unknown value from the file or panel and says why', () => {
    const input = { hotkeyMode: 'sticky' };
    const out = sanitizePartial(input, 'test');
    assert.equal(out.hotkeyMode, undefined);
    assert.match(describeRejected(input, out).hotkeyMode, /hold, toggle/);
  });

  it('is documented in --help', () => {
    assert.match(HELP_TEXT, /--hotkey-mode <hold\|toggle>/);
  });
});

describe('focusChangePolicy', () => {
  it('defaults to copy', () => {
    assert.equal(resolve().resolved.focusChangePolicy, 'copy');
  });

  it('can be set back to paste from the file, the env var or the CLI flag', () => {
    assert.equal(
      resolve({ file: { focusChangePolicy: 'paste' } }).resolved.focusChangePolicy,
      'paste',
    );
    assert.equal(
      resolve({ env: { MURMUR_FOCUS_CHANGE_POLICY: 'paste' } }).resolved.focusChangePolicy,
      'paste',
    );
    assert.equal(
      resolve({ argv: ['--focus-change-policy', 'paste'] }).resolved.focusChangePolicy,
      'paste',
    );
  });

  it('rejects "ask": it is not implemented, so it must not be silently accepted', () => {
    const input = { focusChangePolicy: 'ask' };
    const out = sanitizePartial(input, 'test');
    assert.equal(out.focusChangePolicy, undefined);
    assert.match(describeRejected(input, out).focusChangePolicy, /copy, paste/);
    assert.equal(
      resolve({ env: { MURMUR_FOCUS_CHANGE_POLICY: 'ask' } }).resolved.focusChangePolicy,
      'copy',
    );
  });

  it('is documented in --help', () => {
    assert.match(HELP_TEXT, /--focus-change-policy <copy\|paste>/);
  });
});
