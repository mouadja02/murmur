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
  IPC_OPEN_CONTROL_PANEL,
  IPC_OPEN_LOG_DIR,
  IPC_QUEUE_DEPTH,
  IPC_QUIT,
  IPC_REQUEST_INFO,
  IPC_RETRY,
  IPC_SET_MOUSE_INTERACTIVE,
  IPC_SHOW_CONTEXT_MENU,
  IPC_START_RECORDING,
  IPC_STATUS,
  IPC_STOP_RECORDING,
  IPC_TOGGLE_RECORDING,
  type Status,
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
  openLogDir: (dir: string) => {
    ipcRenderer.send(IPC_OPEN_LOG_DIR, dir);
  },
});
