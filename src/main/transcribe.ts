import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

export interface TranscribeOptions {
  cliPath: string;
  modelPath: string;
  /** Kill whisper-cli if it runs longer than this. Defaults to 5 minutes. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/**
 * whisper-cli defaults to 4 threads. Measured on a 20-thread CPU with
 * ggml-base.en (15 s dictation): 4 → 1.88 s, 8 → 1.42 s, 12 → 1.21 s,
 * 16 → 1.20 s. Half the logical cores (≈ physical cores on SMT CPUs) captures
 * most of the gain without oversubscribing; small machines keep the default.
 */
export function whisperThreadCount(logicalCores = os.availableParallelism()): number {
  return Math.min(16, Math.max(4, Math.floor(logicalCores / 2)));
}

// whisper.cpp annotates non-speech segments instead of returning nothing:
// "[BLANK_AUDIO]", "[ Silence ]", "(upbeat music)", "(coughs)" … Strip them so
// silence never reaches the LLM (which would happily "refine" the tag).
// Only remove known annotations. Arbitrary brackets can be code or Markdown;
// adjacent identifiers (playlist[music]) and link labels are meaningful too.
const BRACKET_TAG_RE =
  /(?<![\w$])\[\s*(?:[a-z ]*\s)?(?:silence|music|applause|laugh\w*|inaudible|noise|static|breath\w*|cough\w*|sigh\w*|blank_audio)\s*\](?!\()/gi;
const PAREN_TAG_RE =
  /\((?:[a-z ]*\s)?(?:silence|music|applause|laugh\w*|inaudible|noise|static|breath\w*|cough\w*|sigh\w*|blank_audio)\)/gi;

/** Remove whisper's non-speech annotations and collapse leftover whitespace. */
export function cleanTranscription(text: string): string {
  return text
    .replace(BRACKET_TAG_RE, ' ')
    .replace(PAREN_TAG_RE, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .trim();
}

export interface TranscribeResult {
  text: string;
  stderr: string;
  durationMs: number;
}

export interface TranscribeStreamOptions {
  onToken: (token: string) => void;
}

const TIMESTAMP_RE = /^\[[\d:. >]+\]\s*-->\s*\[[\d:. >]+\]\s*/;
const NOISE_RE =
  /^(whisper_|system:|main:|error:|warn|info|\[|progress\s*=|ggml_|load_|init_|[=]+$)/i;

function parseWhisperLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let text = trimmed;
  if (TIMESTAMP_RE.test(text)) {
    text = text.replace(TIMESTAMP_RE, '').trim();
  }

  if (!text) return null;
  if (NOISE_RE.test(text)) return null;
  if (/^\d+%$/.test(text)) return null;

  return cleanTranscription(text) || null;
}

export async function transcribe(
  wavPath: string,
  opts: TranscribeOptions,
  streamOpts?: TranscribeStreamOptions,
): Promise<TranscribeResult> {
  // Write whisper's .txt into a private temp dir, never next to the input:
  // for MCP `murmur_transcribe` the input lives in a user folder, where a
  // sibling `transcription.txt` would be silently overwritten.
  const outDir = await mkdtemp(path.join(os.tmpdir(), 'murmur-whisper-'));
  const outPrefix = path.join(outDir, 'transcription');
  const args = [
    '-m',
    opts.modelPath,
    '-f',
    wavPath,
    '-t',
    String(whisperThreadCount()),
    '-otxt',
    '-of',
    outPrefix,
    '--print-progress',
  ];
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const started = Date.now();
  let stderr = '';

  try {
    await new Promise<void>((resolve, reject) => {
      const proc = spawn(opts.cliPath, args, { windowsHide: true });
      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error(`whisper-cli timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);

      if (streamOpts?.onToken && proc.stdout) {
        const rl = createInterface({ input: proc.stdout });
        rl.on('line', (line: string) => {
          const token = parseWhisperLine(line);
          if (token) streamOpts.onToken(`${token} `);
        });
      }

      proc.stderr.on('data', (b: Buffer) => {
        stderr += b.toString();
      });
      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`whisper-cli exited with code ${code}. stderr:\n${stderr}`));
      });
    });

    const text = cleanTranscription(await readFile(`${outPrefix}.txt`, 'utf8'));
    return { text, stderr, durationMs: Date.now() - started };
  } finally {
    await rm(outDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
