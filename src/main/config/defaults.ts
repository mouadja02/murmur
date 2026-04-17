import type { PartialConfig } from './schema.js';

export const DEFAULT_SYSTEM_PROMPT = `You refine a raw voice transcription into a high-quality prompt for an AI coding assistant.

Rules:
- Restructure as: Goal, then Context, then Constraints, then Output format.
- Remove filler words (um, like, you know, basically, actually, kind of, sort of).
- Fix obvious dictation artifacts and homophones using coding context (e.g. "react" not "wreaked", "async" not "a sink").
- Never invent requirements the user did not state. If something is ambiguous, keep it ambiguous.
- Keep the user's voice. Do not make it corporate or verbose.
- Output ONLY the refined prompt. No preamble like "Here is the refined prompt:". No meta-commentary. No markdown code fences unless the refined prompt itself needs them.`;

const IS_WINDOWS = process.platform === 'win32';
const WHISPER_CLI_FILENAME = IS_WINDOWS ? 'whisper-cli.exe' : 'whisper-cli';

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

  // On Windows we ship whisper.cpp via `pnpm setup:whisper` which extracts into
  // ./bin/whisper/. On Linux/macOS users typically install it via their package
  // manager (`apt install whisper.cpp`, `brew install whisper-cpp`) or build
  // from source, so we default to a plain command name that resolves via PATH.
  whisperCliPath: IS_WINDOWS ? `./bin/whisper/${WHISPER_CLI_FILENAME}` : WHISPER_CLI_FILENAME,
  whisperModelPath: IS_WINDOWS
    ? './bin/whisper/models/ggml-base.en.bin'
    : './models/ggml-base.en.bin',

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
