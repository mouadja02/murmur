import type { ProviderId } from '../providers/index.js';

export type OverlayAnchor = 'bottom-center' | 'bottom-right' | 'top-right' | 'free';

export interface OverlayPosition {
  x: number;
  y: number;
}

/**
 * The fully-resolved runtime config. Every field is required and absolute
 * (paths are resolved relative to `process.cwd()`).
 */
export interface ResolvedConfig {
  // LLM provider
  provider: ProviderId;
  baseUrl: string;
  model: string;
  apiKey: string | null;
  temperature: number;

  // Local STT
  whisperCliPath: string;
  whisperModelPath: string;

  // Audio capture
  sampleRate: number;

  // Push-to-talk combo (parsed by HotkeyService).
  hotkeyCombo: string;
  // Tap-to-toggle visibility combo (parsed by HotkeyService).
  toggleHotkeyCombo: string;

  // Injection
  clipboardRestoreDelayMs: number;

  // Overlay window
  overlayAnchor: OverlayAnchor;
  overlayOffsetX: number;
  overlayOffsetY: number;
  /** Persisted absolute screen position when anchor === 'free'. */
  overlayPosition: OverlayPosition | null;

  // Prompt engineering
  systemPrompt: string;
  /** Skill IDs (filenames without `.md`) that get composed into the system prompt. */
  enabledSkills: string[];

  // Web control panel
  /** 0 picks a random free port at startup. */
  controlPanelPort: number;

  // Paths
  logsDir: string;
  skillsDir: string;
  configFilePath: string;
}

/**
 * The shape persisted to the on-disk config file. All fields optional because
 * users may only set what they care about; everything else falls back to
 * defaults.
 */
export interface PartialConfig {
  provider?: ProviderId;
  baseUrl?: string;
  model?: string;
  apiKey?: string | null;
  temperature?: number;

  whisperCliPath?: string;
  whisperModelPath?: string;

  sampleRate?: number;
  hotkeyCombo?: string;
  toggleHotkeyCombo?: string;
  clipboardRestoreDelayMs?: number;

  overlay?: {
    anchor?: OverlayAnchor;
    offsetX?: number;
    offsetY?: number;
    position?: OverlayPosition | null;
  };

  systemPrompt?: string;
  enabledSkills?: string[];
  controlPanelPort?: number;

  logsDir?: string;
  skillsDir?: string;
}

const VALID_PROVIDERS: ProviderId[] = ['ollama', 'openai-compat'];
const VALID_ANCHORS: OverlayAnchor[] = ['bottom-center', 'bottom-right', 'top-right', 'free'];

function isString(v: unknown): v is string {
  return typeof v === 'string';
}

function isNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function pick<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return isString(value) && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/**
 * Best-effort sanitization of an arbitrary parsed JSON object into a
 * `PartialConfig`. Invalid fields are dropped silently with a console warning.
 */
export function sanitizePartial(input: unknown, source: string): PartialConfig {
  if (!input || typeof input !== 'object') {
    if (input !== undefined) console.warn(`[config] ${source}: not an object, ignored`);
    return {};
  }
  const obj = input as Record<string, unknown>;
  const out: PartialConfig = {};

  const provider = pick(obj.provider, VALID_PROVIDERS);
  if (provider) out.provider = provider;
  if (isString(obj.baseUrl)) out.baseUrl = obj.baseUrl;
  if (isString(obj.model)) out.model = obj.model;
  if (obj.apiKey === null || isString(obj.apiKey)) out.apiKey = obj.apiKey;
  if (isNumber(obj.temperature)) out.temperature = obj.temperature;

  if (isString(obj.whisperCliPath)) out.whisperCliPath = obj.whisperCliPath;
  if (isString(obj.whisperModelPath)) out.whisperModelPath = obj.whisperModelPath;

  if (isNumber(obj.sampleRate)) out.sampleRate = obj.sampleRate;
  if (isString(obj.hotkeyCombo)) out.hotkeyCombo = obj.hotkeyCombo;
  if (isString(obj.toggleHotkeyCombo)) out.toggleHotkeyCombo = obj.toggleHotkeyCombo;
  if (isNumber(obj.clipboardRestoreDelayMs)) {
    out.clipboardRestoreDelayMs = obj.clipboardRestoreDelayMs;
  }

  const overlay = obj.overlay;
  if (overlay && typeof overlay === 'object') {
    const o = overlay as Record<string, unknown>;
    const anchor = pick(o.anchor, VALID_ANCHORS);
    out.overlay = {};
    if (anchor) out.overlay.anchor = anchor;
    if (isNumber(o.offsetX)) out.overlay.offsetX = o.offsetX;
    if (isNumber(o.offsetY)) out.overlay.offsetY = o.offsetY;
    if (o.position === null) out.overlay.position = null;
    else if (o.position && typeof o.position === 'object') {
      const p = o.position as Record<string, unknown>;
      if (isNumber(p.x) && isNumber(p.y)) out.overlay.position = { x: p.x, y: p.y };
    }
  }

  if (isString(obj.logsDir)) out.logsDir = obj.logsDir;
  if (isString(obj.skillsDir)) out.skillsDir = obj.skillsDir;

  if (isString(obj.systemPrompt)) out.systemPrompt = obj.systemPrompt;
  if (Array.isArray(obj.enabledSkills)) {
    out.enabledSkills = obj.enabledSkills.filter(isString);
  }
  if (
    isNumber(obj.controlPanelPort) &&
    obj.controlPanelPort >= 0 &&
    obj.controlPanelPort <= 65535
  ) {
    out.controlPanelPort = Math.floor(obj.controlPanelPort);
  }

  return out;
}
