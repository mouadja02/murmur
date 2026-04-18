import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import pc from 'picocolors';
import prompts from 'prompts';
import type { ResolvedConfig } from '../config/index.js';
import { updateConfigFile } from '../config/index.js';
import { isOnPath, whisperCliAvailable } from '../platform.js';

/**
 * Resolve the package root from this file's location in the compiled `dist/`.
 *
 *   <pkg>/dist/main/cli/auto-setup.js  ->  <pkg>
 *
 * We rely on the TS compiler preserving this depth (`dist/main/cli/`).
 */
function getPackageRoot(): string {
  const __filename = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(__filename), '..', '..', '..');
}

const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin';

interface SetupContext {
  cfg: ResolvedConfig;
  userDataDir: string;
}

/** Returns true if the configured model file exists. */
function modelAvailable(cfg: ResolvedConfig): boolean {
  return existsSync(cfg.whisperModelPath);
}

async function askYesNo(message: string, initial = true): Promise<boolean> {
  const { ok } = await prompts(
    {
      type: 'confirm',
      name: 'ok',
      message,
      initial,
    },
    { onCancel: () => process.exit(1) },
  );
  return Boolean(ok);
}

/** Stream-download a file with a compact progress line. */
async function downloadWithProgress(url: string, destPath: string, label: string): Promise<void> {
  mkdirSync(path.dirname(destPath), { recursive: true });
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`download failed: HTTP ${res.status} ${res.statusText}`);
  }
  const totalHeader = res.headers.get('content-length');
  const total = totalHeader ? Number.parseInt(totalHeader, 10) : 0;
  const stream = createWriteStream(destPath);
  const reader = res.body.getReader();
  let received = 0;
  let lastPrint = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    received += value.byteLength;
    stream.write(value);
    // Throttle progress output to ~10 Hz
    const now = Date.now();
    if (now - lastPrint > 100) {
      const mb = received / 1024 / 1024;
      const pct = total ? ((received / total) * 100).toFixed(1) : '?';
      process.stdout.write(
        `\r    ${pc.dim(label)}  ${mb.toFixed(1)} MB${total ? ` / ${(total / 1024 / 1024).toFixed(1)} MB (${pct}%)` : ''}`,
      );
      lastPrint = now;
    }
  }
  stream.end();
  await new Promise<void>((resolve, reject) => {
    stream.on('finish', () => resolve());
    stream.on('error', reject);
  });
  process.stdout.write(
    `\r    ${pc.green('✓')} ${label}  ${(received / 1024 / 1024).toFixed(1)} MB                    \n`,
  );
}

/** Download the ggml-base.en.bin model to the configured path. */
async function installModel(ctx: SetupContext): Promise<boolean> {
  const dest = ctx.cfg.whisperModelPath;
  console.log('');
  console.log(pc.dim(`    -> ${dest}`));
  try {
    await downloadWithProgress(MODEL_URL, dest, 'ggml-base.en.bin');
    return true;
  } catch (err) {
    console.error(pc.red(`    x download failed: ${(err as Error).message}`));
    return false;
  }
}

interface WhisperInstallResult {
  /** Path to the whisper-cli binary (or bare command name if on PATH). */
  binaryPath: string;
  /**
   * If the installer also produced a model file as a side effect (Windows PS1
   * always does), this is where it landed. Lets us skip the model download
   * step.
   */
  modelPath?: string;
}

/**
 * Linux/macOS: build whisper.cpp from source into `<userDataDir>/whisper.cpp/`
 * and copy the resulting binary into `~/.local/bin/whisper-cli` (user-local,
 * no sudo needed).
 */
async function installWhisperUnix(ctx: SetupContext): Promise<WhisperInstallResult | null> {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const buildRoot = path.join(ctx.userDataDir, 'whisper.cpp');
  const userBinDir = path.join(home, '.local', 'bin');
  const targetBin = path.join(userBinDir, 'whisper-cli');

  console.log('');
  console.log(pc.dim('    Building whisper.cpp from source. This will take 2-5 minutes.'));
  console.log('');

  // 1. Check for required build tools
  const missingTools: string[] = [];
  if (!isOnPath('git')) missingTools.push('git');
  if (!isOnPath('cmake')) missingTools.push('cmake');
  if (!isOnPath('make')) missingTools.push('make');
  if (!isOnPath('cc') && !isOnPath('gcc') && !isOnPath('clang'))
    missingTools.push('build-essential');

  if (missingTools.length > 0) {
    console.log(pc.yellow('    Missing build tools:'), missingTools.join(', '));
    console.log('');
    if (process.platform === 'darwin') {
      console.log(pc.dim('    Install them with:'));
      console.log(`        xcode-select --install`);
      console.log(
        `        brew install ${missingTools.filter((t) => t !== 'build-essential').join(' ')}`,
      );
    } else {
      console.log(pc.dim('    Install them with:'));
      console.log(`        sudo apt-get install -y ${missingTools.join(' ')}`);
    }
    console.log('');
    console.log(pc.dim('    Then re-run `npx @mouadja02/murmur`.'));
    return null;
  }

  // 2. Clone (or pull) the repo
  if (!existsSync(buildRoot)) {
    console.log(pc.dim(`    [1/3] git clone -> ${buildRoot}`));
    const clone = spawnSync(
      'git',
      ['clone', '--depth=1', 'https://github.com/ggerganov/whisper.cpp', buildRoot],
      { stdio: 'inherit' },
    );
    if (clone.status !== 0) {
      console.error(pc.red('    x git clone failed'));
      return null;
    }
  } else {
    console.log(pc.dim(`    [1/3] whisper.cpp source already present at ${buildRoot}`));
  }

  // 3. Configure + build
  console.log(pc.dim('    [2/3] cmake configure + build (this is the slow part)...'));
  const nproc = process.env.NPROC || (process.platform === 'darwin' ? '4' : '');
  const configure = spawnSync('cmake', ['-B', 'build'], { cwd: buildRoot, stdio: 'inherit' });
  if (configure.status !== 0) {
    console.error(pc.red('    x cmake configure failed'));
    return null;
  }
  const buildArgs = ['--build', 'build', '--config', 'Release'];
  if (nproc) buildArgs.push('-j', nproc);
  const build = spawnSync('cmake', buildArgs, { cwd: buildRoot, stdio: 'inherit' });
  if (build.status !== 0) {
    console.error(pc.red('    x cmake build failed'));
    return null;
  }

  // 4. Install into ~/.local/bin (on PATH on all modern distros since 20.04)
  const builtBin = path.join(buildRoot, 'build', 'bin', 'whisper-cli');
  if (!existsSync(builtBin)) {
    console.error(pc.red(`    x expected binary not found at ${builtBin}`));
    return null;
  }
  mkdirSync(userBinDir, { recursive: true });
  try {
    copyFileSync(builtBin, targetBin);
    chmodSync(targetBin, 0o755);
  } catch (err) {
    console.error(pc.red(`    x failed to install to ${targetBin}: ${(err as Error).message}`));
    return null;
  }

  console.log(pc.green(`    ✓ whisper-cli installed at ${targetBin}`));

  // 5. Warn if ~/.local/bin is not on PATH
  if (!process.env.PATH?.split(':').includes(userBinDir)) {
    console.log('');
    console.log(pc.yellow(`    Note: ${userBinDir} is not on your PATH.`));
    console.log(pc.dim('    Add this to your ~/.bashrc or ~/.zshrc:'));
    console.log(`        export PATH="$HOME/.local/bin:$PATH"`);
    console.log('');
    console.log(pc.dim('    For now, using the absolute path directly.'));
    return { binaryPath: targetBin }; // absolute path so it works right now
  }

  return { binaryPath: 'whisper-cli' }; // on PATH → bare name is fine
}

/** Windows: run the PowerShell prebuilt-download script. */
async function installWhisperWindows(ctx: SetupContext): Promise<WhisperInstallResult | null> {
  const script = path.join(getPackageRoot(), 'scripts', 'setup-whisper.ps1');
  if (!existsSync(script)) {
    console.error(pc.red(`    x setup script not found at ${script}`));
    return null;
  }
  console.log('');
  console.log(
    pc.dim(`    Downloading prebuilt whisper.cpp into ${ctx.userDataDir}\\bin\\whisper ...`),
  );
  const res = spawnSync(
    'powershell',
    ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', script, '-InstallDir', ctx.userDataDir],
    { stdio: 'inherit' },
  );
  if (res.status !== 0) {
    console.error(pc.red('    x setup-whisper.ps1 exited with an error'));
    return null;
  }
  const binaryPath = path.join(ctx.userDataDir, 'bin', 'whisper', 'whisper-cli.exe');
  if (!existsSync(binaryPath)) return null;
  // The PS1 script always drops the model next to the binary as a freebie.
  const modelPath = path.join(ctx.userDataDir, 'bin', 'whisper', 'models', 'ggml-base.en.bin');
  return {
    binaryPath,
    modelPath: existsSync(modelPath) ? modelPath : undefined,
  };
}

async function installWhisper(ctx: SetupContext): Promise<WhisperInstallResult | null> {
  if (process.platform === 'win32') return installWhisperWindows(ctx);
  return installWhisperUnix(ctx);
}

/**
 * Persist updates back to the user config file so the next run picks them up
 * without the user having to pass flags again.
 */
function saveConfig(configFilePath: string, update: Partial<ResolvedConfig>): void {
  updateConfigFile(configFilePath, (raw) => {
    if (update.whisperCliPath !== undefined) raw.whisperCliPath = update.whisperCliPath;
    if (update.whisperModelPath !== undefined) raw.whisperModelPath = update.whisperModelPath;
  });
}

interface SetupResult {
  /** Fields that were changed; caller should re-resolve paths before preflight. */
  changes: Partial<ResolvedConfig>;
  /** True if the user opted out of any missing-asset prompt. */
  userDeclined: boolean;
}

/**
 * Runs before the interactive pre-launch menu. If whisper-cli or the model is
 * missing, offer to install them. Returns any config updates made so the
 * Electron main process starts with the correct paths without a restart.
 */
export async function runAutoSetup(ctx: SetupContext): Promise<SetupResult> {
  const { cfg } = ctx;
  const changes: Partial<ResolvedConfig> = {};
  let userDeclined = false;

  // Only prompt interactively.
  if (!process.stdin.isTTY) return { changes, userDeclined: true };

  const whisperOk = whisperCliAvailable(cfg.whisperCliPath);
  let modelOk = modelAvailable(cfg);

  if (whisperOk && modelOk) return { changes, userDeclined };

  console.log('');
  console.log(pc.bold('  ── First-time setup ────────────────────────────────────────'));
  console.log('');

  // 1. Whisper binary (and bundled model on Windows)
  if (!whisperOk) {
    console.log(`  ${pc.yellow('o')} whisper-cli ${pc.dim('not found at')} ${cfg.whisperCliPath}`);
    const platformHint =
      process.platform === 'win32'
        ? 'downloads a prebuilt binary (~30 MB) + model'
        : 'builds from source (~2-5 min, needs cmake + gcc/clang)';
    const install = await askYesNo(`    Install whisper.cpp now? (${platformHint})`, true);
    if (install) {
      const result = await installWhisper(ctx);
      if (result) {
        changes.whisperCliPath = result.binaryPath;
        const configUpdate: Partial<ResolvedConfig> = { whisperCliPath: result.binaryPath };
        if (result.modelPath) {
          changes.whisperModelPath = result.modelPath;
          configUpdate.whisperModelPath = result.modelPath;
          modelOk = true; // skip the separate model-download step below
        }
        saveConfig(cfg.configFilePath, configUpdate);
      } else {
        console.log(pc.red('    Skipping — install whisper-cli manually then re-run.'));
        userDeclined = true;
      }
    } else {
      userDeclined = true;
    }
  }

  // 2. Model file (~148 MB) — only if not already bundled by step 1
  if (!modelOk) {
    console.log('');
    console.log(
      `  ${pc.yellow('o')} whisper model ${pc.dim('not found at')} ${cfg.whisperModelPath}`,
    );
    const download = await askYesNo('    Download ggml-base.en.bin (~148 MB)?', true);
    if (download) {
      const ok = await installModel(ctx);
      if (ok) {
        changes.whisperModelPath = cfg.whisperModelPath;
      } else {
        userDeclined = true;
      }
    } else {
      userDeclined = true;
    }
  }

  console.log('');
  const didSomething =
    changes.whisperCliPath !== undefined || changes.whisperModelPath !== undefined;
  if (didSomething) {
    console.log(pc.green('  ✓ Setup complete. Continuing...'));
  } else if (userDeclined) {
    console.log(
      pc.dim('  (Setup skipped. Some features may not work until assets are installed.)'),
    );
  }
  console.log('');

  return { changes, userDeclined };
}
