import 'dotenv/config';
import { app, type BrowserWindow, ipcMain, Menu, screen, shell } from 'electron';
import {
  type InfoPayload,
  IPC_AUDIO_CHUNK,
  IPC_BEGIN_WINDOW_DRAG,
  IPC_END_WINDOW_DRAG,
  IPC_HIDE_OVERLAY,
  IPC_INFO,
  IPC_OPEN_CONTROL_PANEL,
  IPC_QUIT,
  IPC_REQUEST_INFO,
  IPC_SET_MOUSE_INTERACTIVE,
  IPC_SHOW_CONTEXT_MENU,
  IPC_TOGGLE_RECORDING,
} from '../shared/ipc.js';
import {
  getProviderConfig,
  HELP_TEXT,
  type LoadedConfig,
  loadConfig,
  printResolvedConfig,
  updateConfigFile,
} from './config/index.js';
import { type ServerHandle, startControlPanelServer } from './control-panel/server.js';
import { HotkeyService } from './hotkey.js';
import {
  createOverlayWindow,
  hideOverlay,
  placeOverlay,
  showOverlay,
  toggleOverlayVisibility,
} from './overlay/window.js';
import { Pipeline } from './pipeline.js';
import { runPreflight } from './preflight.js';
import { createProvider, type LlmProvider, PROVIDER_PRESETS } from './providers/index.js';
import { beginWindowDrag, endWindowDrag } from './window-drag.js';

let mainWindow: BrowserWindow | null = null;
let loaded: LoadedConfig | null = null;
let pipeline: Pipeline | null = null;
let provider: LlmProvider | null = null;
let controlPanel: ServerHandle | null = null;
const hotkey = new HotkeyService();

const POSITION_SAVE_DEBOUNCE_MS = 350;

function buildInfo(l: LoadedConfig, controlPanelUrl: string): InfoPayload {
  const r = l.resolved;
  return {
    provider: r.provider,
    providerDisplayName: PROVIDER_PRESETS[r.provider].displayName,
    baseUrl: r.baseUrl,
    model: r.model,
    hotkeyCombo: r.hotkeyCombo,
    toggleHotkeyCombo: r.toggleHotkeyCombo,
    configFilePath: r.configFilePath,
    controlPanelUrl,
  };
}

function pushInfoToRenderer(): void {
  if (!loaded || !mainWindow) return;
  mainWindow.webContents.send(
    IPC_INFO,
    buildInfo(loaded, controlPanel?.url ?? 'http://localhost:7331'),
  );
}

function persistOverlayPosition(x: number, y: number): void {
  if (!loaded) return;
  loaded.resolved.overlayAnchor = 'free';
  loaded.resolved.overlayPosition = { x, y };
  updateConfigFile(loaded.resolved.configFilePath, (raw) => {
    const overlay = (
      raw.overlay && typeof raw.overlay === 'object' ? (raw.overlay as Record<string, unknown>) : {}
    ) as Record<string, unknown>;
    overlay.anchor = 'free';
    overlay.position = { x, y };
    raw.overlay = overlay;
  });
}

function clearOverlayPosition(): void {
  if (!loaded) return;
  loaded.resolved.overlayPosition = null;
  updateConfigFile(loaded.resolved.configFilePath, (raw) => {
    if (raw.overlay && typeof raw.overlay === 'object') {
      const overlay = raw.overlay as Record<string, unknown>;
      delete overlay.position;
    }
  });
}

function setupPositionPersistence(win: BrowserWindow): void {
  let timer: NodeJS.Timeout | null = null;
  win.on('move', () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (win.isDestroyed()) return;
      const [x, y] = win.getPosition();
      persistOverlayPosition(x, y);
    }, POSITION_SAVE_DEBOUNCE_MS);
  });
}

function showContextMenu(): void {
  if (!mainWindow || !loaded) return;
  const r = loaded.resolved;
  const providerLabel = `${PROVIDER_PRESETS[r.provider].displayName} · ${r.model}`;
  const panelUrl = controlPanel?.url ?? 'http://localhost:7331';

  const menu = Menu.buildFromTemplate([
    {
      label: 'Open control panel',
      click: () => {
        shell.openExternal(panelUrl).catch((err) => {
          console.error('[main] failed to open control panel:', err);
        });
      },
    },
    { type: 'separator' },
    {
      label: 'Hide overlay',
      accelerator: r.toggleHotkeyCombo,
      click: () => {
        if (mainWindow) hideOverlay(mainWindow);
      },
    },
    {
      label: 'Reset position',
      enabled: loaded.resolved.overlayPosition !== null,
      click: () => {
        clearOverlayPosition();
        if (mainWindow && loaded) {
          loaded.resolved.overlayAnchor = 'bottom-center';
          updateConfigFile(loaded.resolved.configFilePath, (raw) => {
            if (raw.overlay && typeof raw.overlay === 'object') {
              (raw.overlay as Record<string, unknown>).anchor = 'bottom-center';
            }
          });
          placeOverlay(mainWindow, loaded.resolved);
        }
      },
    },
    { type: 'separator' },
    { label: providerLabel, enabled: false },
    { label: r.baseUrl, enabled: false },
    { label: `PTT: ${r.hotkeyCombo}`, enabled: false },
    { label: `Toggle: ${r.toggleHotkeyCombo}`, enabled: false },
    { label: `Panel: ${panelUrl}`, enabled: false },
    { type: 'separator' },
    {
      label: 'Quit Murmur',
      click: () => app.quit(),
    },
  ]);
  menu.popup({ window: mainWindow });
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
    pushInfoToRenderer();
  });

  ipcMain.on(IPC_SET_MOUSE_INTERACTIVE, (_evt, interactive: boolean) => {
    if (!mainWindow) return;
    if (interactive) {
      mainWindow.setIgnoreMouseEvents(false);
    } else {
      mainWindow.setIgnoreMouseEvents(true, { forward: true });
    }
  });

  ipcMain.on(IPC_HIDE_OVERLAY, () => {
    if (mainWindow) hideOverlay(mainWindow);
  });

  ipcMain.on(IPC_SHOW_CONTEXT_MENU, () => {
    showContextMenu();
  });

  ipcMain.on(IPC_BEGIN_WINDOW_DRAG, () => {
    if (mainWindow) beginWindowDrag(mainWindow);
  });

  ipcMain.on(IPC_END_WINDOW_DRAG, () => {
    endWindowDrag();
  });

  ipcMain.on(IPC_OPEN_CONTROL_PANEL, () => {
    const url = controlPanel?.url ?? 'http://localhost:7331';
    shell.openExternal(url).catch((err) => {
      console.error('[main] failed to open control panel:', err);
    });
  });

  ipcMain.on(IPC_QUIT, () => {
    app.quit();
  });
}

function wireHotkey(): void {
  if (!loaded) return;
  const parsed = hotkey.configure({
    ptt: loaded.resolved.hotkeyCombo,
    toggle: loaded.resolved.toggleHotkeyCombo,
  });
  console.log(
    `[murmur] hotkeys: PTT=${parsed.ptt ? loaded.resolved.hotkeyCombo : '(invalid)'}` +
      ` toggle=${parsed.toggle ? loaded.resolved.toggleHotkeyCombo : '(invalid)'}`,
  );
  hotkey.on('start', () => pipeline?.start());
  hotkey.on('stop', () => pipeline?.stop());
  hotkey.on('toggle', () => {
    if (!mainWindow) return;
    const visible = toggleOverlayVisibility(mainWindow);
    console.log(`[murmur] overlay ${visible ? 'shown' : 'hidden'} via toggle hotkey`);
  });
  hotkey.start();
}

function rebindHotkeys(): void {
  if (!loaded) return;
  hotkey.configure({
    ptt: loaded.resolved.hotkeyCombo,
    toggle: loaded.resolved.toggleHotkeyCombo,
  });
}

function reloadConfigAfterExternalUpdate(): void {
  if (!loaded) return;
  const fresh = loadConfig({ userDataDir: app.getPath('userData') });
  loaded.resolved = fresh.resolved;
  provider = createProvider(getProviderConfig(loaded.resolved));
  if (pipeline) {
    pipeline = new Pipeline({
      cfg: loaded.resolved,
      provider,
      getWindow: () => mainWindow,
    });
  }
  rebindHotkeys();
  pushInfoToRenderer();
  console.log(
    `[murmur] config reloaded from control panel: ` +
      `provider=${loaded.resolved.provider} model=${loaded.resolved.model}`,
  );
}

async function startPanel(): Promise<void> {
  if (!loaded) return;
  try {
    controlPanel = await startControlPanelServer({
      getCurrentConfig: () => {
        if (!loaded) throw new Error('config not loaded yet');
        return loaded.resolved;
      },
      onConfigUpdated: () => {
        reloadConfigAfterExternalUpdate();
      },
      testLlm: async () => {
        if (!provider) return { ok: false, message: 'provider not initialised' };
        const start = Date.now();
        const err = await provider.preflight();
        const latencyMs = Date.now() - start;
        if (err) return { ok: false, message: err, latencyMs };
        return { ok: true, message: 'reachable', latencyMs };
      },
    });
    console.log(`[murmur] control panel: ${controlPanel.url}`);
  } catch (err) {
    console.error('[murmur] could not start control panel server:', err);
  }
}

function wireScreenChanges(): void {
  const reposition = () => {
    if (!mainWindow || !loaded) return;
    placeOverlay(mainWindow, loaded.resolved);
  };
  screen.on('display-metrics-changed', reposition);
  screen.on('display-added', reposition);
  screen.on('display-removed', reposition);
}

async function bootstrap(): Promise<void> {
  await app.whenReady();

  loaded = loadConfig({ userDataDir: app.getPath('userData') });

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

  provider = createProvider(getProviderConfig(loaded.resolved));

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

  setupPositionPersistence(mainWindow);

  mainWindow.once('ready-to-show', () => {
    mainWindow?.showInactive();
    pushInfoToRenderer();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  wireIPC();
  wireHotkey();
  wireScreenChanges();
  await startPanel();
  pushInfoToRenderer();
}

bootstrap().catch((err) => {
  console.error('[murmur] fatal during bootstrap:', err);
  app.exit(1);
});

app.on('before-quit', () => {
  hotkey.shutdown();
  controlPanel?.stop().catch(() => undefined);
});

app.on('window-all-closed', () => {
  app.quit();
});

// Re-show the overlay on macOS dock-click / Windows taskbar reactivation.
app.on('activate', () => {
  if (mainWindow) showOverlay(mainWindow);
});
