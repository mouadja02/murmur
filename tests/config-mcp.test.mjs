import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { parseCli } from '../dist/main/config/cli.js';
import { loadConfig } from '../dist/main/config/index.js';
import { sanitizePartial } from '../dist/main/config/schema.js';

function withTempConfig(fileContents, argv, fn) {
  const tmp = mkdtempSync(path.join(tmpdir(), 'murmur-mcp-cfg-'));
  try {
    writeFileSync(path.join(tmp, 'config.json'), JSON.stringify(fileContents));
    fn(loadConfig({ userDataDir: tmp, argv }));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

describe('MCP config', () => {
  it('parses serve mode and MCP flags from CLI', () => {
    const parsed = parseCli([
      'node',
      'murmur',
      'serve',
      '--port',
      '8123',
      '--mcp-port',
      '8124',
      '--recorder-command',
      'sox -q -d -r 16000 -c 1 -b 16 -e signed-integer -t raw -',
    ]);

    assert.equal(parsed.mode, 'serve');
    assert.equal(parsed.partial.controlPanelPort, 8123);
    assert.equal(parsed.partial.mcpPort, 8124);
    assert.equal(
      parsed.partial.recorderCommand,
      'sox -q -d -r 16000 -c 1 -b 16 -e signed-integer -t raw -',
    );
  });

  it('accepts persisted MCP and recorder config', () => {
    const out = sanitizePartial(
      {
        mcpPort: 7332,
        recorderCommand: 'arecord -q -f S16_LE -r 16000 -c 1 -t raw',
      },
      'test',
    );

    assert.equal(out.mcpPort, 7332);
    assert.equal(out.recorderCommand, 'arecord -q -f S16_LE -r 16000 -c 1 -t raw');
  });

  it('resolves MCP settings with CLI over file over env over defaults', () => {
    const oldMcp = process.env.MURMUR_MCP_PORT;
    const oldRecorder = process.env.MURMUR_RECORDER_COMMAND;
    try {
      process.env.MURMUR_MCP_PORT = '9000';
      process.env.MURMUR_RECORDER_COMMAND = 'env-recorder --raw';

      withTempConfig(
        { mcpPort: 8000, recorderCommand: 'file-recorder --raw' },
        ['node', 'test', 'serve', '--mcp-port', '7000', '--recorder-command', 'cli-recorder --raw'],
        (loaded) => {
          assert.equal(loaded.cli.mode, 'serve');
          assert.equal(loaded.resolved.mcpPort, 7000);
          assert.equal(loaded.resolved.recorderCommand, 'cli-recorder --raw');
          assert.equal(loaded.valueSources.mcpPort, 'cli');
          assert.equal(loaded.valueSources.recorderCommand, 'cli');
          assert.equal(loaded.overrides.mcpPort, 'cli');
          assert.equal(loaded.overrides.recorderCommand, 'cli');
        },
      );
    } finally {
      if (oldMcp === undefined) delete process.env.MURMUR_MCP_PORT;
      else process.env.MURMUR_MCP_PORT = oldMcp;
      if (oldRecorder === undefined) delete process.env.MURMUR_RECORDER_COMMAND;
      else process.env.MURMUR_RECORDER_COMMAND = oldRecorder;
    }
  });

  it('defaults MCP port and recorder command', () => {
    withTempConfig({}, ['node', 'test'], (loaded) => {
      assert.equal(loaded.resolved.mcpPort, 7332);
      assert.equal(typeof loaded.resolved.recorderCommand, 'string');
      assert.ok(loaded.resolved.recorderCommand.length > 0);
      assert.equal(loaded.valueSources.mcpPort, 'default');
      assert.equal(loaded.valueSources.recorderCommand, 'default');
    });
  });
});
