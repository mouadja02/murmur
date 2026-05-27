import { CommandAudioRecorder } from './audio/recorder.js';
import type { LoadedConfig, ResolvedConfig } from './config/index.js';
import { getProviderConfig, loadConfig } from './config/index.js';
import { type ServerHandle, startControlPanelServer } from './control-panel/server.js';
import { startMcpServer as defaultStartMcpServer, type McpServerHandle } from './mcp/server.js';
import { Pipeline } from './pipeline.js';
import { runPreflight as defaultRunPreflight, type PreflightResult } from './preflight.js';
import { createProvider as defaultCreateProvider, type LlmProvider } from './providers/index.js';

const CONFIG_RELOAD_RETRY_MS = 250;

export interface Runtime {
  loaded: LoadedConfig;
  get provider(): LlmProvider;
  get pipeline(): Pipeline;
  controlPanel: ServerHandle;
  mcpServer: McpServerHandle;
  stop(): Promise<void>;
}

export interface CreateRuntimeOptions {
  userDataDir: string;
  argv?: readonly string[];
  requireRecorder: boolean;
  createProvider?: typeof defaultCreateProvider;
  runPreflight?: (
    cfg: ResolvedConfig,
    provider: LlmProvider,
    opts: { requireRecorder?: boolean },
  ) => Promise<PreflightResult>;
  startControlPanel?: typeof startControlPanelServer;
  startMcpServer?: typeof defaultStartMcpServer;
}

function createHeadlessPipeline(cfg: ResolvedConfig, provider: LlmProvider): Pipeline {
  return new Pipeline({
    cfg,
    provider,
    emitStatus: (s) => console.log(`[murmur] status=${s}`),
    inject: async () => {
      throw new Error('injection is unavailable in headless serve mode');
    },
    createRecorder: () => new CommandAudioRecorder({ commandLine: cfg.recorderCommand }),
  });
}

export async function createRuntime(opts: CreateRuntimeOptions): Promise<Runtime> {
  const loaded = loadConfig({ userDataDir: opts.userDataDir, argv: opts.argv });
  const createProvider = opts.createProvider ?? defaultCreateProvider;
  let provider = createProvider(getProviderConfig(loaded.resolved));
  const preflight = await (opts.runPreflight ?? defaultRunPreflight)(loaded.resolved, provider, {
    requireRecorder: opts.requireRecorder,
  });
  if (!preflight.ok) {
    throw new Error(`preflight failed:\n${preflight.messages.map((m) => `  - ${m}`).join('\n')}`);
  }

  let pipeline = createHeadlessPipeline(loaded.resolved, provider);
  let reloadTimer: NodeJS.Timeout | null = null;

  const applyConfigReload = (): void => {
    const fresh = loadConfig({ userDataDir: opts.userDataDir, argv: opts.argv });
    loaded.resolved = fresh.resolved;
    loaded.overrides = fresh.overrides;
    provider = createProvider(getProviderConfig(loaded.resolved));

    if (pipeline.isBusy()) {
      console.warn('[murmur] config reload deferred: pipeline is busy (recording or processing)');
      if (!reloadTimer) {
        reloadTimer = setTimeout(() => {
          reloadTimer = null;
          applyConfigReload();
        }, CONFIG_RELOAD_RETRY_MS);
      }
      return;
    }

    pipeline = createHeadlessPipeline(loaded.resolved, provider);
    console.log(
      `[murmur] config reloaded: provider=${loaded.resolved.provider} model=${loaded.resolved.model}`,
    );
  };

  const reloadConfig = (): void => {
    applyConfigReload();
  };

  const panelDeps = {
    getCurrentConfig: () => loaded.resolved,
    getCurrentOverrides: () => loaded.overrides,
    onConfigUpdated: reloadConfig,
    testLlm: async () => {
      const start = Date.now();
      const err = await provider.preflight();
      const latencyMs = Date.now() - start;
      if (err) return { ok: false, message: err, latencyMs };
      return { ok: true, message: 'reachable', latencyMs };
    },
  };

  const controlPanel = await (opts.startControlPanel ?? startControlPanelServer)(panelDeps);

  let mcpServer: McpServerHandle;
  try {
    mcpServer = await (opts.startMcpServer ?? defaultStartMcpServer)({
      cfg: loaded.resolved,
      getPipeline: () => pipeline,
      getConfig: () => loaded.resolved,
      onConfigUpdated: reloadConfig,
    });
  } catch (err) {
    await controlPanel.stop().catch(() => undefined);
    throw err;
  }

  const runtime: Runtime = {
    loaded,
    get provider() {
      return provider;
    },
    get pipeline() {
      return pipeline;
    },
    controlPanel,
    mcpServer,
    stop: async () => {
      if (reloadTimer) {
        clearTimeout(reloadTimer);
        reloadTimer = null;
      }
      await Promise.allSettled([controlPanel.stop(), mcpServer.stop()]);
    },
  };

  return runtime;
}
