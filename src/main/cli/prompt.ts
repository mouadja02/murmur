import prompts from 'prompts';

export type PreLaunchAction = 'continue' | 'edit-prompt' | 'open-panel' | 'quit';

export async function askPreLaunchAction(): Promise<PreLaunchAction> {
  const { action } = await prompts(
    {
      type: 'select',
      name: 'action',
      message: 'What next?',
      hint: 'use ↑/↓ and Enter',
      initial: 0,
      choices: [
        { title: 'Continue with current setup', value: 'continue' },
        { title: 'Edit system prompt inline', value: 'edit-prompt' },
        { title: 'Open the control panel in your browser', value: 'open-panel' },
        { title: 'Quit', value: 'quit' },
      ],
    },
    {
      onCancel: () => {
        process.exit(1);
      },
    },
  );
  return (action ?? 'continue') as PreLaunchAction;
}

export async function askMultilineSystemPrompt(initial: string): Promise<string | null> {
  console.log('');
  console.log('  Paste / type the new system prompt. End with a single dot (`.`) on its own line.');
  console.log('  Press Ctrl+C to cancel.');
  console.log('');
  console.log('  --- current prompt ---');
  console.log(
    initial
      .split(/\r?\n/)
      .map((l) => `  ${l}`)
      .join('\n'),
  );
  console.log('  --- new prompt below ---');

  return new Promise((resolve) => {
    const stdin = process.stdin;
    const lines: string[] = [];
    let buffer = '';

    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString('utf8');
      let idx = buffer.indexOf('\n');
      while (idx >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '');
        buffer = buffer.slice(idx + 1);
        if (line.trim() === '.') {
          stdin.removeListener('data', onData);
          stdin.pause();
          resolve(lines.join('\n').trim() || null);
          return;
        }
        lines.push(line);
        idx = buffer.indexOf('\n');
      }
    };

    stdin.on('data', onData);
    stdin.resume();
  });
}
