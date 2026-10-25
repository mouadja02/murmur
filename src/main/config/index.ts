import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PROVIDER_PRESETS, type ProviderConfig } from '../providers/index.js';
import { type CliResult, parseCli } from './cli.js';
import { DEFAULT_CONFIG } from './defaults.js';
import { readConfigFile, writeDefaultConfigIfMissing } from './file.js';
import {
  type OverlayAnchor,
  type OverlayPosition,
  type PartialConfig,
  type ResolvedConfig,
  sanitizePartial,
} from './schema.js';

export { HELP_TEXT } from './cli.js';
export { DEFAULT_CONFIG, DEFAULT_SYSTEM_PROMPT } from './defaults.js';
export { getConfigFileError, updateConfigFile } from './file.js';
export type {
  AppSkillRoute,
  ClipboardRetention,
  InjectionMethod,
  LogMode,
  OverlayAnchor,
  OverlayPosition,
  PartialConfig,
  ResolvedConfig,
  RunMode,
} from './schema.js';

/**
 * Mirrors Electron's `app.getPath('userData')` for the "murmur" app name so
 * the pre-launch CLI (which runs in plain Node, no Electron) lands at the
 * exact same config file as the main process.
 */
export function getUserDataDir(appName = 'murmur'): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) return path.join(appData, appName);
    return path.join(os.homedir(), 'AppData', 'Roaming', appName);
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', appName);
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), appName);
}

function readEnv(): PartialConfig {
  const e = process.env;
  const partial: PartialConfig = {};

  if (
    e.LLM_PROVIDER === 'ollama' ||
    e.LLM_PROVIDER === 'openai-compat' ||
    e.LLM_PROVIDER === 'anthropic'
  ) {
    partial.provider = e.LLM_PROVIDER;
  }
  if (e.LLM_BASE_URL) partial.baseUrl = e.LLM_BASE_URL;
  else if (e.OLLAMA_URL) partial.baseUrl = e.OLLAMA_URL;
  if (e.LLM_MODEL) partial.model = e.LLM_MODEL;
  if (e.LLM_API_KEY) partial.apiKey = e.LLM_API_KEY;
  if (e.LLM_TEMPERATURE) {
    const n = Number(e.LLM_TEMPERATURE);
    if (Number.isFinite(n)) partial.temperature = n;
  }
  if (e.WHISPER_CLI_PATH) partial.whisperCliPath = e.WHISPER_CLI_PATH;
  if (e.WHISPER_MODEL_PATH) partial.whisperModelPath = e.WHISPER_MODEL_PATH;
  if (e.MURMUR_HOTKEY) partial.hotkeyCombo = e.MURMUR_HOTKEY;
  if (e.MURMUR_TOGGLE_HOTKEY) partial.toggleHotkeyCombo = e.MURMUR_TOGGLE_HOTKEY;
  if (e.MURMUR_CLIPBOARD_RESTORE_DELAY_MS) {
    const n = Number(e.MURMUR_CLIPBOARD_RESTORE_DELAY_MS);
    if (Number.isFinite(n)) partial.clipboardRestoreDelayMs = n;
  }
  if (
    e.MURMUR_CLIPBOARD_RETENTION === 'keep-generated' ||
    e.MURMUR_CLIPBOARD_RETENTION === 'restore-previous'
  ) {
    partial.clipboardRetention = e.MURMUR_CLIPBOARD_RETENTION;
  }
  if (
    e.MURMUR_INJECTION_METHOD === 'clipboard' ||
    e.MURMUR_INJECTION_METHOD === 'type' ||
    e.MURMUR_INJECTION_METHOD === 'auto'
  ) {
    partial.injectionMethod = e.MURMUR_INJECTION_METHOD;
  }
  if (e.MURMUR_PROGRESSIVE_INJECTION === 'true' || e.MURMUR_PROGRESSIVE_INJECTION === '1') {
    partial.progressiveInjection = true;
  } else if (e.MURMUR_PROGRESSIVE_INJECTION === 'false' || e.MURMUR_PROGRESSIVE_INJECTION === '0') {
    partial.progressiveInjection = false;
  }
  if (e.MURMUR_VAD_ENABLED === 'true' || e.MURMUR_VAD_ENABLED === '1') {
    partial.vadEnabled = true;
  } else if (e.MURMUR_VAD_ENABLED === 'false' || e.MURMUR_VAD_ENABLED === '0') {
    partial.vadEnabled = false;
  }
  if (e.MURMUR_VAD_THRESHOLD_DB) {
    const n = Number(e.MURMUR_VAD_THRESHOLD_DB);
    if (Number.isFinite(n) && n < 0) partial.vadThresholdDb = n;
  }
  if (e.MURMUR_VAD_SILENCE_MS) {
    const n = Number(e.MURMUR_VAD_SILENCE_MS);
    if (Number.isFinite(n) && n > 0) partial.vadSilenceMs = n;
  }
  if (e.MURMUR_VAD_LEAD_IN_MS) {
    const n = Number(e.MURMUR_VAD_LEAD_IN_MS);
    if (Number.isFinite(n) && n > 0) partial.vadLeadInMs = n;
  }
  if (e.MURMUR_CONTEXT_CAPTURE === 'true' || e.MURMUR_CONTEXT_CAPTURE === '1') {
    partial.contextCapture = true;
  } else if (e.MURMUR_CONTEXT_CAPTURE === 'false' || e.MURMUR_CONTEXT_CAPTURE === '0') {
    partial.contextCapture = false;
  }
  if (e.MURMUR_CLIPBOARD_CONTEXT_ENTRIES) {
    const n = Number(e.MURMUR_CLIPBOARD_CONTEXT_ENTRIES);
    if (Number.isFinite(n) && n >= 0) partial.clipboardContextEntries = Math.min(n, 5);
  }
  if (e.MURMUR_SCREENSHOT_CONTEXT === 'true' || e.MURMUR_SCREENSHOT_CONTEXT === '1') {
    partial.screenshotContext = true;
  } else if (e.MURMUR_SCREENSHOT_CONTEXT === 'false' || e.MURMUR_SCREENSHOT_CONTEXT === '0') {
    partial.screenshotContext = false;
  }
  if (e.MURMUR_LOGS_DIR) partial.logsDir = e.MURMUR_LOGS_DIR;
  if (e.MURMUR_LOG_MODE === 'metadata-only' || e.MURMUR_LOG_MODE === 'full') {
    partial.logMode = e.MURMUR_LOG_MODE;
  }
  if (e.MURMUR_SKILLS_DIR) partial.skillsDir = e.MURMUR_SKILLS_DIR;
  if (e.MURMUR_SYSTEM_PROMPT) partial.systemPrompt = e.MURMUR_SYSTEM_PROMPT;
  if (e.MURMUR_ENABLED_SKILLS) {
    partial.enabledSkills = e.MURMUR_ENABLED_SKILLS.split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }
  if (e.MURMUR_CONTROL_PANEL_PORT) {
    const n = Number(e.MURMUR_CONTROL_PANEL_PORT);
    if (Number.isFinite(n)) partial.controlPanelPort = n;
  }
  if (e.MURMUR_MCP_PORT) {
    const n = Number(e.MURMUR_MCP_PORT);
    if (Number.isFinite(n)) partial.mcpPort = n;
  }
  if (e.MURMUR_RECORDER_COMMAND) partial.recorderCommand = e.MURMUR_RECORDER_COMMAND;

  return sanitizePartial(partial, 'env');
}

function pickFirst<T>(...candidates: (T | null | undefined)[]): T | undefined {
  for (const c of candidates) {
    if (c !== undefined && c !== null) return c;
  }
  return undefined;
}

function resolvePath(p: string, baseDir: string): string {
  return path.isAbsolute(p) ? p : path.resolve(baseDir, p);
}

/**
 * Like `resolvePath`, but preserves bare command names (no path separators) so
 * the OS can resolve them against `$PATH` at runtime. Silently rewriting a
 * value like `whisper-cli` into `<configDir>/whisper-cli` makes preflight
 * checks fail on machines where the binary is installed to `~/.local/bin`
 * rather than the user data dir.
 */
function resolvePathOrBare(p: string, baseDir: string): string {
  if (path.isAbsolute(p)) return p;
  if (!p.includes('/') && !p.includes('\\')) return p;
  return path.resolve(baseDir, p);
}

interface MergeSources {
  cli: PartialConfig;
  file: PartialConfig;
  fileDir: string;
  env: PartialConfig;
}

function mergeOverlay(sources: MergeSources): {
  anchor: OverlayAnchor;
  offsetX: number;
  offsetY: number;
  position: OverlayPosition | null;
  visible: boolean;
} {
  const cli = sources.cli.overlay ?? {};
  const file = sources.file.overlay ?? {};
  const env = sources.env.overlay ?? {};
  // Position only comes from file or CLI; env is awkward to encode coords in.
  let position: OverlayPosition | null = null;
  if (cli.position !== undefined) position = cli.position;
  else if (file.position !== undefined) position = file.position;
  return {
    anchor: pickFirst(cli.anchor, file.anchor, env.anchor) ?? DEFAULT_CONFIG.overlay.anchor,
    offsetX: pickFirst(cli.offsetX, file.offsetX, env.offsetX) ?? DEFAULT_CONFIG.overlay.offsetX,
    offsetY: pickFirst(cli.offsetY, file.offsetY, env.offsetY) ?? DEFAULT_CONFIG.overlay.offsetY,
    position,
    visible: pickFirst(cli.visible, file.visible, env.visible) ?? true,
  };
}

function pickApiKey(sources: MergeSources): string | null {
  for (const s of [sources.cli, sources.file, sources.env]) {
    if (s.apiKey !== undefined) return s.apiKey;
  }
  return DEFAULT_CONFIG.apiKey;
}

function resolveLayeredPath(
  sources: MergeSources,
  key: 'whisperCliPath' | 'whisperModelPath' | 'logsDir' | 'skillsDir',
  fallback: string,
): string {
  // whisper-cli is the only value that can meaningfully be a bare PATH
  // command (e.g. after `apt-get install whisper.cpp` or a build that lands in
  // `~/.local/bin`). Model / logs / skills are always file-system locations.
  const resolver = key === 'whisperCliPath' ? resolvePathOrBare : resolvePath;
  const cwdBase = process.cwd();
  if (sources.cli[key]) return resolver(sources.cli[key] as string, cwdBase);
  if (sources.file[key]) return resolver(sources.file[key] as string, sources.fileDir);
  if (sources.env[key]) return resolver(sources.env[key] as string, cwdBase);
  // Logs belong next to the config, not wherever the process happened to start
  // (under `npx` that is the user's home folder).
  if (key === 'logsDir') return resolver(fallback, sources.fileDir);
  return resolver(fallback, cwdBase);
}

/**
 * Identifies which higher-precedence source (CLI flag or env var) is currently
 * pinning a given resolved config field, making it impossible to change via the
 * control panel.  Keys match `ResolvedConfig` field names.  When a field is
 * absent from this map, the file (or default) is in effect and the panel can
 * persist edits to it.
 */
export type ConfigOverrides = Partial<Record<keyof ResolvedConfig, 'cli' | 'env'>>;
/**
 * Env vars that are set but lose to a higher-precedence source, so changing them
 * has no effect. `by` is the source that wins; `envVar` is the variable's name.
 */
export type ConfigShadowedEnv = Partial<
  Record<keyof ResolvedConfig, { envVar: string; by: 'cli' | 'file' }>
>;
export type ConfigValueSource = 'cli' | 'file' | 'env' | 'default';
export type ConfigValueSources = Partial<Record<keyof ResolvedConfig, ConfigValueSource>>;

export interface LoadedConfig {
  resolved: ResolvedConfig;
  cli: CliResult;
  configFileExisted: boolean;
  configFileWritten: boolean;
  /** Set when config.json exists but could not be read or parsed; defaults are in use and the file is left untouched. */
  configFileError: string | null;
  overrides: ConfigOverrides;
  shadowedEnv: ConfigShadowedEnv;
  valueSources: ConfigValueSources;
}

export interface LoadConfigOptions {
  /** Where the JSON config lives by default. Pass `app.getPath('userData')` from Electron. */
  userDataDir: string;
  /** Defaults to `process.argv`. */
  argv?: readonly string[];
}

/**
 * Resolves the runtime config from CLI flags, the user config file, and `.env`.
 * Pure Node — no Electron import — so the pre-launch CLI can reuse it.
 */
export function loadConfig(opts: LoadConfigOptions): LoadedConfig {
  const cli = parseCli(opts.argv ?? process.argv);

  const configFilePath = path.resolve(
    cli.configFilePath ?? path.join(opts.userDataDir, 'config.json'),
  );
  const env = readEnv();

  let fileLoad = readConfigFile(configFilePath);
  let written = false;
  if (!fileLoad.existed) {
    // Write absolute paths into the first-time config so that future runs from
    // a different cwd still find whisper + logs + skills correctly.
    //
    // On Windows the first-run installer (`setup-whisper.ps1 -InstallDir`)
    // extracts whisper into <userData>/bin/whisper/. A dev checkout that ran
    // `pnpm setup:whisper` has it under ./bin/whisper/ instead, so prefer that
    // only when it actually exists. Never seed against a bare cwd: under `npx`
    // that is the user's home folder.
    // On Linux/macOS whisper-cli is a plain PATH command — store just the name,
    // not an absolute path, so it keeps working after the binary is moved.
    // The model file is downloaded into the user data dir by `setup:whisper`.
    const userDataDir = path.dirname(configFilePath);
    const IS_WINDOWS = process.platform === 'win32';
    const devWhisperCli = path.resolve(process.cwd(), DEFAULT_CONFIG.whisperCliPath);
    const whisperBase = IS_WINDOWS && existsSync(devWhisperCli) ? process.cwd() : userDataDir;
    // Seed only what has to be absolute. A seeded default outranks the same key's
    // env var forever (CLI > file > env), so every other key is left out and
    // falls through to env, then to the built-in default. A path whose env var
    // is set right now is skipped for the same reason.
    const seedDefaults: Record<string, unknown> = {
      whisperCliPath: IS_WINDOWS
        ? path.resolve(whisperBase, DEFAULT_CONFIG.whisperCliPath)
        : DEFAULT_CONFIG.whisperCliPath, // bare name, resolved via PATH at runtime
      whisperModelPath: IS_WINDOWS
        ? path.resolve(whisperBase, DEFAULT_CONFIG.whisperModelPath)
        : path.join(userDataDir, 'models', 'ggml-base.en.bin'),
      logsDir: path.resolve(userDataDir, 'logs'),
      skillsDir: path.resolve(userDataDir, 'skills'),
    };
    for (const key of Object.keys(env)) delete seedDefaults[key];
    if (cli.helpAndExit || cli.printAndExit) {
      // Informational runs must not leave a config file behind; show the values
      // a real first run would seed.
      fileLoad = { ...fileLoad, partial: sanitizePartial(seedDefaults, 'seed defaults') };
    } else {
      written = writeDefaultConfigIfMissing(configFilePath, seedDefaults);
      if (written) fileLoad = readConfigFile(configFilePath);
    }
  } else if (process.platform !== 'win32' && fileLoad.partial.whisperCliPath) {
    // Migration: if an existing Linux/macOS config has a Windows-style path
    // (contains backslash or /mnt/c/) or an absolute path that no longer exists
    // (e.g. was seeded from a stale cwd or user data dir), reset whisperCliPath
    // to the bare PATH name and whisperModelPath to the user-data-relative path.
    const cli_path = fileLoad.partial.whisperCliPath;
    const userDataDir = path.dirname(configFilePath);
    const isStale =
      cli_path.includes('\\') ||
      cli_path.startsWith('/mnt/') ||
      (path.isAbsolute(cli_path) && !existsSync(cli_path));
    if (isStale) {
      const modelDefault = path.join(userDataDir, 'models', 'ggml-base.en.bin');
      fileLoad = {
        ...fileLoad,
        partial: {
          ...fileLoad.partial,
          whisperCliPath: DEFAULT_CONFIG.whisperCliPath,
          // Only reset the model path if it's also stale/missing
          ...(fileLoad.partial.whisperModelPath &&
          path.isAbsolute(fileLoad.partial.whisperModelPath) &&
          !existsSync(fileLoad.partial.whisperModelPath)
            ? { whisperModelPath: modelDefault }
            : {}),
        },
      };
    }
  } else if (process.platform === 'win32') {
    // Migration: configs seeded by <=0.6.x on Windows pointed whisper at
    // <cwd>/bin/whisper (the user's home folder under `npx`), while the
    // installer puts it in <userData>/bin/whisper. If the configured file is
    // gone but the installer's copy exists, use that instead.
    const userDataDir = path.dirname(configFilePath);
    const installed = {
      whisperCliPath: path.resolve(userDataDir, DEFAULT_CONFIG.whisperCliPath),
      whisperModelPath: path.resolve(userDataDir, DEFAULT_CONFIG.whisperModelPath),
    };
    const partial = { ...fileLoad.partial };
    for (const key of ['whisperCliPath', 'whisperModelPath'] as const) {
      const configured = partial[key];
      if (
        configured &&
        path.isAbsolute(configured) &&
        !existsSync(configured) &&
        existsSync(installed[key])
      ) {
        partial[key] = installed[key];
      }
    }
    fileLoad = { ...fileLoad, partial };
  }

  const sources: MergeSources = {
    cli: cli.partial,
    file: fileLoad.partial,
    fileDir: path.dirname(configFilePath),
    env,
  };

  const provider =
    pickFirst(sources.cli.provider, sources.file.provider, sources.env.provider) ??
    DEFAULT_CONFIG.provider;
  const baseUrl =
    pickFirst(sources.cli.baseUrl, sources.file.baseUrl, sources.env.baseUrl) ??
    DEFAULT_CONFIG.baseUrl;
  const model =
    pickFirst(sources.cli.model, sources.file.model, sources.env.model) ?? DEFAULT_CONFIG.model;
  const temperature =
    pickFirst(sources.cli.temperature, sources.file.temperature, sources.env.temperature) ??
    DEFAULT_CONFIG.temperature;
  const hotkeyCombo =
    pickFirst(sources.cli.hotkeyCombo, sources.file.hotkeyCombo, sources.env.hotkeyCombo) ??
    DEFAULT_CONFIG.hotkeyCombo;
  const toggleHotkeyCombo =
    pickFirst(
      sources.cli.toggleHotkeyCombo,
      sources.file.toggleHotkeyCombo,
      sources.env.toggleHotkeyCombo,
    ) ?? DEFAULT_CONFIG.toggleHotkeyCombo;
  const clipboardRestoreDelayMs =
    pickFirst(
      sources.cli.clipboardRestoreDelayMs,
      sources.file.clipboardRestoreDelayMs,
      sources.env.clipboardRestoreDelayMs,
    ) ?? DEFAULT_CONFIG.clipboardRestoreDelayMs;
  const clipboardRetention =
    pickFirst(
      sources.cli.clipboardRetention,
      sources.file.clipboardRetention,
      sources.env.clipboardRetention,
    ) ?? DEFAULT_CONFIG.clipboardRetention;
  const injectionMethod =
    pickFirst(
      sources.cli.injectionMethod,
      sources.file.injectionMethod,
      sources.env.injectionMethod,
    ) ?? DEFAULT_CONFIG.injectionMethod;
  const progressiveInjection =
    pickFirst(
      sources.cli.progressiveInjection,
      sources.file.progressiveInjection,
      sources.env.progressiveInjection,
    ) ?? DEFAULT_CONFIG.progressiveInjection;
  const queueMaxDepth =
    pickFirst(sources.cli.queueMaxDepth, sources.file.queueMaxDepth, sources.env.queueMaxDepth) ??
    DEFAULT_CONFIG.queueMaxDepth;
  const prewarm =
    pickFirst(sources.cli.prewarm, sources.file.prewarm, sources.env.prewarm) ??
    DEFAULT_CONFIG.prewarm;

  const vadEnabled =
    pickFirst(sources.cli.vadEnabled, sources.file.vadEnabled, sources.env.vadEnabled) ??
    DEFAULT_CONFIG.vadEnabled;
  const vadThresholdDb =
    pickFirst(
      sources.cli.vadThresholdDb,
      sources.file.vadThresholdDb,
      sources.env.vadThresholdDb,
    ) ?? DEFAULT_CONFIG.vadThresholdDb;
  const vadSilenceMs =
    pickFirst(sources.cli.vadSilenceMs, sources.file.vadSilenceMs, sources.env.vadSilenceMs) ??
    DEFAULT_CONFIG.vadSilenceMs;
  const vadLeadInMs =
    pickFirst(sources.cli.vadLeadInMs, sources.file.vadLeadInMs, sources.env.vadLeadInMs) ??
    DEFAULT_CONFIG.vadLeadInMs;

  const contextCapture =
    pickFirst(
      sources.cli.contextCapture,
      sources.file.contextCapture,
      sources.env.contextCapture,
    ) ?? DEFAULT_CONFIG.contextCapture;
  const clipboardContextEntries =
    pickFirst(
      sources.cli.clipboardContextEntries,
      sources.file.clipboardContextEntries,
      sources.env.clipboardContextEntries,
    ) ?? DEFAULT_CONFIG.clipboardContextEntries;
  const screenshotContext =
    pickFirst(
      sources.cli.screenshotContext,
      sources.file.screenshotContext,
      sources.env.screenshotContext,
    ) ?? DEFAULT_CONFIG.screenshotContext;
  const appSkillRoutes =
    pickFirst(
      sources.cli.appSkillRoutes,
      sources.file.appSkillRoutes,
      sources.env.appSkillRoutes,
    ) ?? DEFAULT_CONFIG.appSkillRoutes;

  const overlay = mergeOverlay(sources);

  const systemPrompt =
    pickFirst(sources.cli.systemPrompt, sources.file.systemPrompt, sources.env.systemPrompt) ??
    DEFAULT_CONFIG.systemPrompt;
  const enabledSkills =
    pickFirst(sources.cli.enabledSkills, sources.file.enabledSkills, sources.env.enabledSkills) ??
    DEFAULT_CONFIG.enabledSkills;
  const controlPanelPort =
    pickFirst(
      sources.cli.controlPanelPort,
      sources.file.controlPanelPort,
      sources.env.controlPanelPort,
    ) ?? DEFAULT_CONFIG.controlPanelPort;
  const logMode =
    pickFirst(sources.cli.logMode, sources.file.logMode, sources.env.logMode) ??
    DEFAULT_CONFIG.logMode;
  const mcpPort =
    pickFirst(sources.cli.mcpPort, sources.file.mcpPort, sources.env.mcpPort) ??
    DEFAULT_CONFIG.mcpPort;
  const recorderCommand =
    pickFirst(
      sources.cli.recorderCommand,
      sources.file.recorderCommand,
      sources.env.recorderCommand,
    ) ?? DEFAULT_CONFIG.recorderCommand;

  const resolved: ResolvedConfig = {
    provider,
    baseUrl,
    model,
    apiKey: pickApiKey(sources),
    temperature,
    whisperCliPath: resolveLayeredPath(sources, 'whisperCliPath', DEFAULT_CONFIG.whisperCliPath),
    whisperModelPath: resolveLayeredPath(
      sources,
      'whisperModelPath',
      DEFAULT_CONFIG.whisperModelPath,
    ),
    hotkeyCombo,
    toggleHotkeyCombo,
    clipboardRestoreDelayMs,
    clipboardRetention,
    injectionMethod,
    progressiveInjection:
      injectionMethod === 'clipboard' && progressiveInjection ? false : progressiveInjection,
    queueMaxDepth,
    prewarm,
    vadEnabled,
    vadThresholdDb,
    vadSilenceMs,
    vadLeadInMs,
    contextCapture,
    clipboardContextEntries,
    screenshotContext,
    appSkillRoutes,
    overlayAnchor: overlay.anchor,
    overlayOffsetX: overlay.offsetX,
    overlayOffsetY: overlay.offsetY,
    overlayPosition: overlay.position,
    overlayVisible: overlay.visible,
    systemPrompt,
    enabledSkills,
    controlPanelPort,
    logMode,
    mcpPort,
    recorderCommand,
    logsDir: resolveLayeredPath(sources, 'logsDir', DEFAULT_CONFIG.logsDir),
    skillsDir: resolveLayeredPath(sources, 'skillsDir', DEFAULT_CONFIG.skillsDir),
    configFilePath,
  };

  if (resolved.injectionMethod === 'clipboard' && progressiveInjection) {
    console.warn(
      '[config] progressiveInjection is incompatible with injectionMethod "clipboard"; disabling progressive injection',
    );
  }

  return {
    resolved,
    cli,
    configFileExisted: fileLoad.existed,
    configFileWritten: written,
    configFileError: fileLoad.error ?? null,
    overrides: computeOverrides(sources),
    shadowedEnv: computeShadowedEnv(sources),
    valueSources: computeValueSources(sources),
  };
}

function sourceOf(sources: MergeSources, key: keyof PartialConfig): ConfigValueSource {
  const cli = sources.cli as Record<string, unknown>;
  const file = sources.file as Record<string, unknown>;
  const env = sources.env as Record<string, unknown>;
  if (cli[key] !== undefined && cli[key] !== null) return 'cli';
  if (file[key] !== undefined && file[key] !== null) return 'file';
  if (env[key] !== undefined && env[key] !== null) return 'env';
  return 'default';
}

function computeValueSources(sources: MergeSources): ConfigValueSources {
  const out: ConfigValueSources = {};
  const fields: (keyof PartialConfig)[] = [
    'provider',
    'baseUrl',
    'model',
    'apiKey',
    'temperature',
    'whisperCliPath',
    'whisperModelPath',
    'hotkeyCombo',
    'toggleHotkeyCombo',
    'clipboardRestoreDelayMs',
    'clipboardRetention',
    'injectionMethod',
    'progressiveInjection',
    'queueMaxDepth',
    'prewarm',
    'vadEnabled',
    'vadThresholdDb',
    'vadSilenceMs',
    'vadLeadInMs',
    'contextCapture',
    'clipboardContextEntries',
    'screenshotContext',
    'appSkillRoutes',
    'logMode',
    'systemPrompt',
    'enabledSkills',
    'controlPanelPort',
    'mcpPort',
    'recorderCommand',
    'logsDir',
    'skillsDir',
  ];
  for (const key of fields) {
    out[key as keyof ResolvedConfig] = sourceOf(sources, key);
  }
  return out;
}

/**
 * For each resolved field, record whether its current value is being pinned by
 * a CLI flag or environment variable.  Only the *winning* source counts: an env
 * var that the config file outranks is not a lock (see `computeShadowedEnv`).
 * Anything not in the returned map is coming from the JSON config file (or
 * built-in defaults) and is therefore editable via the control panel.
 */
function computeOverrides(sources: MergeSources): ConfigOverrides {
  const out: ConfigOverrides = {};
  const fields: (keyof ResolvedConfig)[] = [
    'provider',
    'baseUrl',
    'model',
    'apiKey',
    'temperature',
    'whisperCliPath',
    'whisperModelPath',
    'hotkeyCombo',
    'toggleHotkeyCombo',
    'clipboardRestoreDelayMs',
    'clipboardRetention',
    'injectionMethod',
    'progressiveInjection',
    'queueMaxDepth',
    'prewarm',
    'vadEnabled',
    'vadThresholdDb',
    'vadSilenceMs',
    'vadLeadInMs',
    'contextCapture',
    'clipboardContextEntries',
    'screenshotContext',
    'appSkillRoutes',
    'logMode',
    'systemPrompt',
    'enabledSkills',
    'controlPanelPort',
    'mcpPort',
    'recorderCommand',
    'logsDir',
    'skillsDir',
  ];
  for (const key of fields) {
    const source = sourceOf(sources, key as keyof PartialConfig);
    if (source === 'cli' || source === 'env') out[key] = source;
  }
  return out;
}

/** Env var(s) that feed each config field; the first one set is reported. */
const ENV_VARS: Partial<Record<keyof PartialConfig, readonly string[]>> = {
  provider: ['LLM_PROVIDER'],
  baseUrl: ['LLM_BASE_URL', 'OLLAMA_URL'],
  model: ['LLM_MODEL'],
  apiKey: ['LLM_API_KEY'],
  temperature: ['LLM_TEMPERATURE'],
  whisperCliPath: ['WHISPER_CLI_PATH'],
  whisperModelPath: ['WHISPER_MODEL_PATH'],
  hotkeyCombo: ['MURMUR_HOTKEY'],
  toggleHotkeyCombo: ['MURMUR_TOGGLE_HOTKEY'],
  clipboardRestoreDelayMs: ['MURMUR_CLIPBOARD_RESTORE_DELAY_MS'],
  clipboardRetention: ['MURMUR_CLIPBOARD_RETENTION'],
  injectionMethod: ['MURMUR_INJECTION_METHOD'],
  progressiveInjection: ['MURMUR_PROGRESSIVE_INJECTION'],
  vadEnabled: ['MURMUR_VAD_ENABLED'],
  vadThresholdDb: ['MURMUR_VAD_THRESHOLD_DB'],
  vadSilenceMs: ['MURMUR_VAD_SILENCE_MS'],
  vadLeadInMs: ['MURMUR_VAD_LEAD_IN_MS'],
  contextCapture: ['MURMUR_CONTEXT_CAPTURE'],
  clipboardContextEntries: ['MURMUR_CLIPBOARD_CONTEXT_ENTRIES'],
  screenshotContext: ['MURMUR_SCREENSHOT_CONTEXT'],
  logsDir: ['MURMUR_LOGS_DIR'],
  logMode: ['MURMUR_LOG_MODE'],
  skillsDir: ['MURMUR_SKILLS_DIR'],
  systemPrompt: ['MURMUR_SYSTEM_PROMPT'],
  enabledSkills: ['MURMUR_ENABLED_SKILLS'],
  controlPanelPort: ['MURMUR_CONTROL_PANEL_PORT'],
  mcpPort: ['MURMUR_MCP_PORT'],
  recorderCommand: ['MURMUR_RECORDER_COMMAND'],
};

function computeShadowedEnv(sources: MergeSources): ConfigShadowedEnv {
  const out: ConfigShadowedEnv = {};
  const env = sources.env as Record<string, unknown>;
  for (const [key, names] of Object.entries(ENV_VARS)) {
    if (env[key] === undefined || env[key] === null) continue;
    const by = sourceOf(sources, key as keyof PartialConfig);
    if (by !== 'cli' && by !== 'file') continue;
    const envVar = names.find((n) => process.env[n]) ?? names[0];
    out[key as keyof ResolvedConfig] = { envVar, by };
  }
  return out;
}

/** Human-readable lines for `computeShadowedEnv`, for startup logs. */
export function describeShadowedEnv(shadowed: ConfigShadowedEnv): string[] {
  return Object.entries(shadowed).map(([field, info]) =>
    info.by === 'cli'
      ? `${info.envVar} is set but a CLI flag overrides ${field}`
      : `${info.envVar} is set but config.json overrides it: edit or remove "${field}" in config.json to use the env var`,
  );
}

export function getProviderConfig(cfg: ResolvedConfig): ProviderConfig {
  return {
    id: cfg.provider,
    displayName: PROVIDER_PRESETS[cfg.provider].displayName,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    apiKey: cfg.apiKey,
    temperature: cfg.temperature,
  };
}

export function printResolvedConfig(loaded: LoadedConfig): void {
  const safe = { ...loaded.resolved, apiKey: loaded.resolved.apiKey ? '***' : null };
  console.log(JSON.stringify(safe, null, 2));
  console.log(`\nconfig file: ${loaded.resolved.configFilePath}`);
  console.log(`  existed: ${loaded.configFileExisted}`);
  console.log(`  written: ${loaded.configFileWritten}`);
  if (loaded.configFileError) console.log(`  error: ${loaded.configFileError}`);
}
