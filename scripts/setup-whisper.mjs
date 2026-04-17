#!/usr/bin/env node
// Cross-platform `pnpm setup:whisper` dispatcher.
//
//   Windows -> runs scripts/setup-whisper.ps1 (downloads a prebuilt whisper.cpp).
//   Linux   -> prints platform-appropriate install hints (apt / build-from-src).
//   macOS   -> prints platform-appropriate install hints (brew).
//
// Also downloads the `ggml-base.en.bin` model on *nix so users just need the
// whisper-cli binary on their PATH.

import { spawnSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin';

function log(msg) {
  console.log(`[setup-whisper] ${msg}`);
}

async function downloadModel(destPath) {
  mkdirSync(path.dirname(destPath), { recursive: true });
  if (existsSync(destPath)) {
    log(`model already present at ${destPath}`);
    return;
  }
  log(`downloading ggml-base.en.bin (~148 MB) -> ${destPath}`);
  const res = await fetch(MODEL_URL, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`download failed: HTTP ${res.status}`);
  }
  const stream = createWriteStream(destPath);
  const reader = res.body.getReader();
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    stream.write(value);
  }
  stream.end();
  await new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
  log(`model ready (${(total / 1024 / 1024).toFixed(1)} MB)`);
}

async function setupWindows() {
  const script = path.join(__dirname, 'setup-whisper.ps1');
  log(`running ${script}`);
  const res = spawnSync(
    'powershell',
    ['-ExecutionPolicy', 'Bypass', '-NoProfile', '-File', script],
    {
      stdio: 'inherit',
      cwd: root,
    },
  );
  process.exit(res.status ?? 0);
}

async function setupUnix() {
  const isMac = process.platform === 'darwin';
  log(`detected ${process.platform}${process.arch}`);

  await downloadModel(path.join(root, 'models', 'ggml-base.en.bin'));

  console.log('');
  console.log('  Next: install the whisper-cli binary on your PATH.');
  console.log('');
  if (isMac) {
    console.log('    # Homebrew (recommended):');
    console.log('    brew install whisper-cpp');
    console.log('');
    console.log('    # or build from source:');
    console.log('    git clone https://github.com/ggerganov/whisper.cpp');
    console.log('    cd whisper.cpp && make && sudo cp main /usr/local/bin/whisper-cli');
  } else {
    console.log('    # Ubuntu/Debian (if packaged):');
    console.log('    sudo apt-get install -y whisper.cpp');
    console.log('');
    console.log('    # or build from source (works everywhere):');
    console.log('    sudo apt-get install -y build-essential git');
    console.log('    git clone https://github.com/ggerganov/whisper.cpp');
    console.log('    cd whisper.cpp && make');
    console.log('    sudo cp main /usr/local/bin/whisper-cli');
  }
  console.log('');
  console.log('  Then point Murmur at the model you just downloaded:');
  console.log('');
  console.log(`    murmur --whisper-model ${path.join(root, 'models', 'ggml-base.en.bin')}`);
  console.log('');
  console.log('  Or set it permanently in the control panel (Whisper tab).');
}

async function main() {
  if (process.platform === 'win32') {
    await setupWindows();
  } else {
    await setupUnix();
  }
}

main().catch((err) => {
  console.error('[setup-whisper] failed:', err?.message ?? err);
  process.exit(1);
});
