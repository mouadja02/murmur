import { contextBridge, ipcRenderer } from 'electron';
import {
  type ErrorPayload,
  type InfoPayload,
  IPC_AUDIO_CHUNK,
  IPC_BEGIN_WINDOW_DRAG,
  IPC_END_WINDOW_DRAG,
  IPC_ERROR,
  IPC_HIDE_OVERLAY,
  IPC_INFO,
  IPC_INSERT_RAW,
  IPC_OPEN_CONTROL_PANEL,
  IPC_OPEN_LOG_DIR,
  IPC_QUEUE_DEPTH,
  IPC_QUIT,
  IPC_REFINE_LAST,
  IPC_REQUEST_INFO,
  IPC_RETRY,
  IPC_SET_MOUSE_INTERACTIVE,
  IPC_SHOW_CONTEXT_MENU,
  IPC_START_RECORDING,
  IPC_STATUS,
  IPC_STOP_RECORDING,
  IPC_TOGGLE_RECORDING,
  IPC_TOKEN,
  IPC_VAD_CONFIG,
  IPC_VAD_MODE,
  IPC_VAD_SILENCE_TIMEOUT,
  IPC_VAD_SPEECH_START,
  type Status,
  type TokenPayload,
  type VadConfigPayload,
  type VadModePayload,
} from '../shared/ipc.js';

contextBridge.exposeInMainWorld('murmur', {
  onStatus: (cb: (status: Status) => void) => {
    ipcRenderer.on(IPC_STATUS, (_evt, status: Status) => cb(status));
  },
  onStartRecording: (cb: () => void) => {
    ipcRenderer.on(IPC_START_RECORDING, () => cb());
  },
  onStopRecording: (cb: () => void) => {
    ipcRenderer.on(IPC_STOP_RECORDING, () => cb());
  },
  onInfo: (cb: (info: InfoPayload) => void) => {
    ipcRenderer.on(IPC_INFO, (_evt, info: InfoPayload) => cb(info));
  },
  onToken: (cb: (payload: TokenPayload) => void) => {
    ipcRenderer.on(IPC_TOKEN, (_evt, payload: TokenPayload) => cb(payload));
  },
  sendAudioChunk: (buffer: ArrayBuffer) => {
    ipcRenderer.send(IPC_AUDIO_CHUNK, buffer);
  },
  toggleRecording: () => {
    ipcRenderer.send(IPC_TOGGLE_RECORDING);
  },
  requestInfo: () => {
    ipcRenderer.send(IPC_REQUEST_INFO);
  },
  setMouseInteractive: (interactive: boolean) => {
    ipcRenderer.send(IPC_SET_MOUSE_INTERACTIVE, interactive);
  },
  hideOverlay: () => {
    ipcRenderer.send(IPC_HIDE_OVERLAY);
  },
  showContextMenu: () => {
    ipcRenderer.send(IPC_SHOW_CONTEXT_MENU);
  },
  beginWindowDrag: () => {
    ipcRenderer.send(IPC_BEGIN_WINDOW_DRAG);
  },
  endWindowDrag: () => {
    ipcRenderer.send(IPC_END_WINDOW_DRAG);
  },
  openControlPanel: () => {
    ipcRenderer.send(IPC_OPEN_CONTROL_PANEL);
  },
  quit: () => {
    ipcRenderer.send(IPC_QUIT);
  },
  onQueueDepth: (cb: (depth: number) => void) => {
    ipcRenderer.on(IPC_QUEUE_DEPTH, (_evt, depth: number) => cb(depth));
  },
  onError: (cb: (payload: ErrorPayload) => void) => {
    ipcRenderer.on(IPC_ERROR, (_evt, payload: ErrorPayload) => cb(payload));
  },
  retry: () => {
    ipcRenderer.send(IPC_RETRY);
  },
  insertRaw: () => {
    ipcRenderer.send(IPC_INSERT_RAW);
  },
  refineLast: () => {
    ipcRenderer.send(IPC_REFINE_LAST);
  },
  openLogDir: (dir: string) => {
    ipcRenderer.send(IPC_OPEN_LOG_DIR, dir);
  },
  onVadConfig: (cb: (cfg: VadConfigPayload) => void) => {
    ipcRenderer.on(IPC_VAD_CONFIG, (_evt, cfg: VadConfigPayload) => cb(cfg));
  },
  onVadMode: (cb: (mode: VadModePayload) => void) => {
    ipcRenderer.on(IPC_VAD_MODE, (_evt, mode: VadModePayload) => cb(mode));
  },
  vadSpeechStart: () => {
    ipcRenderer.send(IPC_VAD_SPEECH_START);
  },
  vadSilenceTimeout: () => {
    ipcRenderer.send(IPC_VAD_SILENCE_TIMEOUT);
  },
});
