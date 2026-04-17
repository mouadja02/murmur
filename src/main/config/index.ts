import path from 'node:path';
import { app } from 'electron';
import { PROVIDER_PRESETS, type ProviderConfig } from '../providers/index.js';
import { type CliResult, parseCli } from './cli.js';
import { DEFAULT_CONFIG } from './defaults.js';
import { readConfigFile, writeDefaultConfigIfMissing } from './file.js';
import type { OverlayAnchor, PartialConfig, ResolvedConfig } from './schema.js';

export type { ResolvedConfig, PartialConfig, OverlayAnchor } from './schema.js';
export { HELP_TEXT } from './cli.js';

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
  if (e.MURMUR_LOGS_DIR) partial.logsDir = e.MURMUR_LOGS_DIR;

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
} {
  const cli = sources.cli.overlay ?? {};
  const file = sources.file.overlay ?? {};
  const env = sources.env.overlay ?? {};
  return {
    anchor: pickFirst(cli.anchor, file.anchor, env.anchor) ?? DEFAULT_CONFIG.overlay.anchor,
    offsetX: pickFirst(cli.offsetX, file.offsetX, env.offsetX) ?? DEFAULT_CONFIG.overlay.offsetX,
    offsetY: pickFirst(cli.offsetY, file.offsetY, env.offsetY) ?? DEFAULT_CONFIG.overlay.offsetY,
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
  key: 'whisperCliPath' | 'whisperModelPath' | 'logsDir',
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

/**
 * Resolves the runtime config from CLI flags, the user config file, and `.env`.
 * MUST be called after `app.whenReady()` because we use `app.getPath`.
 */
export function loadConfig(argv: readonly string[] = process.argv): LoadedConfig {
  const cli = parseCli(argv);

  const configFilePath = path.resolve(
    cli.configFilePath ?? path.join(app.getPath('userData'), 'config.json'),
  );

  const fileLoad = readConfigFile(configFilePath);
  const written = !fileLoad.existed
    ? writeDefaultConfigIfMissing(configFilePath, DEFAULT_CONFIG)
    : false;

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
  const clipboardRestoreDelayMs =
    pickFirst(
      sources.cli.clipboardRestoreDelayMs,
      sources.file.clipboardRestoreDelayMs,
      sources.env.clipboardRestoreDelayMs,
    ) ?? DEFAULT_CONFIG.clipboardRestoreDelayMs;

  const overlay = mergeOverlay(sources);

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
    clipboardRestoreDelayMs,
    overlayAnchor: overlay.anchor,
    overlayOffsetX: overlay.offsetX,
    overlayOffsetY: overlay.offsetY,
    logsDir: resolveLayeredPath(sources, 'logsDir', DEFAULT_CONFIG.logsDir),
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
