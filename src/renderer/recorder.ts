// src/renderer/recorder.ts
import { downsample, floatsToInt16PCM, TARGET_SAMPLE_RATE } from '../shared/pcm.js';

const ANALYSER_FFT_SIZE = 256;

interface CaptureState {
  stream: MediaStream;
  audioContext: AudioContext;
  workletNode: AudioWorkletNode;
  mute: GainNode;
  analyser: AnalyserNode;
  freqBuffer: Uint8Array<ArrayBuffer>;
  chunks: Float32Array[];
  sourceSampleRate: number;
}

let state: CaptureState | null = null;

export async function startCapture(): Promise<void> {
  if (state) return;

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });

  let audioContext: AudioContext;
  try {
    audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
  } catch {
    audioContext = new AudioContext();
  }

  // Load the worklet module relative to this script's URL.
  const workletUrl = new URL('./recorder-worklet.js', import.meta.url);
  await audioContext.audioWorklet.addModule(workletUrl.href);

  const source = audioContext.createMediaStreamSource(stream);
  const workletNode = new AudioWorkletNode(audioContext, 'recorder-processor');
  const mute = audioContext.createGain();
  mute.gain.value = 0;
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = ANALYSER_FFT_SIZE;
  analyser.smoothingTimeConstant = 0.6;

  const chunks: Float32Array[] = [];
  workletNode.port.onmessage = (e: MessageEvent<Float32Array>) => {
    chunks.push(new Float32Array(e.data));
  };

  source.connect(analyser);
  source.connect(workletNode);
  workletNode.connect(mute);
  mute.connect(audioContext.destination);

  state = {
    stream,
    audioContext,
    workletNode,
    mute,
    analyser,
    freqBuffer: new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount)),
    chunks,
    sourceSampleRate: audioContext.sampleRate,
  };
}

export async function stopCapture(): Promise<ArrayBuffer> {
  if (!state) return new ArrayBuffer(0);
  const captured = state;
  state = null;

  captured.workletNode.port.onmessage = null;
  captured.workletNode.disconnect();
  captured.mute.disconnect();
  captured.analyser.disconnect();
  try {
    await captured.audioContext.close();
  } catch {
    /* ignore */
  }
  for (const track of captured.stream.getTracks()) track.stop();

  const raw = floatsToInt16PCM(captured.chunks);
  const pcm16k = downsample(raw, captured.sourceSampleRate, TARGET_SAMPLE_RATE);

  console.log(
    `[recorder] captured ${captured.chunks.length} chunks, ${raw.length} samples at ${captured.sourceSampleRate} Hz -> ${pcm16k.length} samples at ${TARGET_SAMPLE_RATE} Hz`,
  );

  const ab = new ArrayBuffer(pcm16k.byteLength);
  new Int16Array(ab).set(pcm16k);
  return ab;
}

export function isCapturing(): boolean {
  return state !== null;
}

/**
 * Reads the current frequency-domain data into the recorder's internal buffer
 * and returns it. Returns `null` when not capturing.
 */
export function readFrequencies(): Uint8Array<ArrayBuffer> | null {
  if (!state) return null;
  state.analyser.getByteFrequencyData(state.freqBuffer);
  return state.freqBuffer;
}
