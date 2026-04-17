import { contextBridge, ipcRenderer } from 'electron';
import {
  type InfoPayload,
  IPC_AUDIO_CHUNK,
  IPC_HIDE_OVERLAY,
  IPC_INFO,
  IPC_QUIT,
  IPC_REQUEST_INFO,
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
  quit: () => {
    ipcRenderer.send(IPC_QUIT);
  },
});
