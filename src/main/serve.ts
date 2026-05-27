import 'dotenv/config';
import { getUserDataDir } from './config/index.js';
import { createRuntime } from './runtime.js';

async function main(): Promise<void> {
  const runtime = await createRuntime({
    userDataDir: getUserDataDir('murmur'),
    argv: process.argv,
    requireRecorder: true,
  });
  console.log(`[murmur] control panel: ${runtime.controlPanel.url}`);
  console.log(`[murmur] MCP server: ${runtime.mcpServer.url}`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await runtime.stop();
      process.exit(0);
    } catch (err) {
      console.error('[murmur] fatal during shutdown:', err);
      process.exit(1);
    }
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[murmur] fatal during serve:', err);
  process.exit(1);
});
