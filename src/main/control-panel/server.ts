import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type PartialConfig, type ResolvedConfig, updateConfigFile } from '../config/index.js';
import { sanitizePartial } from '../config/schema.js';
import { PROVIDER_PRESETS } from '../providers/index.js';
import { composeSystemPrompt, deleteSkill, loadSkills, type Skill, saveSkill } from '../skills.js';

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

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return {};
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('body is not valid JSON');
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
    sampleRate: cfg.sampleRate,
    hotkeyCombo: cfg.hotkeyCombo,
    toggleHotkeyCombo: cfg.toggleHotkeyCombo,
    clipboardRestoreDelayMs: cfg.clipboardRestoreDelayMs,
    overlayAnchor: cfg.overlayAnchor,
    overlayOffsetX: cfg.overlayOffsetX,
    overlayOffsetY: cfg.overlayOffsetY,
    overlayPosition: cfg.overlayPosition,
    systemPrompt: cfg.systemPrompt,
    enabledSkills: cfg.enabledSkills,
    controlPanelPort: cfg.controlPanelPort,
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

function stateSnapshot(deps: ServerDeps): Record<string, unknown> {
  const cfg = deps.getCurrentConfig();
  const skills = loadSkills(cfg.skillsDir);
  const composed = composeSystemPrompt(cfg.systemPrompt, skills, cfg.enabledSkills);
  return {
    config: publicConfig(cfg),
    skills: skills.map(skillJson),
    composedSystemPrompt: composed,
    providers: Object.entries(PROVIDER_PRESETS).map(([id, preset]) => ({
      id,
      displayName: preset.displayName,
      defaultBaseUrl: preset.defaultBaseUrl,
    })),
    overlay: {
      visible: deps.isOverlayVisible?.() ?? null,
    },
  };
}

function sendHtmlConfirmation(
  res: ServerResponse,
  kind: 'shown' | 'hidden',
  panelUrl: string,
): void {
  const title = kind === 'shown' ? 'Overlay shown' : 'Overlay hidden';
  const body = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title} · Murmur</title>
<style>
  :root { color-scheme: dark; }
  body {
    margin: 0; height: 100vh; display: grid; place-items: center;
    background: radial-gradient(1200px 600px at 50% 20%, #1a1a2e 0%, #0b0b14 60%);
    color: #e7e7f3;
    font: 500 15px/1.5 "Segoe UI", Inter, system-ui, -apple-system, sans-serif;
  }
  .card {
    padding: 32px 40px; border-radius: 16px;
    background: linear-gradient(180deg, rgba(26,26,46,.9), rgba(17,17,36,.9));
    border: 1px solid #2a2a44; text-align: center; max-width: 440px;
  }
  h1 { margin: 0 0 8px; font-size: 22px; font-weight: 700;
       background: linear-gradient(90deg, #a78bfa, #60a5fa);
       -webkit-background-clip: text; background-clip: text; color: transparent; }
  p { margin: 0 0 16px; color: #a8a9c7; }
  a { color: #8b8cff; text-decoration: none; border-bottom: 1px dashed #8b8cff; }
  a:hover { border-bottom-style: solid; }
</style></head>
<body><div class="card">
  <h1>Overlay ${kind}</h1>
  <p>The Murmur pill is now ${kind} on your desktop. You can close this tab.</p>
  <p><a href="${panelUrl}">Open the control panel →</a></p>
</div>
<script>setTimeout(() => { window.close(); }, 1500);</script>
</body></html>`;
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

interface RouteContext {
  method: string;
  pathname: string;
  body: unknown;
  deps: ServerDeps;
  res: ServerResponse;
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

async function handleApi(ctx: RouteContext): Promise<boolean> {
  const { method, pathname, body, deps, res } = ctx;

  if (method === 'GET' && pathname === '/api/state') {
    sendJson(res, 200, stateSnapshot(deps));
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
    const cfg = deps.getCurrentConfig();
    updateConfigFile(cfg.configFilePath, (raw) => {
      mergePatchIntoRaw(raw, patch);
    });
    deps.onConfigUpdated();
    sendJson(res, 200, stateSnapshot(deps));
    return true;
  }

  if (method === 'PUT' && pathname === '/api/system-prompt') {
    const b = body as { prompt?: unknown };
    if (typeof b?.prompt !== 'string') {
      sendError(res, 400, 'prompt must be a string');
      return true;
    }
    const cfg = deps.getCurrentConfig();
    const prompt = b.prompt;
    updateConfigFile(cfg.configFilePath, (raw) => {
      raw.systemPrompt = prompt;
    });
    deps.onConfigUpdated();
    sendJson(res, 200, stateSnapshot(deps));
    return true;
  }

  if (method === 'POST' && pathname === '/api/skills') {
    const b = body as { id?: string; name?: string; description?: string; content?: string };
    if (!b.name || !b.content) {
      sendError(res, 400, 'name and content are required');
      return true;
    }
    const cfg = deps.getCurrentConfig();
    saveSkill(cfg.skillsDir, {
      id: b.id,
      name: b.name,
      description: b.description ?? '',
      content: b.content,
    });
    sendJson(res, 200, stateSnapshot(deps));
    return true;
  }

  {
    const p = matchRoute(pathname, '/api/skills/:id');
    if (p) {
      const cfg = deps.getCurrentConfig();
      if (method === 'PUT') {
        const b = body as { name?: string; description?: string; content?: string };
        if (!b.name || !b.content) {
          sendError(res, 400, 'name and content are required');
          return true;
        }
        saveSkill(cfg.skillsDir, {
          id: p.id,
          name: b.name,
          description: b.description ?? '',
          content: b.content,
        });
        sendJson(res, 200, stateSnapshot(deps));
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
          updateConfigFile(cfg.configFilePath, (raw) => {
            const arr = Array.isArray(raw.enabledSkills) ? (raw.enabledSkills as string[]) : [];
            raw.enabledSkills = arr.filter((id) => id !== p.id);
          });
          deps.onConfigUpdated();
        }
        sendJson(res, 200, stateSnapshot(deps));
        return true;
      }
    }
  }

  {
    const p = matchRoute(pathname, '/api/skills/:id/toggle');
    if (p && method === 'POST') {
      const cfg = deps.getCurrentConfig();
      const b = body as { enabled?: boolean };
      const enable = b?.enabled ?? !cfg.enabledSkills.includes(p.id);
      updateConfigFile(cfg.configFilePath, (raw) => {
        const arr = Array.isArray(raw.enabledSkills) ? (raw.enabledSkills as string[]) : [];
        const set = new Set(arr);
        if (enable) set.add(p.id);
        else set.delete(p.id);
        raw.enabledSkills = [...set];
      });
      deps.onConfigUpdated();
      sendJson(res, 200, stateSnapshot(deps));
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
    'sampleRate',
    'hotkeyCombo',
    'toggleHotkeyCombo',
    'clipboardRestoreDelayMs',
    'systemPrompt',
    'enabledSkills',
    'controlPanelPort',
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

export function startControlPanelServer(deps: ServerDeps): Promise<ServerHandle> {
  return new Promise((resolve, reject) => {
    const desiredPort = deps.getCurrentConfig().controlPanelPort;
    const server = createServer(async (req, res) => {
      const method = req.method ?? 'GET';
      const rawUrl = req.url ?? '/';
      const pathname = rawUrl.split('?')[0];

      res.setHeader('Access-Control-Allow-Origin', '*');
      if (method === 'OPTIONS') {
        res.writeHead(204, {
          'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE',
          'Access-Control-Allow-Headers': 'Content-Type',
        });
        res.end();
        return;
      }

      if (pathname.startsWith('/api/')) {
        let body: unknown = {};
        if (method !== 'GET') {
          try {
            body = await readBody(req);
          } catch (err) {
            sendError(res, 400, (err as Error).message);
            return;
          }
        }
        try {
          const handled = await handleApi({ method, pathname, body, deps, res });
          if (!handled) sendError(res, 404, 'not found');
        } catch (err) {
          console.error('[control-panel] handler error:', err);
          sendError(res, 500, (err as Error).message);
        }
        return;
      }

      // Terminal-clickable hyperlinks: side-effectful GETs that return a tiny
      // confirmation HTML page. Not under /api/ so they render nicely in the
      // browser when clicked from a terminal.
      if (method === 'GET' && pathname === '/overlay/show') {
        deps.showOverlay?.();
        const base = `http://localhost:${(req.socket.address() as { port: number }).port}`;
        sendHtmlConfirmation(res, 'shown', base);
        return;
      }
      if (method === 'GET' && pathname === '/overlay/hide') {
        deps.hideOverlay?.();
        const base = `http://localhost:${(req.socket.address() as { port: number }).port}`;
        sendHtmlConfirmation(res, 'hidden', base);
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
