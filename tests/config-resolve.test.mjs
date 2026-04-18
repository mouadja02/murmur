import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadConfig } from '../dist/main/config/index.js';

/**
 * Write a config file into a fresh temp dir and resolve it. Returns the
 * temp dir so the caller can clean up.
 */
function withConfig(fileContents, fn) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'murmur-cfg-'));
  try {
    writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(fileContents));
    const loaded = loadConfig({ userDataDir: tmp, argv: ['node', 'test'] });
    fn(loaded, tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe('loadConfig — whisperCliPath resolution', () => {
  it('preserves a bare command name so the OS can resolve it via $PATH', () => {
    withConfig({ whisperCliPath: 'whisper-cli' }, (loaded) => {
      assert.equal(loaded.resolved.whisperCliPath, 'whisper-cli');
    });
  });

  it('keeps an absolute path as-is', () => {
    // Must be a real file, otherwise the Linux/macOS migration in loadConfig
    // resets stale absolute paths back to the bare default.
    const tmp = mkdtempSync(path.join(tmpdir(), 'murmur-bin-'));
    try {
      const abs = path.join(tmp, 'whisper-cli');
      writeFileSync(abs, '');
      withConfig({ whisperCliPath: abs }, (loaded) => {
        assert.equal(loaded.resolved.whisperCliPath, abs);
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('resolves a relative path with separators against the config dir', () => {
    withConfig({ whisperCliPath: './bin/whisper-cli' }, (loaded, tmp) => {
      assert.equal(loaded.resolved.whisperCliPath, path.resolve(tmp, 'bin/whisper-cli'));
    });
  });
});

describe('loadConfig — non-whisper paths still resolve against config dir', () => {
  it('whisperModelPath with no separators is treated as a relative file under configDir', () => {
    // This is the legacy behavior: users who wrote `model.bin` expected it
    // relative to their config dir. Only whisperCliPath gets the bare-PATH
    // treatment.
    withConfig({ whisperModelPath: 'model.bin' }, (loaded, tmp) => {
      assert.equal(loaded.resolved.whisperModelPath, path.resolve(tmp, 'model.bin'));
    });
  });

  it('logsDir defaults to an absolute path under cwd when unspecified', () => {
    withConfig({}, (loaded) => {
      assert.equal(path.isAbsolute(loaded.resolved.logsDir), true);
    });
  });
});
