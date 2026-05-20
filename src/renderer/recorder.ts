import { downsample, floatsToInt16PCM, TARGET_SAMPLE_RATE } from '../shared/pcm.js';

const BUFFER_SIZE = 4096;
const ANALYSER_FFT_SIZE = 256; // -> 128 frequency bins

interface CaptureState {
  stream: MediaStream;
  audioContext: AudioContext;
  processor: ScriptProcessorNode;
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

  const source = audioContext.createMediaStreamSource(stream);
  const processor = audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);
  const mute = audioContext.createGain();
  mute.gain.value = 0;
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = ANALYSER_FFT_SIZE;
  analyser.smoothingTimeConstant = 0.6;

  const chunks: Float32Array[] = [];
  processor.onaudioprocess = (e) => {
    chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  };

  source.connect(analyser);
  source.connect(processor);
  processor.connect(mute);
  mute.connect(audioContext.destination);

  state = {
    stream,
    audioContext,
    processor,
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

  captured.processor.disconnect();
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
