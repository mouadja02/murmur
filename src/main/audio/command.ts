/**
 * Splits a recorder command line into the executable and its arguments
 * (it is spawned without a shell).
 *
 * Quoting follows the Windows argument rules so that a quoted Windows path
 * keeps its backslashes (`"C:\Program Files\sox\sox.exe"`, `"\\host\share\sox.exe"`):
 * inside quotes, backslashes are literal unless a run of them ends at the
 * closing quote character. Then each pair is one backslash, and an odd one
 * left over makes that quote literal (`\"` -> `"`). Single quotes behave the
 * same with `'`. Outside quotes every backslash is literal.
 */
export function splitCommandLine(input: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  // A quoted token already says where it ends; the drive-path heuristic below is
  // only for unquoted paths with spaces.
  let tokenWasQuoted = false;
  const chars = [...input.trim()];

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (quote) {
      if (ch === '\\') {
        let run = 1;
        while (chars[i + run] === '\\') run++;
        if (chars[i + run] === quote) {
          current += '\\'.repeat(Math.floor(run / 2));
          if (run % 2 === 1) {
            current += quote;
            i += run; // the escaped quote is consumed too
          } else {
            i += run - 1; // the quote is processed next and closes the argument
          }
        } else {
          current += '\\'.repeat(run);
          i += run - 1;
        }
        continue;
      }
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      tokenWasQuoted = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        const winPath = !tokenWasQuoted && /^[A-Za-z]:\\/.test(current);
        const winPathComplete = winPath && /\.(exe|cmd|bat|com)$/i.test(current);
        if (winPath && !winPathComplete) {
          current += ch;
        } else {
          out.push(current);
          current = '';
          tokenWasQuoted = false;
        }
      }
      continue;
    }
    current += ch;
  }

  if (quote) throw new Error('unterminated quoted recorder command');
  if (current) out.push(current);
  if (out.length === 0) throw new Error('empty recorder command');
  return out;
}

/**
 * What to tell the user when the recorder executable cannot be found. Shared by
 * the `murmur serve` preflight and the spawn error that `murmur_record` returns,
 * which the overlay's MCP endpoint also uses.
 */
export function recorderNotFoundMessage(bin: string): string {
  return (
    `recorder command not found: ${bin}.\n` +
    `  Fix: install SoX on Windows/macOS or alsa-utils on Linux,\n` +
    `       or pass --recorder-command, or set MURMUR_RECORDER_COMMAND\n` +
    `       (config.json's recorderCommand, if present, takes precedence over the env var)`
  );
}
