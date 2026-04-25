import 'dotenv/config';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getUserDataDir, HELP_TEXT, loadConfig, updateConfigFile } from '../config/index.js';
import { loadSkills } from '../skills.js';
import { runAutoSetup } from './auto-setup.js';
import { printBanner } from './banner.js';
import { runLlmSetup } from './llm-setup.js';
import { askMultilineSystemPrompt, askPreLaunchAction } from './prompt.js';
import { printStatus } from './status.js';

function getVersion(): string {
  try {
    const _require = createRequire(import.meta.url);
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(__dirname, '..', '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function controlPanelUrl(port: number): string {
  const effective = port > 0 ? port : 7331;
  return `http://localhost:${effective}`;
}

async function main(): Promise<void> {
  const userDataDir = getUserDataDir();
  let loaded = loadConfig({ userDataDir });

  if (loaded.cli.helpAndExit) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  if (loaded.cli.printAndExit) {
    // Electron-side --print-config handles the machine-readable dump; the CLI
    // path only runs the interactive banner. Fall through so Electron sees it.
    process.exit(0);
  }

  let cfg = loaded.resolved;
  const configWasWritten = loaded.configFileWritten;
  printBanner(getVersion());

  const skills = loadSkills(cfg.skillsDir);
  const panelUrl = controlPanelUrl(cfg.controlPanelPort);
  printStatus({ cfg, skills, controlPanelUrl: panelUrl });

  // When stdin is not a TTY (CI, piped, VS Code debug), skip interactivity
  // entirely — including the first-time setup prompts.
  if (!process.stdin.isTTY) {
    console.log('\n  (non-interactive stdin — launching with current setup)\n');
    process.exit(0);
  }

  // First-time / missing-asset setup: prompts the user to install whisper-cli
  // and the model if they're missing, writing any new paths back to the config
  // file so the Electron process picks them up without a restart.
  const setupResult = await runAutoSetup({ cfg, userDataDir });
  if (
    setupResult.changes.whisperCliPath !== undefined ||
    setupResult.changes.whisperModelPath !== undefined
  ) {
    // Re-load so resolved paths reflect the new on-disk config.
    loaded = loadConfig({ userDataDir });
    cfg = loaded.resolved;
    const updatedSkills = loadSkills(cfg.skillsDir);
    printStatus({ cfg, skills: updatedSkills, controlPanelUrl: panelUrl });
  }

  const llmSetupResult = await runLlmSetup({
    cfg,
    valueSources: loaded.valueSources,
    configFileWritten: configWasWritten,
  });
  if (
    llmSetupResult.changes.provider !== undefined ||
    llmSetupResult.changes.baseUrl !== undefined ||
    llmSetupResult.changes.model !== undefined ||
    llmSetupResult.changes.apiKey !== undefined
  ) {
    loaded = loadConfig({ userDataDir });
    cfg = loaded.resolved;
    const updatedSkills = loadSkills(cfg.skillsDir);
    printStatus({ cfg, skills: updatedSkills, controlPanelUrl: panelUrl });
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
