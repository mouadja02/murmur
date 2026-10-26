import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type ConfigOverrides,
  type ConfigShadowedEnv,
  getConfigFileError,
  type PartialConfig,
  type ResolvedConfig,
  updateConfigFile,
} from '../config/index.js';
import { describeRejected, sanitizePartial } from '../config/schema.js';
import { hasLoopbackHost, isLoopbackHostname } from '../http-guard.js';
import { PROVIDER_PRESETS } from '../providers/index.js';
import {
  composeSystemPrompt,
  createSkill,
  deleteSkill,
  isValidSkillId,
  loadSkillsReport,
  type Skill,
  SkillConflictError,
  saveSkill,
} from '../skills.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const UI_DIR = path.resolve(__dirname, 'ui');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

export interface ServerDeps {
  getCurrentConfig: () => ResolvedConfig;
  /**
   * Returns the per-field override map (CLI / env vars currently shadowing the
   * on-disk config).  The control panel uses this to disable inputs whose
   * resolved value comes from a higher-precedence source than the JSON file —
   * editing them would silently no-op on the next config reload.
   */
  getCurrentOverrides?: () => ConfigOverrides;
  /**
   * Env vars that are set but outranked by a CLI flag or config.json.  They
   * lock nothing; the panel just explains why the env var has no effect.
   */
  getCurrentShadowedEnv?: () => ConfigShadowedEnv;
  /** Called when the config has been mutated (file already written). Expected to re-resolve. */
  onConfigUpdated: () => void;
  /** Probe the LLM provider with the current config. */
  testLlm: () => Promise<{ ok: boolean; message: string; latencyMs?: number }>;
  /**
   * Called by the control panel / terminal hyperlinks to toggle overlay visibility.
   * Both are optional so the server can still boot without a main-process bridge
   * (e.g. during tests). `isOverlayVisible` is used by the UI to render state.
   */
  showOverlay?: () => void;
  hideOverlay?: () => void;
  isOverlayVisible?: () => boolean;
}

export interface ServerHandle {
  port: number;
  url: string;
  stop: () => Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

/** Answers 409 for a skill that would have replaced an existing file; false for any other error. */
function sendSkillConflict(res: ServerResponse, err: unknown): boolean {
  if (!(err instanceof SkillConflictError)) return false;
  sendJson(res, 409, {
    error: err.message,
    requestedId: err.requestedId,
    existingId: err.existingId,
  });
  return true;
}

/** Large enough for any skill file or prompt; anything bigger is a mistake or an attack. */
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

class RequestBodyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Past the limit the rest of the upload is read and thrown away rather than abandoned: leaving the
 * loop destroys the socket mid-upload, and some clients then never see the 413. A body bigger than
 * this is cut off for real.
 */
const MAX_DISCARDED_BODY_BYTES = 32 * 1024 * 1024;

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_DISCARDED_BODY_BYTES) throw new RequestBodyError(413, 'request body too large');
    if (tooLarge) continue;
    if (size > MAX_REQUEST_BODY_BYTES) {
      tooLarge = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(buf);
  }
  if (tooLarge) throw new RequestBodyError(413, 'request body too large');
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new RequestBodyError(400, 'body is not valid JSON');
  }
}

function serveStatic(req: IncomingMessage, res: ServerResponse): boolean {
  const url = req.url ?? '/';
  const pathname = url.split('?')[0];
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  // Forbid anything that escapes the UI dir.
  if (rel.includes('..')) {
    sendError(res, 400, 'bad path');
    return true;
  }
  const full = path.join(UI_DIR, rel);
  if (!full.startsWith(UI_DIR)) {
    sendError(res, 400, 'bad path');
    return true;
  }
  try {
    const body = readFileSync(full);
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': body.byteLength,
      'Cache-Control': 'no-store',
    });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

function publicConfig(cfg: ResolvedConfig): Record<string, unknown> {
  return {
    provider: cfg.provider,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    apiKey: cfg.apiKey ? '••••••••' : null,
    apiKeySet: cfg.apiKey !== null && cfg.apiKey !== '',
    temperature: cfg.temperature,
    whisperCliPath: cfg.whisperCliPath,
    whisperModelPath: cfg.whisperModelPath,
    hotkeyCombo: cfg.hotkeyCombo,
    hotkeyMode: cfg.hotkeyMode,
    toggleHotkeyCombo: cfg.toggleHotkeyCombo,
    clipboardRestoreDelayMs: cfg.clipboardRestoreDelayMs,
    clipboardRetention: cfg.clipboardRetention,
    injectionMethod: cfg.injectionMethod,
    focusChangePolicy: cfg.focusChangePolicy,
    progressiveInjection: cfg.progressiveInjection,
    vadEnabled: cfg.vadEnabled,
    vadThresholdDb: cfg.vadThresholdDb,
    vadSilenceMs: cfg.vadSilenceMs,
    vadLeadInMs: cfg.vadLeadInMs,
    contextCapture: cfg.contextCapture,
    clipboardContextEntries: cfg.clipboardContextEntries,
    screenshotContext: cfg.screenshotContext,
    appSkillRoutes: cfg.appSkillRoutes,
    overlayAnchor: cfg.overlayAnchor,
    overlayOffsetX: cfg.overlayOffsetX,
    overlayOffsetY: cfg.overlayOffsetY,
    overlayPosition: cfg.overlayPosition,
    systemPrompt: cfg.systemPrompt,
    enabledSkills: cfg.enabledSkills,
    controlPanelPort: cfg.controlPanelPort,
    mcpPort: cfg.mcpPort,
    recorderCommand: cfg.recorderCommand,
    logMode: cfg.logMode,
    logsDir: cfg.logsDir,
    skillsDir: cfg.skillsDir,
    configFilePath: cfg.configFilePath,
  };
}

function skillJson(s: Skill): Record<string, unknown> {
  return {
    id: s.id,
    name: s.name,
    description: s.description,
    content: s.content,
    filePath: s.filePath,
  };
}

function stateSnapshot(deps: ServerDeps, csrfToken: string): Record<string, unknown> {
  const cfg = deps.getCurrentConfig();
  const { skills, shadowed } = loadSkillsReport(cfg.skillsDir);
  const composed = composeSystemPrompt(cfg.systemPrompt, skills, cfg.enabledSkills);
  return {
    config: publicConfig(cfg),
    overrides: deps.getCurrentOverrides?.() ?? {},
    shadowedEnv: deps.getCurrentShadowedEnv?.() ?? {},
    configError: getConfigFileError(cfg.configFilePath),
    skills: skills.map(skillJson),
    skillConflicts: shadowed.map((c) => ({
      id: c.id,
      file: path.basename(c.filePath),
      keptFile: path.basename(c.keptFilePath),
    })),
    composedSystemPrompt: composed,
    providers: Object.entries(PROVIDER_PRESETS).map(([id, preset]) => ({
      id,
      displayName: preset.displayName,
      defaultBaseUrl: preset.defaultBaseUrl,
    })),
    overlay: {
      visible: deps.isOverlayVisible?.() ?? null,
    },
    security: {
      csrfToken,
    },
  };
}

interface RouteContext {
  method: string;
  pathname: string;
  body: unknown;
  deps: ServerDeps;
  res: ServerResponse;
  csrfToken: string;
}

function matchRoute(pathname: string, pattern: string): Record<string, string> | null {
  const a = pathname.replace(/\/+$/, '').split('/');
  const b = pattern.split('/');
  if (a.length !== b.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < a.length; i++) {
    const seg = b[i];
    if (seg.startsWith(':')) {
      params[seg.slice(1)] = decodeURIComponent(a[i]);
    } else if (seg !== a[i]) {
      return null;
    }
  }
  return params;
}

/**
 * Applies `mutate` to config.json. If the write is refused (unparseable file)
 * or fails, answers 409 so the panel never reports a save that didn't happen.
 */
function persistConfig(
  deps: ServerDeps,
  res: ServerResponse,
  mutate: (raw: Record<string, unknown>) => void,
): boolean {
  const { configFilePath } = deps.getCurrentConfig();
  if (updateConfigFile(configFilePath, mutate)) return true;
  const reason = getConfigFileError(configFilePath) ?? 'could not write the config file';
  sendError(res, 409, `Not saved: ${reason}`);
  return false;
}

async function handleApi(ctx: RouteContext): Promise<boolean> {
  const { method, pathname, body, deps, res, csrfToken } = ctx;

  if (method === 'GET' && pathname === '/api/state') {
    sendJson(res, 200, stateSnapshot(deps, csrfToken));
    return true;
  }

  if (method === 'POST' && pathname === '/api/overlay/show') {
    deps.showOverlay?.();
    sendJson(res, 200, { ok: true, visible: deps.isOverlayVisible?.() ?? null });
    return true;
  }

  if (method === 'POST' && pathname === '/api/overlay/hide') {
    deps.hideOverlay?.();
    sendJson(res, 200, { ok: true, visible: deps.isOverlayVisible?.() ?? null });
    return true;
  }

  if (method === 'PUT' && pathname === '/api/config') {
    const patch = sanitizePartial(body, 'control-panel');
    const rejected = describeRejected(body, patch);
    if (Object.keys(rejected).length > 0) {
      // Best-effort sanitizing is right for hand-edited files, but a save that
      // silently drops a field reads as success. Refuse the whole request.
      const detail = Object.entries(rejected)
        .map(([field, reason]) => `${field} ${reason}`)
        .join('; ');
      sendJson(res, 400, { error: `Not saved: ${detail}`, rejected });
      return true;
    }
    if (
      !persistConfig(deps, res, (raw) => {
        mergePatchIntoRaw(raw, patch);
      })
    ) {
      return true;
    }
    deps.onConfigUpdated();
    sendJson(res, 200, stateSnapshot(deps, csrfToken));
    return true;
  }

  if (method === 'PUT' && pathname === '/api/system-prompt') {
    const b = body as { prompt?: unknown };
    if (typeof b?.prompt !== 'string') {
      sendError(res, 400, 'prompt must be a string');
      return true;
    }
    const prompt = b.prompt;
    if (
      !persistConfig(deps, res, (raw) => {
        raw.systemPrompt = prompt;
      })
    ) {
      return true;
    }
    deps.onConfigUpdated();
    sendJson(res, 200, stateSnapshot(deps, csrfToken));
    return true;
  }

  if (method === 'POST' && pathname === '/api/skills') {
    const b = body as { id?: string; name?: string; description?: string; content?: string };
    if (!b.name || !b.content) {
      sendError(res, 400, 'name and content are required');
      return true;
    }
    if (b.id && !isValidSkillId(b.id)) {
      sendError(res, 400, 'skill id must use lowercase letters, numbers, and hyphens');
      return true;
    }
    const cfg = deps.getCurrentConfig();
    try {
      const created = createSkill(cfg.skillsDir, {
        id: b.id,
        name: b.name,
        description: b.description ?? '',
        content: b.content,
      });
      sendJson(res, 200, { ...stateSnapshot(deps, csrfToken), createdId: created.id });
    } catch (err) {
      if (!sendSkillConflict(res, err)) throw err;
    }
    return true;
  }

  {
    const p = matchRoute(pathname, '/api/skills/:id');
    if (p) {
      const cfg = deps.getCurrentConfig();
      if (!isValidSkillId(p.id)) {
        sendError(res, 400, 'skill id must use lowercase letters, numbers, and hyphens');
        return true;
      }
      if (method === 'PUT') {
        const b = body as { name?: string; description?: string; content?: string };
        if (!b.name || !b.content) {
          sendError(res, 400, 'name and content are required');
          return true;
        }
        try {
          saveSkill(cfg.skillsDir, {
            id: p.id,
            name: b.name,
            description: b.description ?? '',
            content: b.content,
          });
          sendJson(res, 200, stateSnapshot(deps, csrfToken));
        } catch (err) {
          if (!sendSkillConflict(res, err)) throw err;
        }
        return true;
      }
      if (method === 'DELETE') {
        const ok = deleteSkill(cfg.skillsDir, p.id);
        if (!ok) {
          sendError(res, 404, 'skill not found');
          return true;
        }
        // Also remove from enabledSkills.
        if (cfg.enabledSkills.includes(p.id)) {
          if (
            !persistConfig(deps, res, (raw) => {
              const arr = Array.isArray(raw.enabledSkills) ? (raw.enabledSkills as string[]) : [];
              raw.enabledSkills = arr.filter((id) => id !== p.id);
            })
          ) {
            return true;
          }
          deps.onConfigUpdated();
        }
        sendJson(res, 200, stateSnapshot(deps, csrfToken));
        return true;
      }
    }
  }

  {
    const p = matchRoute(pathname, '/api/skills/:id/toggle');
    if (p && method === 'POST') {
      if (!isValidSkillId(p.id)) {
        sendError(res, 400, 'skill id must use lowercase letters, numbers, and hyphens');
        return true;
      }
      const cfg = deps.getCurrentConfig();
      const b = body as { enabled?: boolean };
      const enable = b?.enabled ?? !cfg.enabledSkills.includes(p.id);
      if (
        !persistConfig(deps, res, (raw) => {
          const arr = Array.isArray(raw.enabledSkills) ? (raw.enabledSkills as string[]) : [];
          const set = new Set(arr);
          if (enable) set.add(p.id);
          else set.delete(p.id);
          raw.enabledSkills = [...set];
        })
      ) {
        return true;
      }
      deps.onConfigUpdated();
      sendJson(res, 200, stateSnapshot(deps, csrfToken));
      return true;
    }
  }

  if (method === 'POST' && pathname === '/api/test/llm') {
    try {
      const result = await deps.testLlm();
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 200, { ok: false, message: (err as Error).message });
    }
    return true;
  }

  return false;
}

function mergePatchIntoRaw(raw: Record<string, unknown>, patch: PartialConfig): void {
  const scalarKeys: (keyof PartialConfig)[] = [
    'provider',
    'baseUrl',
    'model',
    'apiKey',
    'temperature',
    'whisperCliPath',
    'whisperModelPath',
    'hotkeyCombo',
    'hotkeyMode',
    'toggleHotkeyCombo',
    'clipboardRestoreDelayMs',
    'clipboardRetention',
    'injectionMethod',
    'focusChangePolicy',
    'progressiveInjection',
    'vadEnabled',
    'vadThresholdDb',
    'vadSilenceMs',
    'vadLeadInMs',
    'contextCapture',
    'clipboardContextEntries',
    'screenshotContext',
    'appSkillRoutes',
    'systemPrompt',
    'enabledSkills',
    'controlPanelPort',
    'mcpPort',
    'recorderCommand',
    'logMode',
    'logsDir',
    'skillsDir',
  ];
  for (const k of scalarKeys) {
    if (patch[k] !== undefined) {
      (raw as Record<string, unknown>)[k] = patch[k] as unknown;
    }
  }
  if (patch.overlay) {
    const existing =
      raw.overlay && typeof raw.overlay === 'object'
        ? (raw.overlay as Record<string, unknown>)
        : {};
    raw.overlay = { ...existing, ...patch.overlay };
  }
}

function requestPort(req: IncomingMessage): number | null {
  const address = req.socket.address();
  if (typeof address !== 'object' || address === null || !('port' in address)) return null;
  return address.port;
}

function isAllowedOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const port = requestPort(req);
    const originPort = parsed.port ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80;
    return (
      (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
      isLoopbackHostname(parsed.hostname) &&
      port !== null &&
      originPort === port
    );
  } catch {
    return false;
  }
}

function isStateChangingMethod(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}

function setSecurityHeaders(res: ServerResponse, csrfToken: string): void {
  // Not used for auth (the page sends the token from /api/state as a header); HttpOnly keeps it
  // out of reach of scripts on other localhost origins, which share cookies across ports.
  res.setHeader('Set-Cookie', `murmur_token=${csrfToken}; Path=/; SameSite=Strict; HttpOnly`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
}

export function startControlPanelServer(deps: ServerDeps): Promise<ServerHandle> {
  return new Promise((resolve, reject) => {
    const desiredPort = deps.getCurrentConfig().controlPanelPort;
    const csrfToken = randomBytes(32).toString('base64url');
    const server = createServer(async (req, res) => {
      const method = req.method ?? 'GET';
      const rawUrl = req.url ?? '/';
      const pathname = rawUrl.split('?')[0];

      setSecurityHeaders(res, csrfToken);
      // Host check blocks DNS rebinding, which would otherwise let a web page
      // read /api/state (including the control token) "same-origin".
      if (!hasLoopbackHost(req) || !isAllowedOrigin(req)) {
        sendError(res, 403, 'origin not allowed');
        return;
      }

      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE',
          'Access-Control-Allow-Headers': 'Content-Type, X-Murmur-Token',
        });
        res.end();
        return;
      }

      if (pathname.startsWith('/api/')) {
        if (isStateChangingMethod(method) && req.headers['x-murmur-token'] !== csrfToken) {
          sendError(res, 403, 'missing or invalid control token');
          return;
        }
        let body: unknown = {};
        if (method !== 'GET') {
          try {
            body = await readBody(req);
          } catch (err) {
            sendError(
              res,
              err instanceof RequestBodyError ? err.status : 400,
              (err as Error).message,
            );
            return;
          }
        }
        try {
          const handled = await handleApi({ method, pathname, body, deps, res, csrfToken });
          if (!handled) sendError(res, 404, 'not found');
        } catch (err) {
          console.error('[control-panel] handler error:', err);
          sendError(res, 500, (err as Error).message);
        }
        return;
      }

      if (pathname === '/overlay/show' || pathname === '/overlay/hide') {
        sendError(res, 405, 'overlay changes require POST /api/overlay/* from the control panel');
        return;
      }

      if (method === 'GET') {
        if (!serveStatic(req, res)) {
          if (!serveStatic({ ...req, url: '/' } as IncomingMessage, res)) {
            sendError(res, 404, 'not found');
          }
        }
        return;
      }

      sendError(res, 405, 'method not allowed');
    });

    server.on('error', reject);
    const port = desiredPort && desiredPort > 0 ? desiredPort : 0;
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const boundPort = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        port: boundPort,
        url: `http://localhost:${boundPort}`,
        stop: () =>
          new Promise((ok) => {
            server.close(() => ok());
          }),
      });
    });
  });
}
