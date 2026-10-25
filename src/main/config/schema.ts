import { TARGET_SAMPLE_RATE } from '../../shared/pcm.js';
import type { ProviderId } from '../providers/index.js';

export type RunMode = 'gui' | 'serve';

export type OverlayAnchor = 'bottom-center' | 'bottom-right' | 'top-right' | 'free';

export type InjectionMethod = 'clipboard' | 'type' | 'auto';
export type ClipboardRetention = 'keep-generated' | 'restore-previous';
export type LogMode = 'metadata-only' | 'full';
/** Push-to-talk: hold the combo while speaking, or press once to start and again to stop. */
export type HotkeyMode = 'hold' | 'toggle';
/**
 * What to do when the foreground window changed between the start of a capture
 * and the insertion: `copy` the prompt and tell the user, or `paste` anyway.
 */
export type FocusChangePolicy = 'copy' | 'paste';

export interface OverlayPosition {
  x: number;
  y: number;
}

export interface AppSkillRoute {
  match: string;
  enable: string[];
  disable: string[];
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

  // Push-to-talk combo (parsed by HotkeyService).
  hotkeyCombo: string;
  hotkeyMode: HotkeyMode;
  // Tap-to-toggle visibility combo (parsed by HotkeyService).
  toggleHotkeyCombo: string;

  // Injection
  clipboardRestoreDelayMs: number;
  clipboardRetention: ClipboardRetention;
  injectionMethod: InjectionMethod;
  focusChangePolicy: FocusChangePolicy;
  progressiveInjection: boolean;
  queueMaxDepth: number;
  prewarm: boolean;

  // Voice Activity Detection (VAD)
  vadEnabled: boolean;
  vadThresholdDb: number;
  vadSilenceMs: number;
  vadLeadInMs: number;

  // Context capture
  contextCapture: boolean;
  clipboardContextEntries: number;
  screenshotContext: boolean;
  appSkillRoutes: AppSkillRoute[];

  // Overlay window
  overlayAnchor: OverlayAnchor;
  overlayOffsetX: number;
  overlayOffsetY: number;
  /** Persisted absolute screen position when anchor === 'free'. */
  overlayPosition: OverlayPosition | null;
  /** Whether the overlay should be visible on startup. */
  overlayVisible: boolean;

  // Prompt engineering
  systemPrompt: string;
  /** Skill IDs (filenames without `.md`) that get composed into the system prompt. */
  enabledSkills: string[];

  // Web control panel
  /** 0 picks a random free port at startup. */
  controlPanelPort: number;

  // MCP server mode
  /** 0 picks a random free port at startup. */
  mcpPort: number;
  /** Shell command that emits 16 kHz mono signed 16-bit PCM on stdout. */
  recorderCommand: string;

  // Paths
  logMode: LogMode;
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

  hotkeyCombo?: string;
  hotkeyMode?: HotkeyMode;
  toggleHotkeyCombo?: string;
  clipboardRestoreDelayMs?: number;
  clipboardRetention?: ClipboardRetention;
  injectionMethod?: InjectionMethod;
  focusChangePolicy?: FocusChangePolicy;
  progressiveInjection?: boolean;
  queueMaxDepth?: number;
  prewarm?: boolean;

  vadEnabled?: boolean;
  vadThresholdDb?: number;
  vadSilenceMs?: number;
  vadLeadInMs?: number;

  contextCapture?: boolean;
  clipboardContextEntries?: number;
  screenshotContext?: boolean;
  appSkillRoutes?: AppSkillRoute[];

  overlay?: {
    anchor?: OverlayAnchor;
    offsetX?: number;
    offsetY?: number;
    position?: OverlayPosition | null;
    visible?: boolean;
  };

  systemPrompt?: string;
  enabledSkills?: string[];
  controlPanelPort?: number;
  mcpPort?: number;
  recorderCommand?: string;

  logsDir?: string;
  logMode?: LogMode;
  skillsDir?: string;
}

const VALID_PROVIDERS: ProviderId[] = ['ollama', 'openai-compat', 'anthropic'];
const VALID_ANCHORS: OverlayAnchor[] = ['bottom-center', 'bottom-right', 'top-right', 'free'];
const VALID_INJECTION_METHODS: InjectionMethod[] = ['clipboard', 'type', 'auto'];
const VALID_CLIPBOARD_RETENTION: ClipboardRetention[] = ['keep-generated', 'restore-previous'];
const VALID_LOG_MODES: LogMode[] = ['metadata-only', 'full'];
const VALID_HOTKEY_MODES: HotkeyMode[] = ['hold', 'toggle'];
const VALID_FOCUS_CHANGE_POLICIES: FocusChangePolicy[] = ['copy', 'paste'];
const SKILL_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

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

function sanitizeHttpUrl(value: unknown): string | undefined {
  if (!isString(value)) return undefined;
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? trimmed : undefined;
  } catch {
    return undefined;
  }
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
  const baseUrl = sanitizeHttpUrl(obj.baseUrl);
  if (baseUrl) out.baseUrl = baseUrl;
  if (isString(obj.model)) out.model = obj.model;
  if (obj.apiKey === null || isString(obj.apiKey)) out.apiKey = obj.apiKey;
  if (isNumber(obj.temperature)) out.temperature = obj.temperature;

  if (isString(obj.whisperCliPath)) out.whisperCliPath = obj.whisperCliPath;
  if (isString(obj.whisperModelPath)) out.whisperModelPath = obj.whisperModelPath;

  // Capture is fixed at 16 kHz (what whisper.cpp expects). Older configs and the
  // old panel field may still carry the key; honour nothing but say so.
  if (obj.sampleRate !== undefined && obj.sampleRate !== TARGET_SAMPLE_RATE) {
    console.warn(
      `[config] ${source}: sampleRate is ignored; audio is always captured at ${TARGET_SAMPLE_RATE} Hz`,
    );
  }
  if (isString(obj.hotkeyCombo)) out.hotkeyCombo = obj.hotkeyCombo;
  const hotkeyMode = pick(obj.hotkeyMode, VALID_HOTKEY_MODES);
  if (hotkeyMode) out.hotkeyMode = hotkeyMode;
  if (isString(obj.toggleHotkeyCombo)) out.toggleHotkeyCombo = obj.toggleHotkeyCombo;
  if (isNumber(obj.clipboardRestoreDelayMs)) {
    out.clipboardRestoreDelayMs = obj.clipboardRestoreDelayMs;
  }
  const clipboardRetention = pick(obj.clipboardRetention, VALID_CLIPBOARD_RETENTION);
  if (clipboardRetention) out.clipboardRetention = clipboardRetention;

  const injectionMethod = pick(obj.injectionMethod, VALID_INJECTION_METHODS);
  if (injectionMethod) out.injectionMethod = injectionMethod;

  const focusChangePolicy = pick(obj.focusChangePolicy, VALID_FOCUS_CHANGE_POLICIES);
  if (focusChangePolicy) out.focusChangePolicy = focusChangePolicy;

  if (typeof obj.progressiveInjection === 'boolean') {
    out.progressiveInjection = obj.progressiveInjection;
  }

  if (isNumber(obj.queueMaxDepth) && obj.queueMaxDepth >= 1) {
    out.queueMaxDepth = Math.floor(obj.queueMaxDepth);
  }

  if (typeof obj.prewarm === 'boolean') out.prewarm = obj.prewarm;

  if (typeof obj.vadEnabled === 'boolean') out.vadEnabled = obj.vadEnabled;
  if (isNumber(obj.vadThresholdDb) && obj.vadThresholdDb < 0) {
    out.vadThresholdDb = obj.vadThresholdDb;
  }
  if (isNumber(obj.vadSilenceMs) && obj.vadSilenceMs > 0) {
    out.vadSilenceMs = Math.floor(obj.vadSilenceMs);
  }
  if (isNumber(obj.vadLeadInMs) && obj.vadLeadInMs > 0) {
    out.vadLeadInMs = Math.floor(obj.vadLeadInMs);
  }

  if (typeof obj.contextCapture === 'boolean') out.contextCapture = obj.contextCapture;
  if (isNumber(obj.clipboardContextEntries) && obj.clipboardContextEntries >= 0) {
    out.clipboardContextEntries = Math.min(Math.floor(obj.clipboardContextEntries), 5);
  }
  if (typeof obj.screenshotContext === 'boolean') out.screenshotContext = obj.screenshotContext;
  if (Array.isArray(obj.appSkillRoutes)) {
    out.appSkillRoutes = obj.appSkillRoutes.filter((route): route is AppSkillRoute => {
      if (!route || typeof route !== 'object') return false;
      const r = route as Record<string, unknown>;
      return (
        isString(r.match) &&
        Array.isArray(r.enable) &&
        r.enable.every((s) => isString(s) && SKILL_ID_RE.test(s)) &&
        Array.isArray(r.disable) &&
        r.disable.every((s) => isString(s) && SKILL_ID_RE.test(s))
      );
    });
  }

  const overlay = obj.overlay;
  if (overlay && typeof overlay === 'object') {
    const o = overlay as Record<string, unknown>;
    const anchor = pick(o.anchor, VALID_ANCHORS);
    out.overlay = {};
    if (anchor) out.overlay.anchor = anchor;
    if (isNumber(o.offsetX)) out.overlay.offsetX = o.offsetX;
    if (isNumber(o.offsetY)) out.overlay.offsetY = o.offsetY;
    if (typeof o.visible === 'boolean') out.overlay.visible = o.visible;
    if (o.position === null) out.overlay.position = null;
    else if (o.position && typeof o.position === 'object') {
      const p = o.position as Record<string, unknown>;
      if (isNumber(p.x) && isNumber(p.y)) out.overlay.position = { x: p.x, y: p.y };
    }
  }

  if (isString(obj.logsDir)) out.logsDir = obj.logsDir;
  const logMode = pick(obj.logMode, VALID_LOG_MODES);
  if (logMode) out.logMode = logMode;
  if (isString(obj.skillsDir)) out.skillsDir = obj.skillsDir;

  if (isString(obj.systemPrompt)) out.systemPrompt = obj.systemPrompt;
  if (Array.isArray(obj.enabledSkills)) {
    out.enabledSkills = obj.enabledSkills.filter(
      (id): id is string => isString(id) && SKILL_ID_RE.test(id),
    );
  }
  if (
    isNumber(obj.controlPanelPort) &&
    obj.controlPanelPort >= 0 &&
    obj.controlPanelPort <= 65535
  ) {
    out.controlPanelPort = Math.floor(obj.controlPanelPort);
  }
  if (isNumber(obj.mcpPort) && obj.mcpPort >= 0 && obj.mcpPort <= 65535) {
    out.mcpPort = Math.floor(obj.mcpPort);
  }
  if (isString(obj.recorderCommand) && obj.recorderCommand.trim()) {
    out.recorderCommand = obj.recorderCommand.trim();
  }

  return out;
}

const oneOf = (allowed: readonly string[]): string => allowed.join(', ');

/** Why `sanitizePartial` drops a value, per top-level key. */
const REJECTION_REASONS: Partial<Record<keyof PartialConfig, string>> = {
  provider: `must be one of: ${oneOf(VALID_PROVIDERS)}`,
  baseUrl: 'must be a full URL starting with http:// or https://',
  model: 'must be text',
  apiKey: 'must be text, or null to clear it',
  temperature: 'must be a number',
  whisperCliPath: 'must be text',
  whisperModelPath: 'must be text',
  hotkeyCombo: 'must be text',
  hotkeyMode: `must be one of: ${oneOf(VALID_HOTKEY_MODES)}`,
  toggleHotkeyCombo: 'must be text',
  clipboardRestoreDelayMs: 'must be a number',
  clipboardRetention: `must be one of: ${oneOf(VALID_CLIPBOARD_RETENTION)}`,
  injectionMethod: `must be one of: ${oneOf(VALID_INJECTION_METHODS)}`,
  focusChangePolicy: `must be one of: ${oneOf(VALID_FOCUS_CHANGE_POLICIES)}`,
  progressiveInjection: 'must be true or false',
  queueMaxDepth: 'must be a number, at least 1',
  prewarm: 'must be true or false',
  vadEnabled: 'must be true or false',
  vadThresholdDb: 'must be a negative number (dB)',
  vadSilenceMs: 'must be a number greater than 0',
  vadLeadInMs: 'must be a number greater than 0',
  contextCapture: 'must be true or false',
  clipboardContextEntries: 'must be a number, at least 0',
  screenshotContext: 'must be true or false',
  appSkillRoutes:
    'every route needs a match string plus enable and disable lists of valid skill ids',
  systemPrompt: 'must be text',
  enabledSkills: 'must be a list of valid skill ids (lowercase letters, numbers, hyphens)',
  controlPanelPort: 'must be a whole number from 0 to 65535',
  mcpPort: 'must be a whole number from 0 to 65535',
  recorderCommand: 'must be a non-empty command line',
  logsDir: 'must be text',
  logMode: `must be one of: ${oneOf(VALID_LOG_MODES)}`,
  skillsDir: 'must be text',
};

const OVERLAY_REJECTION_REASONS: Record<string, string> = {
  anchor: `must be one of: ${oneOf(VALID_ANCHORS)}`,
  offsetX: 'must be a number',
  offsetY: 'must be a number',
  visible: 'must be true or false',
  position: 'must be null or an object with numeric x and y',
};

/**
 * Fields that were submitted in `input` but did not survive `sanitizePartial`,
 * each with a reason. `sanitizePartial` is built for best-effort file loading
 * and drops bad values silently; interactive saves use this to tell the user
 * instead. Values that are merely normalised (rounded, clamped) are not flagged.
 */
export function describeRejected(input: unknown, sanitized: PartialConfig): Record<string, string> {
  const rejected: Record<string, string> = {};
  if (!input || typeof input !== 'object' || Array.isArray(input)) return rejected;
  const obj = input as Record<string, unknown>;
  const kept = sanitized as Record<string, unknown>;

  for (const [key, reason] of Object.entries(REJECTION_REASONS)) {
    const value = obj[key];
    if (value === undefined) continue;
    const out = kept[key];
    const lostEntries =
      Array.isArray(value) && Array.isArray(out) ? out.length < value.length : false;
    if (out !== undefined && !lostEntries) continue;
    rejected[key] = key === 'baseUrl' ? `${reason}${suggestScheme(value)}` : reason;
  }

  const overlay = obj.overlay;
  if (overlay && typeof overlay === 'object') {
    const sent = overlay as Record<string, unknown>;
    const out = (sanitized.overlay ?? {}) as Record<string, unknown>;
    for (const [key, reason] of Object.entries(OVERLAY_REJECTION_REASONS)) {
      if (sent[key] !== undefined && out[key] === undefined) rejected[`overlay.${key}`] = reason;
    }
  }
  return rejected;
}

/** "localhost:1234/v1" is the common slip; offer the corrected URL. */
function suggestScheme(value: unknown): string {
  if (!isString(value)) return '';
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed) || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return '';
  return ` (did you mean http://${trimmed}?)`;
}
