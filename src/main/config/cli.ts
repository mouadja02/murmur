import type { PartialConfig } from './schema.js';
import { sanitizePartial } from './schema.js';

export interface CliResult {
  /** Sanitized partial config from CLI flags (e.g. --model qwen3:4b). */
  partial: PartialConfig;
  /** Override path for the on-disk config file (--config <path>). */
  configFilePath: string | null;
  /** If true, dump the resolved config to stdout and exit 0 (--print-config). */
  printAndExit: boolean;
  /** If true, print --help text and exit 0. */
  helpAndExit: boolean;
}

/**
 * Parses Murmur CLI flags. Anything Electron itself wants (or anything we
 * don't recognise) is ignored.
 *
 * Supports both `--key value` and `--key=value`.
 *
 * Recognised flags:
 *   --provider <ollama|openai-compat>
 *   --base-url <url>
 *   --model <id>
 *   --api-key <key>
 *   --temperature <float>
 *   --whisper-cli <path>
 *   --whisper-model <path>
 *   --hotkey <combo>           (informational, hotkey is hardcoded for now)
 *   --logs-dir <path>
 *   --overlay-anchor <bottom-center|bottom-right|top-right|free>
 *   --overlay-offset-x <int>
 *   --overlay-offset-y <int>
 *   --config <path>
 *   --print-config
 *   --help, -h
 */
export function parseCli(argv: readonly string[]): CliResult {
  const result: CliResult = {
    partial: {},
    configFilePath: null,
    printAndExit: false,
    helpAndExit: false,
  };
  const raw: Record<string, string | true> = {};

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg?.startsWith('--')) {
      if (arg === '-h') raw.help = true;
      continue;
    }
    const stripped = arg.slice(2);
    const eq = stripped.indexOf('=');
    let key: string;
    let val: string | true;
    if (eq >= 0) {
      key = stripped.slice(0, eq);
      val = stripped.slice(eq + 1);
    } else {
      key = stripped;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        val = next;
        i++;
      } else {
        val = true;
      }
    }
    raw[key] = val;
  }

  if (raw.help === true || raw.h === true) result.helpAndExit = true;
  if (raw['print-config'] === true) result.printAndExit = true;
  if (typeof raw.config === 'string') result.configFilePath = raw.config;

  const candidate: Record<string, unknown> = {};
  if (typeof raw.provider === 'string') candidate.provider = raw.provider;
  if (typeof raw['base-url'] === 'string') candidate.baseUrl = raw['base-url'];
  if (typeof raw.model === 'string') candidate.model = raw.model;
  if (typeof raw['api-key'] === 'string') candidate.apiKey = raw['api-key'];
  if (typeof raw.temperature === 'string') {
    const n = Number(raw.temperature);
    if (Number.isFinite(n)) candidate.temperature = n;
  }
  if (typeof raw['whisper-cli'] === 'string') candidate.whisperCliPath = raw['whisper-cli'];
  if (typeof raw['whisper-model'] === 'string') candidate.whisperModelPath = raw['whisper-model'];
  if (typeof raw.hotkey === 'string') candidate.hotkeyCombo = raw.hotkey;
  if (typeof raw['logs-dir'] === 'string') candidate.logsDir = raw['logs-dir'];

  const overlay: Record<string, unknown> = {};
  if (typeof raw['overlay-anchor'] === 'string') overlay.anchor = raw['overlay-anchor'];
  if (typeof raw['overlay-offset-x'] === 'string') {
    const n = Number(raw['overlay-offset-x']);
    if (Number.isFinite(n)) overlay.offsetX = n;
  }
  if (typeof raw['overlay-offset-y'] === 'string') {
    const n = Number(raw['overlay-offset-y']);
    if (Number.isFinite(n)) overlay.offsetY = n;
  }
  if (Object.keys(overlay).length > 0) candidate.overlay = overlay;

  result.partial = sanitizePartial(candidate, 'cli');
  return result;
}

export const HELP_TEXT = `
Murmur — voice-first prompt engineering for vibe coders

Usage:
  pnpm dev -- [flags]
  electron . [flags]

LLM provider:
  --provider <ollama|openai-compat>   Selects the LLM backend
  --base-url <url>                    Provider HTTP base URL
  --model <id>                        Model identifier on the provider
  --api-key <key>                     Optional bearer token (openai-compat only)
  --temperature <float>               Sampling temperature (default 0.2)

Local STT:
  --whisper-cli <path>                Path to whisper-cli.exe
  --whisper-model <path>              Path to a ggml-*.bin model file

Hotkey / capture:
  --hotkey <combo>                    Informational only for now (PTT is Ctrl+Shift+Space)

Overlay window:
  --overlay-anchor <bottom-center|bottom-right|top-right|free>
  --overlay-offset-x <px>
  --overlay-offset-y <px>

Config file:
  --config <path>                     Override config file location
  --print-config                      Print resolved config and exit
  -h, --help                          Show this help and exit

Provider quick reference:
  Ollama (native):
    --provider ollama --base-url http://localhost:11434 --model qwen3:4b
  LM Studio:
    --provider openai-compat --base-url http://localhost:1234/v1 --model <loaded-model-id>
  llama.cpp server:
    --provider openai-compat --base-url http://localhost:8080/v1 --model <served-model>
`.trim();
