// src/renderer/recorder-worklet.ts
// Runs inside AudioWorkletGlobalScope. No external imports allowed.

// AudioWorkletProcessor and registerProcessor live in AudioWorkletGlobalScope,
// not in the standard lib.dom types — declare them here to satisfy tsc.
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>,
  ): boolean;
}
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;

class RecorderProcessor extends AudioWorkletProcessor {
  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0];
    if (channel && channel.length > 0) {
      // .slice(0) copies the buffer before this call returns and the engine reclaims it.
      this.port.postMessage(channel.slice(0));
    }
    return true; // returning false removes the processor
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
