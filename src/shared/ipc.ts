// main → renderer
export const IPC_STATUS = 'murmur:status';
export const IPC_START_RECORDING = 'murmur:start-recording';
export const IPC_STOP_RECORDING = 'murmur:stop-recording';
export const IPC_INFO = 'murmur:info';

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

export type Status =
  | 'idle'
  | 'recording'
  | 'transcribing'
  | 'refining'
  | 'injecting'
  | 'done'
  | 'error';

/**
 * Snapshot of public-safe runtime info that the renderer is allowed to see.
 * The api key is intentionally excluded.
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
}
