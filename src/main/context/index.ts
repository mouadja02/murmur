import type { AppSkillRoute } from '../config/index.js';
import type { ImageAttachment } from '../providers/types.js';
// Type-only imports keep this module free of Electron / native deps, so the
// pipeline (also used by headless `murmur serve`) can import it under plain node.
import type { ClipboardEntry } from './clipboard.js';
import { type ContextBlock, composeContextBlock } from './compose.js';
import type { ScreenshotContext } from './screenshot.js';
import type { WindowContext } from './window.js';

export interface CapturedContext {
  /** Active app at capture start; drives `appSkillRoutes` even when not sent to the LLM. */
  window: WindowContext | null;
  /** Text block appended to the system prompt ('' when nothing is shared). */
  block: string;
  images: ImageAttachment[];
  /**
   * The parts behind `block` and `images`, kept apart so a re-run can be
   * filtered by the settings in force when it is sent (see `contextForRerun`).
   */
  shared: ContextBlock;
}

export interface ContextSettings {
  contextCapture: boolean;
  clipboardContextEntries: number;
  screenshotContext: boolean;
  appSkillRoutes: readonly AppSkillRoute[];
}

export interface ContextSources {
  activeWindow: () => Promise<WindowContext | null>;
  clipboard: (count: number) => ClipboardEntry[];
  screenshot: () => Promise<ScreenshotContext | null>;
}

/** True when any context feature needs work done at capture time. */
export function contextWanted(s: ContextSettings): boolean {
  return (
    s.contextCapture ||
    s.clipboardContextEntries > 0 ||
    s.screenshotContext ||
    s.appSkillRoutes.length > 0
  );
}

/**
 * Snapshot context at the moment a capture starts. The overlay never takes
 * focus, so the active window is still the app the user is dictating into.
 */
export async function captureContext(
  s: ContextSettings,
  sources: ContextSources,
): Promise<CapturedContext> {
  const needWindow = s.contextCapture || s.appSkillRoutes.length > 0;
  const [window, screenshot] = await Promise.all([
    needWindow ? sources.activeWindow() : Promise.resolve(null),
    s.screenshotContext ? sources.screenshot() : Promise.resolve(null),
  ]);
  const clipboard =
    s.clipboardContextEntries > 0 ? sources.clipboard(s.clipboardContextEntries) : [];
  return {
    window,
    ...sharedParts({ window: s.contextCapture ? window : null, clipboard, screenshot }),
  };
}

function sharedParts(shared: ContextBlock): Pick<CapturedContext, 'block' | 'images' | 'shared'> {
  const { screenshot } = shared;
  return {
    block: composeContextBlock(shared),
    images: screenshot ? [{ base64: screenshot.base64, mimeType: screenshot.mimeType }] : [],
    shared,
  };
}

/**
 * Context for re-running a dictation (Refine last, Retry) from a snapshot taken
 * earlier. The snapshot is data gated by the settings at send time: a part the
 * user has since switched off is dropped, and so is everything when the
 * refinement now goes to a different provider endpoint than the one the
 * context was captured for. The window is kept only for `appSkillRoutes`
 * matching, which never leaves the machine.
 */
export function contextForRerun(
  ctx: CapturedContext | null,
  s: ContextSettings,
  sameDestination: boolean,
): CapturedContext | null {
  if (!ctx) return null;
  const { shared } = ctx;
  const allowed: ContextBlock = sameDestination
    ? {
        window: s.contextCapture ? shared.window : null,
        clipboard: shared.clipboard.slice(0, Math.max(0, s.clipboardContextEntries)),
        screenshot: s.screenshotContext ? shared.screenshot : null,
      }
    : { window: null, clipboard: [], screenshot: null };
  return {
    window: s.appSkillRoutes.length > 0 ? ctx.window : null,
    ...sharedParts(allowed),
  };
}

/**
 * Apply `appSkillRoutes` to the base skill list. A route matches when its
 * `match` string occurs (case-insensitively) in the active app name or window
 * title. Routes apply in order, so a later route can undo an earlier one.
 */
export function routeSkills(
  baseSkillIds: readonly string[],
  routes: readonly AppSkillRoute[],
  window: WindowContext | null,
): string[] {
  if (!window || routes.length === 0) return [...baseSkillIds];
  const haystack = `${window.processName}\n${window.windowTitle}`.toLowerCase();
  const out = new Set(baseSkillIds);
  for (const route of routes) {
    const needle = route.match.trim().toLowerCase();
    if (!needle || !haystack.includes(needle)) continue;
    for (const id of route.enable) out.add(id);
    for (const id of route.disable) out.delete(id);
  }
  return [...out];
}

/** Append the captured context to a composed system prompt. */
export function withContext(systemPrompt: string, ctx: CapturedContext | null): string {
  if (!ctx?.block) return systemPrompt;
  return (
    `${systemPrompt}\n\n## Context\n` +
    'Background about where the user is dictating. Use it only to resolve ' +
    'names, terms, and references in the transcription. Never mention it or ' +
    'add requirements from it.\n\n' +
    ctx.block
  );
}
