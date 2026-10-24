import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BrowserWindow } from 'electron';
import {
  type ErrorPayload,
  IPC_ERROR,
  IPC_QUEUE_DEPTH,
  IPC_START_RECORDING,
  IPC_STATUS,
  IPC_STOP_RECORDING,
  IPC_TOKEN,
  IPC_VAD_MODE,
  type Status,
  type TokenPayload,
  type TokenPhase,
  type VadModePayload,
} from '../shared/ipc.js';
import { peakWindowRmsDb, TARGET_SAMPLE_RATE } from '../shared/pcm.js';
import type { AudioRecorder } from './audio/recorder.js';
import type { ResolvedConfig } from './config/index.js';
import {
  type CapturedContext,
  contextForRerun,
  routeSkills,
  withContext,
} from './context/index.js';
import type { InjectOptions } from './inject.js';
import { createSession, type Session } from './logger.js';
import type { ProgressiveInjector } from './progressive-inject.js';
import type { LlmProvider } from './providers/index.js';
import { composeSystemPrompt, loadSkills } from './skills.js';
import { type TranscribeResult, transcribe } from './transcribe.js';
import { buildWav } from './wav.js';

type PipelineState = 'idle' | 'recording' | 'processing';

const AUDIO_TIMEOUT_MS = 10_000;
const STATUS_LINGER_MS = 1_500;
/** Captures shorter than this are accidental hotkey taps, not prompts. */
const MIN_SPEECH_MS = 250;

/**
 * Thrown when a capture contains no speech (too short, or whisper only heard
 * silence/noise). The hotkey flow treats it as a quiet no-op instead of an
 * error; programmatic callers (MCP) still receive it as a rejection.
 */
export class NoSpeechError extends Error {
  constructor() {
    super('no speech detected');
    this.name = 'NoSpeechError';
  }
}

export interface ProcessPcmResult {
  text: string;
  transcription: string;
  sessionDir: string;
}

export interface ProcessPcmOptions {
  inject?: boolean;
  skillIds?: string[];
  /** Context snapshotted when the capture started (resolved after whisper runs). */
  context?: Promise<CapturedContext | null>;
}

/** How a capture was started: held hotkey, or click/toggle (VAD may auto-stop it). */
export type CaptureMode = 'ptt' | 'toggle';

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
  getWindow?: () => BrowserWindow | null;
  onStatus?: (s: Status) => void;
  emitStatus?: (s: Status) => void;
  onToken?: (token: string, phase: TokenPhase) => void;
  requestRendererStart?: (autoStop: boolean) => void;
  requestRendererStop?: () => void;
  inject?: (text: string, opts: InjectOptions) => Promise<void>;
  transcribeAudio?: typeof transcribe;
  createRecorder?: () => AudioRecorder;
  createProgressiveInjector?: () => ProgressiveInjector;
  whisperSupportsStreaming?: boolean;
  /** Snapshot active window / clipboard / screenshot when a capture starts. */
  captureContext?: () => Promise<CapturedContext | null>;
}

interface QueuedCapture {
  session: Session;
  buffer: ArrayBuffer;
  context: Promise<CapturedContext | null>;
}

interface PendingHeadlessRecord {
  recorder: AudioRecorder;
  session: Session;
  processOpts: ProcessPcmOptions;
}

const NO_CONTEXT: Promise<CapturedContext | null> = Promise.resolve(null);

/** Where refinement requests (and so any shared context) are sent. */
function destinationOf(provider: LlmProvider): string {
  const { id, baseUrl } = provider.config;
  return `${id} ${baseUrl.trim().replace(/\/+$/, '').toLowerCase()}`;
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
  private lastErrorAudioBuffer: ArrayBuffer | null = null;
  private headlessRecorder: AudioRecorder | null = null;
  private pendingHeadless: PendingHeadlessRecord | null = null;
  private recordStopTimer: NodeJS.Timeout | null = null;
  private pendingHeadlessResolve: ((v: ProcessPcmResult) => void) | null = null;
  private pendingHeadlessReject: ((err: unknown) => void) | null = null;
  private tokenListeners = new Set<(token: string, phase: TokenPhase) => void>();
  private lastTranscription: string | null = null;
  private lastContext: CapturedContext | null = null;
  private lastContextDestination = '';
  private lastErrorContext: Promise<CapturedContext | null> = NO_CONTEXT;
  private lastErrorContextDestination = '';
  private sessionContext: Promise<CapturedContext | null> = NO_CONTEXT;
  private backgroundContext: Promise<CapturedContext | null> = NO_CONTEXT;
  private currentStatus: Status = 'idle';
  private statusBeforeQueueFull: Status = 'idle';
  private stopRequested = false;

  constructor(private readonly deps: PipelineDeps) {}

  /** Start a context snapshot for a capture that is beginning now. Never rejects. */
  private beginContext(): Promise<CapturedContext | null> {
    const capture = this.deps.captureContext;
    if (!capture) return NO_CONTEXT;
    return capture().catch((err) => {
      console.warn('[pipeline] context capture failed (continuing without it):', err);
      return null;
    });
  }

  /**
   * Carry user-facing history over from a pipeline this one replaces (config
   * reloads rebuild the pipeline). Without this, saving a skill or prompt
   * change in the control panel would wipe "Refine last" and "Retry" — exactly
   * when the user wants to re-run with the new settings.
   */
  inheritFrom(prev: Pipeline): void {
    this.lastTranscription = prev.lastTranscription;
    this.lastErrorSessionDir = prev.lastErrorSessionDir;
    this.lastErrorAudioBuffer = prev.lastErrorAudioBuffer;
    // Keep only the context the new settings and provider allow: what the user
    // switched off must not stay in memory, nor come back if it is re-enabled.
    this.lastContextDestination = prev.lastContextDestination;
    this.lastContext = this.rerunContext(prev.lastContext, prev.lastContextDestination);
    this.lastErrorContextDestination = prev.lastErrorContextDestination;
    this.lastErrorContext = this.rerunContextLater(
      prev.lastErrorContext,
      prev.lastErrorContextDestination,
    );
  }

  /** A stored context filtered by the current settings and provider (see `contextForRerun`). */
  private rerunContext(ctx: CapturedContext | null, capturedFor: string): CapturedContext | null {
    const { cfg, provider } = this.deps;
    return contextForRerun(
      ctx,
      {
        contextCapture: cfg.contextCapture,
        clipboardContextEntries: cfg.clipboardContextEntries,
        screenshotContext: cfg.screenshotContext,
        appSkillRoutes: cfg.appSkillRoutes ?? [],
      },
      capturedFor === destinationOf(provider),
    );
  }

  private rerunContextLater(
    ctx: Promise<CapturedContext | null>,
    capturedFor: string,
  ): Promise<CapturedContext | null> {
    return ctx.then((resolved) => this.rerunContext(resolved, capturedFor));
  }

  addTokenListener(fn: (token: string, phase: TokenPhase) => void): void {
    this.tokenListeners.add(fn);
  }

  removeTokenListener(fn: (token: string, phase: TokenPhase) => void): void {
    this.tokenListeners.delete(fn);
  }

  hasLastTranscription(): boolean {
    return this.lastTranscription !== null;
  }

  isRecording(): boolean {
    return this.state === 'recording';
  }

  isIdle(): boolean {
    return (
      this.state === 'idle' &&
      this.audioQueue.length === 0 &&
      this.backgroundSession === null &&
      !this.hasHeadlessPending()
    );
  }

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

  private setStatus(s: Status): void {
    this.currentStatus = s;
    this.deps.getWindow?.()?.webContents.send(IPC_STATUS, s);
    this.deps.emitStatus?.(s);
    this.deps.onStatus?.(s);
  }

  private emitToken(token: string, phase: TokenPhase): void {
    const payload: TokenPayload = { token, phase };
    this.deps.getWindow?.()?.webContents.send(IPC_TOKEN, payload);
    this.deps.onToken?.(token, phase);
    for (const listener of this.tokenListeners) {
      listener(token, phase);
    }
  }

  private requestRendererStart(autoStop: boolean): void {
    this.deps.requestRendererStart?.(autoStop);
    const win = this.deps.getWindow?.();
    win?.webContents.send(IPC_VAD_MODE, { autoStop } satisfies VadModePayload);
    win?.webContents.send(IPC_START_RECORDING);
  }

  private requestRendererStop(): void {
    this.deps.requestRendererStop?.();
    this.deps.getWindow?.()?.webContents.send(IPC_STOP_RECORDING);
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
    this.deps.getWindow?.()?.webContents.send(IPC_QUEUE_DEPTH, this.audioQueue.length);
  }

  private enqueue(item: QueuedCapture): void {
    const max = this.deps.cfg.queueMaxDepth;
    if (this.audioQueue.length >= max) {
      this.audioQueue.shift();
      // Flash "queue full", then restore whatever phase we were in — unless the
      // pipeline has moved on meanwhile (otherwise an idle overlay would get
      // stuck showing a stale "Transcribing…").
      if (this.currentStatus !== 'queue-full') this.statusBeforeQueueFull = this.currentStatus;
      this.setStatus('queue-full');
      setTimeout(() => {
        if (this.currentStatus === 'queue-full') this.setStatus(this.statusBeforeQueueFull);
      }, 1_500);
    }
    this.audioQueue.push(item);
    this.sendQueueDepth();
  }

  private processNextQueued(): void {
    const next = this.audioQueue.shift();
    if (!next) return;
    this.sendQueueDepth();
    this.processBuffer(next.session, next.buffer, next.context).catch((err) => {
      console.error('[pipeline] queued item crashed:', err);
    });
  }

  private getTranscribeFn(): typeof transcribe {
    return this.deps.transcribeAudio ?? transcribe;
  }

  private resolveSkillIds(skillIds?: string[]): string[] {
    return skillIds ?? this.deps.cfg.enabledSkills;
  }

  /**
   * Begin an overlay capture. With VAD on, the overlay shows "Listening…"
   * until the renderer reports speech ({@link speechStarted}); in toggle mode
   * it also ends the capture itself after a silence ({@link vadSilence}).
   */
  start(mode: CaptureMode = 'ptt'): void {
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
    this.stopRequested = false;
    this.session = createSession(this.deps.cfg.logsDir, this.deps.cfg.logMode);
    this.sessionContext = this.beginContext();
    console.log(`[pipeline] session=${this.session.dir} mode=${mode}`);
    this.setStatus(this.deps.cfg.vadEnabled ? 'vad-listening' : 'recording');
    this.requestRendererStart(mode === 'toggle');
  }

  /** Renderer VAD heard the first speech of the current capture. */
  speechStarted(): void {
    if (this.state === 'recording' && this.currentStatus === 'vad-listening') {
      this.setStatus('recording');
    }
  }

  /** Renderer VAD saw a long enough silence after speech in a toggle capture. */
  vadSilence(): void {
    if (this.hasHeadlessPending()) return;
    if (this.state === 'recording') {
      console.log('[pipeline] VAD silence: auto-stopping');
      this.stop();
    } else if (this.state === 'processing' && this.backgroundSession !== null) {
      this.stopBackgroundCapture();
    }
  }

  stop(): void {
    if (this.hasHeadlessPending()) {
      console.warn('[pipeline] stop ignored: headless recording active');
      return;
    }
    if (this.state !== 'recording') {
      console.warn(`[pipeline] stop ignored: state=${this.state}`);
      return;
    }
    // VAD auto-stop and a manual click can race; only stop the renderer once.
    if (this.stopRequested) return;
    this.stopRequested = true;
    this.requestRendererStop();

    this.audioTimeout = setTimeout(() => {
      if (this.state === 'recording') {
        console.warn('[pipeline] no audio chunk within 10s, resetting');
        this.reset();
      }
    }, AUDIO_TIMEOUT_MS);
  }

  toggle(): void {
    if (this.hasHeadlessPending()) return;
    if (this.state === 'idle') {
      this.start('toggle');
    } else if (this.state === 'recording') {
      this.stop();
    } else if (this.state === 'processing') {
      if (this.backgroundSession === null) {
        this.backgroundSession = createSession(this.deps.cfg.logsDir, this.deps.cfg.logMode);
        this.backgroundContext = this.beginContext();
        this.requestRendererStart(true);
      } else {
        this.stopBackgroundCapture();
      }
    }
  }

  /**
   * End a capture queued behind an in-flight one. The "no audio arrived"
   * timeout starts here, at stop — starting it when the capture began
   * discarded any queued dictation longer than 10 s.
   */
  private stopBackgroundCapture(): void {
    if (this.backgroundAudioTimeout) return; // already stopping
    this.requestRendererStop();
    this.backgroundAudioTimeout = setTimeout(() => {
      console.warn('[pipeline] background recording produced no audio, discarding');
      this.backgroundSession = null;
      this.backgroundContext = NO_CONTEXT;
      this.backgroundAudioTimeout = null;
    }, AUDIO_TIMEOUT_MS);
  }

  private reset(): void {
    this.state = 'idle';
    this.session = null;
    this.sessionContext = NO_CONTEXT;
    if (this.audioTimeout) {
      clearTimeout(this.audioTimeout);
      this.audioTimeout = null;
    }
    if (this.backgroundAudioTimeout) {
      clearTimeout(this.backgroundAudioTimeout);
      this.backgroundAudioTimeout = null;
    }
    this.backgroundSession = null;
    this.backgroundContext = NO_CONTEXT;
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

  /**
   * System prompt for a dictation: base prompt + skills (+ app routes) +
   * captured context. Explicit `skillIds` (MCP callers) are used verbatim;
   * otherwise the enabled skills are adjusted by `appSkillRoutes` for the app
   * that was active when the capture started.
   */
  private composeForDictation(
    skillIds: string[] | undefined,
    ctx: CapturedContext | null,
  ): { composed: string; activeSkillIds: string[] } {
    const { cfg } = this.deps;
    const activeSkillIds =
      skillIds ?? routeSkills(cfg.enabledSkills, cfg.appSkillRoutes ?? [], ctx?.window ?? null);
    const composed = withContext(
      composeSystemPrompt(cfg.systemPrompt, loadSkills(cfg.skillsDir), activeSkillIds),
      ctx,
    );
    return { composed, activeSkillIds };
  }

  async refineLast(skillIds?: string[]): Promise<string> {
    if (!this.lastTranscription) {
      throw new Error('no previous transcription to refine');
    }
    if (this.isBusy()) {
      throw new Error('pipeline is busy');
    }

    const { cfg, provider } = this.deps;
    const useProgressive = cfg.progressiveInjection && !!this.deps.createProgressiveInjector;
    // Use the skills enabled *now*: the point of refine-last is re-running the
    // previous dictation after tweaking skills / the prompt in the panel. The
    // context is the one captured with that dictation, narrowed to what the
    // current settings and provider allow.
    const ctx = this.rerunContext(this.lastContext, this.lastContextDestination);
    const { composed, activeSkillIds } = this.composeForDictation(skillIds, ctx);
    const session = createSession(cfg.logsDir, cfg.logMode);
    const pipelineStart = Date.now();
    const timings: Record<string, number | string> = {
      provider: provider.config.id,
      source: 'refine-last',
    };
    let injector: ProgressiveInjector | null = null;
    if (useProgressive) {
      injector = this.deps.createProgressiveInjector?.() ?? null;
    }

    const transcription = this.lastTranscription;
    // Mark busy so a hotkey press or MCP call can't start a capture mid-refine.
    this.cancelIdle();
    this.state = 'processing';
    try {
      this.setStatus('refining-streaming');
      session.writeTranscription(transcription);
      session.writeSystemPrompt(composed);
      timings.activeSkills = activeSkillIds.join(',') || '(none)';

      if (ctx?.block && cfg.logMode === 'full') session.writeContext(ctx.block);

      const rStart = Date.now();
      const { text: refined } = await provider.refineStream(
        {
          systemPrompt: composed,
          userPrompt: transcription,
          images: ctx?.images,
        },
        {
          onToken: (token) => {
            this.emitToken(token, 'refinement');
            if (injector) injector.pushToken(token);
          },
        },
      );
      timings.refineMs = Date.now() - rStart;
      session.writeRefined(refined);

      if (!refined) throw new Error(`${provider.config.displayName} returned empty refinement`);

      if (injector) {
        const iStart = Date.now();
        await injector.flush();
        timings.injectMs = Date.now() - iStart;
      } else {
        const injectFn = this.deps.inject;
        if (injectFn) {
          this.setStatus('injecting');
          const iStart = Date.now();
          await injectFn(refined, {
            clipboardRestoreDelayMs: cfg.clipboardRestoreDelayMs,
            clipboardRetention: cfg.clipboardRetention,
            injectionMethod: cfg.injectionMethod,
          });
          timings.injectMs = Date.now() - iStart;
        }
      }

      timings.totalMs = Date.now() - pipelineStart;
      session.writeTimings(timings);
      this.state = 'idle';
      this.setStatus('done');
      this.scheduleIdle();
      return refined;
    } catch (err) {
      if (injector) injector.abort();
      console.error('[pipeline] refineLast error:', err);
      session.writeError(err);
      timings.totalMs = Date.now() - pipelineStart;
      session.writeTimings(timings);
      this.state = 'idle';
      this.setStatus('error');
      this.scheduleIdle(2_500);
      throw err;
    }
  }

  async processPcm(
    buffer: ArrayBuffer | Buffer,
    opts: ProcessPcmOptions = {},
    existingSession?: Session | null,
  ): Promise<ProcessPcmResult> {
    const { cfg, provider } = this.deps;
    const shouldInject = opts.inject ?? true;
    const useProgressive =
      shouldInject && cfg.progressiveInjection && !!this.deps.createProgressiveInjector;
    const canStreamWhisper = this.deps.whisperSupportsStreaming ?? true;
    const session = existingSession ?? createSession(cfg.logsDir, cfg.logMode);
    const timings: Record<string, number | string> = { provider: provider.config.id };
    const pipelineStart = Date.now();
    let transientWavPath: string | null = null;
    let injector: ProgressiveInjector | null = null;

    if (useProgressive) {
      injector = this.deps.createProgressiveInjector?.() ?? null;
    }

    try {
      const pcm = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
      // Every capture path (overlay renderer, headless recorder) yields 16 kHz mono,
      // so label it as such regardless of what the config file says.
      const wav = buildWav(pcm, TARGET_SAMPLE_RATE);
      const wavPath = path.join(session.dir, 'audio.wav');
      transientWavPath = wavPath;
      writeFileSync(wavPath, wav);
      if (cfg.logMode === 'full') session.writeAudio(wav);
      timings.audioBytes = wav.length;
      timings.audioDurationMs = Math.round((pcm.length / 2 / TARGET_SAMPLE_RATE) * 1000);
      if (timings.audioDurationMs < MIN_SPEECH_MS) throw new NoSpeechError();
      // Same threshold as the overlay's VAD, applied to every capture path
      // (overlay, hotkey, MCP's recorder). Whisper turns near-silence into
      // phantom words ("you", "Thank you."), so never hand it a quiet clip.
      if (cfg.vadEnabled) {
        const peakDb = peakWindowRmsDb(pcm, TARGET_SAMPLE_RATE);
        timings.peakDb = Number.isFinite(peakDb) ? Math.round(peakDb) : 'silent';
        if (peakDb < cfg.vadThresholdDb) throw new NoSpeechError();
      }

      this.setStatus(canStreamWhisper ? 'transcribing-streaming' : 'transcribing');
      const tStart = Date.now();
      const transcribeOpts = canStreamWhisper
        ? { onToken: (token: string) => this.emitToken(token, 'transcription') }
        : undefined;
      const { text: transcription, stderr: whisperStderr } = await this.getTranscribeFn()(
        wavPath,
        {
          cliPath: cfg.whisperCliPath,
          modelPath: cfg.whisperModelPath,
        },
        transcribeOpts,
      );
      timings.transcribeMs = Date.now() - tStart;
      session.writeTranscription(transcription);
      writeFileSync(path.join(session.dir, 'whisper-stderr.log'), whisperStderr, 'utf8');
      if (cfg.logMode !== 'full') rmSync(wavPath, { force: true });
      transientWavPath = null;
      console.log(
        `[pipeline] transcription complete (${timings.transcribeMs} ms, ${transcription.length} chars)`,
      );

      if (!transcription) throw new NoSpeechError();

      // Context capture started with the recording and has been running in
      // parallel with whisper; it is almost always ready by now.
      const ctx = opts.context ? await opts.context : null;
      this.lastTranscription = transcription;
      this.lastContext = ctx;
      this.lastContextDestination = destinationOf(provider);

      this.setStatus('refining-streaming');
      const { composed, activeSkillIds } = this.composeForDictation(opts.skillIds, ctx);
      session.writeSystemPrompt(composed);
      if (ctx?.block && cfg.logMode === 'full') session.writeContext(ctx.block);
      timings.activeSkills = activeSkillIds.join(',') || '(none)';
      if (ctx?.window) timings.app = ctx.window.processName;
      if (ctx?.images.length) timings.images = ctx.images.length;
      const rStart = Date.now();
      const { text: refined } = await provider.refineStream(
        {
          systemPrompt: composed,
          userPrompt: transcription,
          images: ctx?.images,
        },
        {
          onToken: (token) => {
            this.emitToken(token, 'refinement');
            if (injector) injector.pushToken(token);
          },
        },
      );
      timings.refineMs = Date.now() - rStart;
      session.writeRefined(refined);
      console.log(
        `[pipeline] refinement complete (${timings.refineMs} ms, ${refined.length} chars)`,
      );

      if (!refined) throw new Error(`${provider.config.displayName} returned empty refinement`);

      if (injector) {
        const iStart = Date.now();
        await injector.flush();
        timings.injectMs = Date.now() - iStart;
      } else if (shouldInject) {
        const injectFn = this.deps.inject;
        if (!injectFn) {
          throw new Error('inject is not configured');
        }
        this.setStatus('injecting');
        const iStart = Date.now();
        await injectFn(refined, {
          clipboardRestoreDelayMs: cfg.clipboardRestoreDelayMs,
          clipboardRetention: cfg.clipboardRetention,
          injectionMethod: cfg.injectionMethod,
        });
        timings.injectMs = Date.now() - iStart;
      }

      timings.totalMs = Date.now() - pipelineStart;
      session.writeTimings(timings);
      console.log(`[pipeline] done: total=${timings.totalMs}ms`);

      this.setStatus('done');
      return { text: refined, transcription, sessionDir: session.dir };
    } catch (err) {
      if (injector) injector.abort();
      if (cfg.logMode !== 'full' && transientWavPath) rmSync(transientWavPath, { force: true });
      timings.totalMs = Date.now() - pipelineStart;
      if (err instanceof NoSpeechError) {
        console.log('[pipeline] no speech detected, nothing to refine');
        timings.outcome = 'no-speech';
        session.writeTimings(timings);
        throw err;
      }
      console.error('[pipeline] error:', err);
      session.writeError(err);
      session.writeTimings(timings);
      this.setStatus('error');
      throw err;
    }
  }

  private async processBuffer(
    session: Session,
    buffer: ArrayBuffer,
    context: Promise<CapturedContext | null> = NO_CONTEXT,
  ): Promise<void> {
    this.cancelIdle();
    this.state = 'processing';

    try {
      await this.processPcm(buffer, { inject: true, context }, session);
      this.lastErrorSessionDir = null;
      this.lastErrorAudioBuffer = null;
      this.lastErrorContext = NO_CONTEXT;
      this.state = 'idle';
      if (this.continueWithNextCapture()) return;
      this.scheduleIdle();
    } catch (err) {
      this.state = 'idle';
      if (err instanceof NoSpeechError) {
        // Accidental tap or silence: nothing to retry, no error toast.
        if (this.continueWithNextCapture()) return;
        this.setStatus('idle');
        return;
      }
      this.lastErrorSessionDir = session.dir;
      this.lastErrorAudioBuffer = buffer.slice(0);
      this.lastErrorContextDestination = destinationOf(this.deps.provider);
      this.lastErrorContext = context;
      const message = err instanceof Error ? err.message : String(err);
      this.deps.getWindow?.()?.webContents.send(IPC_ERROR, {
        message,
        sessionDir: session.dir,
      } satisfies ErrorPayload);
      if (this.continueWithNextCapture()) return;
      this.scheduleIdle(2_500);
    }
  }

  /**
   * After a capture finishes processing: run the next queued capture, or — if
   * the user started a new capture while this one was processing and it is
   * still going — make that the live recording. Returns false when there is
   * nothing left to do. Before this, a capture that outlived the processing it
   * was queued behind had its audio dropped ("audio chunk without active
   * session") and left the pipeline looking busy forever.
   */
  private continueWithNextCapture(): boolean {
    if (this.audioQueue.length > 0) {
      this.processNextQueued();
      return true;
    }
    if (!this.backgroundSession) return false;

    const stopping = this.backgroundAudioTimeout !== null;
    if (this.backgroundAudioTimeout) {
      clearTimeout(this.backgroundAudioTimeout);
      this.backgroundAudioTimeout = null;
    }
    this.cancelIdle();
    this.state = 'recording';
    this.session = this.backgroundSession;
    this.sessionContext = this.backgroundContext;
    this.backgroundSession = null;
    this.backgroundContext = NO_CONTEXT;
    this.stopRequested = stopping;
    if (stopping) {
      // Renderer was already told to stop; its audio is on the way.
      this.audioTimeout = setTimeout(() => {
        if (this.state === 'recording') this.reset();
      }, AUDIO_TIMEOUT_MS);
    }
    this.setStatus('recording');
    return true;
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
    const session = createSession(this.deps.cfg.logsDir, this.deps.cfg.logMode);
    const processOpts: ProcessPcmOptions = {
      inject: opts.inject ?? false,
      skillIds: opts.skillIds,
      context: this.beginContext(),
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
    if (this.backgroundAudioTimeout) {
      clearTimeout(this.backgroundAudioTimeout);
      this.backgroundAudioTimeout = null;
    }

    if (this.state === 'processing' && this.backgroundSession) {
      const session = this.backgroundSession;
      const context = this.backgroundContext;
      this.backgroundSession = null;
      this.backgroundContext = NO_CONTEXT;
      if (buffer.byteLength > 0) {
        this.enqueue({ session, buffer, context });
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
    const context = this.sessionContext;
    this.session = null;
    this.sessionContext = NO_CONTEXT;
    await this.processBuffer(session, buffer, context);
  }

  async retry(): Promise<void> {
    if (this.state !== 'idle' || !this.lastErrorSessionDir) return;
    const sessionDir = this.lastErrorSessionDir;
    this.lastErrorSessionDir = null;

    if (this.lastErrorAudioBuffer) {
      const buffer = this.lastErrorAudioBuffer;
      const context = this.rerunContextLater(
        this.lastErrorContext,
        this.lastErrorContextDestination,
      );
      this.lastErrorAudioBuffer = null;
      this.lastErrorContext = NO_CONTEXT;
      const session = createSession(this.deps.cfg.logsDir, this.deps.cfg.logMode);
      this.state = 'processing';
      await this.processBuffer(session, buffer, context);
      return;
    }

    const wavPath = path.join(sessionDir, 'audio.wav');
    if (!existsSync(wavPath)) {
      console.warn('[pipeline] retry: audio.wav not found at', wavPath);
      return;
    }

    const wavBuf = readFileSync(wavPath);
    if (wavBuf.length < 44 || wavBuf.toString('ascii', 0, 4) !== 'RIFF') {
      console.warn('[pipeline] retry: invalid WAV file at', wavPath);
      return;
    }
    const dataSize = wavBuf.readUInt32LE(40);
    const pcmBuf = wavBuf.subarray(44, 44 + dataSize);
    const ab = pcmBuf.buffer.slice(pcmBuf.byteOffset, pcmBuf.byteOffset + pcmBuf.byteLength);

    const session = createSession(this.deps.cfg.logsDir, this.deps.cfg.logMode);
    this.state = 'processing';
    await this.processBuffer(session, ab);
  }
}
