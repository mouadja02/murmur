import 'dotenv/config';
import { parseCli } from './config/cli.js';
import { getUserDataDir, HELP_TEXT, loadConfig, printResolvedConfig } from './config/index.js';
import { createRuntime } from './runtime.js';

async function main(): Promise<void> {
  // --help / --print-config answer before any preflight, server or recorder.
  const cli = parseCli(process.argv);
  if (cli.helpAndExit) {
    console.log(HELP_TEXT);
    return;
  }
  if (cli.printAndExit) {
    printResolvedConfig(loadConfig({ userDataDir: getUserDataDir('murmur'), argv: process.argv }));
    return;
  }

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
