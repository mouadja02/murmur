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
    assert.deepEqual(splitCommandLine("cmd 'it\\'s'"), ['cmd', "it's"]);
  });

  // #77: the README sends Windows users to `--recorder-command` with the full
  // SoX path, which they quote because it contains spaces.
  it('keeps backslashes in a double-quoted Windows path', () => {
    assert.deepEqual(
      splitCommandLine('"C:\\Program Files (x86)\\sox-14-4-2\\sox.exe" -q -d -t raw -'),
      ['C:\\Program Files (x86)\\sox-14-4-2\\sox.exe', '-q', '-d', '-t', 'raw', '-'],
    );
  });

  it('keeps backslashes in a single-quoted Windows path', () => {
    assert.deepEqual(splitCommandLine("'C:\\Program Files (x86)\\sox-14-4-2\\sox.exe' -q"), [
      'C:\\Program Files (x86)\\sox-14-4-2\\sox.exe',
      '-q',
    ]);
  });

  it('resolves a quoted Windows path to the same executable as the unquoted form', () => {
    const unquoted = 'C:\\Program Files (x86)\\sox-14-4-2\\sox.exe -q';
    const quoted = '"C:\\Program Files (x86)\\sox-14-4-2\\sox.exe" -q';
    assert.deepEqual(splitCommandLine(quoted), splitCommandLine(unquoted));
  });

  it('ends a quoted Windows path at its closing quote, with or without an extension', () => {
    // The drive-path heuristic that joins words after C:\ applies to unquoted
    // paths only; a quoted one already says where it ends.
    assert.deepEqual(splitCommandLine('"C:\\tools\\sox\\rec" -q -t raw'), [
      'C:\\tools\\sox\\rec',
      '-q',
      '-t',
      'raw',
    ]);
  });

  it('keeps the leading double backslash of a quoted UNC path', () => {
    assert.deepEqual(splitCommandLine('"\\\\audio-host\\tools\\sox.exe" -q'), [
      '\\\\audio-host\\tools\\sox.exe',
      '-q',
    ]);
  });

  it('halves a backslash run that ends at the closing quote (Windows argv rule)', () => {
    // "C:\dir\\" -> C:\dir\ : the doubled backslash before the quote is one
    // literal backslash, and the quote still closes the argument.
    assert.deepEqual(splitCommandLine('rec "C:\\dir\\\\" -q'), ['rec', 'C:\\dir\\', '-q']);
    // Three backslashes before a quote: one literal backslash, then a literal quote.
    assert.deepEqual(splitCommandLine('rec "a\\\\\\"b"'), ['rec', 'a\\"b']);
  });

  it('rejects empty and unterminated commands', () => {
    assert.throws(() => splitCommandLine('   '), /empty/i);
    assert.throws(() => splitCommandLine('sox "unterminated'), /unterminated/i);
  });
});
