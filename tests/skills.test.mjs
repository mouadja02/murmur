import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { composeSystemPrompt, deleteSkill, loadSkills, saveSkill } from '../dist/main/skills.js';

function makeTempDir() {
  return mkdtempSync(path.join(tmpdir(), 'murmur-skills-'));
}

describe('skills', () => {
  let dir;

  beforeEach(() => {
    dir = makeTempDir();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('seeds two example skills on first load', () => {
    const skills = loadSkills(dir);
    const ids = skills.map((s) => s.id).sort();
    assert.deepEqual(ids, ['code-context', 'concise-output']);
    for (const s of skills) {
      assert.ok(s.name, 'skill has a name');
      assert.ok(s.description, 'skill has a description');
      assert.ok(s.content.length > 0, 'skill body is not empty');
    }
  });

  it('save → load round-trips a new skill with auto-slugged id', () => {
    loadSkills(dir); // seed
    const saved = saveSkill(dir, {
      name: 'My Fancy Skill',
      description: 'd',
      content: 'body content',
    });
    assert.equal(saved.id, 'my-fancy-skill');
    assert.equal(saved.content, 'body content');

    const all = loadSkills(dir);
    const found = all.find((s) => s.id === 'my-fancy-skill');
    assert.ok(found, 'saved skill is in loadSkills output');
    assert.equal(found.name, 'My Fancy Skill');
    assert.equal(found.content, 'body content');

    // On-disk frontmatter is well-formed.
    const raw = readFileSync(found.filePath, 'utf8');
    assert.match(raw, /^---\nid: my-fancy-skill\nname: My Fancy Skill\n/);
  });

  it('deleteSkill removes the file and returns true', () => {
    loadSkills(dir);
    saveSkill(dir, { id: 'x', name: 'x', content: 'x' });
    assert.equal(deleteSkill(dir, 'x'), true);
    assert.equal(deleteSkill(dir, 'x'), false, 'second delete is a no-op');
    const all = loadSkills(dir);
    assert.equal(
      all.find((s) => s.id === 'x'),
      undefined,
    );
  });

  it('composeSystemPrompt returns base prompt when nothing is enabled', () => {
    const skills = loadSkills(dir);
    const out = composeSystemPrompt('BASE', skills, []);
    assert.equal(out, 'BASE');
  });

  it('composeSystemPrompt concatenates enabled skills under an Active skills header', () => {
    const skills = loadSkills(dir);
    const out = composeSystemPrompt('BASE', skills, ['concise-output']);
    assert.match(out, /^BASE/);
    assert.match(out, /## Active skills/);
    assert.match(out, /### Concise output/);
  });

  it('composeSystemPrompt silently drops unknown skill ids', () => {
    const skills = loadSkills(dir);
    const out = composeSystemPrompt('BASE', skills, ['does-not-exist']);
    assert.equal(out, 'BASE');
  });
});
