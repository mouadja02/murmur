import 'dotenv/config';
import { app, BrowserWindow, ipcMain, screen } from 'electron';
import {
  IPC_AUDIO_CHUNK,
  IPC_INFO,
  IPC_QUIT,
  IPC_REQUEST_INFO,
  IPC_SET_MOUSE_INTERACTIVE,
  IPC_TOGGLE_RECORDING,
  type InfoPayload,
} from '../shared/ipc.js';
import {
  getProviderConfig,
  HELP_TEXT,
  type LoadedConfig,
  loadConfig,
  printResolvedConfig,
} from './config/index.js';
import { HotkeyService } from './hotkey.js';
import { createOverlayWindow, positionOverlay } from './overlay/window.js';
import { Pipeline } from './pipeline.js';
import { runPreflight } from './preflight.js';
import { createProvider, PROVIDER_PRESETS } from './providers/index.js';

let mainWindow: BrowserWindow | null = null;
let loaded: LoadedConfig | null = null;
let pipeline: Pipeline | null = null;
const hotkey = new HotkeyService();

function buildInfo(l: LoadedConfig): InfoPayload {
  const r = l.resolved;
  return {
    provider: r.provider,
    providerDisplayName: PROVIDER_PRESETS[r.provider].displayName,
    baseUrl: r.baseUrl,
    model: r.model,
    hotkeyCombo: r.hotkeyCombo,
    configFilePath: r.configFilePath,
  };
}

function wireIPC(): void {
  ipcMain.on(IPC_AUDIO_CHUNK, (_evt, buffer: ArrayBuffer) => {
    pipeline?.handleAudioChunk(buffer).catch((err) => {
      console.error('[main] handleAudioChunk crashed:', err);
    });
  });

  ipcMain.on(IPC_TOGGLE_RECORDING, () => {
    pipeline?.toggle();
  });

  ipcMain.on(IPC_REQUEST_INFO, () => {
    if (loaded) mainWindow?.webContents.send(IPC_INFO, buildInfo(loaded));
  });

  ipcMain.on(IPC_SET_MOUSE_INTERACTIVE, (_evt, interactive: boolean) => {
    if (!mainWindow) return;
    if (interactive) {
      mainWindow.setIgnoreMouseEvents(false);
    } else {
      mainWindow.setIgnoreMouseEvents(true, { forward: true });
    }
  });

  ipcMain.on(IPC_QUIT, () => {
    app.quit();
  });
}

function wireHotkey(): void {
  hotkey.on('start', () => pipeline?.start());
  hotkey.on('stop', () => pipeline?.stop());
  hotkey.start();
}

function wireScreenChanges(): void {
  const reposition = () => {
    if (!mainWindow || !loaded) return;
    positionOverlay(
      mainWindow,
      loaded.resolved.overlayAnchor,
      loaded.resolved.overlayOffsetX,
      loaded.resolved.overlayOffsetY,
    );
  };
  screen.on('display-metrics-changed', reposition);
  screen.on('display-added', reposition);
  screen.on('display-removed', reposition);
}

async function bootstrap(): Promise<void> {
  await app.whenReady();

  loaded = loadConfig();

  if (loaded.cli.helpAndExit) {
    console.log(HELP_TEXT);
    app.exit(0);
    return;
  }
  if (loaded.cli.printAndExit) {
    printResolvedConfig(loaded);
    app.exit(0);
    return;
  }

  if (loaded.configFileWritten) {
    console.log(`[murmur] wrote default config to ${loaded.resolved.configFilePath}`);
  } else if (loaded.configFileExisted) {
    console.log(`[murmur] config: ${loaded.resolved.configFilePath}`);
  }
  console.log(
    `[murmur] provider=${loaded.resolved.provider} model=${loaded.resolved.model} ` +
      `baseUrl=${loaded.resolved.baseUrl}`,
  );

  const provider = createProvider(getProviderConfig(loaded.resolved));

  const preflight = await runPreflight(loaded.resolved, provider);
  if (!preflight.ok) {
    console.error('\n[murmur] preflight failed:');
    for (const msg of preflight.messages) {
      console.error(`  - ${msg}`);
    }
    console.error('\nRun with --help to see all available flags.');
    app.exit(1);
    return;
  }
  console.log('[murmur] preflight ok');

  mainWindow = createOverlayWindow(loaded.resolved);
  pipeline = new Pipeline({
    cfg: loaded.resolved,
    provider,
    getWindow: () => mainWindow,
  });

  mainWindow.once('ready-to-show', () => {
    mainWindow?.showInactive();
    if (loaded) mainWindow?.webContents.send(IPC_INFO, buildInfo(loaded));
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  wireIPC();
  wireHotkey();
  wireScreenChanges();
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
