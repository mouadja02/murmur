import { startCapture, stopCapture } from './recorder.js';

declare global {
  interface Window {
    murmur: {
      onStatus: (cb: (status: string) => void) => void;
      onStartRecording: (cb: () => void) => void;
      onStopRecording: (cb: () => void) => void;
      sendAudioChunk: (buffer: ArrayBuffer) => void;
    };
  }
}

const statusEl = document.getElementById('status');
if (!statusEl) throw new Error('status element missing');

window.murmur.onStatus((s) => {
  statusEl.textContent = s;
  statusEl.className = s;
});

window.murmur.onStartRecording(async () => {
  try {
    await startCapture();
  } catch (err) {
    console.error('[renderer] startCapture failed:', err);
  }
});

window.murmur.onStopRecording(async () => {
  try {
    const buf = await stopCapture();
    if (buf.byteLength > 0) {
      window.murmur.sendAudioChunk(buf);
    } else {
      console.warn('[renderer] stop called with no audio captured');
    }
  } catch (err) {
    console.error('[renderer] stopCapture failed:', err);
  }
});

export {};
