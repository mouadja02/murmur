export function splitCommandLine(input: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const ch of input.trim()) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === '\\') {
      if (quote) escaping = true;
      else current += ch;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        const winPath = /^[A-Za-z]:\\/.test(current);
        const winPathComplete = winPath && /\.(exe|cmd|bat|com)$/i.test(current);
        if (winPath && !winPathComplete) {
          current += ch;
        } else {
          out.push(current);
          current = '';
        }
      }
      continue;
    }
    current += ch;
  }

  if (escaping) current += '\\';
  if (quote) throw new Error('unterminated quoted recorder command');
  if (current) out.push(current);
  if (out.length === 0) throw new Error('empty recorder command');
  return out;
}
