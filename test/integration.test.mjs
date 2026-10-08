import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, appendFileSync, existsSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startServer, pluginRoot } from '../src/server.mjs';
import { hash, applyChanges, sensitive } from '../src/journal.mjs';

test('file creation and reversible removal preserve drafts, scope and replay', async () => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'student-ide-files-'));
  let app = await startServer({ workspace, port: 0 });
  const request = async (route, body) => {
    const response = await fetch(app.origin + '/api/' + route, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-student-ide': '1' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const owner = { clientId: 'file-check', writerId: 'file-check-window' };
  try {
    assert.equal((await request('files/create', { ...owner, path: 'src/draft.txt' })).status, 200);
    assert.equal((await request('files/create', { ...owner, path: 'src/draft.txt' })).status, 409);
    for (const file of ['../outside.py', '.env', 'nested/.private.py', 'CON.py', 'a/b/c/d/e/f/main.py']) assert.equal((await request('files/create', { ...owner, path: file })).status, 403);
    const outside = mkdtempSync(path.join(os.tmpdir(), 'student-ide-files-outside-'));
    symlinkSync(outside, path.join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await request('files/create', { ...owner, path: 'escape/outside.py' })).status, 403);
    assert.equal(existsSync(path.join(outside, 'outside.py')), false);
    const draft = '未保存 🐍';
    await request('events', { ...owner, events: [{ id: crypto.randomUUID(), type: 'document.open', payload: { path: 'src/draft.txt', modelId: 'new-file', version: 1, text: draft, diskHash: hash('') } }] });
    const removal = { ...owner, path: 'src/draft.txt', modelId: 'new-file', version: 1 };
    assert.equal((await request('files/archive', { ...removal, version: 2 })).status, 409);
    writeFileSync(path.join(workspace, 'src/draft.txt'), 'external');
    assert.equal((await request('files/archive', removal)).status, 409);
    writeFileSync(path.join(workspace, 'src/draft.txt'), '');
    await request('capture', { recording: false });
    assert.equal((await request('files/archive', removal)).status, 409);
    await request('capture', { recording: true });
    const archived = await request('files/archive', removal);
    assert.equal(archived.status, 200);
    assert.equal(existsSync(path.join(workspace, 'src/draft.txt')), false);
    assert.equal(readFileSync(path.join(archived.body.trashDirectory, 'files/src/draft.txt'), 'utf8'), '');
    assert.equal(readFileSync(path.join(archived.body.trashDirectory, 'draft.txt'), 'utf8'), draft);
    assert.equal((await request('files')).body.files.length, 0);
    assert.equal((await request('state')).body.buffers.length, 0);
    assert.equal((await request('replay?path=src/draft.txt')).body.text, draft);
    assert.equal((await request('replay?path=src/draft.txt')).body.deleted, true);
    assert.equal(app.journal.events.at(-1).originChannel, 'ui_endpoint');
    await app.close();
    app = await startServer({ workspace, port: 0 });
    assert.equal((await request('state')).body.buffers.length, 0);
    assert.equal((await request('replay?path=src/draft.txt')).body.hash, hash(draft));
    assert.equal((await request('files/create', { ...owner, path: 'src/draft.txt' })).status, 200);
    const recreated = (await request('file?path=src/draft.txt')).body;
    assert.equal(recreated.text, '');
    assert.equal(recreated.recovered, false);
    assert.equal(recreated.diskChanged, false);
  } finally { await app.close(); }
});

test('end-to-end: unsaved buffers, replay, recovery, Python and MCP', async t => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'student-ide-check-'));
  const original = 'print("saved")\n';
  writeFileSync(path.join(workspace, 'main.py'), original);
  writeFileSync(path.join(workspace, 'test_entry.py'), 'print("runner fixture")\n');
  writeFileSync(path.join(workspace, '.excluded.py'), 'print("excluded fixture")\n');
  let app = await startServer({ workspace, port: 0, runTimeout: 1500, phase: 'preparation' });
  let url = app.origin;
  const request = async (route, body, headers = {}) => {
    const response = await fetch(url + '/api/' + route, body === undefined ? { headers } : { method: 'POST', headers: { 'content-type': 'application/json', 'x-student-ide': '1', ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const event = (type, payload, id = crypto.randomUUID()) => ({ id, type, payload });
  const send = events => request('events', { clientId: 'test-client', events });
  t.after(async () => { await app.close(); }); // Preserve artifacts; never delete files without user approval.
  const initial = event('document.open', { path: 'main.py', modelId: 'test-model', text: original, version: 1, diskHash: hash(original) });
  let edited = 'print("未保存 🐍")\n';

  await t.test('same-origin and project boundaries', async () => {
    assert.equal((await request('file?path=../AGENTS.md')).status, 403);
    assert.equal((await request('file?path=.env')).status, 403);
    assert.equal((await request('state', undefined, { Origin: 'https://other.example' })).status, 403);
    const hostStatus = await new Promise(resolve => {
      http.get(url + '/api/state', { headers: { Host: 'other.example' } }, response => { response.resume(); resolve(response.statusCode); });
    });
    assert.equal(hostStatus, 403);
    const listing = (await request('files')).body;
    assert.deepEqual(listing.files.map(file => file.path), ['main.py', 'test_entry.py']);
  });
  await t.test('acknowledged unsaved edits and idempotency', async () => {
    assert.equal((await send([initial])).status, 200);
    const change = { ...event('document.edit', { path: 'main.py', modelId: 'test-model', baseVersion: 1, version: 2, changes: [{ offset: 0, length: original.length, text: edited }] }), source: 'agent', originChannel: 'hook_endpoint' };
    assert.equal((await send([change])).status, 200);
    assert.equal(app.journal.ids.get(change.id).originChannel, 'ui_endpoint');
    assert.equal(app.journal.ids.get(change.id).source, 'ui_endpoint');
    const before = app.journal.events.length;
    assert.equal((await send([change])).status, 200);
    assert.equal(app.journal.events.length, before);
    assert.equal(readFileSync(path.join(workspace, 'main.py'), 'utf8'), original);
    const snapshot = (await request('state')).body;
    assert.equal(snapshot.buffers[0].text, edited);
    assert.equal(snapshot.buffers[0].dirty, true);
    assert.equal(snapshot.buffers[0].version, 2);
  });
  await t.test('undo, redo, replay and UTF-16 multi-cursor offsets', async () => {
    const undo = event('document.edit', { path: 'main.py', modelId: 'test-model', baseVersion: 2, version: 3, undo: true, changes: [{ offset: 0, length: edited.length, text: original }] });
    const redo = event('document.edit', { path: 'main.py', modelId: 'test-model', baseVersion: 3, version: 4, redo: true, changes: [{ offset: 0, length: original.length, text: edited }] });
    assert.equal((await send([undo, redo])).status, 200);
    const replay = (await request('replay?path=main.py')).body;
    assert.equal(replay.text, edited);
    assert.equal(replay.hash, hash(edited));
    assert.equal(replay.checkpoints.length, 4);
    assert.equal((await request('replay?path=main.py&seq=' + app.journal.ids.get(undo.id).seq)).body.text, original);
    assert.equal(replay.checkpoints.at(-1).originChannel, 'ui_endpoint');
    assert.equal(applyChanges('🐍abc', [{ offset: 4, length: 1, text: 'Z' }, { offset: 2, length: 1, text: 'X' }]), '🐍XbZ');
    assert.throws(() => applyChanges('abc', [{ offset: 1, length: 3, text: '' }]));
  });
  await t.test('invalid versions and batch atomicity', async () => {
    const before = app.journal.events.length;
    const first = event('editor.focus', { path: 'main.py' });
    const bad = event('document.edit', { path: 'main.py', modelId: 'test-model', baseVersion: 1, version: 5, changes: [] });
    assert.equal((await send([first, bad])).status, 409);
    assert.equal(app.journal.events.length, before);
    assert.equal((await request('events', { clientId: 'another-client', events: [first] })).status, 409);
  });
  await t.test('actual Python executes the unsaved snapshot', async () => {
    const result = await request('run', { path: 'main.py', modelId: 'test-model', version: 4, input: '' });
    assert.equal(result.status, 200);
    assert.equal(result.body.exitCode, 0, JSON.stringify(result.body));
    assert.match(result.body.stdout, /未保存 🐍/);
    assert.equal(result.body.hash, hash(edited));
    assert.equal(result.body.version, 4);
    assert.equal(readFileSync(path.join(workspace, 'main.py'), 'utf8'), original);
    assert.equal(app.journal.runs.get(result.body.runId).text, edited);
  });
  await t.test('sensitive content is rejected before logging', async () => {
    const fake = 'password = "TEST_ONLY_NOT_A_CREDENTIAL"';
    assert.equal(sensitive(fake), true);
    const change = event('document.edit', { path: 'main.py', modelId: 'test-model', baseVersion: 4, version: 5, changes: [{ offset: 0, length: edited.length, text: fake }] });
    assert.equal((await send([change])).status, 422);
    assert.equal(readFileSync(app.journal.file, 'utf8').includes('TEST_ONLY_NOT_A_CREDENTIAL'), false);
    assert.equal((await request('run', { path: 'main.py', modelId: 'test-model', version: 4, input: fake })).status, 422);
  });
  await t.test('real __main__ supports unittest discovery and dependency snapshots', async () => {
    const suite = 'import unittest\nclass Smoke(unittest.TestCase):\n    def test_probe(self):\n        self.assertEqual(1, 2)\nif __name__ == "__main__": unittest.main()\n';
    const disk = readFileSync(path.join(workspace, 'test_entry.py'), 'utf8');
    await send([event('document.open', { path: 'test_entry.py', modelId: 'test-suite', version: 1, text: suite, diskHash: hash(disk) })]);
    const result = (await request('run', { path: 'test_entry.py', modelId: 'test-suite', version: 1, input: '' })).body;
    assert.equal(result.status, 'failed');
    assert.match(result.stderr, /Ran 1 test/);
    assert.match(result.stderr, /AssertionError/);
    assert.ok(result.dependencies.some(file => file.path === 'main.py' && file.hash === hash(original)));
    const passing = suite.replace('assertEqual(1, 2)', 'assertEqual(1, 1)');
    await send([event('document.edit', { path: 'test_entry.py', modelId: 'test-suite', baseVersion: 1, version: 2, changes: [{ offset: 0, length: suite.length, text: passing }] })]);
    assert.equal((await request('run', { path: 'test_entry.py', modelId: 'test-suite', version: 2, input: '' })).body.status, 'passed');
    await send([event('editor.state', { path: 'main.py' })]);
  });
  await t.test('pause creates a visible boundary', async () => {
    assert.equal((await request('capture', { recording: false })).status, 200);
    assert.equal(app.journal.events.at(-1).originChannel, 'ui_endpoint');
    assert.equal((await request('run', { path: 'main.py', modelId: 'test-model', version: 4, input: '' })).status, 409);
    assert.equal((await request('state')).body.recording, false);
    await request('capture', { recording: true });
  });
  await t.test('save refuses an externally changed file', async () => {
    writeFileSync(path.join(workspace, 'main.py'), 'print("external")\n');
    const recovered = (await request('file?path=main.py')).body;
    assert.equal(recovered.diskHash, hash(original));
    assert.notEqual(recovered.diskHash, recovered.currentDiskHash);
    assert.equal((await request('save', { path: 'main.py', modelId: 'test-model', version: 4 })).status, 409);
    assert.equal(readFileSync(path.join(workspace, 'main.py'), 'utf8'), 'print("external")\n');
    writeFileSync(path.join(workspace, 'main.py'), original);
    assert.equal((await request('save', { path: 'main.py', modelId: 'test-model', version: 4 })).status, 200);
    assert.equal(readFileSync(path.join(workspace, 'main.py'), 'utf8'), edited);
    assert.equal(app.journal.events.at(-1).originChannel, 'ui_endpoint');
  });
  await t.test('SDK client calls real MCP tools', async () => {
    const client = new Client({ name: 'student-ide-check', version: '1.0.0' });
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(pluginRoot, 'runtime/mcp.mjs')], env: { ...process.env, STUDENT_IDE_PORT: new URL(url).port, STUDENT_IDE_WORKSPACE: workspace } });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ['get_coding_events', 'get_editor_snapshot', 'get_language_capabilities', 'open_student_ide', 'register_language', 'replay_document', 'verify_language']);
      const result = await client.callTool({ name: 'get_editor_snapshot', arguments: {} });
      assert.equal(result.structuredContent.buffers[0].text, edited);
      const replay = await client.callTool({ name: 'replay_document', arguments: { path: 'main.py' } });
      assert.equal(replay.structuredContent.hash, hash(edited));
    } finally { await client.close(); }
  });
  await t.test('hook context and unrelated-project isolation', async () => {
    const invoke = (cwd, input = {}) => new Promise(resolve => {
      const child = spawn(process.execPath, [path.join(pluginRoot, 'scripts/hook.mjs')], { env: { ...process.env, STUDENT_IDE_PORT: new URL(url).port }, windowsHide: true });
      let result = ''; child.stdout.on('data', chunk => { result += chunk; }); child.on('close', () => resolve(result));
      child.stdin.end(JSON.stringify({ cwd, hook_event_name: 'UserPromptSubmit', session_id: 'test-codex-session', turn_id: 'test-turn', prompt: '解释当前代码', ...input }));
    });
    const output = await invoke(workspace);
    assert.match(JSON.parse(output).hookSpecificOutput.additionalContext, /未保存/);
    assert.equal(await invoke(workspace, { hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_use_id: 'toolu_check-42', tool_input: { command: 'password = "NOT_A_REAL_PASSWORD"' } }), '');
    const hooked = app.journal.events.at(-1);
    assert.equal(hooked.originChannel, 'hook_endpoint');
    assert.equal(hooked.payload.toolUseId, 'toolu_check-42');
    assert.equal(readFileSync(app.journal.file, 'utf8').includes('NOT_A_REAL_PASSWORD'), false);
    const before = app.journal.events.length;
    assert.equal(await invoke(os.tmpdir()), '');
    assert.equal(app.journal.events.length, before);
  });
  await t.test('Python failures and timeout are recorded', async () => {
    edited = 'raise ValueError("expected failure")\n';
    await send([event('document.edit', { path: 'main.py', modelId: 'test-model', baseVersion: 4, version: 5, changes: [{ offset: 0, length: app.journal.buffers.get('main.py').text.length, text: edited }] })]);
    const failure = (await request('run', { path: 'main.py', modelId: 'test-model', version: 5, input: '' })).body;
    assert.equal(failure.status, 'failed');
    assert.match(failure.stderr, /ValueError/);
    const infinite = 'while True: pass\n';
    await send([event('document.edit', { path: 'main.py', modelId: 'test-model', baseVersion: 5, version: 6, changes: [{ offset: 0, length: edited.length, text: infinite }] })]);
    const timeout = (await request('run', { path: 'main.py', modelId: 'test-model', version: 6, input: '' })).body;
    assert.equal(timeout.timedOut, true);
    assert.equal(timeout.status, 'timeout');
  });
  await t.test('agent-selected interpreter and missing-runtime classification', async () => {
    const pythonExe = execFileSync('python', ['-I', '-X', 'utf8', '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8', windowsHide: true }).trim();
    const previous = process.env.STUDENT_IDE_PYTHON;
    let scoped;
    try {
      process.env.STUDENT_IDE_PYTHON = pythonExe;
      scoped = await startServer({ workspace, port: 0, phase: 'preparation', data: mkdtempSync(path.join(os.tmpdir(), 'student-ide-runtime-')) });
      const post = async (route, body) => (await fetch(scoped.origin + '/api/' + route, { method: 'POST', headers: { 'content-type': 'application/json', 'x-student-ide': '1' }, body: JSON.stringify(body) })).json();
      assert.equal((await (await fetch(scoped.origin + '/api/health')).json()).python, pythonExe);
      const open = event('document.open', { path: 'main.py', modelId: 'runtime-check', version: 1, text: 'print("selected interpreter")\n', diskHash: hash(readFileSync(path.join(workspace, 'main.py'), 'utf8')) });
      await post('events', { clientId: 'runtime-client', events: [open] });
      assert.equal((await post('run', { path: 'main.py', modelId: 'runtime-check', version: 1, input: '' })).exitCode, 0);
      await scoped.close();
      scoped = await startServer({ workspace, port: 0, phase: 'preparation', python: path.join(workspace, 'missing-python.exe'), data: mkdtempSync(path.join(os.tmpdir(), 'student-ide-missing-runtime-')) });
      const health = await (await fetch(scoped.origin + '/api/health')).json();
      assert.equal(health.python, path.join(workspace, 'missing-python.exe'));
      await post('events', { clientId: 'runtime-client', events: [open] });
      const missing = await post('run', { path: 'main.py', modelId: 'runtime-check', version: 1, input: '' });
      assert.equal(missing.status, 'failed');
      assert.equal(missing.exitCode, null);
      assert.match(missing.stderr, /Python 启动失败/);
    } finally {
      if (scoped) await scoped.close();
      if (previous === undefined) delete process.env.STUDENT_IDE_PYTHON;
      else process.env.STUDENT_IDE_PYTHON = previous;
    }
  });
  await t.test('durable restart and damaged-tail detection', async () => {
    const currentHash = hash(app.journal.buffers.get('main.py').text);
    const beforeSeq = app.journal.events.at(-1).seq;
    const beforeGaps = app.journal.gaps.length;
    const beforeRaw = readFileSync(app.journal.file, 'utf8');
    await app.close();
    const legacy = { id: crypto.randomUUID(), sessionId: app.journal.sessionId, seq: beforeSeq + 1, type: 'editor.focus', source: 'student', timestamp: new Date().toISOString(), receivedAt: new Date().toISOString(), payload: { path: 'main.py' } };
    appendFileSync(app.journal.file, '\n' + JSON.stringify({ events: [legacy], checksum: hash(JSON.stringify([legacy])) }) + '\n');
    appendFileSync(app.journal.file, '{"partial":');
    app = await startServer({ workspace, port: 0 });
    url = app.origin;
    assert.ok(readFileSync(app.journal.file, 'utf8').startsWith(beforeRaw));
    assert.equal(app.journal.ids.get(legacy.id).source, 'student');
    assert.equal(app.journal.ids.get(legacy.id).originChannel, undefined);
    assert.equal((await request('replay?path=main.py')).body.checkpoints.at(-1).originChannel, 'ui_endpoint');
    assert.equal(hash(app.journal.buffers.get('main.py').text), currentHash);
    assert.equal(app.journal.replay('main.py').hash, currentHash);
    assert.ok(app.journal.events.at(-1).seq > beforeSeq);
    assert.equal(app.journal.gaps.length, beforeGaps + 1);
    assert.match(readFileSync(app.journal.file, 'utf8'), /\{"partial":/);
  });
});
