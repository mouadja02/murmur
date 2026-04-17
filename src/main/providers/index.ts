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

export const PROVIDER_PRESETS: Record<ProviderId, { displayName: string; defaultBaseUrl: string }> =
  {
    ollama: {
      displayName: 'Ollama',
      defaultBaseUrl: 'http://localhost:11434',
    },
    'openai-compat': {
      displayName: 'OpenAI-compatible',
      defaultBaseUrl: 'http://localhost:1234/v1', // LM Studio default
    },
  };

export function createProvider(config: ProviderConfig): LlmProvider {
  switch (config.id) {
    case 'ollama':
      return new OllamaProvider(config);
    case 'openai-compat':
      return new OpenAiCompatProvider(config);
    default: {
      const _exhaustive: never = config.id;
      throw new Error(`Unknown provider id: ${_exhaustive as string}`);
    }
  }
}
