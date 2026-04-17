import { CONFIG } from '../shared/constants.js';
import { SYSTEM_PROMPT } from '../shared/prompts.js';

export interface RefineResult {
  text: string;
  systemPrompt: string;
  durationMs: number;
}

interface OllamaGenerateResponse {
  response: string;
  done: boolean;
}

const THINK_BLOCK = /<think>[\s\S]*?<\/think>/g;

export async function refine(transcription: string): Promise<RefineResult> {
  const started = Date.now();

  const body = {
    model: CONFIG.llmModel,
    system: SYSTEM_PROMPT,
    prompt: transcription,
    stream: false,
    think: false,
    options: {
      temperature: 0.2,
    },
  };

  const res = await fetch(`${CONFIG.ollamaUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Ollama /api/generate HTTP ${res.status}: ${errText}`);
  }

  const data = (await res.json()) as OllamaGenerateResponse;
  const cleaned = data.response.replace(THINK_BLOCK, '').trim();

  return {
    text: cleaned,
    systemPrompt: SYSTEM_PROMPT,
    durationMs: Date.now() - started,
  };
}
