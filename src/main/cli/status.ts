import pc from 'picocolors';
import type { ResolvedConfig } from '../config/index.js';
import { PROVIDER_PRESETS } from '../providers/index.js';
import type { Skill } from '../skills.js';

const LABEL_WIDTH = 12;

/**
 * Emits an OSC-8 hyperlink escape sequence. Modern terminals (Windows Terminal,
 * iTerm2, WezTerm, Alacritty, Kitty, VS Code's integrated terminal, …) render
 * the label as a clickable link to `url`. Terminals that don't understand the
 * sequence fall back to the plain label.
 */
export function hyperlink(url: string, label: string): string {
  const OSC = '\u001b]8;;';
  const ST = '\u001b\\';
  return `${OSC}${url}${ST}${label}${OSC}${ST}`;
}

function row(label: string, value: string): string {
  return `  ${pc.dim(label.padEnd(LABEL_WIDTH))}${value}`;
}

function header(text: string): string {
  const rule = pc.dim('─'.repeat(Math.max(2, 60 - text.length - 4)));
  return `\n  ${pc.bold(pc.cyan(`── ${text} `))}${rule}`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function previewPrompt(prompt: string, lines = 3, width = 64): string[] {
  const flat = prompt.replace(/\s+/g, ' ').trim();
  if (!flat) return [pc.dim('(empty)')];
  const out: string[] = [];
  let rest = flat;
  while (rest.length && out.length < lines) {
    if (rest.length <= width) {
      out.push(rest);
      rest = '';
      break;
    }
    let cut = rest.lastIndexOf(' ', width);
    if (cut < width / 2) cut = width;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length) out[out.length - 1] = out[out.length - 1].replace(/.{1}$/, '…');
  return out;
}

export interface StatusInput {
  cfg: ResolvedConfig;
  skills: readonly Skill[];
  controlPanelUrl: string;
}

export function renderStatus(input: StatusInput): string {
  const { cfg, skills, controlPanelUrl } = input;
  const provider = PROVIDER_PRESETS[cfg.provider]?.displayName ?? cfg.provider;
  const enabledSet = new Set(cfg.enabledSkills);
  const enabledCount = skills.filter((s) => enabledSet.has(s.id)).length;
  const apiKeyState = cfg.apiKey
    ? pc.green('set')
    : cfg.provider === 'openai-compat'
      ? pc.yellow('not set (ok for local)')
      : pc.dim('n/a');

  const lines: string[] = [];

  lines.push(header('Provider'));
  lines.push(row('Provider', pc.bold(provider) + pc.dim(' · ') + pc.bold(cfg.model)));
  lines.push(row('Base URL', cfg.baseUrl));
  lines.push(row('API key', apiKeyState));
  lines.push(row('Temp', String(cfg.temperature)));

  lines.push(header('Hotkeys'));
  lines.push(row('PTT', pc.bold(cfg.hotkeyCombo)) + pc.dim('  hold to record'));
  lines.push(row('Toggle', pc.bold(cfg.toggleHotkeyCombo)) + pc.dim('  hide / show overlay'));

  lines.push(header('Paths'));
  lines.push(row('Logs', truncate(cfg.logsDir, 64)));
  lines.push(row('Skills dir', truncate(cfg.skillsDir, 64)));
  lines.push(row('Whisper', truncate(cfg.whisperCliPath, 64)));
  lines.push(row('Model', truncate(cfg.whisperModelPath, 64)));
  lines.push(row('Config', truncate(cfg.configFilePath, 64)));

  lines.push(header(`Skills  ${pc.dim(`(${enabledCount}/${skills.length} active)`)}`));
  if (skills.length === 0) {
    lines.push(`  ${pc.dim('(no skills installed)')}`);
  } else {
    for (const skill of skills) {
      const on = enabledSet.has(skill.id);
      const mark = on ? pc.green('●') : pc.dim('○');
      const name = on ? pc.bold(skill.name) : pc.dim(skill.name);
      const desc = skill.description ? pc.dim(` — ${skill.description}`) : '';
      lines.push(`  ${mark} ${name}${desc}`);
    }
  }

  lines.push(header('System prompt'));
  for (const line of previewPrompt(cfg.systemPrompt)) {
    lines.push(`  ${pc.dim('"')}${pc.italic(line)}${pc.dim('"')}`);
  }

  lines.push(header('Control panel'));
  lines.push(row('URL', pc.cyan(pc.underline(controlPanelUrl))));
  lines.push(row('', pc.dim("open it any time from the overlay's right-click menu")));

  lines.push('');
  return lines.join('\n');
}

export function printStatus(input: StatusInput): void {
  process.stdout.write(renderStatus(input));
}

export interface ReadyBannerInput {
  cfg: ResolvedConfig;
  controlPanelUrl: string;
}

/**
 * Rendered after Electron finishes bootstrap (preflight + window creation).
 * Gives the user a dense, clickable "cockpit" line for the common commands.
 *
 * The Overlay links use the `murmur://` custom protocol — clicking them
 * forwards to the running Electron instance via `second-instance` instead of
 * opening a browser tab. The panel link is an http URL and intentionally
 * opens the control panel in the browser.
 */
export function renderReadyBanner(input: ReadyBannerInput): string {
  const { cfg, controlPanelUrl } = input;
  const provider = PROVIDER_PRESETS[cfg.provider]?.displayName ?? cfg.provider;

  const showLink = hyperlink('murmur://show', pc.green('show'));
  const hideLink = hyperlink('murmur://hide', pc.yellow('hide'));
  const toggleLink = hyperlink('murmur://toggle', pc.cyan('toggle'));
  const panelLink = hyperlink(controlPanelUrl, pc.cyan(pc.underline(controlPanelUrl)));

  const lines: string[] = [];
  lines.push('');
  lines.push(`  ${pc.bold(pc.green('o'))} ${pc.bold('murmur is ready')}`);
  lines.push(
    row('Overlay', `${showLink}  ${pc.dim('/')}  ${hideLink}  ${pc.dim('/')}  ${toggleLink}`),
  );
  lines.push(row('Panel', panelLink));
  lines.push(
    row(
      'Hotkeys',
      `${pc.bold(cfg.hotkeyCombo)} ${pc.dim('(push-to-talk)')}  ${pc.dim('/')}  ${pc.bold(cfg.toggleHotkeyCombo)} ${pc.dim('(toggle)')}`,
    ),
  );
  lines.push(row('LLM', `${pc.bold(provider)} ${pc.dim('/')} ${pc.bold(cfg.model)}`));
  lines.push('');
  lines.push(
    `  ${pc.dim('Click a link above (Ctrl-click in some terminals). Overlay links stay in-app; the panel link opens in your browser.')}`,
  );
  lines.push('');
  return lines.join('\n');
}

export function printReadyBanner(input: ReadyBannerInput): void {
  process.stdout.write(renderReadyBanner(input));
}
