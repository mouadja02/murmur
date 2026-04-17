import type { PartialConfig } from './schema.js';

/**
 * Built-in defaults, used when no other source supplies a value.
 * Paths are intentionally relative; they get resolved against `process.cwd()`
 * by `resolveConfig`.
 */
export const DEFAULT_CONFIG: Required<Omit<PartialConfig, 'apiKey' | 'overlay'>> & {
  apiKey: null;
  overlay: { anchor: 'bottom-center'; offsetX: number; offsetY: number };
} = {
  provider: 'ollama',
  baseUrl: 'http://localhost:11434',
  model: 'qwen3:4b',
  apiKey: null,
  temperature: 0.2,

  whisperCliPath: './bin/whisper/whisper-cli.exe',
  whisperModelPath: './bin/whisper/models/ggml-base.en.bin',

  sampleRate: 16000,
  hotkeyCombo: 'Ctrl+Shift+Space',
  clipboardRestoreDelayMs: 150,

  overlay: {
    anchor: 'bottom-center',
    offsetX: 0,
    offsetY: 24,
  },

  logsDir: './logs',
};
