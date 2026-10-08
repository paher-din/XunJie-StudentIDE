import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { pluginRoot } from '../src/server.mjs';
import { hash } from '../src/journal.mjs';

test('fresh distributions omit stale files and work outside the development dependency tree', async () => {
  const excluded = 'unreferenced-' + randomUUID() + '.mjs';
  writeFileSync(path.join(pluginRoot, 'runtime', excluded), 'throw new Error("must not ship");\n');
  const pack = () => JSON.parse(execFileSync(process.execPath, [path.join(pluginRoot, 'scripts/package.mjs')], { cwd: pluginRoot, encoding: 'utf8', windowsHide: true }));
  const first = pack(), second = pack();
  assert.notEqual(first.marketplaceRoot, second.marketplaceRoot);
  assert.ok(existsSync(first.pluginRoot));
  for (const item of [first, second]) {
    for (const omitted of ['node_modules', 'lab', '.student-ide', 'test', 'web', 'runtime/' + excluded]) assert.equal(existsSync(path.join(item.pluginRoot, omitted)), false, omitted);
    const catalog = JSON.parse(readFileSync(path.join(item.marketplaceRoot, '.agents/plugins/marketplace.json'), 'utf8'));
    assert.equal(path.resolve(item.marketplaceRoot, catalog.plugins[0].source.path), item.pluginRoot);
    assert.equal(catalog.name, 'xunjie-studentide');
  }

  const isolated = mkdtempSync(path.join(os.tmpdir(), 'xunjie-distribution-'));
  const installed = path.join(isolated, 'student-ide');
  cpSync(second.pluginRoot, installed, { recursive: true });
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'xunjie-package-project-'));
  writeFileSync(path.join(workspace, 'data.json'), '{}\n');
  const { startServer } = await import(pathToFileURL(path.join(installed, 'src/server.mjs')).href);
  const app = await startServer({ workspace, port: 0, phase: 'preparation' });
  const environment = { ...process.env, STUDENT_IDE_WORKSPACE: workspace, STUDENT_IDE_PORT: new URL(app.origin).port };
  const client = new Client({ name: 'xunjie-package-test', version: '1.0.0' });
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(installed, 'runtime/mcp.mjs')], env: environment }));
    assert.equal((await client.listTools()).tools.length, 7);
    // The service must keep handling HTTP while the smoke child waits for MCP.
    const smokeAsync = () => new Promise((resolve, reject) => execFile(process.execPath, [path.join(pluginRoot, 'scripts/smoke-mcp.mjs')], { env: environment, encoding: 'utf8', windowsHide: true, timeout: 10000 }, (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout))));
    assert.equal((await smokeAsync()).phase, 'preparation');
    const owner = { clientId: 'package-qa', writerId: 'package-qa' };
    const post = (route, body) => fetch(app.origin + '/api/' + route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-student-ide': '1' }, body: JSON.stringify(body) });
    assert.equal((await post('phase', { ...owner, phase: 'student', expectedRevision: app.journal.phaseRevision })).status, 200);
    const snapshot = await client.callTool({ name: 'get_editor_snapshot', arguments: {} });
    assert.ok(!snapshot.isError);
    assert.equal(snapshot.structuredContent.phase, 'student');
    assert.equal((await client.listTools()).tools.length, 4);
    assert.equal((await smokeAsync()).phase, 'student');
    const text = '{"value": }\n';
    assert.equal((await post('events', { ...owner, events: [{ id: randomUUID(), type: 'document.open', payload: { path: 'data.json', modelId: 'package-json', version: 1, text, diskHash: hash('{}\n') } }] })).status, 200);
    const diagnostics = await post('diagnostics', { ...owner, path: 'data.json', modelId: 'package-json', version: 1 });
    assert.equal(diagnostics.status, 200);
    const result = await diagnostics.json();
    assert.equal(result.status, 'ready');
    assert.ok(result.diagnostics.length > 0);
    assert.equal(readFileSync(path.join(workspace, 'data.json'), 'utf8'), '{}\n');
  } finally { await client.close(); await app.close(); }
});
