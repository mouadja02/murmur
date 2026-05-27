import { writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Status } from '../shared/ipc.js';
import type { AudioRecorder } from './audio/recorder.js';
import type { ResolvedConfig } from './config/index.js';
import { createSession, type Session } from './logger.js';
import type { LlmProvider } from './providers/index.js';
import { composeSystemPrompt, loadSkills } from './skills.js';
import { type TranscribeResult, transcribe } from './transcribe.js';
import { buildWav } from './wav.js';

type PipelineState = 'idle' | 'recording' | 'processing';

const AUDIO_TIMEOUT_MS = 10_000;
const STATUS_LINGER_MS = 1_500;

export interface ProcessPcmResult {
  text: string;
  transcription: string;
  sessionDir: string;
}

export interface ProcessPcmOptions {
  inject?: boolean;
  skillIds?: string[];
}

export interface RefineTextOptions {
  skillIds?: string[];
}

export interface RecordOptions {
  durationMs?: number;
  inject?: boolean;
  skillIds?: string[];
}

export interface PipelineDeps {
  cfg: ResolvedConfig;
  provider: LlmProvider;
  emitStatus?: (s: Status) => void;
  requestRendererStart?: () => void;
  requestRendererStop?: () => void;
  inject?: (text: string, opts: { clipboardRestoreDelayMs: number }) => Promise<void>;
  transcribeAudio?: typeof transcribe;
  createRecorder?: () => AudioRecorder;
}

interface PendingHeadlessRecord {
  recorder: AudioRecorder;
  session: Session;
  processOpts: ProcessPcmOptions;
}

export class Pipeline {
  private state: PipelineState = 'idle';
  private session: Session | null = null;
  private audioTimeout: NodeJS.Timeout | null = null;
  private idleTimeout: NodeJS.Timeout | null = null;
  private headlessRecorder: AudioRecorder | null = null;
  private pendingHeadless: PendingHeadlessRecord | null = null;
  private recordStopTimer: NodeJS.Timeout | null = null;
  private pendingHeadlessResolve: ((v: ProcessPcmResult) => void) | null = null;
  private pendingHeadlessReject: ((err: unknown) => void) | null = null;

  constructor(private readonly deps: PipelineDeps) {}

  isRecording(): boolean {
    return this.state === 'recording';
  }

  /** True when overlay and headless paths are fully idle. */
  isIdle(): boolean {
    return this.state === 'idle' && !this.hasHeadlessPending();
  }

  /** True when overlay or headless work is in flight. */
  isBusy(): boolean {
    return !this.isIdle();
  }

  private hasHeadlessPending(): boolean {
    return (
      this.headlessRecorder !== null ||
      this.pendingHeadless !== null ||
      this.recordStopTimer !== null ||
      this.pendingHeadlessResolve !== null
    );
  }

  private hasOverlaySession(): boolean {
    return this.session !== null;
  }

  private setStatus(s: Status): void {
    this.deps.emitStatus?.(s);
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

  private getTranscribeFn(): typeof transcribe {
    return this.deps.transcribeAudio ?? transcribe;
  }

  private resolveSkillIds(skillIds?: string[]): string[] {
    return skillIds ?? this.deps.cfg.enabledSkills;
  }

  start(): void {
    if (this.hasHeadlessPending()) {
      console.warn('[pipeline] start ignored: headless recording active');
      return;
    }
    if (this.state !== 'idle') {
      console.warn(`[pipeline] start ignored: state=${this.state}`);
      return;
    }
    this.cancelIdle();
    this.state = 'recording';
    this.session = createSession(this.deps.cfg.logsDir);
    console.log(`[pipeline] session=${this.session.dir}`);
    this.setStatus('recording');
    this.deps.requestRendererStart?.();
  }

  stop(): void {
    if (!this.hasOverlaySession()) {
      console.warn('[pipeline] stop ignored: no overlay session');
      return;
    }
    if (this.state !== 'recording') {
      console.warn(`[pipeline] stop ignored: state=${this.state}`);
      return;
    }
    this.deps.requestRendererStop?.();

    this.audioTimeout = setTimeout(() => {
      if (this.hasOverlaySession() && this.state === 'recording') {
        console.warn('[pipeline] no audio chunk within 10s, resetting overlay');
        this.resetOverlay();
      }
    }, AUDIO_TIMEOUT_MS);
  }

  toggle(): void {
    if (this.state === 'idle' && !this.hasHeadlessPending()) this.start();
    else if (this.hasOverlaySession() && this.state === 'recording') this.stop();
    // ignored while processing or during headless-only recording
  }

  private resetOverlay(): void {
    if (this.hasHeadlessPending()) {
      console.warn('[pipeline] resetOverlay skipped: headless recording active');
      return;
    }
    this.state = 'idle';
    this.session = null;
    if (this.audioTimeout) {
      clearTimeout(this.audioTimeout);
      this.audioTimeout = null;
    }
    this.setStatus('idle');
  }

  private abortHeadlessRecording(err?: unknown): void {
    if (this.recordStopTimer) {
      clearTimeout(this.recordStopTimer);
      this.recordStopTimer = null;
    }
    this.headlessRecorder = null;
    this.pendingHeadless = null;
    this.pendingHeadlessResolve = null;
    this.pendingHeadlessReject = null;
    this.state = 'idle';
    if (err !== undefined) {
      console.error('[pipeline] headless recording aborted:', err);
      this.setStatus('error');
      this.scheduleIdle(2_500);
    } else {
      this.setStatus('idle');
    }
  }

  async transcribeFile(filePath: string): Promise<TranscribeResult> {
    const { cfg } = this.deps;
    return this.getTranscribeFn()(filePath, {
      cliPath: cfg.whisperCliPath,
      modelPath: cfg.whisperModelPath,
    });
  }

  async refineText(text: string, opts: RefineTextOptions = {}): Promise<string> {
    const { cfg, provider } = this.deps;
    const skills = loadSkills(cfg.skillsDir);
    const composed = composeSystemPrompt(
      cfg.systemPrompt,
      skills,
      this.resolveSkillIds(opts.skillIds),
    );
    const { text: refined } = await provider.refine({
      systemPrompt: composed,
      userPrompt: text,
    });
    if (!refined) {
      throw new Error(`${provider.config.displayName} returned empty refinement`);
    }
    return refined;
  }

  async processPcm(
    buffer: ArrayBuffer | Buffer,
    opts: ProcessPcmOptions = {},
    existingSession?: Session | null,
  ): Promise<ProcessPcmResult> {
    const { cfg, provider } = this.deps;
    const shouldInject = opts.inject ?? true;
    const session = existingSession ?? createSession(cfg.logsDir);
    const timings: Record<string, number | string> = { provider: provider.config.id };
    const pipelineStart = Date.now();

    try {
      const pcm = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
      const wav = buildWav(pcm, cfg.sampleRate);
      session.writeAudio(wav);
      const wavPath = path.join(session.dir, 'audio.wav');
      timings.audioBytes = wav.length;
      timings.audioDurationMs = Math.round((pcm.length / 2 / cfg.sampleRate) * 1000);

      this.setStatus('transcribing');
      const tStart = Date.now();
      const { text: transcription, stderr: whisperStderr } = await this.getTranscribeFn()(wavPath, {
        cliPath: cfg.whisperCliPath,
        modelPath: cfg.whisperModelPath,
      });
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
      const skills = loadSkills(cfg.skillsDir);
      const activeSkillIds = this.resolveSkillIds(opts.skillIds);
      const composed = composeSystemPrompt(cfg.systemPrompt, skills, activeSkillIds);
      session.writeSystemPrompt(composed);
      timings.activeSkills = activeSkillIds.join(',') || '(none)';
      const rStart = Date.now();
      const { text: refined } = await provider.refine({
        systemPrompt: composed,
        userPrompt: transcription,
      });
      timings.refineMs = Date.now() - rStart;
      session.writeRefined(refined);
      console.log(`[pipeline] refined (${timings.refineMs} ms): ${JSON.stringify(refined)}`);

      if (!refined) {
        throw new Error(`${provider.config.displayName} returned empty refinement`);
      }

      if (shouldInject) {
        const injectFn = this.deps.inject;
        if (!injectFn) {
          throw new Error('inject is not configured');
        }
        this.setStatus('injecting');
        const iStart = Date.now();
        await injectFn(refined, { clipboardRestoreDelayMs: cfg.clipboardRestoreDelayMs });
        timings.injectMs = Date.now() - iStart;
      }

      timings.totalMs = Date.now() - pipelineStart;
      session.writeTimings(timings);
      console.log(`[pipeline] done: total=${timings.totalMs}ms`);

      this.setStatus('done');
      return { text: refined, transcription, sessionDir: session.dir };
    } catch (err) {
      console.error('[pipeline] error:', err);
      session.writeError(err);
      timings.totalMs = Date.now() - pipelineStart;
      session.writeTimings(timings);
      this.setStatus('error');
      throw err;
    }
  }

  async record(opts: RecordOptions = {}): Promise<ProcessPcmResult> {
    if (this.hasHeadlessPending() || this.state !== 'idle') {
      throw new Error('recording already in progress');
    }
    const createRecorder = this.deps.createRecorder;
    if (!createRecorder) {
      throw new Error('createRecorder is not configured');
    }

    const recorder = createRecorder();
    const session = createSession(this.deps.cfg.logsDir);
    const processOpts: ProcessPcmOptions = {
      inject: opts.inject ?? false,
      skillIds: opts.skillIds,
    };

    this.headlessRecorder = recorder;
    this.pendingHeadless = { recorder, session, processOpts };
    this.cancelIdle();
    this.state = 'recording';
    this.setStatus('recording');
    console.log(`[pipeline] headless session=${session.dir}`);

    try {
      await recorder.start();
    } catch (err) {
      this.abortHeadlessRecording(err);
      throw err;
    }

    if (opts.durationMs != null) {
      await new Promise<void>((resolve) => {
        this.recordStopTimer = setTimeout(() => {
          this.recordStopTimer = null;
          resolve();
        }, opts.durationMs);
      });
      return this.finishHeadlessRecord();
    }

    return new Promise<ProcessPcmResult>((resolve, reject) => {
      this.pendingHeadlessResolve = resolve;
      this.pendingHeadlessReject = reject;
    });
  }

  async stopRecording(): Promise<ProcessPcmResult> {
    if (!this.headlessRecorder || !this.pendingHeadless) {
      throw new Error('no active recording');
    }
    if (this.recordStopTimer) {
      clearTimeout(this.recordStopTimer);
      this.recordStopTimer = null;
    }
    return this.finishHeadlessRecord();
  }

  private async finishHeadlessRecord(): Promise<ProcessPcmResult> {
    const pending = this.pendingHeadless;
    if (!pending) {
      throw new Error('no active recording');
    }
    const { recorder, session, processOpts } = pending;

    try {
      const buffer = await recorder.stop();
      this.headlessRecorder = null;
      this.pendingHeadless = null;
      if (this.recordStopTimer) {
        clearTimeout(this.recordStopTimer);
        this.recordStopTimer = null;
      }
      this.state = 'processing';
      const result = await this.processPcm(buffer, processOpts, session);
      this.state = 'idle';
      this.scheduleIdle();
      this.pendingHeadlessResolve?.(result);
      this.pendingHeadlessResolve = null;
      this.pendingHeadlessReject = null;
      return result;
    } catch (err) {
      const rejectPending = this.pendingHeadlessReject;
      this.abortHeadlessRecording(err);
      rejectPending?.(err);
      throw err;
    }
  }

  async handleAudioChunk(buffer: ArrayBuffer): Promise<void> {
    if (this.audioTimeout) {
      clearTimeout(this.audioTimeout);
      this.audioTimeout = null;
    }

    if (!this.hasOverlaySession() || this.state !== 'recording') {
      console.warn('[pipeline] audio chunk without active overlay session');
      return;
    }

    if (buffer.byteLength === 0) {
      console.warn('[pipeline] empty audio chunk, resetting overlay');
      this.resetOverlay();
      return;
    }

    const session = this.session;
    this.state = 'processing';
    this.session = null;

    try {
      await this.processPcm(buffer, { inject: true }, session);
      this.state = 'idle';
      this.scheduleIdle();
    } catch (err) {
      console.error('[pipeline] handleAudioChunk error:', err);
      this.state = 'idle';
      this.scheduleIdle(2_500);
    }
  }
}
