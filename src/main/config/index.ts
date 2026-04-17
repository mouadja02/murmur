import os from 'node:os';
import path from 'node:path';
import { PROVIDER_PRESETS, type ProviderConfig } from '../providers/index.js';
import { type CliResult, parseCli } from './cli.js';
import { DEFAULT_CONFIG } from './defaults.js';
import { readConfigFile, writeDefaultConfigIfMissing } from './file.js';
import type { OverlayAnchor, OverlayPosition, PartialConfig, ResolvedConfig } from './schema.js';

export { HELP_TEXT } from './cli.js';
export { DEFAULT_CONFIG, DEFAULT_SYSTEM_PROMPT } from './defaults.js';
export { updateConfigFile } from './file.js';
export type { OverlayAnchor, OverlayPosition, PartialConfig, ResolvedConfig } from './schema.js';

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

  if (e.LLM_PROVIDER === 'ollama' || e.LLM_PROVIDER === 'openai-compat') {
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
  if (e.MURMUR_LOGS_DIR) partial.logsDir = e.MURMUR_LOGS_DIR;
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

  return partial;
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
  const cwdBase = process.cwd();
  if (sources.cli[key]) return resolvePath(sources.cli[key] as string, cwdBase);
  if (sources.file[key]) return resolvePath(sources.file[key] as string, sources.fileDir);
  if (sources.env[key]) return resolvePath(sources.env[key] as string, cwdBase);
  return resolvePath(fallback, cwdBase);
}

export interface LoadedConfig {
  resolved: ResolvedConfig;
  cli: CliResult;
  configFileExisted: boolean;
  configFileWritten: boolean;
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

  let fileLoad = readConfigFile(configFilePath);
  let written = false;
  if (!fileLoad.existed) {
    // Write absolute paths so that future runs from a different cwd still
    // resolve to the original install's whisper assets / logs / skills dirs.
    const cwdBase = process.cwd();
    const userDataDir = path.dirname(configFilePath);
    const seedDefaults = {
      ...DEFAULT_CONFIG,
      whisperCliPath: path.resolve(cwdBase, DEFAULT_CONFIG.whisperCliPath),
      whisperModelPath: path.resolve(cwdBase, DEFAULT_CONFIG.whisperModelPath),
      logsDir: path.resolve(cwdBase, DEFAULT_CONFIG.logsDir),
      skillsDir: path.resolve(userDataDir, 'skills'),
    };
    written = writeDefaultConfigIfMissing(configFilePath, seedDefaults);
    if (written) fileLoad = readConfigFile(configFilePath);
  }

  const env = readEnv();

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
  const sampleRate =
    pickFirst(sources.cli.sampleRate, sources.file.sampleRate, sources.env.sampleRate) ??
    DEFAULT_CONFIG.sampleRate;
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
    sampleRate,
    hotkeyCombo,
    toggleHotkeyCombo,
    clipboardRestoreDelayMs,
    overlayAnchor: overlay.anchor,
    overlayOffsetX: overlay.offsetX,
    overlayOffsetY: overlay.offsetY,
    overlayPosition: overlay.position,
    systemPrompt,
    enabledSkills,
    controlPanelPort,
    logsDir: resolveLayeredPath(sources, 'logsDir', DEFAULT_CONFIG.logsDir),
    skillsDir: resolveLayeredPath(sources, 'skillsDir', DEFAULT_CONFIG.skillsDir),
    configFilePath,
  };

  return {
    resolved,
    cli,
    configFileExisted: fileLoad.existed,
    configFileWritten: written,
  };
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
}
