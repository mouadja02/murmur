import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';

const indexPath = path.join(process.cwd(), 'src', 'main', 'index.ts');

describe('Electron MCP wiring', () => {
  it('starts MCP in the GUI process with the shared pipeline', () => {
    const source = readFileSync(indexPath, 'utf8');

    assert.match(source, /startMcpServer/);
    assert.match(source, /let\s+mcpServer:/);
    assert.match(source, /getPipeline:\s*\(\)\s*=>\s*\{/);
    assert.match(source, /return pipeline;/);
  });

  it('configures a recorder for MCP-triggered GUI recordings', () => {
    const source = readFileSync(indexPath, 'utf8');

    assert.match(source, /CommandAudioRecorder/);
    assert.match(source, /createRecorder:\s*\(\)\s*=>\s*new CommandAudioRecorder/);
    assert.match(source, /recorderCommand/);
  });
});
