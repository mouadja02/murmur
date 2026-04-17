import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IPC_START_RECORDING,
  IPC_STATUS,
  IPC_STOP_RECORDING,
  type Status,
} from '../shared/ipc.js';
import { HotkeyService } from './hotkey.js';
import { runPreflight } from './preflight.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
const hotkey = new HotkeyService();

function setStatus(s: Status): void {
  mainWindow?.webContents.send(IPC_STATUS, s);
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 360,
    height: 180,
    resizable: false,
    title: 'murmur',
    backgroundColor: '#0a0a0a',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function wireHotkey(): void {
  hotkey.on('start', () => {
    console.log('[hotkey] start');
    setStatus('recording');
    mainWindow?.webContents.send(IPC_START_RECORDING);
  });

  hotkey.on('stop', () => {
    console.log('[hotkey] stop');
    setStatus('transcribing');
    mainWindow?.webContents.send(IPC_STOP_RECORDING);
  });

  hotkey.start();
}

async function bootstrap(): Promise<void> {
  await app.whenReady();

  const preflight = await runPreflight();
  if (!preflight.ok) {
    console.error('\n[murmur] preflight failed:');
    for (const msg of preflight.messages) {
      console.error(`  - ${msg}`);
    }
    console.error('');
    app.exit(1);
    return;
  }
  console.error('[murmur] preflight ok');

  createWindow();
  wireHotkey();
}

bootstrap().catch((err) => {
  console.error('[murmur] fatal during bootstrap:', err);
  app.exit(1);
});

app.on('before-quit', () => {
  hotkey.shutdown();
});

app.on('window-all-closed', () => {
  app.quit();
});
