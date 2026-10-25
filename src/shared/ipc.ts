// main → renderer
export const IPC_STATUS = 'murmur:status';
export const IPC_START_RECORDING = 'murmur:start-recording';
export const IPC_STOP_RECORDING = 'murmur:stop-recording';
export const IPC_INFO = 'murmur:info';
export const IPC_TOKEN = 'murmur:token';
export const IPC_REFINE_LAST = 'murmur:refine-last';
export const IPC_VAD_CONFIG = 'murmur:vad-config';
export const IPC_VAD_MODE = 'murmur:vad-mode';

// renderer → main
export const IPC_AUDIO_CHUNK = 'murmur:audio-chunk';
export const IPC_TOGGLE_RECORDING = 'murmur:toggle-recording';
export const IPC_REQUEST_INFO = 'murmur:request-info';
export const IPC_SET_MOUSE_INTERACTIVE = 'murmur:set-mouse-interactive';
export const IPC_HIDE_OVERLAY = 'murmur:hide-overlay';
export const IPC_SHOW_CONTEXT_MENU = 'murmur:show-context-menu';
export const IPC_BEGIN_WINDOW_DRAG = 'murmur:begin-window-drag';
export const IPC_END_WINDOW_DRAG = 'murmur:end-window-drag';
export const IPC_OPEN_CONTROL_PANEL = 'murmur:open-control-panel';
export const IPC_QUIT = 'murmur:quit';
export const IPC_VAD_SPEECH_START = 'murmur:vad-speech-start';
export const IPC_VAD_SILENCE_TIMEOUT = 'murmur:vad-silence-timeout';
export const IPC_VAD_RMS = 'murmur:vad-rms';

// main → renderer
export const IPC_QUEUE_DEPTH = 'murmur:queue-depth'; // payload: number
export const IPC_ERROR = 'murmur:error'; // payload: ErrorPayload
// renderer → main
export const IPC_RETRY = 'murmur:retry';
export const IPC_INSERT_RAW = 'murmur:insert-raw';
export const IPC_OPEN_LOG_DIR = 'murmur:open-log-dir'; // payload: string

export type Status =
  | 'idle'
  | 'recording'
  | 'vad-listening'
  | 'transcribing'
  | 'transcribing-streaming'
  | 'refining'
  | 'refining-streaming'
  | 'injecting'
  | 'done'
  | 'error'
  | 'queue-full';

export type TokenPhase = 'transcription' | 'refinement';

export interface TokenPayload {
  token: string;
  phase: TokenPhase;
}

/**
 * Snapshot of public-safe runtime info that the renderer is allowed to see.
 * The api key is deliberately excluded.
 */
export interface InfoPayload {
  provider: string;
  providerDisplayName: string;
  baseUrl: string;
  model: string;
  hotkeyCombo: string;
  toggleHotkeyCombo: string;
  configFilePath: string;
  controlPanelUrl: string;
  progressiveInjection: boolean;
}

export interface ErrorPayload {
  message: string;
  sessionDir: string;
  partialText?: string;
  transcription?: string;
  stopReason?: 'length' | 'aborted';
  copiedToClipboard?: boolean;
  /** The words behind this error are still held, so "Insert raw" can use them. */
  canInsertRaw?: boolean;
  /** Informational, not a failure: no Retry / Insert raw. */
  notice?: boolean;
}

/** Sent right before IPC_START_RECORDING to say how this capture should end. */
export interface VadModePayload {
  /** true for click-to-record (stop on silence); false for push-to-talk. */
  autoStop: boolean;
}

export interface VadConfigPayload {
  enabled: boolean;
  thresholdDb: number;
  silenceMs: number;
  leadInMs: number;
}
