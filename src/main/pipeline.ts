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
import {
  type GuardedProgressiveInjector,
  guardProgressiveInjector,
  type ProgressiveInjector,
} from './progressive-inject.js';
import type { LlmProvider } from './providers/index.js';
import type { StopReason } from './providers/types.js';
import { composeSystemPrompt, loadSkills } from './skills.js';
import { type TranscribeResult, transcribe } from './transcribe.js';
import { buildWav } from './wav.js';

type PipelineState = 'idle' | 'recording' | 'processing';

const AUDIO_TIMEOUT_MS = 10_000;
const STATUS_LINGER_MS = 1_500;
/** Captures shorter than this are accidental hotkey taps, not prompts. */
const MIN_SPEECH_MS = 250;
/**
 * Longest headless (MCP) recording. Bounds the microphone-on time and the PCM
 * held in memory (~32 KB/s) when nothing ever calls stop.
 */
const DEFAULT_MAX_RECORD_MS = 5 * 60_000;
const RECORDING_CANCELLED = 'recording cancelled';
const CLIPBOARD_ONLY_NOTICE =
  'Copied to the clipboard instead of typing: an earlier attempt left part of this dictation in the target. Clear that text, then paste.';
const FOCUS_CHANGED_NOTICE =
  'Copied to the clipboard, not inserted: the active window changed since you started dictating. Click where you want it, then paste (Ctrl+V, or Cmd+V on macOS).';

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

/**
 * A dictation failed after its speech was transcribed. Carrying the words lets
 * the overlay offer "Insert raw" and MCP callers recover them instead of
 * re-speaking.
 */
export class DictationError extends Error {
  constructor(
    message: string,
    public readonly transcription: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'DictationError';
  }
}

/**
 * A provider returned text but explicitly said generation was incomplete.
 * Keeping this distinct from transport errors lets MCP callers inspect the
 * partial text and original transcription without treating it as success.
 */
export class IncompleteRefinementError extends DictationError {
  constructor(
    public readonly partialText: string,
    transcription: string,
    public readonly stopReason: Extract<StopReason, 'length' | 'aborted'>,
    public readonly sessionDir: string | undefined,
    public readonly copiedToClipboard: boolean,
  ) {
    super(
      `${stopReason === 'length' ? 'Refinement was cut off by the provider' : 'Refinement stream ended early'}; ` +
        (copiedToClipboard
          ? 'partial text was copied to the clipboard. '
          : 'partial text is available in the error result. ') +
        'The raw transcription is retained for retry.',
      transcription,
    );
    this.name = 'IncompleteRefinementError';
  }
}

/**
 * Progressive typing left some, but not all, of the prompt in the target. The
 * run is not a success: the text there is incomplete.
 */
export class PartialInsertionError extends DictationError {
  constructor(
    message: string,
    transcription: string,
    public readonly typedChars: number,
    public readonly copiedToClipboard: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, transcription, options);
    this.name = 'PartialInsertionError';
  }
}

export interface ProcessPcmResult {
  text: string;
  transcription: string;
  sessionDir: string;
  stopReason: StopReason;
  /** Headless recording only: capture was cut off at the maximum recording length. */
  stoppedAtLimit?: boolean;
}

export interface ProcessPcmOptions {
  inject?: boolean;
  /**
   * Copy the prompt to the clipboard instead of typing or pasting it. Used when
   * an earlier attempt already left part of the dictation in the target.
   */
  clipboardOnly?: boolean;
  skillIds?: string[];
  /** Context snapshotted when the capture started (resolved after whisper runs). */
  context?: Promise<CapturedContext | null>;
  /** Window that was in front when the capture started (see `focusChangePolicy`). */
  target?: Promise<string | null>;
}

/**
 * How a capture was started: held hotkey (`ptt`), pill click (`toggle`; VAD may
 * auto-stop it), or a toggle-mode hotkey press (`hotkey-toggle`; only the next
 * press ends it, so a thinking pause cannot cut a long dictation short).
 */
export type CaptureMode = 'ptt' | 'toggle' | 'hotkey-toggle';

export interface RefineTextOptions {
  skillIds?: string[];
}

export interface RecordOptions {
  durationMs?: number;
  inject?: boolean;
  skillIds?: string[];
  /**
   * Aborting while the microphone is open stops the recorder, discards the
   * audio and rejects the record. Once capture has stopped and processing has
   * begun, aborting no longer interrupts it.
   */
  signal?: AbortSignal;
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
  copyToClipboard?: (text: string) => Promise<void>;
  transcribeAudio?: typeof transcribe;
  createRecorder?: () => AudioRecorder;
  createProgressiveInjector?: () => ProgressiveInjector;
  whisperSupportsStreaming?: boolean;
  /** Snapshot active window / clipboard / screenshot when a capture starts. */
  captureContext?: () => Promise<CapturedContext | null>;
  /**
   * Opaque identity of the window in front right now, or null when it cannot
   * be told. Compared by equality only and never logged.
   */
  getForegroundWindow?: () => Promise<string | null>;
  /** Cap for headless `record()`; defaults to 5 minutes. */
  maxRecordMs?: number;
}

interface QueuedCapture {
  session: Session;
  buffer: ArrayBuffer;
  context: Promise<CapturedContext | null>;
  target: Promise<string | null>;
}

interface PendingHeadlessRecord {
  recorder: AudioRecorder;
  session: Session;
  processOpts: ProcessPcmOptions;
}

const NO_CONTEXT: Promise<CapturedContext | null> = Promise.resolve(null);
const NO_TARGET: Promise<string | null> = Promise.resolve(null);

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
  /** Words of the dictation behind the current error, for "Insert raw". */
  private lastErrorTranscription: string | null = null;
  /**
   * The latest insertion left part of a dictation in the target (typing stopped
   * or the stream failed mid-way). Re-running it must not type over that text.
   */
  private partialInsertion = false;
  private headlessRecorder: AudioRecorder | null = null;
  private pendingHeadless: PendingHeadlessRecord | null = null;
  private recordStopTimer: NodeJS.Timeout | null = null;
  private pendingHeadlessResolve: ((v: ProcessPcmResult) => void) | null = null;
  private pendingHeadlessReject: ((err: unknown) => void) | null = null;
  /** Set once the headless recorder was told to stop; cancellation no longer applies. */
  private headlessFinishing = false;
  private tokenListeners = new Set<(token: string, phase: TokenPhase) => void>();
  private lastTranscription: string | null = null;
  private lastContext: CapturedContext | null = null;
  private lastContextDestination = '';
  private lastErrorContext: Promise<CapturedContext | null> = NO_CONTEXT;
  private lastErrorContextDestination = '';
  private sessionContext: Promise<CapturedContext | null> = NO_CONTEXT;
  private backgroundContext: Promise<CapturedContext | null> = NO_CONTEXT;
  /** Front window when the live / background capture started, per session. */
  private sessionTarget: Promise<string | null> = NO_TARGET;
  private backgroundTarget: Promise<string | null> = NO_TARGET;
  private currentStatus: Status = 'idle';
  private statusBeforeQueueFull: Status = 'idle';
  private stopRequested = false;

  private async rejectIncompleteRefinement(
    response: { text: string; stopReason?: StopReason },
    transcription: string,
    opts: { sessionDir?: string; copyToClipboard: boolean },
  ): Promise<never> {
    const stopReason = response.stopReason;
    if (stopReason !== 'length' && stopReason !== 'aborted') {
      throw new Error('rejectIncompleteRefinement called for a complete response');
    }

    let copiedToClipboard = false;
    if (opts.copyToClipboard && response.text && this.deps.copyToClipboard) {
      try {
        await this.deps.copyToClipboard(response.text);
        copiedToClipboard = true;
      } catch (err) {
        console.warn('[pipeline] could not copy partial refinement to clipboard:', err);
      }
    }
    throw new IncompleteRefinementError(
      response.text,
      transcription,
      stopReason,
      opts.sessionDir,
      copiedToClipboard,
    );
  }

  /** Copies `text` for the user to paste by hand; throws if that is not possible. */
  private async copyForPaste(text: string): Promise<void> {
    const copy = this.deps.copyToClipboard;
    if (!copy) throw new Error('the clipboard is unavailable');
    await copy(text);
  }

  private async tryCopy(text: string): Promise<boolean> {
    try {
      await this.copyForPaste(text);
      return true;
    } catch (err) {
      console.warn('[pipeline] could not copy to clipboard:', err);
      return false;
    }
  }

  /**
   * Stops progressive typing and works out what a failed run should report.
   * Typing is awaited first, so nothing lands in the target after the error is
   * shown. If text already reached the target, the run is remembered as a
   * partial insertion (so Retry / Refine last copy instead of typing it again)
   * and the error says so.
   */
  private async failureAfterTyping(
    err: unknown,
    injector: ProgressiveInjector | null,
    transcription: string | null,
    timings: Record<string, number | string>,
  ): Promise<unknown> {
    const typing = injector ? await injector.abort() : null;
    const partial = typing !== null && (typing.typed.length > 0 || typing.failed);
    if (partial) {
      this.partialInsertion = true;
      timings.outcome = 'partial-insert';
      timings.typedChars = typing.typed.length;
    }
    if (err instanceof DictationError) return err;
    if (partial && transcription !== null) {
      const reason = err instanceof Error ? err.message : String(err);
      return new PartialInsertionError(
        `${reason}. ${typing.typed.length} characters were already typed into the target; ` +
          'Retry will copy the prompt to the clipboard instead of typing it again.',
        transcription,
        typing.typed.length,
        false,
        { cause: err },
      );
    }
    if (transcription !== null) {
      return new DictationError(err instanceof Error ? err.message : String(err), transcription, {
        cause: err,
      });
    }
    return err;
  }

  /**
   * Puts a finished prompt where the user will use it. Progressive typing that
   * stopped early is an error, not a success: the target holds only part of the
   * prompt, so the whole prompt goes to the clipboard.
   */
  private async deliverRefined(
    refined: string,
    how: {
      injector: ProgressiveInjector | null;
      /** `injector` with the window check; refused means nothing was typed. */
      guarded?: GuardedProgressiveInjector | null;
      /** Window the capture started in; unset for re-runs, which have no capture. */
      target?: Promise<string | null>;
      clipboardOnly: boolean;
      inject: boolean;
    },
    transcription: string,
    timings: Record<string, number | string>,
  ): Promise<'inserted' | 'copied' | 'copied-focus' | 'skipped'> {
    const { cfg } = this.deps;
    const start = Date.now();
    if (how.clipboardOnly) {
      this.setStatus('injecting');
      await this.copyForPaste(refined);
      timings.injectMs = Date.now() - start;
      return 'copied';
    }
    if (how.injector) {
      const typing = await how.injector.flush();
      if (how.guarded?.blocked()) {
        // The user moved to another window before the first keystroke: nothing
        // was typed there, so the whole prompt is safe to hand over by clipboard.
        this.setStatus('injecting');
        await this.copyForPaste(refined);
        timings.injectMs = Date.now() - start;
        timings.focusChanged = 1;
        return 'copied-focus';
      }
      timings.injectMs = Date.now() - start;
      if (typing.failed) {
        const copied = await this.tryCopy(refined);
        const typedChars = typing.typed.length;
        throw new PartialInsertionError(
          (typedChars > 0
            ? `Typing stopped after ${typedChars} characters.`
            : 'Typing stopped before any text reached the target.') +
            (copied
              ? ' The full prompt was copied to the clipboard; clear the partial text and paste it.'
              : ' The prompt could not be copied to the clipboard, so use Retry.'),
          transcription,
          typedChars,
          copied,
          { cause: typing.error },
        );
      }
      return 'inserted';
    }
    if (!how.inject) return 'skipped';
    const injectFn = this.deps.inject;
    if (!injectFn) throw new Error('inject is not configured');
    if (how.target && (await this.focusMoved(how.target))) {
      this.setStatus('injecting');
      await this.copyForPaste(refined);
      timings.injectMs = Date.now() - start;
      timings.focusChanged = 1;
      return 'copied-focus';
    }
    this.setStatus('injecting');
    await injectFn(refined, {
      clipboardRestoreDelayMs: cfg.clipboardRestoreDelayMs,
      clipboardRetention: cfg.clipboardRetention,
      injectionMethod: cfg.injectionMethod,
    });
    timings.injectMs = Date.now() - start;
    return 'inserted';
  }

  /** Tells the overlay about something that is not a failure (shown in the toast). */
  private sendNotice(message: string, sessionDir: string): void {
    const payload: ErrorPayload = { message, sessionDir, notice: true };
    this.deps.getWindow?.()?.webContents.send(IPC_ERROR, payload);
  }

  private sendError(err: unknown, sessionDir: string): void {
    const payload: ErrorPayload = {
      message: err instanceof Error ? err.message : String(err),
      sessionDir,
      canInsertRaw: this.lastErrorTranscription !== null,
    };
    if (err instanceof IncompleteRefinementError) {
      payload.partialText = err.partialText;
      payload.transcription = err.transcription;
      payload.stopReason = err.stopReason;
      payload.copiedToClipboard = err.copiedToClipboard;
    }
    this.deps.getWindow?.()?.webContents.send(IPC_ERROR, payload);
  }

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
   * Note which window is in front for a capture that is beginning now. Skipped
   * (null) when the policy is `paste`, and never rejects: a window that cannot
   * be identified simply means no check later.
   */
  private beginTarget(): Promise<string | null> {
    const query = this.deps.getForegroundWindow;
    if (!query || this.deps.cfg.focusChangePolicy !== 'copy') return NO_TARGET;
    return query().catch((err) => {
      console.warn('[pipeline] could not identify the active window (not guarding):', err);
      return null;
    });
  }

  /**
   * True when the window in front now differs from the one a capture started
   * in. Only a positively different identity counts: if either side is unknown
   * the answer is false, so a platform that cannot tell windows apart behaves
   * as before.
   */
  private async focusMoved(target: Promise<string | null>): Promise<boolean> {
    const query = this.deps.getForegroundWindow;
    if (!query || this.deps.cfg.focusChangePolicy !== 'copy') return false;
    const startedIn = await target;
    if (startedIn === null) return false;
    try {
      const now = await query();
      return now !== null && now !== startedIn;
    } catch (err) {
      console.warn('[pipeline] could not identify the active window (not guarding):', err);
      return false;
    }
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
    this.lastErrorTranscription = prev.lastErrorTranscription;
    this.partialInsertion = prev.partialInsertion;
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

  /** The current error came from a dictation whose words can still be inserted. */
  canInsertRaw(): boolean {
    return this.lastErrorTranscription !== null && !this.isBusy();
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
    this.processBuffer(next.session, next.buffer, next.context, false, next.target).catch((err) => {
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
    this.sessionTarget = this.beginTarget();
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

  toggle(mode: Exclude<CaptureMode, 'ptt'> = 'toggle'): void {
    if (this.hasHeadlessPending()) return;
    if (this.state === 'idle') {
      this.start(mode);
    } else if (this.state === 'recording') {
      this.stop();
    } else if (this.state === 'processing') {
      if (this.backgroundSession === null) {
        this.backgroundSession = createSession(this.deps.cfg.logsDir, this.deps.cfg.logMode);
        this.backgroundContext = this.beginContext();
        this.backgroundTarget = this.beginTarget();
        this.requestRendererStart(mode === 'toggle');
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
      this.backgroundTarget = NO_TARGET;
      this.backgroundAudioTimeout = null;
    }, AUDIO_TIMEOUT_MS);
  }

  private reset(): void {
    this.state = 'idle';
    this.session = null;
    this.sessionContext = NO_CONTEXT;
    this.sessionTarget = NO_TARGET;
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
    this.backgroundTarget = NO_TARGET;
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
    this.headlessFinishing = false;
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
    const response = await provider.refine({
      systemPrompt: composed,
      userPrompt: text,
    });
    const refined = response.text;
    if (response.stopReason === 'length' || response.stopReason === 'aborted') {
      // Callers get the partial text in the error; an MCP call must not
      // overwrite the user's clipboard as a side effect.
      await this.rejectIncompleteRefinement(response, text, { copyToClipboard: false });
    }
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
    // Text from an earlier attempt may still sit in the target: copy, don't type.
    const clipboardOnly = this.partialInsertion;
    const useProgressive =
      !clipboardOnly && cfg.progressiveInjection && !!this.deps.createProgressiveInjector;
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
      const response = await provider.refineStream(
        {
          systemPrompt: composed,
          userPrompt: transcription,
          images: ctx?.images,
        },
        {
          onToken: (token) => {
            this.emitToken(token, 'refinement');
            // Progressive injection is opt-in: typing as tokens arrive is its
            // whole point. A truncated stream is still rejected below.
            if (injector) injector.pushToken(token);
          },
        },
      );
      const refined = response.text;
      const stopReason = response.stopReason ?? 'end';
      timings.refineMs = Date.now() - rStart;
      timings.stopReason = stopReason;
      session.writeRefined(refined);

      if (stopReason === 'length' || stopReason === 'aborted') {
        await this.rejectIncompleteRefinement(response, transcription, {
          sessionDir: session.dir,
          copyToClipboard: true,
        });
      }

      if (!refined) throw new Error(`${provider.config.displayName} returned empty refinement`);

      const delivered = await this.deliverRefined(
        refined,
        { injector, clipboardOnly, inject: !!this.deps.inject },
        transcription,
        timings,
      );
      if (delivered !== 'skipped') this.partialInsertion = false;
      this.lastErrorTranscription = null;

      timings.totalMs = Date.now() - pipelineStart;
      session.writeTimings(timings);
      this.state = 'idle';
      this.setStatus('done');
      if (delivered === 'copied') this.sendNotice(CLIPBOARD_ONLY_NOTICE, session.dir);
      this.scheduleIdle();
      return refined;
    } catch (err) {
      const failure = await this.failureAfterTyping(err, injector, transcription, timings);
      console.error('[pipeline] refineLast error:', err);
      session.writeError(failure);
      timings.totalMs = Date.now() - pipelineStart;
      session.writeTimings(timings);
      this.lastErrorTranscription = transcription;
      this.state = 'idle';
      this.setStatus('error');
      this.sendError(failure, session.dir);
      this.scheduleIdle(2_500);
      throw failure;
    }
  }

  async processPcm(
    buffer: ArrayBuffer | Buffer,
    opts: ProcessPcmOptions = {},
    existingSession?: Session | null,
  ): Promise<ProcessPcmResult> {
    const { cfg, provider } = this.deps;
    const shouldInject = opts.inject ?? true;
    const clipboardOnly = shouldInject && (opts.clipboardOnly ?? false);
    const useProgressive =
      shouldInject &&
      !clipboardOnly &&
      cfg.progressiveInjection &&
      !!this.deps.createProgressiveInjector;
    const canStreamWhisper = this.deps.whisperSupportsStreaming ?? true;
    const session = existingSession ?? createSession(cfg.logsDir, cfg.logMode);
    const timings: Record<string, number | string> = { provider: provider.config.id };
    const pipelineStart = Date.now();
    let transientWavPath: string | null = null;
    let injector: ProgressiveInjector | null = null;
    let guarded: GuardedProgressiveInjector | null = null;
    let spoken: string | null = null;
    const target = opts.target ?? NO_TARGET;

    if (useProgressive) {
      const inner = this.deps.createProgressiveInjector?.() ?? null;
      // Typing begins with the first token, long before the run ends, so the
      // window check has to gate the first keystroke, not the final insert.
      if (inner) {
        guarded = guardProgressiveInjector(inner, async () => !(await this.focusMoved(target)));
        injector = guarded;
      }
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
      spoken = transcription;

      // Context capture started with the recording and has been running in
      // parallel with whisper; it is almost always ready by now.
      const ctx = opts.context ? await opts.context : null;
      this.lastTranscription = transcription;
      // A new dictation replaces the one whose partial text may sit in the
      // target. A copy-only re-run of that dictation keeps the warning.
      if (!clipboardOnly) this.partialInsertion = false;
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
      const response = await provider.refineStream(
        {
          systemPrompt: composed,
          userPrompt: transcription,
          images: ctx?.images,
        },
        {
          onToken: (token) => {
            this.emitToken(token, 'refinement');
            // Progressive injection is opt-in: typing as tokens arrive is its
            // whole point. A truncated stream is still rejected below.
            if (injector) injector.pushToken(token);
          },
        },
      );
      const refined = response.text;
      const stopReason = response.stopReason ?? 'end';
      timings.refineMs = Date.now() - rStart;
      timings.stopReason = stopReason;
      session.writeRefined(refined);
      console.log(
        `[pipeline] refinement complete (${timings.refineMs} ms, ${refined.length} chars)`,
      );

      if (stopReason === 'length' || stopReason === 'aborted') {
        await this.rejectIncompleteRefinement(response, transcription, {
          sessionDir: session.dir,
          copyToClipboard: shouldInject,
        });
      }

      if (!refined) throw new Error(`${provider.config.displayName} returned empty refinement`);

      const delivered = await this.deliverRefined(
        refined,
        { injector, guarded, target, clipboardOnly, inject: shouldInject },
        transcription,
        timings,
      );
      if (delivered !== 'skipped') this.partialInsertion = false;

      timings.totalMs = Date.now() - pipelineStart;
      session.writeTimings(timings);
      console.log(`[pipeline] done: total=${timings.totalMs}ms`);

      this.setStatus('done');
      if (delivered === 'copied') this.sendNotice(CLIPBOARD_ONLY_NOTICE, session.dir);
      if (delivered === 'copied-focus') this.sendNotice(FOCUS_CHANGED_NOTICE, session.dir);
      return { text: refined, transcription, sessionDir: session.dir, stopReason };
    } catch (err) {
      const typingFailure = await this.failureAfterTyping(err, injector, spoken, timings);
      if (cfg.logMode !== 'full' && transientWavPath) rmSync(transientWavPath, { force: true });
      timings.totalMs = Date.now() - pipelineStart;
      if (err instanceof NoSpeechError) {
        console.log('[pipeline] no speech detected, nothing to refine');
        timings.outcome = 'no-speech';
        session.writeTimings(timings);
        throw err;
      }
      console.error('[pipeline] error:', err);
      session.writeError(typingFailure);
      session.writeTimings(timings);
      this.setStatus('error');
      throw typingFailure;
    }
  }

  private async processBuffer(
    session: Session,
    buffer: ArrayBuffer,
    context: Promise<CapturedContext | null> = NO_CONTEXT,
    clipboardOnly = false,
    target: Promise<string | null> = NO_TARGET,
  ): Promise<void> {
    this.cancelIdle();
    this.state = 'processing';

    try {
      await this.processPcm(buffer, { inject: true, context, clipboardOnly, target }, session);
      this.lastErrorSessionDir = null;
      this.lastErrorTranscription = null;
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
      this.lastErrorTranscription = err instanceof DictationError ? err.transcription : null;
      this.lastErrorAudioBuffer = buffer.slice(0);
      this.lastErrorContextDestination = destinationOf(this.deps.provider);
      this.lastErrorContext = context;
      this.sendError(err, session.dir);
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
    this.sessionTarget = this.backgroundTarget;
    this.backgroundSession = null;
    this.backgroundContext = NO_CONTEXT;
    this.backgroundTarget = NO_TARGET;
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
    if (opts.inject && !this.deps.inject) {
      throw new Error(
        'injection is unavailable: this Murmur instance has no text inserter (headless serve mode)',
      );
    }
    if (this.hasHeadlessPending() || this.state !== 'idle') {
      throw new Error('recording already in progress');
    }
    const createRecorder = this.deps.createRecorder;
    if (!createRecorder) {
      throw new Error('createRecorder is not configured');
    }
    const signal = opts.signal;
    if (signal?.aborted) throw new Error(RECORDING_CANCELLED);

    const recorder = createRecorder();
    const session = createSession(this.deps.cfg.logsDir, this.deps.cfg.logMode);
    const processOpts: ProcessPcmOptions = {
      inject: opts.inject ?? false,
      skillIds: opts.skillIds,
      context: this.beginContext(),
      target: opts.inject ? this.beginTarget() : NO_TARGET,
    };

    const done = new Promise<ProcessPcmResult>((resolve, reject) => {
      this.pendingHeadlessResolve = resolve;
      this.pendingHeadlessReject = reject;
    });
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

    if (signal?.aborted) {
      this.cancelHeadlessRecording(recorder);
      return done;
    }
    recorder.onUnexpectedExit?.((err) => this.failHeadlessRecording(recorder, err));

    const maxMs = this.deps.maxRecordMs ?? DEFAULT_MAX_RECORD_MS;
    const requestedMs = opts.durationMs ?? Number.POSITIVE_INFINITY;
    const atLimit = requestedMs > maxMs;
    this.recordStopTimer = setTimeout(
      () => {
        this.recordStopTimer = null;
        if (atLimit) console.warn(`[pipeline] headless recording reached the ${maxMs} ms limit`);
        // A failure reaches the caller through `done`.
        this.finishHeadlessRecord({ atLimit }).catch(() => undefined);
      },
      Math.min(requestedMs, maxMs),
    );

    if (!signal) return done;
    const onAbort = () => this.cancelHeadlessRecording(recorder);
    signal.addEventListener('abort', onAbort, { once: true });
    return done.finally(() => signal.removeEventListener('abort', onAbort));
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

  /**
   * Stops the microphone and drops the audio of a headless recording whose
   * caller is gone. No-op once the recorder was told to stop (processing then
   * runs to completion) or if `recorder` is no longer the active one.
   */
  private cancelHeadlessRecording(recorder: AudioRecorder): void {
    if (this.pendingHeadless?.recorder !== recorder || this.headlessFinishing) return;
    const rejectPending = this.pendingHeadlessReject;
    const { session } = this.pendingHeadless;
    console.warn('[pipeline] headless recording cancelled by its caller');
    this.abortHeadlessRecording();
    // Stopping ends the capture process; the buffered audio is dropped.
    void Promise.resolve()
      .then(() => recorder.stop())
      .catch(() => undefined);
    rejectPending?.(new Error(RECORDING_CANCELLED));
    this.writeOutcome(session, 'cancelled');
  }

  /** The recorder process ended on its own while a caller was still waiting. */
  private failHeadlessRecording(recorder: AudioRecorder, err: Error): void {
    if (this.pendingHeadless?.recorder !== recorder || this.headlessFinishing) return;
    const rejectPending = this.pendingHeadlessReject;
    const { session } = this.pendingHeadless;
    this.abortHeadlessRecording(err);
    rejectPending?.(err);
    session.writeError(err);
    this.writeOutcome(session, 'recorder-exited');
  }

  /** Leaves a metadata-only note in a session that ended before any processing. */
  private writeOutcome(session: Session, outcome: string): void {
    try {
      session.writeTimings({ outcome });
    } catch (err) {
      console.warn('[pipeline] could not write session timings:', err);
    }
  }

  private async finishHeadlessRecord(opts: { atLimit?: boolean } = {}): Promise<ProcessPcmResult> {
    const pending = this.pendingHeadless;
    if (!pending || this.headlessFinishing) {
      throw new Error('no active recording');
    }
    this.headlessFinishing = true;
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
      const processed = await this.processPcm(buffer, processOpts, session);
      const result = opts.atLimit ? { ...processed, stoppedAtLimit: true } : processed;
      this.state = 'idle';
      this.headlessFinishing = false;
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
      const target = this.backgroundTarget;
      this.backgroundSession = null;
      this.backgroundContext = NO_CONTEXT;
      this.backgroundTarget = NO_TARGET;
      if (buffer.byteLength > 0) {
        this.enqueue({ session, buffer, context, target });
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
    const target = this.sessionTarget;
    this.session = null;
    this.sessionContext = NO_CONTEXT;
    this.sessionTarget = NO_TARGET;
    await this.processBuffer(session, buffer, context, false, target);
  }

  async retry(): Promise<void> {
    if (this.state !== 'idle' || !this.lastErrorSessionDir) return;
    const sessionDir = this.lastErrorSessionDir;
    this.lastErrorSessionDir = null;
    // Text from the failed attempt may still sit in the target: copy, don't type.
    const clipboardOnly = this.partialInsertion;

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
      await this.processBuffer(session, buffer, context, clipboardOnly);
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
    await this.processBuffer(session, ab, NO_CONTEXT, clipboardOnly);
  }

  /**
   * Insert the words the user actually spoke when refinement (or insertion of
   * the refined text) failed. No provider call. When part of the dictation is
   * already in the target, or insertion itself fails, the text goes to the
   * clipboard instead.
   */
  async insertRaw(): Promise<void> {
    const transcription = this.lastErrorTranscription;
    if (transcription === null) throw new Error('no transcription to insert');
    if (this.isBusy()) throw new Error('pipeline is busy');

    const { cfg } = this.deps;
    const sessionDir = this.lastErrorSessionDir ?? '';
    const clipboardOnly = this.partialInsertion;
    this.cancelIdle();
    this.state = 'processing';
    try {
      if (clipboardOnly) {
        await this.copyForPaste(transcription);
      } else {
        const injectFn = this.deps.inject;
        if (!injectFn) throw new Error('inject is not configured');
        this.setStatus('injecting');
        try {
          await injectFn(transcription, {
            clipboardRestoreDelayMs: cfg.clipboardRestoreDelayMs,
            clipboardRetention: cfg.clipboardRetention,
            injectionMethod: cfg.injectionMethod,
          });
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          const copied = await this.tryCopy(transcription);
          throw new Error(
            copied
              ? `${reason}. The raw transcription was copied to the clipboard instead.`
              : reason,
            { cause: err },
          );
        }
      }
    } catch (err) {
      console.error('[pipeline] insertRaw error:', err);
      this.state = 'idle';
      this.setStatus('error');
      this.sendError(err, sessionDir);
      this.scheduleIdle(2_500);
      throw err;
    }
    this.lastErrorTranscription = null;
    this.partialInsertion = false;
    this.state = 'idle';
    this.setStatus('done');
    if (clipboardOnly) this.sendNotice(CLIPBOARD_ONLY_NOTICE, sessionDir);
    this.scheduleIdle();
  }
}
