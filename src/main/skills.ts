import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export interface Skill {
  /** Frontmatter `id`, or the filename slug when the file has none. */
  id: string;
  /** Human-readable display name. Falls back to id if frontmatter is missing. */
  name: string;
  /** One-liner used in pickers. */
  description: string;
  /** Markdown body (everything after the frontmatter block). */
  content: string;
  /** Absolute path on disk. */
  filePath: string;
}

const FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)$/;
function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return { meta: {}, body: raw };
  const meta: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
    if (m) meta[m[1].trim()] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return { meta, body: match[2] };
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'skill'
  );
}

/** Matches ids produced by `slugify` and explicit frontmatter `id` values. */
const SKILL_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function isValidSkillId(id: string): boolean {
  return SKILL_ID_RE.test(id);
}

function assertValidSkillId(id: string): void {
  if (!isValidSkillId(id)) {
    throw new Error(`invalid skill id "${id}"; use 1-64 lowercase letters, numbers, and hyphens`);
  }
}

function skillPath(dir: string, id: string): string {
  assertValidSkillId(id);
  const root = path.resolve(dir);
  const filePath = path.resolve(root, `${id}.md`);
  const relative = path.relative(root, filePath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`invalid skill path for "${id}"`);
  }
  return filePath;
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Lists, one id per line, the bundled example skills already offered to a skills folder. */
const SEED_MARKER = '.seeded-skills';

const SEED_SKILLS: Array<{ id: string; name: string; description: string; body: string }> = [
  {
    id: 'concise-output',
    name: 'Concise output',
    description: 'Trim filler, keep the prompt to the point.',
    body: `When refining the user's transcription, ruthlessly cut filler words and repetition. Prefer short, declarative sentences. If the user repeated a thought, keep only the clearest version. Do not add greetings or sign-offs.`,
  },
  {
    id: 'code-context',
    name: 'Code context',
    description: 'Bias toward software engineering vocabulary.',
    body: `Treat the transcription as developer dictation. Disambiguate homophones using coding context: "react" not "wreaked", "async" not "a sink", "tsx" not "ts x", "regex" not "rejects". Preserve API names, file paths, and identifiers verbatim. Never rewrap code-like tokens in prose.`,
  },
];

function readSeededIds(markerPath: string): string[] {
  try {
    return readFileSync(markerPath, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/**
 * Offers each bundled example skill once per skills folder. The marker records
 * what was offered, so a skill the user deletes stays deleted instead of coming
 * back on the next load (the control panel reloads every few seconds). Delete the
 * marker file to get the examples back.
 */
function ensureSeedSkills(dir: string): void {
  ensureDir(dir);
  const markerPath = path.join(dir, SEED_MARKER);
  const offered = readSeededIds(markerPath);
  const pending = SEED_SKILLS.filter((seed) => !offered.includes(seed.id));
  if (pending.length === 0) return;
  for (const seed of pending) {
    const filePath = path.join(dir, `${seed.id}.md`);
    if (existsSync(filePath)) continue;
    const file = `---\nid: ${seed.id}\nname: ${seed.name}\ndescription: ${seed.description}\n---\n\n${seed.body}\n`;
    writeFileSync(filePath, file, 'utf8');
  }
  const all = [...offered, ...pending.map((seed) => seed.id)];
  writeFileSync(markerPath, `${all.join('\n')}\n`, 'utf8');
}

/** Every readable skill file in `dir`, in filename order. Two files may share an id. */
function readSkillFiles(dir: string): Skill[] {
  const out: Skill[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith('.md')) continue;
    const filePath = path.join(dir, entry);
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf8');
    } catch (err) {
      console.warn(`[skills] failed to read ${filePath}:`, err);
      continue;
    }
    const { meta, body } = parseFrontmatter(raw);
    const id = meta.id || entry.replace(/\.md$/i, '');
    if (!isValidSkillId(id)) {
      console.warn(`[skills] skipped ${filePath}: invalid skill id "${id}"`);
      continue;
    }
    out.push({
      id,
      name: meta.name || id,
      description: meta.description || '',
      content: body.trim(),
      filePath,
    });
  }
  return out;
}

/** A skill file that is ignored because another file already provides the same id. */
export interface ShadowedSkill {
  id: string;
  filePath: string;
  /** The file whose skill is used instead. */
  keptFilePath: string;
}

export interface SkillsReport {
  skills: Skill[];
  shadowed: ShadowedSkill[];
}

/**
 * One skill per id: the file named `<id>.md` wins, otherwise the first by
 * filename. The rest are reported, so edit and delete always have exactly one
 * file to act on and the list never shows an id twice.
 */
function resolveDuplicates(files: Skill[]): SkillsReport {
  const byId = new Map<string, Skill[]>();
  for (const skill of files) byId.set(skill.id, [...(byId.get(skill.id) ?? []), skill]);
  const skills: Skill[] = [];
  const shadowed: ShadowedSkill[] = [];
  for (const [id, group] of byId) {
    const kept =
      group.find((s) => path.basename(s.filePath).toLowerCase() === `${id}.md`) ?? group[0];
    skills.push(kept);
    for (const other of group) {
      if (other !== kept) {
        shadowed.push({ id, filePath: other.filePath, keptFilePath: kept.filePath });
      }
    }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return { skills, shadowed };
}

/** Like `loadSkills`, and also names the duplicate-id files that were ignored. */
export function loadSkillsReport(dir: string): SkillsReport {
  ensureSeedSkills(dir);
  return resolveDuplicates(readSkillFiles(dir));
}

export function loadSkills(dir: string): Skill[] {
  return loadSkillsReport(dir).skills;
}

/** The loaded skill with this id, found without seeding or any other write. */
function findSkill(dir: string, id: string): Skill | undefined {
  return resolveDuplicates(readSkillFiles(dir)).skills.find((s) => s.id === id);
}

/** Thrown instead of overwriting a skill file that already exists. */
export class SkillConflictError extends Error {
  override name = 'SkillConflictError';
  constructor(
    message: string,
    /** The id that was asked for. */
    readonly requestedId: string,
    /** The id of the skill occupying the target, or null if that file is not a loadable skill. */
    readonly existingId: string | null,
  ) {
    super(message);
  }
}

export interface SaveSkillInput {
  id?: string;
  name: string;
  description?: string;
  content: string;
}

/**
 * Frontmatter values are single-line. A newline in a name/description would
 * otherwise inject extra keys (e.g. a second `id:`) into the saved file.
 */
function oneLine(value: string): string {
  return value.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

function renderSkillFile(skill: Omit<Skill, 'filePath'>): string {
  const meta = [`id: ${skill.id}`, `name: ${skill.name}`, `description: ${skill.description}`];
  return `---\n${meta.join('\n')}\n---\n\n${skill.content}\n`;
}

function normalizeInput(input: SaveSkillInput): Omit<Skill, 'filePath'> {
  const name = oneLine(input.name);
  return {
    id: input.id?.trim() || slugify(name),
    name,
    description: oneLine(input.description ?? ''),
    content: input.content.trim(),
  };
}

/** Writes a skill file that must not exist yet; an existing file is reported, never replaced. */
function writeNewSkill(dir: string, skill: Omit<Skill, 'filePath'>): Skill {
  const filePath = skillPath(dir, skill.id);
  const taken = findSkill(dir, skill.id);
  if (taken) {
    throw new SkillConflictError(
      `a skill with id "${skill.id}" already exists (${path.basename(taken.filePath)})`,
      skill.id,
      taken.id,
    );
  }
  try {
    writeFileSync(filePath, renderSkillFile(skill), { encoding: 'utf8', flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    // The filename is taken by a file that holds a skill under another id, or none at all.
    const occupant = readSkillFiles(dir).find((s) => s.filePath === filePath);
    const file = path.basename(filePath);
    throw new SkillConflictError(
      occupant
        ? `${file} already holds the skill "${occupant.id}"; choose a different id`
        : `${file} already exists; choose a different id`,
      skill.id,
      occupant?.id ?? null,
    );
  }
  return { ...skill, filePath };
}

/**
 * Creates a skill and never replaces one: throws `SkillConflictError` when the
 * id is taken or its `<id>.md` file already exists.
 */
export function createSkill(dir: string, input: SaveSkillInput): Skill {
  ensureDir(dir);
  return writeNewSkill(dir, normalizeInput(input));
}

/**
 * Saves a skill. One that is already loaded is rewritten in the file it was
 * loaded from, whatever that file is called; otherwise it is created as a new
 * `<id>.md` that must not exist yet.
 */
export function saveSkill(dir: string, input: SaveSkillInput): Skill {
  ensureDir(dir);
  const skill = normalizeInput(input);
  skillPath(dir, skill.id); // rejects an invalid id before anything is touched
  const loaded = findSkill(dir, skill.id);
  if (!loaded) return writeNewSkill(dir, skill);
  writeFileSync(loaded.filePath, renderSkillFile(skill), 'utf8');
  return { ...skill, filePath: loaded.filePath };
}

/** Deletes the file the skill was loaded from; false when no loaded skill has this id. */
export function deleteSkill(dir: string, id: string): boolean {
  assertValidSkillId(id);
  const loaded = findSkill(dir, id);
  if (!loaded) return false;
  unlinkSync(loaded.filePath);
  return true;
}

/**
 * Composes the active system prompt: base prompt followed by an `Active skills`
 * section that concatenates each enabled skill's body.
 */
export function composeSystemPrompt(
  basePrompt: string,
  allSkills: readonly Skill[],
  enabledIds: readonly string[],
): string {
  if (enabledIds.length === 0) return basePrompt;
  const enabled = enabledIds
    .map((id) => allSkills.find((s) => s.id === id))
    .filter((s): s is Skill => Boolean(s));
  if (enabled.length === 0) return basePrompt;
  const sections = enabled.map((s) => `### ${s.name}\n${s.content}`).join('\n\n---\n\n');
  return `${basePrompt}\n\n## Active skills\n\n${sections}`;
}
