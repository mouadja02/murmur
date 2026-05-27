/**
 * Pure URL helpers for the `murmur://` custom scheme.
 *
 * Deliberately free of `electron` and I/O imports so the logic is unit-testable
 * under a plain `node --test` run (no Electron runtime).
 */

export const MURMUR_PROTOCOL = 'murmur';

export type MurmurAction = 'show' | 'hide' | 'toggle' | 'panel' | 'quit';

export interface ProtocolRegistrationInput {
  defaultApp: boolean;
  execPath: string;
  electronEntryPath: string;
  argv: readonly unknown[];
}

export interface ProtocolRegistration {
  executable: string;
  args: string[];
}

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

/**
 * Build arguments for Electron's protocol registration. Default-app Electron
 * launches need the Murmur entry script as the first argument. Do not trust
 * `argv[1]` here: when the handler is repaired from another Electron-hosted
 * environment, it can point at that host app's install directory.
 */
export function buildProtocolRegistration(input: ProtocolRegistrationInput): ProtocolRegistration {
  return {
    executable: input.execPath,
    args: input.defaultApp ? [input.electronEntryPath] : [],
  };
}
