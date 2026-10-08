import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { pluginRoot } from '../src/server.mjs';

const client = new Client({ name: 'student-ide-smoke', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(pluginRoot, 'runtime/mcp.mjs')], env: process.env }));
try {
  const snapshot = await client.callTool({ name: 'get_editor_snapshot', arguments: {} });
  assert.ok(!snapshot.isError, snapshot.content[0]?.text);
  const state = snapshot.structuredContent;
  assert.equal(state.name, 'student-ide');
  const listed = await client.listTools();
  const names = listed.tools.map(tool => tool.name).sort();
  const expected = ['get_editor_snapshot', 'get_coding_events', 'replay_document', 'get_language_capabilities'];
  if (state.phase === 'preparation') expected.push('open_student_ide', 'register_language', 'verify_language');
  assert.deepEqual(names, expected.sort());
  console.log(JSON.stringify({ passed: true, phase: state.phase, tools: names, url: state.url, workspace: state.workspace, servicePid: state.pid }));
} finally { await client.close(); }
