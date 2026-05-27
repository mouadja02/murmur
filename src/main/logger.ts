import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { LogMode } from './config/index.js';

export interface Session {
  readonly dir: string;
  readonly startedAt: number;
  writeAudio(buf: Buffer): void;
  writeTranscription(text: string): void;
  writeSystemPrompt(text: string): void;
  writeRefined(text: string): void;
  writeError(err: unknown): void;
  writeTimings(timings: Record<string, number | string>): void;
}

function timestampDirName(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}` +
    `-${pad(d.getMilliseconds(), 3)}`
  );
}

export function createSession(logsDir: string, logMode: LogMode = 'metadata-only'): Session {
  const now = new Date();
  const dir = path.join(logsDir, timestampDirName(now));
  mkdirSync(dir, { recursive: true });
  const writeContent = logMode === 'full';

  return {
    dir,
    startedAt: now.getTime(),
    writeAudio(buf) {
      if (!writeContent) return;
      writeFileSync(path.join(dir, 'audio.wav'), buf);
    },
    writeTranscription(text) {
      if (!writeContent) return;
      writeFileSync(path.join(dir, 'transcription.txt'), text, 'utf8');
    },
    writeSystemPrompt(text) {
      if (!writeContent) return;
      writeFileSync(path.join(dir, 'system-prompt.txt'), text, 'utf8');
    },
    writeRefined(text) {
      if (!writeContent) return;
      writeFileSync(path.join(dir, 'refined.txt'), text, 'utf8');
    },
    writeError(err) {
      if (!writeContent) return;
      const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
      writeFileSync(path.join(dir, 'error.txt'), msg, 'utf8');
    },
    writeTimings(timings) {
      writeFileSync(path.join(dir, 'timings.json'), JSON.stringify(timings, null, 2), 'utf8');
    },
  };
}
