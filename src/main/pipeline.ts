import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import { CONFIG } from '../shared/constants.js';
import { IPC_START_RECORDING, IPC_STATUS, IPC_STOP_RECORDING, type Status } from '../shared/ipc.js';
import { SYSTEM_PROMPT } from '../shared/prompts.js';
import { pasteAtCursor } from './inject.js';
import { createSession, type Session } from './logger.js';
import { refine } from './refine.js';
import { transcribe } from './transcribe.js';
import { buildWav } from './wav.js';

type PipelineState = 'idle' | 'recording' | 'processing';

const AUDIO_TIMEOUT_MS = 10_000;
const STATUS_LINGER_MS = 1_500;

export class Pipeline {
  private state: PipelineState = 'idle';
  private session: Session | null = null;
  private audioTimeout: NodeJS.Timeout | null = null;
  private idleTimeout: NodeJS.Timeout | null = null;

  constructor(private readonly getWindow: () => BrowserWindow | null) {}

  private setStatus(s: Status): void {
    this.getWindow()?.webContents.send(IPC_STATUS, s);
  }

  private scheduleIdle(delay = STATUS_LINGER_MS): void {
    if (this.idleTimeout) clearTimeout(this.idleTimeout);
    this.idleTimeout = setTimeout(() => {
      this.idleTimeout = null;
      this.setStatus('idle');
    }, delay);
  }

  private cancelIdle(): void {
    if (this.idleTimeout) {
      clearTimeout(this.idleTimeout);
      this.idleTimeout = null;
    }
  }

  start(): void {
    if (this.state !== 'idle') {
      console.warn(`[pipeline] start ignored: state=${this.state}`);
      return;
    }
    this.cancelIdle();
    this.state = 'recording';
    this.session = createSession();
    console.log(`[pipeline] session=${this.session.dir}`);
    this.setStatus('recording');
    this.getWindow()?.webContents.send(IPC_START_RECORDING);
  }

  stop(): void {
    if (this.state !== 'recording') {
      console.warn(`[pipeline] stop ignored: state=${this.state}`);
      return;
    }
    this.getWindow()?.webContents.send(IPC_STOP_RECORDING);

    this.audioTimeout = setTimeout(() => {
      if (this.state === 'recording') {
        console.warn('[pipeline] no audio chunk within 10s, resetting');
        this.reset();
      }
    }, AUDIO_TIMEOUT_MS);
  }

  private reset(): void {
    this.state = 'idle';
    this.session = null;
    if (this.audioTimeout) {
      clearTimeout(this.audioTimeout);
      this.audioTimeout = null;
    }
    this.setStatus('idle');
  }

  async handleAudioChunk(buffer: ArrayBuffer): Promise<void> {
    if (this.audioTimeout) {
      clearTimeout(this.audioTimeout);
      this.audioTimeout = null;
    }

    if (!this.session || this.state !== 'recording') {
      console.warn('[pipeline] audio chunk without active session');
      return;
    }

    if (buffer.byteLength === 0) {
      console.warn('[pipeline] empty audio chunk, resetting');
      this.reset();
      return;
    }

    const session = this.session;
    this.state = 'processing';
    this.session = null;

    const timings: Record<string, number> = {};
    const pipelineStart = Date.now();

    try {
      const pcm = Buffer.from(buffer);
      const wav = buildWav(pcm, CONFIG.sampleRate);
      session.writeAudio(wav);
      const wavPath = path.join(session.dir, 'audio.wav');
      timings.audioBytes = wav.length;
      timings.audioDurationMs = Math.round((pcm.length / 2 / CONFIG.sampleRate) * 1000);

      this.setStatus('transcribing');
      const tStart = Date.now();
      const { text: transcription, stderr: whisperStderr } = await transcribe(wavPath);
      timings.transcribeMs = Date.now() - tStart;
      session.writeTranscription(transcription);
      writeFileSync(path.join(session.dir, 'whisper-stderr.log'), whisperStderr, 'utf8');
      console.log(
        `[pipeline] transcription (${timings.transcribeMs} ms): ${JSON.stringify(transcription)}`,
      );

      if (!transcription) {
        throw new Error('whisper returned empty transcription');
      }

      this.setStatus('refining');
      session.writeSystemPrompt(SYSTEM_PROMPT);
      const rStart = Date.now();
      const { text: refined } = await refine(transcription);
      timings.refineMs = Date.now() - rStart;
      session.writeRefined(refined);
      console.log(`[pipeline] refined (${timings.refineMs} ms): ${JSON.stringify(refined)}`);

      if (!refined) {
        throw new Error('ollama returned empty refinement');
      }

      this.setStatus('injecting');
      const iStart = Date.now();
      await pasteAtCursor(refined);
      timings.injectMs = Date.now() - iStart;

      timings.totalMs = Date.now() - pipelineStart;
      session.writeTimings(timings);
      console.log(
        `[pipeline] done: audio=${timings.audioDurationMs}ms transcribe=${timings.transcribeMs}ms refine=${timings.refineMs}ms inject=${timings.injectMs}ms total=${timings.totalMs}ms`,
      );

      this.state = 'idle';
      this.setStatus('done');
      this.scheduleIdle();
    } catch (err) {
      console.error('[pipeline] error:', err);
      session.writeError(err);
      timings.totalMs = Date.now() - pipelineStart;
      session.writeTimings(timings);
      this.state = 'idle';
      this.setStatus('error');
      this.scheduleIdle(2_500);
    }
  }
}
