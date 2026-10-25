import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { startControlPanelServer } from '../dist/main/control-panel/server.js';
import {
  createSkill,
  deleteSkill,
  loadSkills,
  loadSkillsReport,
  saveSkill,
} from '../dist/main/skills.js';

/** A file a user dropped into the skills folder by hand: its frontmatter id differs from the filename. */
const TEAM_NOTES =
  '---\nid: team-vocab\nname: Team vocab\ndescription: ours\n---\n\nUSE OUR WORDS\n';

function mdFiles(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort();
}

describe('skill storage: module', () => {
  let dir;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'murmur-skills-int-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('create never overwrites', () => {
    it('refuses an id that is already a loaded skill and leaves the file untouched', () => {
      loadSkills(dir); // seed
      const file = path.join(dir, 'concise-output.md');
      const before = readFileSync(file, 'utf8');
      assert.throws(
        () => createSkill(dir, { name: 'Concise output', content: 'NEW BODY FROM IMPORT' }),
        (err) => err.name === 'SkillConflictError' && err.existingId === 'concise-output',
      );
      assert.equal(readFileSync(file, 'utf8'), before);
    });

    it('refuses an explicit frontmatter id that collides, too', () => {
      loadSkills(dir);
      assert.throws(
        () => createSkill(dir, { id: 'code-context', name: 'Whatever', content: 'x' }),
        /already (holds|exists)/,
      );
    });

    it('refuses to write over a file that holds a skill under a different id', () => {
      writeFileSync(path.join(dir, 'team-notes.md'), TEAM_NOTES, 'utf8');
      assert.throws(
        () => createSkill(dir, { name: 'Team notes', content: 'x' }),
        (err) => err.name === 'SkillConflictError' && err.existingId === 'team-vocab',
      );
      assert.equal(readFileSync(path.join(dir, 'team-notes.md'), 'utf8'), TEAM_NOTES);
    });

    it('still creates a skill with a fresh name', () => {
      loadSkills(dir);
      const made = createSkill(dir, { name: 'Fresh One', content: 'body' });
      assert.equal(made.id, 'fresh-one');
      assert.ok(existsSync(path.join(dir, 'fresh-one.md')));
    });
  });

  describe('edit and delete act on the file that was loaded', () => {
    it('deletes a hand-dropped skill by its frontmatter id', () => {
      writeFileSync(path.join(dir, 'team-notes.md'), TEAM_NOTES, 'utf8');
      assert.ok(loadSkills(dir).some((s) => s.id === 'team-vocab'));
      assert.equal(deleteSkill(dir, 'team-vocab'), true);
      assert.equal(existsSync(path.join(dir, 'team-notes.md')), false);
      assert.equal(
        loadSkills(dir).some((s) => s.id === 'team-vocab'),
        false,
      );
    });

    it('edits a hand-dropped skill in place without writing a second file', () => {
      writeFileSync(path.join(dir, 'team-notes.md'), TEAM_NOTES, 'utf8');
      loadSkills(dir);
      const before = mdFiles(dir);
      saveSkill(dir, { id: 'team-vocab', name: 'Team vocab', description: 'ours', content: 'NEW' });
      assert.deepEqual(mdFiles(dir), before);
      const edited = loadSkills(dir).filter((s) => s.id === 'team-vocab');
      assert.equal(edited.length, 1);
      assert.equal(edited[0].content, 'NEW');
      assert.ok(edited[0].filePath.endsWith('team-notes.md'));
    });

    it('does not treat an unrelated file as the target of an edit by id', () => {
      writeFileSync(path.join(dir, 'team-notes.md'), TEAM_NOTES, 'utf8');
      assert.throws(
        () => saveSkill(dir, { id: 'team-notes', name: 'Other', content: 'x' }),
        /already (holds|exists)/,
      );
      assert.equal(readFileSync(path.join(dir, 'team-notes.md'), 'utf8'), TEAM_NOTES);
    });

    it('saveSkill still creates a skill that does not exist yet', () => {
      loadSkills(dir);
      const saved = saveSkill(dir, { id: 'brand-new', name: 'Brand new', content: 'body' });
      assert.ok(existsSync(saved.filePath));
    });
  });

  describe('duplicate ids', () => {
    it('lists one skill per id, preferring <id>.md, and reports the shadowed file', () => {
      writeFileSync(path.join(dir, 'a-first.md'), TEAM_NOTES.replace('USE OUR', 'FIRST'), 'utf8');
      writeFileSync(path.join(dir, 'team-vocab.md'), TEAM_NOTES, 'utf8');
      const report = loadSkillsReport(dir);
      const found = report.skills.filter((s) => s.id === 'team-vocab');
      assert.equal(found.length, 1);
      assert.ok(found[0].filePath.endsWith('team-vocab.md'));
      assert.deepEqual(
        report.shadowed.map((s) => [
          s.id,
          path.basename(s.filePath),
          path.basename(s.keptFilePath),
        ]),
        [['team-vocab', 'a-first.md', 'team-vocab.md']],
      );
    });
  });

  describe('bundled example skills', () => {
    it('stay deleted once the user removes them', () => {
      loadSkills(dir);
      assert.equal(deleteSkill(dir, 'concise-output'), true);
      assert.equal(existsSync(path.join(dir, 'concise-output.md')), false);
      loadSkills(dir);
      loadSkills(dir);
      assert.equal(existsSync(path.join(dir, 'concise-output.md')), false);
      assert.deepEqual(
        loadSkills(dir).map((s) => s.id),
        ['code-context'],
      );
    });

    it('are not re-created when a user empties the folder entirely', () => {
      loadSkills(dir);
      deleteSkill(dir, 'concise-output');
      deleteSkill(dir, 'code-context');
      assert.deepEqual(loadSkills(dir), []);
    });

    it('keep a user-edited seed (never overwritten by the seeder)', () => {
      loadSkills(dir);
      saveSkill(dir, { id: 'code-context', name: 'Code context', content: 'MY EDIT' });
      assert.equal(loadSkills(dir).find((s) => s.id === 'code-context').content, 'MY EDIT');
    });

    it('upgrade: an install whose example files already exist keeps them, and deleting one sticks', () => {
      // Folder as an older release left it: examples on disk (one edited), no marker file.
      const edited =
        '---\nid: code-context\nname: Code context\ndescription: mine\n---\n\nMY OWN WORDS\n';
      const old = '---\nid: concise-output\nname: Concise output\ndescription: d\n---\n\nOLD\n';
      writeFileSync(path.join(dir, 'code-context.md'), edited, 'utf8');
      writeFileSync(path.join(dir, 'concise-output.md'), old, 'utf8');
      loadSkills(dir);
      assert.equal(readFileSync(path.join(dir, 'code-context.md'), 'utf8'), edited);
      assert.equal(deleteSkill(dir, 'concise-output'), true);
      assert.deepEqual(
        loadSkills(dir).map((s) => s.id),
        ['code-context'],
      );
    });

    it('still seed a folder that already holds skills of the user', () => {
      writeFileSync(path.join(dir, 'team-notes.md'), TEAM_NOTES, 'utf8');
      const ids = loadSkills(dir)
        .map((s) => s.id)
        .sort();
      assert.deepEqual(ids, ['code-context', 'concise-output', 'team-vocab']);
    });
  });
});

function makeFakeConfig(overrides = {}) {
  return {
    provider: 'ollama',
    baseUrl: 'http://localhost:11434',
    model: 'qwen3:4b',
    apiKey: null,
    temperature: 0.2,
    whisperCliPath: 'C:/whisper.exe',
    whisperModelPath: 'C:/model.bin',
    sampleRate: 16000,
    hotkeyCombo: 'Ctrl+Shift+Space',
    toggleHotkeyCombo: 'Ctrl+Shift+H',
    clipboardRestoreDelayMs: 150,
    clipboardRetention: 'keep-generated',
    injectionMethod: 'auto',
    systemPrompt: 'BASE PROMPT',
    enabledSkills: [],
    controlPanelPort: 0,
    mcpPort: 7332,
    recorderCommand: 'sox -q -d -r 16000 -c 1 -b 16 -e signed-integer -t raw -',
    logsDir: 'logs',
    overlay: { anchor: 'bottom-center', offsetX: 0, offsetY: -40 },
    overlayAnchor: 'bottom-center',
    overlayOffsetX: 0,
    overlayOffsetY: -40,
    overlayPosition: null,
    ...overrides,
  };
}

describe('skill storage: control panel API', () => {
  let root;
  let dir;
  let handle;
  let headers;

  async function boot() {
    const cfg = makeFakeConfig({ skillsDir: dir, configFilePath: path.join(root, 'config.json') });
    handle = await startControlPanelServer({
      getCurrentConfig: () => cfg,
      onConfigUpdated: () => {},
      testLlm: async () => ({ ok: true, message: 'mocked' }),
    });
    const state = await (await fetch(`${handle.url}/api/state`)).json();
    headers = {
      'Content-Type': 'application/json',
      'X-Murmur-Token': state.security.csrfToken,
    };
    return state;
  }

  const send = (method, route, body) =>
    fetch(`${handle.url}${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'murmur-skills-api-'));
    dir = path.join(root, 'skills');
    mkdirSync(dir);
  });

  afterEach(async () => {
    if (handle) await handle.stop();
    handle = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  it('POST /api/skills with a colliding id returns 409 and leaves the file unchanged', async () => {
    await boot();
    const file = path.join(dir, 'concise-output.md');
    const before = readFileSync(file, 'utf8');

    const res = await send('POST', '/api/skills', {
      name: 'Concise output',
      content: 'NEW BODY FROM IMPORT',
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.match(body.error, /concise-output/);
    assert.equal(body.existingId, 'concise-output');
    assert.equal(readFileSync(file, 'utf8'), before);
  });

  it('POST /api/skills with a fresh name still creates the skill (control)', async () => {
    await boot();
    const res = await send('POST', '/api/skills', { name: 'Fresh One', content: 'body' });
    assert.equal(res.status, 200);
    const state = await res.json();
    assert.ok(state.skills.some((s) => s.id === 'fresh-one'));
  });

  it('DELETE and PUT act on a hand-dropped file whose id differs from its filename', async () => {
    writeFileSync(path.join(dir, 'team-notes.md'), TEAM_NOTES, 'utf8');
    const state = await boot();
    assert.ok(state.skills.some((s) => s.id === 'team-vocab'));

    const put = await send('PUT', '/api/skills/team-vocab', {
      name: 'Team vocab',
      description: 'ours',
      content: 'EDITED',
    });
    assert.equal(put.status, 200);
    const afterPut = await put.json();
    assert.equal(afterPut.skills.filter((s) => s.id === 'team-vocab').length, 1);
    assert.equal(existsSync(path.join(dir, 'team-vocab.md')), false, 'no second file');
    assert.match(readFileSync(path.join(dir, 'team-notes.md'), 'utf8'), /EDITED/);

    const del = await send('DELETE', '/api/skills/team-vocab');
    assert.equal(del.status, 200);
    assert.equal(existsSync(path.join(dir, 'team-notes.md')), false);
    assert.equal(
      (await del.json()).skills.some((s) => s.id === 'team-vocab'),
      false,
    );
  });

  it('PUT to an id that only matches another skill file name is a conflict, not an overwrite', async () => {
    writeFileSync(path.join(dir, 'team-notes.md'), TEAM_NOTES, 'utf8');
    await boot();
    const res = await send('PUT', '/api/skills/team-notes', { name: 'Other', content: 'x' });
    assert.equal(res.status, 409);
    assert.equal(readFileSync(path.join(dir, 'team-notes.md'), 'utf8'), TEAM_NOTES);
  });

  it('a deleted bundled skill stays deleted across the panel 4 s state polls', async () => {
    await boot();
    const del = await send('DELETE', '/api/skills/concise-output');
    assert.equal(del.status, 200);
    for (let i = 0; i < 3; i++) {
      const state = await (await fetch(`${handle.url}/api/state`)).json();
      assert.equal(
        state.skills.some((s) => s.id === 'concise-output'),
        false,
      );
    }
    assert.equal(existsSync(path.join(dir, 'concise-output.md')), false);
  });

  it('reports a duplicate id in /api/state so the panel can show it', async () => {
    writeFileSync(path.join(dir, 'a-first.md'), TEAM_NOTES, 'utf8');
    writeFileSync(path.join(dir, 'team-vocab.md'), TEAM_NOTES, 'utf8');
    const state = await boot();
    assert.equal(state.skills.filter((s) => s.id === 'team-vocab').length, 1);
    assert.deepEqual(
      state.skillConflicts.map((c) => [c.id, c.file, c.keptFile]),
      [['team-vocab', 'a-first.md', 'team-vocab.md']],
    );
  });
});
