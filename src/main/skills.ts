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
  /** Filename slug, no extension. */
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

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function ensureSeedSkills(dir: string): void {
  ensureDir(dir);
  const seeds: Array<{ id: string; name: string; description: string; body: string }> = [
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
  for (const seed of seeds) {
    const filePath = path.join(dir, `${seed.id}.md`);
    if (existsSync(filePath)) continue;
    const file = `---\nid: ${seed.id}\nname: ${seed.name}\ndescription: ${seed.description}\n---\n\n${seed.body}\n`;
    writeFileSync(filePath, file, 'utf8');
  }
}

export function loadSkills(dir: string): Skill[] {
  ensureSeedSkills(dir);
  const out: Skill[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
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
    out.push({
      id,
      name: meta.name || id,
      description: meta.description || '',
      content: body.trim(),
      filePath,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export interface SaveSkillInput {
  id?: string;
  name: string;
  description?: string;
  content: string;
}

export function saveSkill(dir: string, input: SaveSkillInput): Skill {
  ensureDir(dir);
  const id = input.id?.trim() || slugify(input.name);
  const filePath = path.join(dir, `${id}.md`);
  const meta = [`id: ${id}`, `name: ${input.name}`, `description: ${input.description ?? ''}`].join(
    '\n',
  );
  const file = `---\n${meta}\n---\n\n${input.content.trim()}\n`;
  writeFileSync(filePath, file, 'utf8');
  return {
    id,
    name: input.name,
    description: input.description ?? '',
    content: input.content.trim(),
    filePath,
  };
}

export function deleteSkill(dir: string, id: string): boolean {
  const filePath = path.join(dir, `${id}.md`);
  if (!existsSync(filePath)) return false;
  unlinkSync(filePath);
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
