// src/shared/pcm.ts

export const TARGET_SAMPLE_RATE = 16_000;

export function floatsToInt16PCM(chunks: Float32Array[]): Int16Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Int16Array(total);
  let offset = 0;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) {
      const v = Math.max(-1, Math.min(1, c[i] ?? 0));
      out[offset++] = v < 0 ? v * 0x8000 : v * 0x7fff;
    }
  }
  return out;
}

export function downsample(input: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLength = Math.floor(input.length / ratio);
  const out = new Int16Array(outLength);
  for (let i = 0; i < outLength; i++) {
    out[i] = input[Math.floor(i * ratio)] ?? 0;
  }
  return out;
}
