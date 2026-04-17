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

/**
 * Read-modify-write the config file, preserving fields we don't know about.
 * Used for runtime mutations like persisting the dragged overlay position.
 */
export function updateConfigFile(
  filePath: string,
  mutator: (raw: Record<string, unknown>) => void,
): boolean {
  let raw: Record<string, unknown> = {};
  try {
    const content = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[config] could not read ${filePath} for update:`, (err as Error).message);
      // fall through and write a fresh file
    }
  }
  try {
    mutator(raw);
    const dir = path.dirname(filePath);
    mkdirSync(dir, { recursive: true });
    writeFileSync(filePath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
    return true;
  } catch (err) {
    console.warn(`[config] could not write ${filePath}:`, (err as Error).message);
    return false;
  }
}
