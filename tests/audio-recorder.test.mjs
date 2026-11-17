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

  it('reports a child that exits on its own, with its code and stderr', async () => {
    const child = fakeChild({ killEmitsClose: false });
    const recorder = new CommandAudioRecorder({
      commandLine: 'recorder --raw',
      spawnFn: spawnWithEmit(child),
    });
    const exits = [];
    recorder.onUnexpectedExit((err) => exits.push(err));

    await recorder.start();
    child.stderr.write('device unplugged');
    await new Promise((resolve) => setImmediate(resolve));
    child.emit('close', 2);

    assert.equal(exits.length, 1);
    assert.match(exits[0].message, /code 2/);
    assert.match(exits[0].message, /device unplugged/);
  });

  it('does not report an exit that stop() caused', async () => {
    const child = fakeChild();
    const recorder = new CommandAudioRecorder({
      commandLine: 'recorder --raw',
      spawnFn: spawnWithEmit(child),
    });
    const exits = [];
    recorder.onUnexpectedExit((err) => exits.push(err));

    await recorder.start();
    child.stdout.write(Buffer.from([1, 2]));
    await recorder.stop();

    assert.deepEqual(exits, []);
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

  // #78: the overlay's MCP endpoint spawns this recorder without a preflight
  // check, so a missing SoX used to surface as a bare "spawn sox ENOENT".
  it('names a missing recorder command and how to fix it (real spawn)', async () => {
    const missing = 'murmur-test-no-such-recorder-7f3c';
    const recorder = new CommandAudioRecorder({ commandLine: `${missing} -q -t raw -` });

    await assert.rejects(
      () => recorder.start(),
      (err) => {
        assert.match(err.message, new RegExp(`recorder command not found: ${missing}\\b`));
        assert.match(err.message, /install SoX/);
        assert.match(err.message, /--recorder-command/);
        assert.match(err.message, /MURMUR_RECORDER_COMMAND/);
        assert.match(err.message, /recorderCommand/);
        assert.equal(err.code, 'ENOENT');
        assert.equal(err.cause?.code, 'ENOENT');
        return true;
      },
    );
  });

  // #77 end to end: a quoted executable path (on Windows CI, node.exe under
  // "C:\Program Files\..." with backslashes and spaces) launches for real. The
  // fake recorder is Node itself, writing a few PCM bytes and exiting.
  it('launches a recorder given as a quoted full path (real spawn)', async () => {
    const script = 'process.stdout.write(Buffer.alloc(64, 1))';
    const recorder = new CommandAudioRecorder({
      commandLine: `"${process.execPath}" -e "${script}"`,
    });
    const exited = new Promise((resolve) => recorder.onUnexpectedExit(resolve));

    await recorder.start();
    await exited;
    const out = Buffer.from(await recorder.stop());

    assert.equal(out.length, 64);
  });

  it('passes other spawn errors through unchanged', async () => {
    const original = Object.assign(new Error('spawn recorder EACCES'), { code: 'EACCES' });
    const recorder = new CommandAudioRecorder({
      commandLine: 'recorder --raw',
      spawnFn: () => {
        const child = fakeChild();
        queueMicrotask(() => child.emit('error', original));
        return child;
      },
    });

    await assert.rejects(
      () => recorder.start(),
      (err) => err === original,
    );
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
