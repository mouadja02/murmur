import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.dirname(__dirname);
const userArgs = process.argv.slice(2);

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: 'inherit',
      shell: false,
      cwd: root,
      ...opts,
    });
    child.on('exit', (code) => resolve(code ?? 0));
    child.on('error', (err) => {
      console.error(err);
      resolve(1);
    });
  });
}

const preLaunch = path.join(root, 'dist', 'main', 'cli', 'pre-launch.js');
const preCode = await run(process.execPath, [preLaunch, ...userArgs]);
if (preCode !== 0) process.exit(preCode);

const electronBinName = process.platform === 'win32' ? 'electron.cmd' : 'electron';
const electronBin = path.join(root, 'node_modules', '.bin', electronBinName);
const electronCode = await run(electronBin, ['.', '--', ...userArgs], {
  // electron.cmd is a batch wrapper; shell:true lets it run on Windows.
  shell: process.platform === 'win32',
});
process.exit(electronCode);
