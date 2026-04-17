import 'dotenv/config';
import path from 'node:path';

const appRoot = process.cwd();

function resolvePath(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(appRoot, p);
}

export const CONFIG = {
  ollamaUrl: process.env.OLLAMA_URL ?? 'http://localhost:11434',
  llmModel: process.env.LLM_MODEL ?? 'qwen3:4b',
  whisperCliPath: resolvePath(process.env.WHISPER_CLI_PATH ?? './bin/whisper/whisper-cli.exe'),
  whisperModelPath: resolvePath(
    process.env.WHISPER_MODEL_PATH ?? './bin/whisper/models/ggml-base.en.bin',
  ),
  clipboardRestoreDelayMs: 150,
  logsDir: path.resolve(appRoot, 'logs'),
  sampleRate: 16000,
} as const;
