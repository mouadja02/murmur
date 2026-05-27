import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import process from 'node:process';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { CommandAudioRecorder, getRecorderStopSignal } from '../dist/main/audio/recorder.js';

function fakeChild({ killEmitsClose = true } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killCalls = [];
  child.kill = (signal) => {
    child.killCalls.push(signal);
    if (killEmitsClose) child.emit('close', 0);
    return true;
  };
  return child;
}

function spawnWithEmit(child) {
  return (_cmd, _args) => {
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
}

describe('getRecorderStopSignal', () => {
  it('uses default kill on Windows and SIGINT elsewhere', () => {
    if (process.platform === 'win32') {
      assert.equal(getRecorderStopSignal(), undefined);
    } else {
      assert.equal(getRecorderStopSignal(), 'SIGINT');
    }
  });
});

describe('CommandAudioRecorder', () => {
  it('collects stdout PCM until stopped', async () => {
    const child = fakeChild();
    const spawned = [];
    const recorder = new CommandAudioRecorder({
      commandLine: 'recorder --raw',
      spawnFn: (cmd, args) => {
        spawned.push({ cmd, args });
        return spawnWithEmit(child)(cmd, args);
      },
    });

    await recorder.start();
    child.stdout.write(Buffer.from([1, 2, 3]));
    const out = Buffer.from(await recorder.stop());

    assert.deepEqual(spawned, [{ cmd: 'recorder', args: ['--raw'] }]);
    assert.deepEqual([...out], [1, 2, 3]);
    assert.equal(child.killCalls.length, 1);
    assert.equal(child.killCalls[0], getRecorderStopSignal());
  });

  it('settles when the child exits before stop is called', async () => {
    const child = fakeChild({ killEmitsClose: false });
    const recorder = new CommandAudioRecorder({
      commandLine: 'recorder --raw',
      spawnFn: spawnWithEmit(child),
    });

    await recorder.start();
    child.stdout.write(Buffer.from([4, 5]));
    child.emit('close', 0);

    const out = Buffer.from(await recorder.stop());
    assert.deepEqual([...out], [4, 5]);
    assert.equal(child.killCalls.length, 0);
  });

  it('rejects when the recorder exits before producing audio', async () => {
    const child = fakeChild();
    const recorder = new CommandAudioRecorder({
      commandLine: 'recorder --raw',
      spawnFn: spawnWithEmit(child),
    });

    await recorder.start();
    await assert.rejects(recorder.stop(), /no audio/i);
  });

  it('recovers from spawn error and allows restart', async () => {
    let attempts = 0;
    let activeChild = null;
    const recorder = new CommandAudioRecorder({
      commandLine: 'recorder --raw',
      spawnFn: () => {
        attempts++;
        const child = fakeChild();
        activeChild = child;
        if (attempts === 1) {
          queueMicrotask(() => child.emit('error', new Error('ENOENT')));
          return child;
        }
        queueMicrotask(() => child.emit('spawn'));
        return child;
      },
    });

    await assert.rejects(() => recorder.start(), /ENOENT/);
    await recorder.start();
    activeChild.stdout.write(Buffer.from([7]));
    const out = Buffer.from(await recorder.stop());
    assert.deepEqual([...out], [7]);
    assert.equal(attempts, 2);
  });

  it('rejects concurrent start calls', async () => {
    const child = fakeChild();
    const recorder = new CommandAudioRecorder({
      commandLine: 'recorder --raw',
      spawnFn: spawnWithEmit(child),
    });

    await recorder.start();
    await assert.rejects(() => recorder.start(), /already recording/i);
    child.stdout.write(Buffer.from([1]));
    await recorder.stop();
  });

  it('describes null exit codes without saying code null', async () => {
    const child = fakeChild({ killEmitsClose: false });
    const recorder = new CommandAudioRecorder({
      commandLine: 'recorder --raw',
      spawnFn: spawnWithEmit(child),
    });

    await recorder.start();
    child.stderr.write('device busy');
    child.emit('close', null);

    await assert.rejects(recorder.stop(), (err) => {
      assert.match(err.message, /terminated by signal/);
      assert.match(err.message, /device busy/);
      assert.doesNotMatch(err.message, /code null/i);
      return true;
    });
  });
});
