import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { PartialConfig } from './schema.js';
import { sanitizePartial } from './schema.js';

export interface ConfigFileLoad {
  /** True if the file existed on disk (even if empty/invalid). */
  existed: boolean;
  /** Sanitized contents (empty object if missing or unreadable). */
  partial: PartialConfig;
}

export function readConfigFile(filePath: string): ConfigFileLoad {
  let content: string;
  try {
    content = readFileSync(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { existed: false, partial: {} };
    }
    console.warn(`[config] could not read ${filePath}:`, (err as Error).message);
    return { existed: true, partial: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    console.warn(`[config] ${filePath} is not valid JSON: ${(err as Error).message}`);
    return { existed: true, partial: {} };
  }
  return { existed: true, partial: sanitizePartial(parsed, filePath) };
}

/**
 * Writes a default config to disk so the user has something to edit. Never
 * overwrites an existing file.
 */
export function writeDefaultConfigIfMissing(
  filePath: string,
  defaults: Record<string, unknown>,
): boolean {
  try {
    readFileSync(filePath, 'utf8');
    return false;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[config] could not check ${filePath}:`, (err as Error).message);
      return false;
    }
  }
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const body = JSON.stringify(defaults, null, 2);
  writeFileSync(filePath, `${body}\n`, 'utf8');
  return true;
}
