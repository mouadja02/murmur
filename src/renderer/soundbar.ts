import { readFrequencies } from './recorder.js';

const BAR_COUNT = 18;
/**
 * Range of frequency bins to visualise. With fftSize=256 and sampleRate=16000,
 * each bin spans 16000/256 = 62.5 Hz. Bins 1..50 cover ~62 Hz to 3.1 kHz, the
 * meat of human speech.
 */
const BIN_START = 1;
const BIN_END = 50;
const MIN_HEIGHT = 0.08;
const DECAY = 0.85;

export interface SoundbarController {
  start(): void;
  stop(): void;
}

export function createSoundbar(container: HTMLElement): SoundbarController {
  container.innerHTML = '';
  const bars: HTMLDivElement[] = [];
  const heights: number[] = new Array(BAR_COUNT).fill(MIN_HEIGHT);

  for (let i = 0; i < BAR_COUNT; i++) {
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.transform = `scaleY(${MIN_HEIGHT})`;
    container.appendChild(bar);
    bars.push(bar);
  }

  let raf: number | null = null;
  let running = false;

  function frame(): void {
    if (!running) return;
    const freq = readFrequencies();
    if (freq) {
      const range = BIN_END - BIN_START;
      const binsPerBar = range / BAR_COUNT;
      for (let i = 0; i < BAR_COUNT; i++) {
        const from = BIN_START + Math.floor(i * binsPerBar);
        const to = BIN_START + Math.floor((i + 1) * binsPerBar);
        let sum = 0;
        let count = 0;
        for (let j = from; j < to && j < freq.length; j++) {
          sum += freq[j] ?? 0;
          count++;
        }
        const avg = count > 0 ? sum / count / 255 : 0;
        const next = Math.max(MIN_HEIGHT, avg);
        heights[i] = Math.max(next, (heights[i] ?? MIN_HEIGHT) * DECAY);
        bars[i]?.style.setProperty('transform', `scaleY(${heights[i]})`);
      }
    } else {
      for (let i = 0; i < BAR_COUNT; i++) {
        heights[i] = Math.max(MIN_HEIGHT, (heights[i] ?? MIN_HEIGHT) * DECAY);
        bars[i]?.style.setProperty('transform', `scaleY(${heights[i]})`);
      }
    }
    raf = requestAnimationFrame(frame);
  }

  return {
    start() {
      if (running) return;
      running = true;
      raf = requestAnimationFrame(frame);
    },
    stop() {
      running = false;
      if (raf !== null) cancelAnimationFrame(raf);
      raf = null;
      // Clear inline transforms so per-state CSS (done/error/etc.) wins.
      for (let i = 0; i < BAR_COUNT; i++) {
        heights[i] = MIN_HEIGHT;
        bars[i]?.style.removeProperty('transform');
      }
    },
  };
}
