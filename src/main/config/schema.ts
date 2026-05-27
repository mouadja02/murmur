import type { ProviderId } from '../providers/index.js';

export type RunMode = 'gui' | 'serve';

export type OverlayAnchor = 'bottom-center' | 'bottom-right' | 'top-right' | 'free';

export type InjectionMethod = 'clipboard' | 'type' | 'auto';
export type ClipboardRetention = 'keep-generated' | 'restore-previous';
export type LogMode = 'metadata-only' | 'full';

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
  clipboardRetention: ClipboardRetention;
  injectionMethod: InjectionMethod;
  queueMaxDepth: number;
  prewarm: boolean;

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

  sampleRate?: number;
  hotkeyCombo?: string;
  toggleHotkeyCombo?: string;
  clipboardRestoreDelayMs?: number;
  clipboardRetention?: ClipboardRetention;
  injectionMethod?: InjectionMethod;
  queueMaxDepth?: number;
  prewarm?: boolean;

  overlay?: {
    anchor?: OverlayAnchor;
    offsetX?: number;
    offsetY?: number;
    position?: OverlayPosition | null;
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

  if (isNumber(obj.sampleRate)) out.sampleRate = obj.sampleRate;
  if (isString(obj.hotkeyCombo)) out.hotkeyCombo = obj.hotkeyCombo;
  if (isString(obj.toggleHotkeyCombo)) out.toggleHotkeyCombo = obj.toggleHotkeyCombo;
  if (isNumber(obj.clipboardRestoreDelayMs)) {
    out.clipboardRestoreDelayMs = obj.clipboardRestoreDelayMs;
  }
  const clipboardRetention = pick(obj.clipboardRetention, VALID_CLIPBOARD_RETENTION);
  if (clipboardRetention) out.clipboardRetention = clipboardRetention;

  const injectionMethod = pick(obj.injectionMethod, VALID_INJECTION_METHODS);
  if (injectionMethod) out.injectionMethod = injectionMethod;

  if (isNumber(obj.queueMaxDepth) && obj.queueMaxDepth >= 1) {
    out.queueMaxDepth = Math.floor(obj.queueMaxDepth);
  }

  if (typeof obj.prewarm === 'boolean') out.prewarm = obj.prewarm;

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
