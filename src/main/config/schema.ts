import type { ProviderId } from '../providers/index.js';

export type OverlayAnchor = 'bottom-center' | 'bottom-right' | 'top-right' | 'free';

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

  // Hotkey (combo string is informational; the hotkey service hardcodes the combo for now)
  hotkeyCombo: string;

  // Injection
  clipboardRestoreDelayMs: number;

  // Overlay window
  overlayAnchor: OverlayAnchor;
  overlayOffsetX: number;
  overlayOffsetY: number;

  // Paths
  logsDir: string;
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
  clipboardRestoreDelayMs?: number;

  overlay?: {
    anchor?: OverlayAnchor;
    offsetX?: number;
    offsetY?: number;
  };

  logsDir?: string;
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
  }

  if (isString(obj.logsDir)) out.logsDir = obj.logsDir;

  return out;
}
