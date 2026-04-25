import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

describe('loadConfig — first-run LLM env precedence', () => {
  it('does not seed provider/baseUrl/model into a fresh config when env supplies them', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'murmur-cfg-'));
    const oldProvider = process.env.LLM_PROVIDER;
    const oldBaseUrl = process.env.LLM_BASE_URL;
    const oldModel = process.env.LLM_MODEL;
    try {
      process.env.LLM_PROVIDER = 'openai-compat';
      process.env.LLM_BASE_URL = 'http://localhost:1234/v1';
      process.env.LLM_MODEL = 'local-model';

      const loaded = loadConfig({ userDataDir: tmp, argv: ['node', 'test'] });

      assert.equal(loaded.configFileWritten, true);
      assert.equal(loaded.resolved.provider, 'openai-compat');
      assert.equal(loaded.resolved.baseUrl, 'http://localhost:1234/v1');
      assert.equal(loaded.resolved.model, 'local-model');
      assert.equal(loaded.valueSources.provider, 'env');
      assert.equal(loaded.valueSources.baseUrl, 'env');
      assert.equal(loaded.valueSources.model, 'env');

      const seeded = JSON.parse(readFileSync(path.join(tmp, 'config.json'), 'utf8'));
      assert.equal('provider' in seeded, false);
      assert.equal('baseUrl' in seeded, false);
      assert.equal('model' in seeded, false);
    } finally {
      if (oldProvider === undefined) delete process.env.LLM_PROVIDER;
      else process.env.LLM_PROVIDER = oldProvider;
      if (oldBaseUrl === undefined) delete process.env.LLM_BASE_URL;
      else process.env.LLM_BASE_URL = oldBaseUrl;
      if (oldModel === undefined) delete process.env.LLM_MODEL;
      else process.env.LLM_MODEL = oldModel;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('marks first-run LLM values as built-in defaults when no env or file value exists', () => {
    const tmp = mkdtempSync(path.join(tmpdir(), 'murmur-cfg-'));
    const oldProvider = process.env.LLM_PROVIDER;
    const oldBaseUrl = process.env.LLM_BASE_URL;
    const oldModel = process.env.LLM_MODEL;
    try {
      delete process.env.LLM_PROVIDER;
      delete process.env.LLM_BASE_URL;
      delete process.env.LLM_MODEL;

      const loaded = loadConfig({ userDataDir: tmp, argv: ['node', 'test'] });

      assert.equal(loaded.resolved.provider, 'ollama');
      assert.equal(loaded.valueSources.provider, 'default');
      assert.equal(loaded.valueSources.baseUrl, 'default');
      assert.equal(loaded.valueSources.model, 'default');
    } finally {
      if (oldProvider === undefined) delete process.env.LLM_PROVIDER;
      else process.env.LLM_PROVIDER = oldProvider;
      if (oldBaseUrl === undefined) delete process.env.LLM_BASE_URL;
      else process.env.LLM_BASE_URL = oldBaseUrl;
      if (oldModel === undefined) delete process.env.LLM_MODEL;
      else process.env.LLM_MODEL = oldModel;
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
