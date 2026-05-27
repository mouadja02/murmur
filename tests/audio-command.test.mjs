import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { splitCommandLine } from '../dist/main/audio/command.js';

describe('splitCommandLine', () => {
  it('splits simple command lines', () => {
    assert.deepEqual(splitCommandLine('arecord -q -f S16_LE'), ['arecord', '-q', '-f', 'S16_LE']);
  });

  it('preserves quoted arguments', () => {
    assert.deepEqual(splitCommandLine('"C:/Program Files/sox/sox.exe" -q -d'), [
      'C:/Program Files/sox/sox.exe',
      '-q',
      '-d',
    ]);
  });

  it('preserves unquoted Windows paths with backslashes', () => {
    assert.deepEqual(splitCommandLine('C:\\Program Files\\sox\\sox.exe -q'), [
      'C:\\Program Files\\sox\\sox.exe',
      '-q',
    ]);
  });

  it('supports escaped quotes inside quotes', () => {
    assert.deepEqual(splitCommandLine('cmd "a \\"quoted\\" value"'), ['cmd', 'a "quoted" value']);
  });

  it('rejects empty and unterminated commands', () => {
    assert.throws(() => splitCommandLine('   '), /empty/i);
    assert.throws(() => splitCommandLine('sox "unterminated'), /unterminated/i);
  });
});
