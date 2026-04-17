import pc from 'picocolors';

const BANNER_LINES = [
  '███╗   ███╗██╗   ██╗██████╗ ███╗   ███╗██╗   ██╗██████╗ ',
  '████╗ ████║██║   ██║██╔══██╗████╗ ████║██║   ██║██╔══██╗',
  '██╔████╔██║██║   ██║██████╔╝██╔████╔██║██║   ██║██████╔╝',
  '██║╚██╔╝██║██║   ██║██╔══██╗██║╚██╔╝██║██║   ██║██╔══██╗',
  '██║ ╚═╝ ██║╚██████╔╝██║  ██║██║ ╚═╝ ██║╚██████╔╝██║  ██║',
  '╚═╝     ╚═╝ ╚═════╝ ╚═╝  ╚═╝╚═╝     ╚═╝ ╚═════╝ ╚═╝  ╚═╝',
];

const SLOGAN = 'voice-first prompt engineering for vibe coders';

export function renderBanner(version = '0.0.0'): string {
  const out: string[] = [''];
  for (const line of BANNER_LINES) out.push(`  ${pc.magenta(line)}`);
  out.push('');
  out.push(`  ${pc.dim('· ')}${pc.italic(pc.cyan(SLOGAN))}${pc.dim(' ·')}`);
  out.push(`  ${pc.dim(`v${version}`)}`);
  out.push('');
  return out.join('\n');
}

export function printBanner(version?: string): void {
  process.stdout.write(renderBanner(version));
}
