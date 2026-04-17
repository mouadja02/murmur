import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface TranscribeOptions {
  cliPath: string;
  modelPath: string;
}

export interface TranscribeResult {
  text: string;
  stderr: string;
  durationMs: number;
}

export async function transcribe(
  wavPath: string,
  opts: TranscribeOptions,
): Promise<TranscribeResult> {
  const outPrefix = path.join(path.dirname(wavPath), 'transcription');
  const args = ['-m', opts.modelPath, '-f', wavPath, '-nt', '-otxt', '-of', outPrefix];

  const started = Date.now();
  let stderr = '';

  await new Promise<void>((resolve, reject) => {
    const proc = spawn(opts.cliPath, args, { windowsHide: true });
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
