import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { CONFIG } from '../shared/constants.js';

export interface TranscribeResult {
  text: string;
  stderr: string;
  durationMs: number;
}

export async function transcribe(wavPath: string): Promise<TranscribeResult> {
  const outPrefix = path.join(path.dirname(wavPath), 'transcription');
  const args = ['-m', CONFIG.whisperModelPath, '-f', wavPath, '-nt', '-otxt', '-of', outPrefix];

  const started = Date.now();
  let stderr = '';

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(CONFIG.whisperCliPath, args, { windowsHide: true });
    proc.stderr.on('data', (b: Buffer) => {
      stderr += b.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`whisper-cli exited with code ${code}. stderr:\n${stderr}`));
    });
  });

  const text = (await readFile(`${outPrefix}.txt`, 'utf8')).trim();
  return { text, stderr, durationMs: Date.now() - started };
}
