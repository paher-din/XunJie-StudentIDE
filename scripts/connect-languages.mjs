import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import path from 'node:path';
import { pluginRoot } from '../src/server.mjs';

// Integration example: connect to this project's MCP; runtimes are prepared by the host agent.
const ids = process.argv.slice(2);
if (!ids.length) throw new Error('传入要接入的参考配置 id，例如 javascript cpp；自定义语言使用 register_language');
const client = new Client({ name: 'language-setup-example', version: '1.0.0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(pluginRoot, 'runtime/mcp.mjs')], env: process.env }));
try {
  const capabilities = (await client.callTool({ name: 'get_language_capabilities', arguments: {} })).structuredContent;
  for (const id of ids) {
    const profile = capabilities.templates.find(template => template.id === id);
    if (!profile) throw new Error('没有此参考配置：' + id);
    const current = capabilities.languages.find(language => language.id === id);
    const registered = await client.callTool({ name: 'register_language', arguments: { profile, ...(current ? { expectedVersion: current.version } : {}) } });
    if (registered.isError) throw new Error(registered.content[0]?.text);
    const result = await client.callTool({ name: 'verify_language', arguments: { id } }, undefined, { timeout: 180000 });
    if (result.isError || result.structuredContent?.status !== 'ready') throw new Error(JSON.stringify(result.structuredContent?.verification ?? result));
    console.log(JSON.stringify({ id, status: 'ready', version: result.structuredContent.version, definitionHash: result.structuredContent.definitionHash }));
  }
} finally { await client.close(); }
