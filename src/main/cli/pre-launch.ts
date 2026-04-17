import { spawnSync } from 'node:child_process';
import { getUserDataDir, HELP_TEXT, loadConfig, updateConfigFile } from '../config/index.js';
import { loadSkills } from '../skills.js';
import { printBanner } from './banner.js';
import { askMultilineSystemPrompt, askPreLaunchAction } from './prompt.js';
import { printStatus } from './status.js';

function controlPanelUrl(port: number): string {
  const effective = port > 0 ? port : 7331;
  return `http://localhost:${effective}`;
}

async function main(): Promise<void> {
  const loaded = loadConfig({ userDataDir: getUserDataDir() });

  if (loaded.cli.helpAndExit) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  if (loaded.cli.printAndExit) {
    // Electron-side --print-config handles the machine-readable dump; the CLI
    // path only runs the interactive banner. Fall through so Electron sees it.
    process.exit(0);
  }

  const cfg = loaded.resolved;
  printBanner();

  const skills = loadSkills(cfg.skillsDir);
  const panelUrl = controlPanelUrl(cfg.controlPanelPort);
  printStatus({ cfg, skills, controlPanelUrl: panelUrl });

  // When stdin is not a TTY (CI, piped, VS Code debug), skip interactivity.
  if (!process.stdin.isTTY) {
    console.log('\n  (non-interactive stdin — launching with current setup)\n');
    process.exit(0);
  }

  let again = true;
  while (again) {
    const action = await askPreLaunchAction();
    switch (action) {
      case 'continue':
        again = false;
        break;
      case 'edit-prompt': {
        const edited = await askMultilineSystemPrompt(cfg.systemPrompt);
        if (edited && edited !== cfg.systemPrompt) {
          updateConfigFile(cfg.configFilePath, (raw) => {
            raw.systemPrompt = edited;
          });
          cfg.systemPrompt = edited;
          console.log('\n  Saved new system prompt.\n');
        } else {
          console.log('\n  (unchanged)\n');
        }
        break;
      }
      case 'open-panel': {
        const opener =
          process.platform === 'win32'
            ? 'start'
            : process.platform === 'darwin'
              ? 'open'
              : 'xdg-open';
        try {
          if (process.platform === 'win32') {
            spawnSync('cmd', ['/c', 'start', '""', panelUrl], { stdio: 'ignore' });
          } else {
            spawnSync(opener, [panelUrl], { stdio: 'ignore' });
          }
          console.log(`\n  Opening ${panelUrl} — it will be live once the app starts.\n`);
        } catch {
          console.log(`\n  Open ${panelUrl} in your browser once the app is running.\n`);
        }
        again = false;
        break;
      }
      case 'quit':
        console.log('\n  Bye.\n');
        process.exit(1);
    }
  }

  process.exit(0);
}

main().catch((err) => {
  console.error('[pre-launch] fatal:', err);
  process.exit(1);
});
