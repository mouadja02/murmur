export type ProviderId = 'ollama' | 'openai-compat' | 'anthropic';

export interface ProviderConfig {
  id: ProviderId;
  displayName: string;
  baseUrl: string;
  model: string;
  apiKey: string | null;
  temperature: number;
}

export interface RefineRequest {
  systemPrompt: string;
  userPrompt: string;
}

export interface RefineResponse {
  text: string;
  durationMs: number;
}

export interface LlmProvider {
  readonly config: ProviderConfig;
  refine(req: RefineRequest): Promise<RefineResponse>;
  /**
   * Verifies the provider is reachable and `config.model` is available.
   * Returns `null` if everything is fine, otherwise a human-readable error
   * message intended for the preflight log.
   */
  preflight(): Promise<string | null>;
}

export const THINK_BLOCK = /<think>[\s\S]*?<\/think>/g;

export function stripThink(text: string): string {
  return text.replace(THINK_BLOCK, '').trim();
}
