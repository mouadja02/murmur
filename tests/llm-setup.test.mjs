import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildLlmSetupUpdate,
  shouldRunLlmSetup,
  validateRequiredLlmAnswer,
} from '../dist/main/cli/llm-setup.js';

const baseConfig = {
  provider: 'ollama',
  baseUrl: 'http://localhost:11434',
  model: 'qwen3:4b',
  apiKey: null,
  configFilePath: 'C:/fake/config.json',
};

describe('LLM setup helpers', () => {
  it('runs on a freshly seeded config when LLM values come from env or defaults', () => {
    assert.equal(
      shouldRunLlmSetup(true, {
        provider: 'env',
        baseUrl: 'env',
        model: 'env',
      }),
      true,
    );
    assert.equal(
      shouldRunLlmSetup(true, {
        provider: 'default',
        baseUrl: 'default',
        model: 'default',
      }),
      true,
    );
  });

  it('does not run for existing configs or CLI-pinned first runs', () => {
    assert.equal(
      shouldRunLlmSetup(false, {
        provider: 'env',
        baseUrl: 'env',
        model: 'env',
      }),
      false,
    );
    assert.equal(
      shouldRunLlmSetup(true, {
        provider: 'cli',
        baseUrl: 'cli',
        model: 'cli',
      }),
      false,
    );
  });

  it('keeps env values when the user submits an empty answer', () => {
    const update = buildLlmSetupUpdate(
      baseConfig,
      { provider: 'env', baseUrl: 'env', model: 'env' },
      { provider: '', baseUrl: '', model: '' },
    );

    assert.deepEqual(update, {});
  });

  it('requires explicit values when no env or config value exists', () => {
    assert.throws(
      () =>
        buildLlmSetupUpdate(
          baseConfig,
          { provider: 'default', baseUrl: 'default', model: 'default' },
          { provider: 'ollama', baseUrl: '', model: 'qwen3:4b' },
        ),
      /LLM_BASE_URL is required/,
    );
    assert.notEqual(validateRequiredLlmAnswer('', 'LLM_MODEL'), true);
  });

  it('persists explicit answers that differ from env defaults', () => {
    const update = buildLlmSetupUpdate(
      baseConfig,
      { provider: 'env', baseUrl: 'env', model: 'env' },
      {
        provider: 'openai-compat',
        baseUrl: 'http://localhost:1234/v1',
        model: 'loaded-model',
      },
    );

    assert.deepEqual(update, {
      provider: 'openai-compat',
      baseUrl: 'http://localhost:1234/v1',
      model: 'loaded-model',
    });
  });
});
