import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

// The README's settings reference must list every key the config file accepts, with the CLI flag
// and environment variable that map to it. The key list is read from the `PartialConfig`
// interface; the flags and variables come from the real parsers, so a new setting that is not
// documented (or a documented flag that does not exist) fails here.

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const readme = read('README.md');
const schema = read('src/main/config/schema.ts');
const cliSource = read('src/main/config/cli.ts');
const configSource = read('src/main/config/index.ts');

/** Keys of `PartialConfig`, with `overlay` expanded to `overlay.<key>`. */
function partialConfigKeys() {
  const body = /export interface PartialConfig \{([\s\S]*?)\n\}/.exec(schema)?.[1];
  assert.ok(body, 'found the PartialConfig interface');
  const keys = [];
  let inOverlay = false;
  for (const line of body.split('\n')) {
    if (/^ {2}overlay\?: \{/.test(line)) {
      inOverlay = true;
      continue;
    }
    if (inOverlay && /^ {2}\};/.test(line)) {
      inOverlay = false;
      continue;
    }
    const m = /^ {2}(\w+)\?:/.exec(line);
    const nested = /^ {4}(\w+)\?:/.exec(line);
    if (inOverlay && nested) keys.push(`overlay.${nested[1]}`);
    else if (!inOverlay && m) keys.push(m[1]);
  }
  return keys;
}

/** Table rows of the settings reference, keyed by setting name. */
function referenceRows() {
  const rows = new Map();
  for (const line of readme.split('\n')) {
    const m = /^\| `([\w.]+)` \| (.*) \| (.*) \| (.*) \| (.*) \|$/.exec(line);
    if (m) rows.set(m[1], { cli: m[3], env: m[4] });
  }
  return rows;
}

describe('README settings reference', () => {
  const keys = partialConfigKeys();
  const rows = referenceRows();

  it('parses the schema', () => {
    assert.ok(keys.length > 30, `expected a full key list, got ${keys.length}`);
    assert.ok(keys.includes('overlay.anchor'));
  });

  it('lists every PartialConfig key', () => {
    const missing = keys.filter((k) => !rows.has(k));
    assert.deepEqual(missing, [], `README settings table is missing: ${missing.join(', ')}`);
  });

  it('lists nothing the config does not accept', () => {
    const extra = [...rows.keys()].filter((k) => !keys.includes(k));
    assert.deepEqual(extra, []);
  });

  it('documents only CLI flags the parser reads', () => {
    const parsed = new Set(
      [...cliSource.matchAll(/raw\['([\w-]+)'\]|raw\.(\w+)\b/g)].map((m) => m[1] ?? m[2]),
    );
    const wrong = [];
    for (const [key, { cli }] of rows)
      for (const flag of cli.matchAll(/`--([\w-]+)`/g))
        if (!parsed.has(flag[1])) wrong.push(`${key}: --${flag[1]}`);
    assert.deepEqual(wrong, []);
  });

  it('documents only environment variables the config reads', () => {
    const wrong = [];
    for (const [key, { env }] of rows)
      for (const name of env.matchAll(/`([A-Z][A-Z0-9_]+)`/g))
        if (!configSource.includes(name[1])) wrong.push(`${key}: ${name[1]}`);
    assert.deepEqual(wrong, []);
  });

  it('marks settings without a flag or variable as "none"', () => {
    // Every key with a documented flag must really be parsed, and vice versa for the keys the
    // parser maps: a key the CLI reads but the README calls "none" would be an undocumented flag.
    const undocumented = [];
    for (const [key, { cli }] of rows) {
      const leaf = key.split('.').pop();
      const flagForKey = new RegExp(
        `candidate\\.${key.replace('.', '\\.')}\\s*=|overlay\\.${leaf}\\s*=`,
      );
      if (cli === 'none' && flagForKey.test(cliSource)) undocumented.push(key);
    }
    assert.deepEqual(undocumented, []);
  });
});
