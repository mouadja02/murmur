import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, ipcMain } from 'electron';
import { IPC_AUDIO_CHUNK } from '../shared/ipc.js';
import { HotkeyService } from './hotkey.js';
import { Pipeline } from './pipeline.js';
import { runPreflight } from './preflight.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let mainWindow: BrowserWindow | null = null;
const hotkey = new HotkeyService();
const pipeline = new Pipeline(() => mainWindow);

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 360,
    height: 180,
    resizable: false,
    title: 'murmur',
    backgroundColor: '#0a0a0a',
    autoHideMenuBar: true,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.showInactive();
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function wireIPC(): void {
  ipcMain.on(IPC_AUDIO_CHUNK, (_evt, buffer: ArrayBuffer) => {
    pipeline.handleAudioChunk(buffer).catch((err) => {
      console.error('[main] handleAudioChunk crashed:', err);
    });
  });
}

function wireHotkey(): void {
  hotkey.on('start', () => pipeline.start());
  hotkey.on('stop', () => pipeline.stop());
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
  wireIPC();
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
