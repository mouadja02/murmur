import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC_AUDIO_CHUNK,
  IPC_START_RECORDING,
  IPC_STATUS,
  IPC_STOP_RECORDING,
} from '../shared/ipc.js';

contextBridge.exposeInMainWorld('murmur', {
  onStatus: (cb: (status: string) => void) => {
    ipcRenderer.on(IPC_STATUS, (_evt, status: string) => cb(status));
  },
  onStartRecording: (cb: () => void) => {
    ipcRenderer.on(IPC_START_RECORDING, () => cb());
  },
  onStopRecording: (cb: () => void) => {
    ipcRenderer.on(IPC_STOP_RECORDING, () => cb());
  },
  sendAudioChunk: (buffer: ArrayBuffer) => {
    ipcRenderer.send(IPC_AUDIO_CHUNK, buffer);
  },
});
