import { AnthropicProvider } from './anthropic.js';
import { OllamaProvider } from './ollama.js';
import { OpenAiCompatProvider } from './openai-compat.js';
import type { LlmProvider, ProviderConfig, ProviderId } from './types.js';

export type {
  LlmProvider,
  ProviderConfig,
  ProviderId,
  RefineRequest,
  RefineResponse,
} from './types.js';

export interface ProviderPreset {
  displayName: string;
  defaultBaseUrl: string;
  /** True when the default base URL is an external cloud service. */
  isOnline: boolean;
}

export const PROVIDER_PRESETS: Record<ProviderId, ProviderPreset> = {
  ollama: {
    displayName: 'Ollama',
    defaultBaseUrl: 'http://localhost:11434',
    isOnline: false,
  },
  'openai-compat': {
    displayName: 'OpenAI-compatible',
    defaultBaseUrl: 'http://localhost:1234/v1', // LM Studio default
    isOnline: false,
  },
  anthropic: {
    displayName: 'Anthropic (Claude)',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    isOnline: true,
  },
};

export function createProvider(config: ProviderConfig): LlmProvider {
  switch (config.id) {
    case 'ollama':
      return new OllamaProvider(config);
    case 'openai-compat':
      return new OpenAiCompatProvider(config);
    case 'anthropic':
      return new AnthropicProvider(config);
    default: {
      const _exhaustive: never = config.id;
      throw new Error(`Unknown provider id: ${_exhaustive as string}`);
    }
  }
}
