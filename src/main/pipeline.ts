import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import {
  IPC_ERROR,
  IPC_QUEUE_DEPTH,
  IPC_START_RECORDING,
  IPC_STATUS,
  IPC_STOP_RECORDING,
  type ErrorPayload,
  type Status,
} from '../shared/ipc.js';
import type { ResolvedConfig } from './config/index.js';
import { pasteAtCursor } from './inject.js';
import { createSession, type Session } from './logger.js';
import type { LlmProvider } from './providers/index.js';
import { composeSystemPrompt, loadSkills } from './skills.js';
import { transcribe } from './transcribe.js';
import { buildWav } from './wav.js';

type PipelineState = 'idle' | 'recording' | 'processing';

const AUDIO_TIMEOUT_MS = 10_000;
const STATUS_LINGER_MS = 1_500;

export interface PipelineDeps {
  cfg: ResolvedConfig;
  provider: LlmProvider;
  getWindow: () => BrowserWindow | null;
  onStatus?: (s: Status) => void;
}

interface QueuedCapture {
  session: Session;
  buffer: ArrayBuffer;
}

export class Pipeline {
  private state: PipelineState = 'idle';
  private session: Session | null = null;
  private audioTimeout: NodeJS.Timeout | null = null;
  private idleTimeout: NodeJS.Timeout | null = null;
  private audioQueue: QueuedCapture[] = [];
  private backgroundSession: Session | null = null;
  private backgroundAudioTimeout: NodeJS.Timeout | null = null;
  private lastErrorSessionDir: string | null = null;

  constructor(private readonly deps: PipelineDeps) {}

  isRecording(): boolean {
    return this.state === 'recording';
  }

  private setStatus(s: Status): void {
    this.deps.getWindow()?.webContents.send(IPC_STATUS, s);
    this.deps.onStatus?.(s);
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

  private sendQueueDepth(): void {
    this.deps.getWindow()?.webContents.send(IPC_QUEUE_DEPTH, this.audioQueue.length);
  }

  private enqueue(item: QueuedCapture): void {
    const max = this.deps.cfg.queueMaxDepth;
    if (this.audioQueue.length >= max) {
      this.audioQueue.shift(); // drop oldest, make room
      this.setStatus('queue-full');
      // Revert back to processing status after brief flash
      setTimeout(() => this.setStatus('transcribing' as Status), 1_500);
    }
    this.audioQueue.push(item);
    this.sendQueueDepth();
  }

  private processNextQueued(): void {
    if (this.audioQueue.length === 0) return;
    const next = this.audioQueue.shift()!;
    this.sendQueueDepth();
    this.processBuffer(next.session, next.buffer).catch((err) => {
      console.error('[pipeline] queued item crashed:', err);
    });
  }

  start(): void {
    if (this.state !== 'idle') {
      console.warn(`[pipeline] start ignored: state=${this.state}`);
      return;
    }
    this.cancelIdle();
    this.state = 'recording';
    this.session = createSession(this.deps.cfg.logsDir);
    console.log(`[pipeline] session=${this.session.dir}`);
    this.setStatus('recording');
    this.deps.getWindow()?.webContents.send(IPC_START_RECORDING);
  }

  stop(): void {
    if (this.state !== 'recording') {
      console.warn(`[pipeline] stop ignored: state=${this.state}`);
      return;
    }
    this.deps.getWindow()?.webContents.send(IPC_STOP_RECORDING);

    this.audioTimeout = setTimeout(() => {
      if (this.state === 'recording') {
        console.warn('[pipeline] no audio chunk within 10s, resetting');
        this.reset();
      }
    }, AUDIO_TIMEOUT_MS);
  }

  toggle(): void {
    if (this.state === 'idle') {
      this.start();
    } else if (this.state === 'recording') {
      this.stop();
    } else if (this.state === 'processing') {
      if (this.backgroundSession === null) {
        this.backgroundSession = createSession(this.deps.cfg.logsDir);
        this.deps.getWindow()?.webContents.send(IPC_START_RECORDING);
        this.backgroundAudioTimeout = setTimeout(() => {
          console.warn('[pipeline] background recording timed out, discarding');
          this.backgroundSession = null;
        }, AUDIO_TIMEOUT_MS);
      } else {
        this.deps.getWindow()?.webContents.send(IPC_STOP_RECORDING);
      }
    }
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

  private async processBuffer(session: Session, buffer: ArrayBuffer): Promise<void> {
    this.state = 'processing';

    const { cfg, provider } = this.deps;
    const timings: Record<string, number | string> = { provider: provider.config.id };
    const pipelineStart = Date.now();

    try {
      const pcm = Buffer.from(buffer);
      const wav = buildWav(pcm, cfg.sampleRate);
      session.writeAudio(wav);
      const wavPath = path.join(session.dir, 'audio.wav');
      timings.audioBytes = wav.length;
      timings.audioDurationMs = Math.round((pcm.length / 2 / cfg.sampleRate) * 1000);

      this.setStatus('transcribing');
      const tStart = Date.now();
      const { text: transcription, stderr: whisperStderr } = await transcribe(wavPath, {
        cliPath: cfg.whisperCliPath,
        modelPath: cfg.whisperModelPath,
      });
      timings.transcribeMs = Date.now() - tStart;
      session.writeTranscription(transcription);
      writeFileSync(path.join(session.dir, 'whisper-stderr.log'), whisperStderr, 'utf8');
      console.log(
        `[pipeline] transcription (${timings.transcribeMs} ms): ${JSON.stringify(transcription)}`,
      );

      if (!transcription) throw new Error('whisper returned empty transcription');

      this.setStatus('refining');
      const skills = loadSkills(cfg.skillsDir);
      const composed = composeSystemPrompt(cfg.systemPrompt, skills, cfg.enabledSkills);
      session.writeSystemPrompt(composed);
      timings.activeSkills = cfg.enabledSkills.join(',') || '(none)';
      const rStart = Date.now();
      const { text: refined } = await provider.refine({
        systemPrompt: composed,
        userPrompt: transcription,
      });
      timings.refineMs = Date.now() - rStart;
      session.writeRefined(refined);
      console.log(`[pipeline] refined (${timings.refineMs} ms): ${JSON.stringify(refined)}`);

      if (!refined) throw new Error(`${provider.config.displayName} returned empty refinement`);

      this.setStatus('injecting');
      const iStart = Date.now();
      await pasteAtCursor(refined, { clipboardRestoreDelayMs: cfg.clipboardRestoreDelayMs });
      timings.injectMs = Date.now() - iStart;
      timings.totalMs = Date.now() - pipelineStart;
      session.writeTimings(timings);
      console.log(
        `[pipeline] done: audio=${timings.audioDurationMs}ms transcribe=${timings.transcribeMs}ms refine=${timings.refineMs}ms inject=${timings.injectMs}ms total=${timings.totalMs}ms`,
      );

      this.lastErrorSessionDir = null;
      this.state = 'idle';
      this.setStatus('done');
      this.scheduleIdle();
      this.processNextQueued();
    } catch (err) {
      console.error('[pipeline] error:', err);
      session.writeError(err);
      timings.totalMs = Date.now() - pipelineStart;
      session.writeTimings(timings);
      this.lastErrorSessionDir = session.dir;
      this.state = 'idle';
      const message = err instanceof Error ? err.message : String(err);
      this.deps.getWindow()?.webContents.send(IPC_ERROR, {
        message,
        sessionDir: session.dir,
      } satisfies ErrorPayload);
      this.setStatus('error');
      this.scheduleIdle(2_500);
      this.processNextQueued();
    }
  }

  async handleAudioChunk(buffer: ArrayBuffer): Promise<void> {
    if (this.audioTimeout) {
      clearTimeout(this.audioTimeout);
      this.audioTimeout = null;
    }
    if (this.backgroundAudioTimeout) {
      clearTimeout(this.backgroundAudioTimeout);
      this.backgroundAudioTimeout = null;
    }

    // Background capture (recorded during processing) — enqueue, don't process yet.
    if (this.state === 'processing' && this.backgroundSession) {
      const session = this.backgroundSession;
      this.backgroundSession = null;
      if (buffer.byteLength > 0) {
        this.enqueue({ session, buffer });
      }
      return;
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
    this.session = null;
    await this.processBuffer(session, buffer);
  }

  async retry(): Promise<void> {
    if (this.state !== 'idle' || !this.lastErrorSessionDir) return;
    const sessionDir = this.lastErrorSessionDir;
    this.lastErrorSessionDir = null;

    const wavPath = path.join(sessionDir, 'audio.wav');
    if (!existsSync(wavPath)) {
      console.warn('[pipeline] retry: audio.wav not found at', wavPath);
      return;
    }

    const wavBuf = readFileSync(wavPath);
    // Strip 44-byte WAV header to recover raw PCM bytes.
    const pcmBuf = wavBuf.subarray(44);
    const ab = pcmBuf.buffer.slice(pcmBuf.byteOffset, pcmBuf.byteOffset + pcmBuf.byteLength);

    const session = createSession(this.deps.cfg.logsDir);
    this.session = session;
    this.state = 'recording';
    await this.processBuffer(session, ab);
  }
}
