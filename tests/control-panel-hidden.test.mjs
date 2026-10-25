import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const uiDir = new URL('../dist/main/control-panel/ui/', import.meta.url);
const css = readFileSync(new URL('style.css', uiDir), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const html = readFileSync(new URL('index.html', uiDir), 'utf8');

/** True when `selector` names the class/id exactly (not as a prefix of a longer name). */
function names(selector, sigil, name) {
  const token = sigil + name;
  for (let at = selector.indexOf(token); at !== -1; at = selector.indexOf(token, at + 1)) {
    if (!/[\w-]/.test(selector.charAt(at + token.length))) return true;
  }
  return false;
}

/** Plain `selector { declarations }` rules in source order (at-rule wrappers are skipped). */
function rules() {
  const out = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim();
    if (selector.startsWith('@')) continue;
    out.push({ selector, body: m[2] });
  }
  return out;
}

/** Elements the markup ships with `class="... hidden ..."`: the control panel shows them by removing it. */
function initiallyHidden() {
  const found = [];
  for (const m of html.matchAll(/<[a-z][^>]*\bclass="([^"]*)"[^>]*>/gi)) {
    const classes = m[1].split(/\s+/);
    if (!classes.includes('hidden')) continue;
    const id = /\bid="([^"]+)"/.exec(m[0])?.[1] ?? null;
    found.push({ id, classes: classes.filter((c) => c !== 'hidden') });
  }
  return found;
}

describe('control panel .hidden helper', () => {
  it('ships elements with the hidden class (so the check below is not vacuous)', () => {
    assert.ok(initiallyHidden().length >= 5);
  });

  it('actually hides every element that ships with it', () => {
    const all = rules();
    const hiddenRule = all.find((r) => r.selector === '.hidden');
    assert.ok(hiddenRule, 'a .hidden rule exists');
    // `!important` is the only way to beat both later class rules and `#id` rules.
    if (/display\s*:\s*none\s*!important/.test(hiddenRule.body)) return;

    const hiddenAt = all.indexOf(hiddenRule);
    const overridden = [];
    for (const el of initiallyHidden()) {
      all.forEach((rule, i) => {
        if (rule === hiddenRule || !/(^|[;\s])display\s*:/.test(rule.body)) return;
        for (const sel of rule.selector.split(',').map((s) => s.trim())) {
          const last = sel.split(/[\s>+~]+/).pop() ?? '';
          if (/\[hidden\]/.test(last)) continue;
          const byId = el.id !== null && names(last, '#', el.id);
          const byClass = el.classes.some((c) => names(last, '.', c)) && !last.includes('#');
          // An id selector outranks .hidden wherever it is; a class selector only wins when later.
          if (byId || (byClass && i > hiddenAt))
            overridden.push(`${el.id ?? el.classes[0]} <- ${sel}`);
        }
      });
    }
    assert.deepEqual(overridden, [], 'these rules set display on an element that should be hidden');
  });
});
