import { createServer, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { updateConfigFile as defaultUpdateConfigFile } from '../config/file.js';
import type { ResolvedConfig } from '../config/index.js';
import type { Pipeline, ProcessPcmResult } from '../pipeline.js';
import { isValidSkillId, loadSkills } from '../skills.js';

const PIPELINE_BUSY_MESSAGE = 'pipeline is busy (recording or processing)';

export interface McpServerHandle {
  port: number;
  url: string;
  stop(): Promise<void>;
}

export interface StartMcpServerDeps {
  cfg: ResolvedConfig;
  getPipeline: () => Pipeline;
  getConfig: () => ResolvedConfig;
  onConfigUpdated: () => void;
  /** Test seam: called each time a request-scoped MCP server is constructed. */
  onMcpServerCreated?: () => void;
  createMurmurMcpServer?: typeof createMurmurMcpServer;
}

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

export interface MurmurMcpServer {
  server: McpServer;
  callToolForTest(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

export type McpPipeline = Pick<
  Pipeline,
  'record' | 'stopRecording' | 'transcribeFile' | 'refineText' | 'isBusy'
>;

export type MurmurMcpServerDeps = {
  getConfig: () => ResolvedConfig;
  getPipeline: () => McpPipeline;
  onConfigUpdated: () => void;
  updateConfigFile?: typeof defaultUpdateConfigFile;
};

function textResult(output: Record<string, unknown> & { text: string }): ToolResult {
  return {
    content: [{ type: 'text', text: output.text }],
    structuredContent: output,
  };
}

function toolError(err: unknown): ToolResult {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: 'text', text: message }], isError: true };
}

function refinedText(result: string | { text: string }): string {
  return typeof result === 'string' ? result : result.text;
}

function recordText(result: ProcessPcmResult): string {
  return result.text;
}

function pipelineBusy(getPipeline: () => McpPipeline): boolean {
  const pipeline = getPipeline();
  return typeof pipeline.isBusy === 'function' ? pipeline.isBusy() : false;
}

function rejectIfBusy(getPipeline: () => McpPipeline): void {
  if (pipelineBusy(getPipeline)) {
    throw new Error(PIPELINE_BUSY_MESSAGE);
  }
}

function registerMurmurTools(
  server: McpServer,
  deps: MurmurMcpServerDeps,
  handlers: Map<string, (args: Record<string, unknown>) => Promise<ToolResult>>,
): void {
  const persistConfig = deps.updateConfigFile ?? defaultUpdateConfigFile;

  function testHandler<T extends z.ZodRawShape>(
    schema: T,
    handler: (args: z.infer<z.ZodObject<T>>) => Promise<ToolResult>,
  ): (args: Record<string, unknown>) => Promise<ToolResult> {
    return async (raw) => {
      try {
        return await handler(z.object(schema).parse(raw));
      } catch (err) {
        return toolError(err);
      }
    };
  }

  const recordSchema = {
    duration_ms: z.number().int().positive().optional(),
    skill_ids: z.array(z.string()).optional(),
    inject: z.boolean().optional(),
  };

  const recordHandler = async (args: {
    duration_ms?: number;
    skill_ids?: string[];
    inject?: boolean;
  }): Promise<ToolResult> => {
    try {
      const result = await deps.getPipeline().record({
        durationMs: args.duration_ms,
        skillIds: args.skill_ids,
        inject: args.inject ?? false,
      });
      return textResult({ text: recordText(result) });
    } catch (err) {
      return toolError(err);
    }
  };
  handlers.set('murmur_record', testHandler(recordSchema, recordHandler));
  server.registerTool(
    'murmur_record',
    {
      description:
        'Record a voice prompt and return the refined text. Starts recording immediately; call murmur_stop_record or pass duration_ms to auto-stop.',
      inputSchema: recordSchema,
    },
    recordHandler,
  );

  const stopHandler = async (): Promise<ToolResult> => {
    try {
      await deps.getPipeline().stopRecording();
      return textResult({ text: 'Recording stopped.' });
    } catch (err) {
      return toolError(err);
    }
  };
  handlers.set('murmur_stop_record', async () => stopHandler());
  server.registerTool(
    'murmur_stop_record',
    { description: 'Stop the active Murmur MCP recording session.', inputSchema: {} },
    stopHandler,
  );

  const transcribeSchema = { file_path: z.string() };
  const transcribeHandler = async (args: { file_path: string }): Promise<ToolResult> => {
    try {
      rejectIfBusy(deps.getPipeline);
      if (!path.isAbsolute(args.file_path)) {
        throw new Error('file_path must be absolute');
      }
      const result = await deps.getPipeline().transcribeFile(args.file_path);
      return textResult({ text: result.text, durationMs: result.durationMs });
    } catch (err) {
      return toolError(err);
    }
  };
  handlers.set('murmur_transcribe', testHandler(transcribeSchema, transcribeHandler));
  server.registerTool(
    'murmur_transcribe',
    {
      description: 'Transcribe a WAV or MP3 file using the configured Whisper model.',
      inputSchema: transcribeSchema,
    },
    transcribeHandler,
  );

  const refineSchema = {
    text: z.string().min(1),
    skill_ids: z.array(z.string()).optional(),
  };
  const refineHandler = async (args: {
    text: string;
    skill_ids?: string[];
  }): Promise<ToolResult> => {
    try {
      rejectIfBusy(deps.getPipeline);
      const result = await deps.getPipeline().refineText(args.text, { skillIds: args.skill_ids });
      return textResult({ text: refinedText(result) });
    } catch (err) {
      return toolError(err);
    }
  };
  handlers.set('murmur_refine', testHandler(refineSchema, refineHandler));
  server.registerTool(
    'murmur_refine',
    {
      description: 'Refine raw text using the active system prompt and enabled skills.',
      inputSchema: refineSchema,
    },
    refineHandler,
  );

  const listHandler = async (): Promise<ToolResult> => {
    try {
      const cfg = deps.getConfig();
      const enabled = new Set(cfg.enabledSkills);
      const skills = loadSkills(cfg.skillsDir).map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        filePath: skill.filePath,
        enabled: enabled.has(skill.id),
      }));
      return {
        content: [{ type: 'text', text: JSON.stringify(skills, null, 2) }],
        structuredContent: { skills },
      };
    } catch (err) {
      return toolError(err);
    }
  };
  handlers.set('murmur_list_skills', async () => listHandler());
  server.registerTool(
    'murmur_list_skills',
    { description: 'List Murmur skills and whether each one is enabled.', inputSchema: {} },
    listHandler,
  );

  const toggleSchema = {
    skill_id: z.string(),
    enabled: z.boolean().optional(),
  };
  const toggleHandler = async (args: {
    skill_id: string;
    enabled?: boolean;
  }): Promise<ToolResult> => {
    try {
      rejectIfBusy(deps.getPipeline);
      const { skill_id, enabled } = args;
      if (!isValidSkillId(skill_id)) {
        throw new Error('invalid skill id');
      }
      const cfg = deps.getConfig();
      const skills = loadSkills(cfg.skillsDir);
      if (!skills.some((skill) => skill.id === skill_id)) {
        throw new Error('skill not found');
      }
      const nextEnabled = enabled ?? !cfg.enabledSkills.includes(skill_id);
      const saved = persistConfig(cfg.configFilePath, (raw) => {
        const arr = Array.isArray(raw.enabledSkills) ? (raw.enabledSkills as string[]) : [];
        const set = new Set(arr);
        if (nextEnabled) set.add(skill_id);
        else set.delete(skill_id);
        raw.enabledSkills = [...set];
      });
      if (!saved) {
        throw new Error('failed to persist skill toggle to config file');
      }
      deps.onConfigUpdated();
      return textResult({
        text: `${skill_id} ${nextEnabled ? 'enabled' : 'disabled'}`,
        enabled: nextEnabled,
      });
    } catch (err) {
      return toolError(err);
    }
  };
  handlers.set('murmur_toggle_skill', testHandler(toggleSchema, toggleHandler));
  server.registerTool(
    'murmur_toggle_skill',
    { description: 'Enable, disable, or toggle a Murmur skill.', inputSchema: toggleSchema },
    toggleHandler,
  );
}

export function createMurmurMcpServer(deps: MurmurMcpServerDeps): MurmurMcpServer {
  const server = new McpServer({ name: 'murmur', version: '0.6.0' });
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<ToolResult>>();
  registerMurmurTools(server, deps, handlers);

  return {
    server,
    callToolForTest(name: string, args: Record<string, unknown>) {
      const handler = handlers.get(name);
      if (!handler) throw new Error(`unknown tool ${name}`);
      return handler(args);
    },
  };
}

async function handleMcpHttpRequest(
  req: import('node:http').IncomingMessage,
  res: ServerResponse,
  deps: StartMcpServerDeps,
): Promise<void> {
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  const createServerFn = deps.createMurmurMcpServer ?? createMurmurMcpServer;
  const murmur = createServerFn({
    getConfig: deps.getConfig,
    getPipeline: deps.getPipeline,
    onConfigUpdated: deps.onConfigUpdated,
  });
  deps.onMcpServerCreated?.();

  try {
    await murmur.server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    console.error('[mcp] request failed:', err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'internal error' });
    }
  } finally {
    await transport.close().catch(() => undefined);
    await murmur.server.close().catch(() => undefined);
  }
}

export async function startMcpServer(deps: StartMcpServerDeps): Promise<McpServerHandle> {
  const httpServer: Server = createServer(async (req, res) => {
    const pathname = (req.url ?? '/').split('?')[0];
    if (pathname !== '/mcp') {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    await handleMcpHttpRequest(req, res, deps);
  });

  const desiredPort = deps.cfg.mcpPort;
  const port = desiredPort && desiredPort > 0 ? desiredPort : 0;

  return new Promise((resolve, reject) => {
    httpServer.on('error', reject);
    httpServer.listen(port, '127.0.0.1', () => {
      const addr = httpServer.address();
      const boundPort = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        port: boundPort,
        url: `http://127.0.0.1:${boundPort}/mcp`,
        stop: () =>
          new Promise<void>((res, rej) => {
            httpServer.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
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
