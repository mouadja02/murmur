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

window.murmur.onStartRecording(() => {
  console.log('[renderer] start-recording received');
});

window.murmur.onStopRecording(() => {
  console.log('[renderer] stop-recording received');
});

export {};
