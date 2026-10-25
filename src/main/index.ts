import 'dotenv/config';
import { app, type BrowserWindow, clipboard, ipcMain, Menu, screen, shell } from 'electron';
import {
  type InfoPayload,
  IPC_AUDIO_CHUNK,
  IPC_BEGIN_WINDOW_DRAG,
  IPC_END_WINDOW_DRAG,
  IPC_HIDE_OVERLAY,
  IPC_INFO,
  IPC_OPEN_CONTROL_PANEL,
  IPC_OPEN_LOG_DIR,
  IPC_QUIT,
  IPC_REFINE_LAST,
  IPC_REQUEST_INFO,
  IPC_RETRY,
  IPC_SET_MOUSE_INTERACTIVE,
  IPC_SHOW_CONTEXT_MENU,
  IPC_TOGGLE_RECORDING,
  IPC_VAD_CONFIG,
  IPC_VAD_SILENCE_TIMEOUT,
  IPC_VAD_SPEECH_START,
  type VadConfigPayload,
} from '../shared/ipc.js';
import { CommandAudioRecorder } from './audio/recorder.js';
import { printReadyBanner } from './cli/status.js';
import {
  describeShadowedEnv,
  getProviderConfig,
  HELP_TEXT,
  type LoadedConfig,
  loadConfig,
  printResolvedConfig,
  updateConfigFile,
} from './config/index.js';
import {
  getClipboardHistory,
  ignoreClipboardText,
  startClipboardMonitoring,
  stopClipboardMonitoring,
} from './context/clipboard.js';
import { type CapturedContext, captureContext, contextWanted } from './context/index.js';
import { captureScreenshot } from './context/screenshot.js';
import { captureActiveWindow } from './context/window.js';
import { type ServerHandle, startControlPanelServer } from './control-panel/server.js';
import { HotkeyService } from './hotkey.js';
import { createTypedProgressiveInjector, type InjectOptions, pasteAtCursor } from './inject.js';
import { type McpServerHandle, startMcpServer } from './mcp/server.js';
import {
  createOverlayWindow,
  hideOverlay,
  placeOverlay,
  showOverlay,
  toggleOverlayVisibility,
} from './overlay/window.js';
import { Pipeline } from './pipeline.js';
import { isPathInside } from './platform.js';
import { runPreflight } from './preflight.js';
import {
  findMurmurUrlInArgv,
  handleFirstInstanceArgv,
  registerProtocol,
  wireProtocolEvents,
} from './protocol/index.js';
import { createProvider, type LlmProvider, PROVIDER_PRESETS } from './providers/index.js';
import { type TrayIconState, TrayService } from './tray.js';
import { probeWhisperStreaming } from './whisper-probe.js';
import { beginWindowDrag, endWindowDrag } from './window-drag.js';

let mainWindow: BrowserWindow | null = null;
let loaded: LoadedConfig | null = null;
let pipeline: Pipeline | null = null;
let provider: LlmProvider | null = null;
let controlPanel: ServerHandle | null = null;
let mcpServer: McpServerHandle | null = null;
let whisperStreaming = true;
const hotkey = new HotkeyService();
const tray = new TrayService();

const POSITION_SAVE_DEBOUNCE_MS = 350;
const PIPELINE_REBUILD_RETRY_MS = 250;

function openControlPanelExternal(): void {
  const url = controlPanel?.url ?? 'http://localhost:7331';
  shell.openExternal(url).catch((err) => {
    console.error('[main] failed to open control panel:', err);
  });
}

const protocolDeps = {
  getWindow: () => mainWindow,
  openPanel: openControlPanelExternal,
};

// Set the app name before anything reads userData paths. Without this,
// Electron defaults to "Electron" in dev mode and the config/log dirs
// land at ~/.config/Electron/ instead of ~/.config/murmur/.
app.setName('murmur');

// Secondary launches of `murmur://...` (triggered by clicking an OSC-8 link
// while the app is running) should forward their URL to the first instance
// instead of starting a new Electron process and then immediately exit. This
// is what makes the terminal click *not* open a browser tab: the OS routes the
// URL into the existing Murmur window via the single-instance lock.
//
// If we're the only instance already, `requestSingleInstanceLock` returns true
// and we continue booting normally (handling any `murmur://...` URL from our
// own argv later on).
if (!app.requestSingleInstanceLock()) {
  app.quit();
  // Nothing else to do; the running instance receives a `second-instance`
  // event with our argv and handles the URL there.
} else if (findMurmurUrlInArgv(process.argv) && mainWindow === null && !app.isReady()) {
  // The very first launch came from a terminal click (e.g. `murmur://show`).
  // The URL handling runs post-ready in `handleFirstInstanceArgv`, nothing to
  // do here — this branch exists only to document the intended flow.
}

// Protocol registration has to happen before `whenReady`.
registerProtocol();

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
    progressiveInjection: r.progressiveInjection,
  };
}

function pushInfoToRenderer(): void {
  if (!loaded || !mainWindow) return;
  mainWindow.webContents.send(
    IPC_INFO,
    buildInfo(loaded, controlPanel?.url ?? 'http://localhost:7331'),
  );
  const r = loaded.resolved;
  mainWindow.webContents.send(IPC_VAD_CONFIG, {
    enabled: r.vadEnabled,
    thresholdDb: r.vadThresholdDb,
    silenceMs: r.vadSilenceMs,
    leadInMs: r.vadLeadInMs,
  } satisfies VadConfigPayload);
}

/** Clipboard history is only polled when the user opted into sharing it. */
function syncClipboardMonitoring(): void {
  if ((loaded?.resolved.clipboardContextEntries ?? 0) > 0) startClipboardMonitoring();
  else stopClipboardMonitoring();
}

async function captureContextNow(): Promise<CapturedContext | null> {
  if (!loaded || !contextWanted(loaded.resolved)) return null;
  return captureContext(loaded.resolved, {
    activeWindow: captureActiveWindow,
    clipboard: getClipboardHistory,
    screenshot: captureScreenshot,
  });
}

async function injectText(text: string, opts: InjectOptions): Promise<void> {
  // Our own paste must not show up as "clipboard context" next time.
  ignoreClipboardText(text);
  await pasteAtCursor(text, opts);
}

function persistOverlayVisibility(visible: boolean): void {
  if (!loaded) return;
  loaded.resolved.overlayVisible = visible;
  updateConfigFile(loaded.resolved.configFilePath, (raw) => {
    const overlay = (
      raw.overlay && typeof raw.overlay === 'object' ? (raw.overlay as Record<string, unknown>) : {}
    ) as Record<string, unknown>;
    overlay.visible = visible;
    raw.overlay = overlay;
  });
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
  const canRefineLast = pipeline?.hasLastTranscription() ?? false;

  const menu = Menu.buildFromTemplate([
    {
      label: 'Refine last transcription',
      enabled: canRefineLast && !pipeline?.isBusy(),
      click: () => {
        pipeline?.refineLast().catch((err) => {
          console.error('[main] refineLast failed:', err);
        });
      },
    },
    { type: 'separator' },
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
        persistOverlayVisibility(false);
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

  ipcMain.on(IPC_VAD_SPEECH_START, () => {
    pipeline?.speechStarted();
  });

  ipcMain.on(IPC_VAD_SILENCE_TIMEOUT, () => {
    pipeline?.vadSilence();
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
    persistOverlayVisibility(false);
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
    openControlPanelExternal();
  });

  ipcMain.on(IPC_QUIT, () => {
    app.quit();
  });

  ipcMain.on(IPC_RETRY, () => {
    pipeline?.retry().catch((err) => {
      console.error('[main] retry failed:', err);
    });
  });

  ipcMain.on(IPC_REFINE_LAST, () => {
    if (!pipeline?.hasLastTranscription()) return;
    pipeline.refineLast().catch((err) => {
      console.error('[main] refineLast failed:', err);
    });
  });

  ipcMain.on(IPC_OPEN_LOG_DIR, (_evt, dir: unknown) => {
    // shell.openPath launches whatever it is given (including executables), so
    // only honour session folders inside the configured logs dir.
    if (!loaded || typeof dir !== 'string' || !isPathInside(dir, loaded.resolved.logsDir)) {
      console.warn('[main] refused to open path outside the logs dir:', dir);
      return;
    }
    shell.openPath(dir).catch((err) => {
      console.error('[main] openPath failed:', err);
    });
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
    persistOverlayVisibility(visible);
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

function createMainPipeline(): Pipeline {
  if (!loaded || !provider) throw new Error('runtime not initialised');
  const cfg = loaded.resolved;
  return new Pipeline({
    cfg,
    provider,
    getWindow: () => mainWindow,
    onStatus: (s) => {
      let iconState: TrayIconState = 'idle';
      if (s === 'recording' || s === 'vad-listening') iconState = 'recording';
      else if (s === 'error') iconState = 'error';
      else if (
        s === 'transcribing' ||
        s === 'transcribing-streaming' ||
        s === 'refining' ||
        s === 'refining-streaming' ||
        s === 'injecting'
      ) {
        iconState = 'processing';
      }
      tray.setState(iconState);
    },
    inject: injectText,
    copyToClipboard: async (text) => {
      await clipboard.writeText(text);
    },
    createRecorder: () => new CommandAudioRecorder({ commandLine: cfg.recorderCommand }),
    createProgressiveInjector: createTypedProgressiveInjector,
    whisperSupportsStreaming: whisperStreaming,
    captureContext: captureContextNow,
  });
}

let pipelineRebuildTimer: NodeJS.Timeout | null = null;

/**
 * Swap in a pipeline built from the current config. While a capture or
 * refinement is in flight the old pipeline must finish, so retry until idle —
 * otherwise a panel edit made mid-dictation would never reach the pipeline.
 */
function rebuildPipelineWhenIdle(): void {
  if (!pipeline) return;
  if (pipeline.isBusy()) {
    if (!pipelineRebuildTimer) {
      console.warn('[murmur] config reload deferred: pipeline is busy (recording or processing)');
      pipelineRebuildTimer = setTimeout(() => {
        pipelineRebuildTimer = null;
        rebuildPipelineWhenIdle();
      }, PIPELINE_REBUILD_RETRY_MS);
    }
    return;
  }
  const previous = pipeline;
  pipeline = createMainPipeline();
  pipeline.inheritFrom(previous);
}

function reloadConfigAfterExternalUpdate(): void {
  if (!loaded) return;
  const fresh = loadConfig({ userDataDir: app.getPath('userData') });
  loaded.resolved = fresh.resolved;
  loaded.overrides = fresh.overrides;
  loaded.shadowedEnv = fresh.shadowedEnv;
  provider = createProvider(getProviderConfig(loaded.resolved));
  rebuildPipelineWhenIdle();
  rebindHotkeys();
  syncClipboardMonitoring();
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
      getCurrentOverrides: () => {
        if (!loaded) throw new Error('config not loaded yet');
        return loaded.overrides;
      },
      getCurrentShadowedEnv: () => {
        if (!loaded) throw new Error('config not loaded yet');
        return loaded.shadowedEnv;
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
      showOverlay: () => {
        if (mainWindow) showOverlay(mainWindow);
      },
      hideOverlay: () => {
        if (mainWindow) hideOverlay(mainWindow);
      },
      isOverlayVisible: () => (mainWindow ? mainWindow.isVisible() : false),
    });
    console.log(`[murmur] control panel: ${controlPanel.url}`);
  } catch (err) {
    console.error('[murmur] could not start control panel server:', err);
  }
}

async function startMcp(): Promise<void> {
  if (!loaded) return;
  try {
    mcpServer = await startMcpServer({
      cfg: loaded.resolved,
      getConfig: () => {
        if (!loaded) throw new Error('config not loaded yet');
        return loaded.resolved;
      },
      getPipeline: () => {
        if (!pipeline) throw new Error('pipeline not initialised');
        return pipeline;
      },
      onConfigUpdated: () => {
        reloadConfigAfterExternalUpdate();
      },
    });
    console.log(`[murmur] MCP server: ${mcpServer.url}`);
  } catch (err) {
    console.error('[murmur] could not start MCP server:', err);
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
  for (const line of describeShadowedEnv(loaded.shadowedEnv)) console.warn(`[murmur] ${line}`);
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

  if (loaded.resolved.prewarm && provider.prewarm) {
    const prewarmFn = provider.prewarm.bind(provider);
    prewarmFn()
      .then((ms) => console.log(`[murmur] prewarm: ${ms}ms`))
      .catch((err) => console.warn('[murmur] prewarm failed (non-fatal):', err));
  }

  const whisperProbe = await probeWhisperStreaming(loaded.resolved.whisperCliPath);
  whisperStreaming = whisperProbe.supportsStreaming;
  console.log(`[murmur] whisper streaming: ${whisperStreaming ? 'supported' : 'not supported'}`);

  mainWindow = createOverlayWindow(loaded.resolved);
  tray.create({
    onShow: () => {
      if (mainWindow) showOverlay(mainWindow);
      persistOverlayVisibility(true);
      tray.setVisibility(true);
    },
    onHide: () => {
      if (mainWindow) hideOverlay(mainWindow);
      persistOverlayVisibility(false);
      tray.setVisibility(false);
    },
    onPanel: openControlPanelExternal,
    onQuit: () => app.quit(),
    isVisible: () => mainWindow?.isVisible() ?? false,
  });
  pipeline = createMainPipeline();

  setupPositionPersistence(mainWindow);

  mainWindow.once('ready-to-show', () => {
    if (loaded?.resolved.overlayVisible !== false) {
      mainWindow?.showInactive();
    }
    pushInfoToRenderer();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  wireIPC();
  wireHotkey();
  syncClipboardMonitoring();
  wireScreenChanges();
  wireProtocolEvents(protocolDeps);
  await startPanel();
  await startMcp();
  pushInfoToRenderer();

  printReadyBanner({
    cfg: loaded.resolved,
    controlPanelUrl: controlPanel?.url ?? 'http://localhost:7331',
  });

  // If the process was started with a `murmur://...` URL (first instance),
  // run it now that the window is alive.
  handleFirstInstanceArgv(protocolDeps);
}

// If we lost the single-instance lock, don't actually bootstrap — the other
// process is already live and received our argv via `second-instance`.
if (app.hasSingleInstanceLock()) {
  bootstrap().catch((err) => {
    console.error('[murmur] fatal during bootstrap:', err);
    app.exit(1);
  });
}

app.on('before-quit', () => {
  stopClipboardMonitoring();
  hotkey.shutdown();
  tray.destroy();
  controlPanel?.stop().catch(() => undefined);
  mcpServer?.stop().catch(() => undefined);
});

app.on('window-all-closed', () => {
  app.quit();
});

// Re-show the overlay on macOS dock-click / Windows taskbar reactivation.
app.on('activate', () => {
  if (mainWindow) showOverlay(mainWindow);
});
