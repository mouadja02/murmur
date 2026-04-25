import process from 'node:process';
import pc from 'picocolors';
import prompts from 'prompts';
import { DEFAULT_CONFIG } from '../config/defaults.js';
import {
  type ConfigValueSource,
  type ConfigValueSources,
  type ResolvedConfig,
  updateConfigFile,
} from '../config/index.js';
import { PROVIDER_PRESETS, type ProviderId } from '../providers/index.js';

type LlmField = 'provider' | 'baseUrl' | 'model';

const LLM_FIELDS: LlmField[] = ['provider', 'baseUrl', 'model'];
const PROVIDER_IDS: ProviderId[] = ['ollama', 'openai-compat', 'anthropic'];
const ENV_NAMES: Record<LlmField, string> = {
  provider: 'LLM_PROVIDER',
  baseUrl: 'LLM_BASE_URL',
  model: 'LLM_MODEL',
};

export type LlmSetupSources = Partial<Record<LlmField | 'apiKey', ConfigValueSource>>;
export type LlmSetupConfig = Pick<
  ResolvedConfig,
  'provider' | 'baseUrl' | 'model' | 'apiKey' | 'configFilePath'
>;

export interface LlmSetupAnswers {
  provider?: string;
  baseUrl?: string;
  model?: string;
  apiKey?: string;
}

export interface LlmSetupResult {
  changes: Partial<ResolvedConfig>;
  userDeclined: boolean;
}

function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

function sourceFor(sources: ConfigValueSources | LlmSetupSources, field: LlmField | 'apiKey') {
  return sources[field] ?? 'default';
}

function shouldAsk(source: ConfigValueSource): boolean {
  return source !== 'cli' && source !== 'file';
}

export function shouldRunLlmSetup(
  configFileWritten: boolean,
  sources: ConfigValueSources | LlmSetupSources,
): boolean {
  if (!configFileWritten) return false;
  return LLM_FIELDS.some((field) => shouldAsk(sourceFor(sources, field)));
}

export function validateRequiredLlmAnswer(value: string, envName: string): true | string {
  return value.trim() ? true : `${envName} is required`;
}

function readAnswer(
  answers: LlmSetupAnswers,
  field: LlmField,
  cfg: LlmSetupConfig,
  sources: ConfigValueSources | LlmSetupSources,
): string | null {
  const source = sourceFor(sources, field);
  if (!shouldAsk(source)) return null;

  const raw = answers[field];
  const value = raw?.trim() ?? '';
  if (!value) {
    if (source === 'env') return null;
    throw new Error(`${ENV_NAMES[field]} is required`);
  }
  if (field === 'provider' && !isProviderId(value)) {
    throw new Error(`LLM_PROVIDER must be one of: ${PROVIDER_IDS.join(', ')}`);
  }
  if (source === 'env' && value === cfg[field]) return null;
  return value;
}

export function buildLlmSetupUpdate(
  cfg: LlmSetupConfig,
  sources: ConfigValueSources | LlmSetupSources,
  answers: LlmSetupAnswers,
): Partial<ResolvedConfig> {
  const update: Partial<ResolvedConfig> = {};

  const provider = readAnswer(answers, 'provider', cfg, sources);
  if (provider !== null) update.provider = provider as ProviderId;

  const baseUrl = readAnswer(answers, 'baseUrl', cfg, sources);
  if (baseUrl !== null) update.baseUrl = baseUrl;

  const model = readAnswer(answers, 'model', cfg, sources);
  if (model !== null) update.model = model;

  const apiKey = answers.apiKey?.trim();
  if (apiKey) update.apiKey = apiKey;

  return update;
}

function saveLlmConfig(configFilePath: string, update: Partial<ResolvedConfig>): void {
  updateConfigFile(configFilePath, (raw) => {
    if (update.provider !== undefined) raw.provider = update.provider;
    if (update.baseUrl !== undefined) raw.baseUrl = update.baseUrl;
    if (update.model !== undefined) raw.model = update.model;
    if (update.apiKey !== undefined) raw.apiKey = update.apiKey;
  });
}

function promptInitial(
  cfg: LlmSetupConfig,
  sources: ConfigValueSources | LlmSetupSources,
  field: LlmField,
): string | undefined {
  return sourceFor(sources, field) === 'env' ? cfg[field] : undefined;
}

function providerSuggestion(provider: ProviderId): string {
  return PROVIDER_PRESETS[provider]?.defaultBaseUrl ?? DEFAULT_CONFIG.baseUrl;
}

function providerFromAnswer(answer: string | undefined, fallback: ProviderId): ProviderId {
  const trimmed = answer?.trim() ?? '';
  return trimmed && isProviderId(trimmed) ? trimmed : fallback;
}

async function askText(
  name: LlmField,
  message: string,
  initial: string | undefined,
  source: ConfigValueSource,
): Promise<string> {
  const { value } = await prompts(
    {
      type: 'text',
      name: 'value',
      message,
      initial,
      validate: (input: string) =>
        source === 'env' && input.trim() === ''
          ? true
          : validateRequiredLlmAnswer(input, ENV_NAMES[name]),
    },
    { onCancel: () => process.exit(1) },
  );
  return typeof value === 'string' ? value : '';
}

/**
 * First-run LLM setup. Env values are shown as defaults and left in env when the
 * user submits blank; fields with no env/file/CLI value require explicit input.
 */
export async function runLlmSetup(ctx: {
  cfg: ResolvedConfig;
  valueSources: ConfigValueSources;
  configFileWritten: boolean;
}): Promise<LlmSetupResult> {
  const changes: Partial<ResolvedConfig> = {};

  if (!process.stdin.isTTY) return { changes, userDeclined: true };
  if (!shouldRunLlmSetup(ctx.configFileWritten, ctx.valueSources)) {
    return { changes, userDeclined: false };
  }

  console.log('');
  console.log(pc.bold('  ── LLM setup ─────────────────────────────────────────────'));
  console.log(pc.dim('  Press Enter on env-backed fields to keep using the environment value.'));
  console.log('');

  const answers: LlmSetupAnswers = {};
  const providerSource = sourceFor(ctx.valueSources, 'provider');
  if (shouldAsk(providerSource)) {
    answers.provider = await askText(
      'provider',
      `    LLM_PROVIDER (${PROVIDER_IDS.join(' | ')})`,
      promptInitial(ctx.cfg, ctx.valueSources, 'provider'),
      providerSource,
    );
  }

  const chosenProvider = providerFromAnswer(answers.provider, ctx.cfg.provider);
  const baseUrlSource = sourceFor(ctx.valueSources, 'baseUrl');
  if (shouldAsk(baseUrlSource)) {
    answers.baseUrl = await askText(
      'baseUrl',
      `    LLM_BASE_URL (suggested: ${providerSuggestion(chosenProvider)})`,
      promptInitial(ctx.cfg, ctx.valueSources, 'baseUrl'),
      baseUrlSource,
    );
  }

  const modelSource = sourceFor(ctx.valueSources, 'model');
  if (shouldAsk(modelSource)) {
    answers.model = await askText(
      'model',
      `    LLM_MODEL (example: ${chosenProvider === 'anthropic' ? 'claude-sonnet-4-5' : DEFAULT_CONFIG.model})`,
      promptInitial(ctx.cfg, ctx.valueSources, 'model'),
      modelSource,
    );
  }

  const effectiveProvider = providerFromAnswer(answers.provider, ctx.cfg.provider);
  const apiKeySource = sourceFor(ctx.valueSources, 'apiKey');
  if (effectiveProvider === 'anthropic' && shouldAsk(apiKeySource)) {
    const { apiKey } = await prompts(
      {
        type: 'password',
        name: 'apiKey',
        message: '    LLM_API_KEY (required for Anthropic)',
        validate: (value: string) => validateRequiredLlmAnswer(value, 'LLM_API_KEY'),
      },
      { onCancel: () => process.exit(1) },
    );
    answers.apiKey = typeof apiKey === 'string' ? apiKey : '';
  }

  const update = buildLlmSetupUpdate(ctx.cfg, ctx.valueSources, answers);
  if (Object.keys(update).length > 0) {
    saveLlmConfig(ctx.cfg.configFilePath, update);
    Object.assign(changes, update);
    console.log('');
    console.log(pc.green('  ✓ LLM setup saved. Continuing...'));
  } else {
    console.log('');
    console.log(pc.dim('  (Using LLM settings from env/CLI. Nothing written to config.)'));
  }
  console.log('');

  return { changes, userDeclined: false };
}
