import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startServer, pluginRoot } from '../src/server.mjs';
import { hash } from '../src/journal.mjs';
import { referenceProfiles } from '../src/languages.mjs';

const readTools = ['get_coding_events', 'get_editor_snapshot', 'get_language_capabilities', 'replay_document'];
const connect = async (workspace, port) => {
  const client = new Client({ name: 'phase-check', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(pluginRoot, 'runtime/mcp.mjs')], env: { ...process.env, STUDENT_IDE_WORKSPACE: workspace, STUDENT_IDE_PORT: String(port) } }));
  return client;
};
const rejected = async (client, name, args = {}) => {
  let result;
  try { result = await client.callTool({ name, arguments: args }); }
  catch (failure) { assert.equal(failure.code, -32602, 'Expected a disabled or unavailable tool'); return; }
  assert.equal(result.isError, true);
};

test('offline MCP reads fail without starting a service or creating a journal', async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'student-ide-offline-'));
  const reserved = http.createServer();
  await new Promise(resolve => reserved.listen(0, '127.0.0.1', resolve));
  const port = reserved.address().port;
  await new Promise(resolve => reserved.close(resolve));
  const client = await connect(workspace, port);
  try {
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), readTools);
    for (const name of readTools) {
      const result = await client.callTool({ name, arguments: name === 'replay_document' ? { path: 'main.mjs' } : {} });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /读取不会启动服务/);
    }
    await rejected(client, 'open_student_ide');
    assert.equal(existsSync(path.join(workspace, '.student-ide')), false);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/api/health`));
  } finally { await client.close(); }
});

test('phase gates protect environment, refresh MCP tools and preserve student work across restart', async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'student-ide-phases-'));
  const disk = 'console.log("saved");\n';
  const draft = 'console.log("学生未保存 🐍");\n';
  writeFileSync(path.join(workspace, 'main.mjs'), disk);
  const probe = path.join(workspace, 'probe.mjs');
  writeFileSync(probe, 'setTimeout(() => console.log("version-one"), 200);\n');
  let app = await startServer({ workspace, port: 0 });
  assert.ok(app.journal.phaseRevision > 0, 'The default student phase must be recorded');
  await app.close();
  app = await startServer({ workspace, port: 0, phase: 'preparation' });
  assert.equal(app.journal.phase, 'student', 'Startup arguments must not reset the default learning phase');
  const client = await connect(workspace, new URL(app.origin).port);
  const owner = { clientId: 'phase-client', writerId: 'phase-window' };
  const request = async (route, body, mcp = false) => {
    const headers = { ...(mcp ? { 'x-student-ide-client': 'mcp' } : {}), ...(body === undefined ? {} : { 'x-student-ide': '1', 'content-type': 'application/json' }) };
    const response = await fetch(app.origin + '/api/' + route, { headers, ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  };
  const switchPhase = async phase => request('phase', { ...owner, phase, expectedRevision: app.journal.phaseRevision });
  const languages = () => JSON.stringify((app.journal.events.filter(event => event.type.startsWith('language.'))));
  try {
    assert.equal((await request('health')).body.phase, 'student');
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), readTools);
    const baseline = languages();
    for (const route of ['languages', 'languages/verify']) assert.equal((await request(route, { id: 'python', payload: 'NEVER_LOG_REQUEST_BODY' })).status, 403);
    for (const route of ['phase', 'events', 'save', 'run', 'capture', 'files/create', 'files/archive']) assert.equal((await request(route, { phase: 'preparation', recording: false }, true)).status, 403);
    assert.equal((await request('file?path=main.mjs', undefined, true)).status, 403);
    assert.equal(languages(), baseline);
    assert.equal(app.journal.phase, 'student');
    assert.equal(readFileSync(path.join(workspace, 'main.mjs'), 'utf8'), disk);
    assert.equal(readFileSync(app.journal.file, 'utf8').includes('NEVER_LOG_REQUEST_BODY'), false);
    assert.ok(app.journal.events.filter(event => event.type === 'policy.denied').every(event => event.originChannel === 'system'));

    assert.equal((await request('phase', { ...owner, phase: 'preparation', expectedRevision: -1 })).status, 409);
    assert.equal((await request('phase', { ...owner, phase: 'unknown', expectedRevision: 0 })).status, 400);
    assert.equal((await switchPhase('preparation')).status, 200);
    await client.callTool({ name: 'get_editor_snapshot', arguments: {} });
    assert.equal((await client.listTools()).tools.length, 7);
    const js = { ...referenceProfiles().find(profile => profile.id === 'javascript'), toolchain: { command: process.execPath, args: [probe] }, execute: { command: process.execPath, args: ['{entry}'] } };
    assert.equal((await client.callTool({ name: 'register_language', arguments: { profile: js } })).structuredContent.status, 'unverified');
    assert.equal((await client.callTool({ name: 'verify_language', arguments: { id: 'javascript' } })).structuredContent.status, 'ready');
    assert.equal((await client.callTool({ name: 'open_student_ide', arguments: {} })).structuredContent.phase, 'preparation');
    const opened = await request('events', { ...owner, events: [{ id: crypto.randomUUID(), type: 'document.open', payload: { path: 'main.mjs', modelId: 'student-buffer', version: 1, text: draft, diskHash: hash(disk) } }] });
    assert.equal(opened.status, 200);
    let received;
    const arrived = new Promise(resolve => { received = incoming => { if (incoming.method === 'POST' && incoming.url === '/api/languages/verify') { app.server.off('request', received); resolve(); } }; app.server.on('request', received); });
    let delayedRequest;
    const delayedResponse = new Promise((resolve, reject) => {
      delayedRequest = http.request(app.origin + '/api/languages/verify', { method: 'POST', headers: { 'content-type': 'application/json', 'x-student-ide': '1', 'x-student-ide-client': 'mcp' } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
      delayedRequest.on('error', reject);
      delayedRequest.write('{"id":"javascript"');
    });
    await arrived;
    assert.equal((await switchPhase('student')).status, 200);
    delayedRequest.end('}');
    assert.equal(await delayedResponse, 403, 'A request started in preparation must be rejected if its body finishes in the student phase');
    await rejected(client, 'register_language', { profile: js, expectedVersion: 1 });
    await rejected(client, 'verify_language', { id: 'javascript' });
    await rejected(client, 'open_student_ide');
    assert.deepEqual((await client.listTools()).tools.map(tool => tool.name).sort(), readTools);
    const protectedLanguages = languages();
    assert.equal((await request('languages', { profile: js, expectedVersion: 1 })).status, 403);
    assert.equal((await request('languages/verify', { id: 'javascript' })).status, 403);
    assert.equal(languages(), protectedLanguages);

    const code = { path: 'main.mjs', modelId: 'student-buffer', version: 1, input: '' };
    const pendingRun = request('run', code);
    const untilBusy = Date.now() + 3000;
    while (!(await request('health')).body.busy) { assert.ok(Date.now() < untilBusy); await new Promise(resolve => setTimeout(resolve, 10)); }
    assert.equal((await switchPhase('preparation')).status, 409);
    const later = draft + '// edited while probing\n';
    assert.equal((await request('events', { ...owner, events: [{ id: crypto.randomUUID(), type: 'document.edit', payload: { path: code.path, modelId: code.modelId, baseVersion: 1, version: 2, changes: [{ offset: draft.length, length: 0, text: '// edited while probing\n' }] } }] })).status, 200);
    const run = await pendingRun;
    assert.equal(run.status, 200);
    assert.equal(run.body.status, 'passed');
    assert.match(run.body.stdout, /学生未保存 🐍/);
    assert.equal(run.body.hash, hash(draft));
    assert.equal(run.body.version, 1);
    assert.equal(readFileSync(path.join(workspace, 'main.mjs'), 'utf8'), disk);
    assert.equal((await client.callTool({ name: 'get_editor_snapshot', arguments: {} })).structuredContent.buffers[0].hash, hash(later));
    code.version = 2;
    writeFileSync(probe, 'console.log("version-two");\n');
    const runCount = app.journal.runs.size;
    assert.equal((await request('run', code)).status, 409);
    assert.equal(app.journal.runs.size, runCount);
    assert.equal(languages(), protectedLanguages);
    assert.equal((await request('save', code)).status, 200);
    assert.equal(readFileSync(path.join(workspace, 'main.mjs'), 'utf8'), later);
    await request('capture', { recording: false });
    assert.equal((await switchPhase('preparation')).status, 200);
    assert.equal(app.journal.recording, false);
    const waitTools = async count => {
      const until = Date.now() + 3500;
      while ((await client.listTools()).tools.length !== count) {
        assert.ok(Date.now() < until, 'MCP monitor did not refresh the tool list');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    };
    await waitTools(7);
    assert.equal((await switchPhase('student')).status, 200);
    await waitTools(4);
    const log = readFileSync(app.journal.file, 'utf8');
    const revision = app.journal.phaseRevision;
    await client.close();
    await app.close();
    app = await startServer({ workspace, port: 0, phase: 'preparation' });
    assert.equal(app.journal.phase, 'student');
    assert.equal(app.journal.phaseRevision, revision);
    assert.equal(app.journal.recording, false);
    assert.equal(app.journal.replay('main.mjs').hash, hash(later));
    assert.ok(readFileSync(app.journal.file, 'utf8').startsWith(log));
  } finally { await client.close(); await app.close(); }
});
