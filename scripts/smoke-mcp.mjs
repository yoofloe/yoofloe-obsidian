import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';

const client = new Client({ name: 'yoofloe-compatibility-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath, args: [resolve('mcp-server.js')],
  env: { SystemRoot: process.env.SystemRoot ?? '', PATH: process.env.PATH ?? '',
    YOOFLOE_PAT: '', YOOFLOE_VAULT_PATH: '', YOOFLOE_FUNCTIONS_BASE_URL: '' },
  stderr: 'pipe'
});
try {
  await client.connect(transport);
  const tools = await client.listTools();
  assert.deepEqual(tools.tools.map((entry) => entry.name).sort(),
    ['yoofloe_agent_direct_guide', 'yoofloe_mcp_session_status', 'yoofloe_test_token']);
  const result = await client.callTool({ name: 'yoofloe_mcp_session_status', arguments: {} });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent.configuration.ready, false);
  assert.equal(result.structuredContent.security, null);
  assert.equal(result.structuredContent.permissions.remoteCapture, false);
  console.log('Built MCP stdio smoke passed: initialize, tools/list, and diagnostic tools/call with no PAT or vault.');
} finally {
  await client.close();
}
