import type { PartialConfig } from './schema.js';

export const DEFAULT_SYSTEM_PROMPT = `You refine a raw voice transcription into a high-quality prompt for an AI coding assistant.

Rules:
- Restructure as: Goal, then Context, then Constraints, then Output format.
- Remove filler words (um, like, you know, basically, actually, kind of, sort of).
- Fix obvious dictation artifacts and homophones using coding context (e.g. "react" not "wreaked", "async" not "a sink").
- Never invent requirements the user did not state. If something is ambiguous, keep it ambiguous.
- Keep the user's voice. Do not make it corporate or verbose.
- Output ONLY the refined prompt. No preamble like "Here is the refined prompt:". No meta-commentary. No markdown code fences unless the refined prompt itself needs them.`;

/**
 * Built-in defaults, used when no other source supplies a value.
 * Paths are intentionally relative; they get resolved against `process.cwd()`
 * by `resolveConfig`.
 */
export const DEFAULT_CONFIG: Required<Omit<PartialConfig, 'apiKey' | 'overlay'>> & {
  apiKey: null;
  overlay: { anchor: 'bottom-center'; offsetX: number; offsetY: number };
} = {
  provider: 'ollama',
  baseUrl: 'http://localhost:11434',
  model: 'qwen3:4b',
  apiKey: null,
  temperature: 0.2,

  whisperCliPath: './bin/whisper/whisper-cli.exe',
  whisperModelPath: './bin/whisper/models/ggml-base.en.bin',

  sampleRate: 16000,
  hotkeyCombo: 'Ctrl+Shift+Space',
  toggleHotkeyCombo: 'Ctrl+Shift+H',
  clipboardRestoreDelayMs: 150,

  overlay: {
    anchor: 'bottom-center',
    offsetX: 0,
    offsetY: 24,
  },

  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  enabledSkills: [],
  controlPanelPort: 7331,

  logsDir: './logs',
  skillsDir: './skills',
};
