import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { splitCommandLine } from './command.js';

export interface AudioRecorder {
  start(): Promise<void>;
  stop(): Promise<ArrayBuffer>;
  /**
   * Registers a listener for the capture process ending on its own, before
   * `stop()` was called (device unplugged, SoX error). Not called for a stop
   * that `stop()` initiated or for a failed `start()`.
   */
  onUnexpectedExit?(listener: (err: Error) => void): void;
}

type RecorderChild = Pick<
  ChildProcessWithoutNullStreams,
  'stdout' | 'stderr' | 'kill' | 'once' | 'removeListener'
>;
type RecorderSpawn = (command: string, args: string[]) => RecorderChild;

export interface CommandAudioRecorderOptions {
  commandLine: string;
  spawnFn?: RecorderSpawn;
  /** Override stop signal (tests); default is platform-specific via {@link getRecorderStopSignal}. */
  stopSignal?: NodeJS.Signals | undefined;
}

/** Windows: default kill(); Unix: SIGINT for recorder processes. */
export function getRecorderStopSignal(): NodeJS.Signals | undefined {
  return process.platform === 'win32' ? undefined : 'SIGINT';
}

export function formatRecorderExitCode(code: number | null): string {
  if (code === null) return 'terminated by signal';
  return String(code);
}

export class CommandAudioRecorder implements AudioRecorder {
  private child: RecorderChild | null = null;
  private chunks: Buffer[] = [];
  private stderr = '';
  private closing: Promise<ArrayBuffer> | null = null;
  private closePromise: Promise<number | null> | null = null;
  private exited = false;
  private exitListener: ((err: Error) => void) | null = null;

  constructor(private readonly opts: CommandAudioRecorderOptions) {}

  onUnexpectedExit(listener: (err: Error) => void): void {
    this.exitListener = listener;
  }

  async start(): Promise<void> {
    if (this.child) throw new Error('recorder is already recording');
    const [cmd, ...args] = splitCommandLine(this.opts.commandLine);
    const spawnFn =
      this.opts.spawnFn ??
      ((command, spawnArgs) => spawn(command, spawnArgs, { windowsHide: true, shell: false }));
    const child = spawnFn(cmd, args);
    this.child = child;
    this.chunks = [];
    this.stderr = '';
    this.closing = null;
    this.exited = false;

    child.stdout.on('data', (chunk: Buffer) => {
      this.chunks.push(Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderr += chunk.toString();
    });

    this.closePromise = new Promise<number | null>((resolve) => {
      child.once('close', (code) => {
        this.exited = true;
        resolve(code);
        if (!this.closing && this.child === child) this.exitListener?.(this.exitError(code));
      });
    });

    await new Promise<void>((resolve, reject) => {
      const onSpawn = () => {
        child.removeListener('error', onError);
        resolve();
      };
      const onError = (err: Error) => {
        child.removeListener('spawn', onSpawn);
        this.resetAfterChildEnd();
        reject(err);
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    });
  }

  stop(): Promise<ArrayBuffer> {
    if (this.closing) return this.closing;
    if (!this.child || !this.closePromise) throw new Error('recorder is not recording');

    const child = this.child;
    const closePromise = this.closePromise;
    this.closing = closePromise.then((code) => this.finishFromClose(code));

    if (!this.exited) {
      const signal = this.opts.stopSignal ?? getRecorderStopSignal();
      child.kill(signal);
    }

    return this.closing;
  }

  private finishFromClose(code: number | null): ArrayBuffer {
    const pcm = Buffer.concat(this.chunks);
    this.resetAfterChildEnd();
    if (pcm.length === 0) {
      if (code !== 0) throw this.exitError(code);
      throw new Error('recorder produced no audio');
    }
    return pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
  }

  private exitError(code: number | null): Error {
    const exitLabel =
      code === null ? formatRecorderExitCode(code) : `code ${formatRecorderExitCode(code)}`;
    return new Error(`recorder exited with ${exitLabel}. stderr:\n${this.stderr}`);
  }

  private resetAfterChildEnd(): void {
    this.child = null;
    this.closePromise = null;
    this.closing = null;
    this.exited = false;
  }
}
