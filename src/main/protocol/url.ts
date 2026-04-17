/**
 * Pure URL helpers for the `murmur://` custom scheme.
 *
 * Deliberately free of `electron` and I/O imports so the logic is unit-testable
 * under a plain `node --test` run (no Electron runtime).
 */

export const MURMUR_PROTOCOL = 'murmur';

export type MurmurAction = 'show' | 'hide' | 'toggle' | 'panel' | 'quit';

const KNOWN_ACTIONS: ReadonlySet<MurmurAction> = new Set([
  'show',
  'hide',
  'toggle',
  'panel',
  'quit',
]);

/** Parse a `murmur://...` URL into a known action, or null if unrecognised. */
export function parseMurmurUrl(url: unknown): MurmurAction | null {
  if (typeof url !== 'string') return null;
  if (!url.toLowerCase().startsWith(`${MURMUR_PROTOCOL}://`)) return null;
  try {
    const u = new URL(url);
    // `new URL("murmur://show")` -> hostname="show", pathname=""
    // `new URL("murmur:///show")` -> hostname="", pathname="/show"
    const candidate = (u.hostname || u.pathname.replace(/^\/+/, '')).toLowerCase();
    return KNOWN_ACTIONS.has(candidate as MurmurAction) ? (candidate as MurmurAction) : null;
  } catch {
    return null;
  }
}

/** Pick the first `murmur://...` URL out of a process `argv` array. */
export function findMurmurUrlInArgv(argv: readonly unknown[]): string | null {
  for (const a of argv) {
    if (typeof a === 'string' && a.toLowerCase().startsWith(`${MURMUR_PROTOCOL}://`)) {
      return a;
    }
  }
  return null;
}
