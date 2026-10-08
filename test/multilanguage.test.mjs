import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, pluginRoot } from '../src/server.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { referenceProfiles } from '../src/languages.mjs';
import { hash } from '../src/journal.mjs';

test('agent-managed language profiles, compiled runs and restart', async t => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'student-ide-languages-'));
  for (const [file, text] of Object.entries({ 'main.py': 'print("python")\n', 'main.mjs': 'console.log("saved");\n', 'lib.mjs': 'export const answer = 7;\n', 'main.cpp': 'int main(){return 0;}\n', 'main.c': 'int main(void){return 0;}\n', 'lesson.study': 'console.log("saved");\n' })) writeFileSync(path.join(workspace, file), text);
  let app = await startServer({ workspace, port: 0, phase: 'preparation' });
  t.after(async () => { await app.close(); });
  const request = async (route, body) => {
    const response = await fetch(app.origin + '/api/' + route, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-student-ide': '1' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const open = async (file, text, version = 1, modelId = file) => request('events', { clientId: 'language-check', events: [{ id: crypto.randomUUID(), type: 'document.open', source: 'qa', payload: { path: file, modelId, version, text, diskHash: hash(readFileSync(path.join(workspace, file), 'utf8')) } }] });
  const run = async (file, version = 1) => (await request('run', { path: file, modelId: file, version, input: '' })).body;
  const templates = referenceProfiles();

  await t.test('unregistered language is visible but cannot run', async () => {
    const files = (await request('files')).body.files;
    assert.ok(files.some(file => file.path === 'main.cpp' && file.syntax.id === 'cpp'));
    await open('main.mjs', 'console.log("unsaved");\n');
    assert.equal((await request('run', { path: 'main.mjs', modelId: 'main.mjs', version: 1, input: '' })).status, 409);
  });
  await t.test('registration validation, conflicts and ready state', async () => {
    const js = templates.find(profile => profile.id === 'javascript');
    assert.equal((await request('languages', { profile: { ...js, id: undefined } })).status, 400);
    assert.equal((await request('languages', { profile: { ...js, extensions: ['.env'] } })).status, 400);
    assert.equal((await request('languages', { profile: { ...js, environment: { API_KEY: 'not-a-credential' } } })).status, 400);
    assert.equal((await request('languages', { profile: { ...js, smoke: { ...js.smoke, files: { '../escape.mjs': '' } } } })).status, 400);
    const client = new Client({ name: 'language-agent-check', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(pluginRoot, 'runtime/mcp.mjs')], env: { ...process.env, STUDENT_IDE_PORT: new URL(app.origin).port, STUDENT_IDE_WORKSPACE: workspace } }));
    try {
      const capabilities = await client.callTool({ name: 'get_language_capabilities', arguments: {} });
      assert.ok(capabilities.structuredContent.templates.some(profile => profile.id === 'javascript'));
      const registered = await client.callTool({ name: 'register_language', arguments: { profile: js } });
      assert.equal(registered.structuredContent.status, 'unverified');
      const checked = await client.callTool({ name: 'verify_language', arguments: { id: 'javascript' } });
      assert.equal(checked.structuredContent.status, 'ready');
    } finally { await client.close(); }
    assert.equal((await request('languages', { profile: { ...js, displayName: 'New name' } })).status, 409);
    assert.equal((await request('languages', { profile: { ...js, id: 'other-js' } })).status, 409);
    const verified = await request('languages/verify', { id: 'javascript' });
    assert.equal(verified.body.status, 'ready', JSON.stringify(verified.body.verification));
    assert.equal(verified.body.verification.result.stages[0].stage, 'execute');
  });
  await t.test('JavaScript unsaved imports and frozen snapshots', async () => {
    const source = 'import {answer} from "./lib.mjs"; console.log("中文 🐍", answer);\n';
    await open('main.mjs', source);
    const result = await run('main.mjs');
    assert.equal(result.status, 'passed', result.stderr);
    assert.match(result.stdout, /中文 🐍 7/);
    assert.equal(result.language, 'javascript');
    assert.equal(result.hash, hash(source));
    assert.equal(readFileSync(path.join(workspace, 'main.mjs'), 'utf8'), 'console.log("saved");\n');
    writeFileSync(path.join(workspace, 'lib.mjs'), 'export const answer = 99;\n');
    assert.equal(readFileSync(path.join(result.snapshotDirectory, 'workspace/lib.mjs'), 'utf8'), 'export const answer = 7;\n');
    assert.equal(app.journal.replay('main.mjs').hash, hash(source));
  });
  await t.test('C++ compiles and executes current buffer', async () => {
    const cpp = templates.find(profile => profile.id === 'cpp');
    assert.equal((await request('languages', { profile: cpp })).status, 200);
    const verified = (await request('languages/verify', { id: 'cpp' })).body;
    assert.equal(verified.status, 'ready', JSON.stringify(verified.verification));
    const source = '#include <iostream>\nint main(){std::cout << "compiled 中文\\n";}\n';
    await open('main.cpp', source);
    const result = await run('main.cpp');
    assert.equal(result.status, 'passed', result.stderr);
    assert.deepEqual(result.stages.map(stage => stage.stage), ['compile', 'execute']);
    assert.match(result.stdout, /compiled 中文/);
    assert.ok(existsSync(path.join(result.snapshotDirectory, 'program.exe')) || existsSync(path.join(result.snapshotDirectory, 'program')));
    assert.equal(readFileSync(path.join(workspace, 'main.cpp'), 'utf8'), 'int main(){return 0;}\n');
  });
  await t.test('compiler errors stop execution and are not runtime setup errors', async () => {
    await open('main.cpp', 'int main( { syntax error }\n', 2);
    const result = await run('main.cpp', 2);
    assert.equal(result.status, 'compile_failed');
    assert.equal(result.stages.length, 1);
    assert.equal(result.failureKind, 'compile');
    assert.ok(result.stderr.length > 0);
    assert.equal(existsSync(path.join(result.snapshotDirectory, 'program.exe')), false);
  });
  await t.test('C profile and a custom fourth language type', async () => {
    const c = templates.find(profile => profile.id === 'c');
    await request('languages', { profile: c });
    assert.equal((await request('languages/verify', { id: 'c' })).body.status, 'ready');
    await open('main.c', '#include <stdio.h>\nint main(void){puts("c-ready");return 0;}\n');
    assert.match((await run('main.c')).stdout, /c-ready/);
    const custom = { ...templates.find(profile => profile.id === 'javascript'), id: 'lesson-script', displayName: 'Lesson script', extensions: ['.study'], editorLanguage: 'unknown-grammar', captureExtensions: ['.study'], smoke: { entry: 'check.study', files: { 'check.study': 'console.log("student-ide-ready");\n' }, expectedStdout: 'student-ide-ready\n' } };
    const registered = await request('languages', { profile: custom });
    assert.equal(registered.body.editorLanguage, 'plaintext');
    await open('lesson.study', 'console.log("custom-ready");\n');
    assert.match((await run('lesson.study')).stdout, /custom-ready/);
    assert.ok(app.journal.events.some(event => event.type === 'language.verified' && event.payload.id === custom.id && event.originChannel === 'runner'));
  });
  await t.test('project profile builds multiple translation units', async () => {
    writeFileSync(path.join(workspace, 'sum.cpp'), 'int answer(){return 42;}\n');
    const base = (await request('languages')).body.languages.find(profile => profile.id === 'cpp');
    const profile = { ...base.profile, mode: 'project', compile: [{ command: 'g++', args: ['{entry}', '{workspace}/sum.cpp', '-std=c++17', '-o', '{artifact}'] }], smoke: { entry: 'check.cpp', files: { 'check.cpp': '#include <iostream>\nint answer(); int main(){std::cout << answer() << "\\n";}\n', 'sum.cpp': 'int answer(){return 42;}\n' }, expectedStdout: '42\n' } };
    await request('languages', { profile, expectedVersion: base.version });
    assert.equal((await request('languages')).body.languages.find(item => item.id === 'cpp').status, 'unverified');
    assert.equal((await request('languages/verify', { id: 'cpp' })).body.status, 'ready');
    await open('main.cpp', '#include <iostream>\nint answer(); int main(){std::cout << answer() << "\\n";}\n', 3);
    const result = await run('main.cpp', 3);
    assert.equal(result.mode, 'project');
    assert.equal(result.stdout.trim(), '42');
  });
  await t.test('profiles and verification survive restart without altering history', async () => {
    const legacy = { ...templates.find(profile => profile.id === 'javascript'), id: 'legacy-script', extensions: ['.oldjs'], captureExtensions: ['.oldjs'], smoke: { entry: 'check.oldjs', files: { 'check.oldjs': 'console.log("student-ide-ready");\n' }, expectedStdout: 'student-ide-ready\n' } };
    app.journal.append([{ type: 'language.registered', source: 'qa', payload: { profile: legacy, version: 1, definitionHash: hash(JSON.stringify(legacy)) } }]);
    const log = readFileSync(app.journal.file, 'utf8');
    const hashes = new Map([...app.journal.buffers].map(([file, buffer]) => [file, hash(buffer.text)]));
    await app.close();
    app = await startServer({ workspace, port: 0 });
    assert.ok(readFileSync(app.journal.file, 'utf8').startsWith(log));
    const capabilities = (await request('languages')).body;
    assert.ok(capabilities.languages.some(profile => profile.id === 'lesson-script' && profile.status === 'ready'));
    assert.ok(capabilities.languages.some(profile => profile.id === 'legacy-script' && profile.status === 'unverified'));
    for (const [file, expected] of hashes) assert.equal(app.journal.replay(file).hash, expected);
    assert.ok(app.journal.events.some(event => event.type === 'run.stage.completed' && event.payload.stage === 'compile'));
    assert.ok(app.journal.events.some(event => event.type === 'language.registered' && event.originChannel === 'agent_endpoint'));
  });
});
