import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { DEFAULT_SYSTEM_PROMPT } from '../dist/main/config/defaults.js';

describe('default refinement prompt', () => {
  it('does not force a Goal/Context/Constraints/Output format template', () => {
    assert.doesNotMatch(DEFAULT_SYSTEM_PROMPT, /Goal,\s*then\s*Context/i);
    assert.doesNotMatch(DEFAULT_SYSTEM_PROMPT, /Constraints,\s*then\s*Output format/i);
    assert.match(DEFAULT_SYSTEM_PROMPT, /Do not invent/i);
    assert.match(DEFAULT_SYSTEM_PROMPT, /one concise prompt/i);
  });

  it('keeps the control panel reset prompt synchronized with the built-in prompt', () => {
    const uiJs = readFileSync('dist/main/control-panel/ui/app.js', 'utf8');
    assert.match(uiJs, /const DEFAULT_PROMPT = `/);
    assert.match(uiJs, /one concise prompt/i);
    assert.doesNotMatch(uiJs, /Restructure as: Goal/i);
  });
});
