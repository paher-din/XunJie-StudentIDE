import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.mjs';
import { referenceProfiles, validateProfile } from '../src/languages.mjs';
import { hash } from '../src/journal.mjs';
import { DiagnosticEngine, normalizeDiagnostics } from '../src/diagnostics.mjs';

test('idle parser workers are released and rebuilt on demand', async () => {
  const engine = new DiagnosticEngine({ idleMs: 30 });
  const input = { path: 'memory.json', sources: { 'memory.json': '{}' }, syntax: 'json', root: process.cwd() };
  try {
    assert.equal((await engine.analyze(input)).status, 'ready');
    assert.ok(engine.worker);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(engine.worker, null);
    assert.equal((await engine.analyze(input)).status, 'ready');
    assert.ok(engine.worker);
  } finally { await engine.close(); }
});

test('diagnostic protocol rejects unsafe configuration and invalid ranges', () => {
  const profile = referenceProfiles().find(item => item.id === 'javascript');
  assert.throws(() => validateProfile({ ...profile, diagnostics: { format: 'json', command: 'node', args: ['{entry}'] } }));
  assert.throws(() => validateProfile({ ...profile, diagnostics: { format: 'text', command: 'node', args: [] } }));
  assert.equal(Object.hasOwn(validateProfile(profile), 'diagnostics'), false);
  const issue = { message: 'bad', startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 };
  assert.throws(() => normalizeDiagnostics([{ ...issue, path: '../outside.py' }], 'main.py', { 'main.py': 'x' }));
  assert.throws(() => normalizeDiagnostics([{ ...issue, endColumn: 3 }], 'main.py', { 'main.py': 'x' }));
});

test('real multilanguage diagnostics observe unsaved versions without executing answers', async t => {
  const workspace = mkdtempSync(path.join(os.tmpdir(), 'student-ide-diagnostics-'));
  const saved = { 'main.c': 'int main(void){return 0;}\n', 'main.cpp': 'int main(){return 0;}\n', 'main.py': 'print("saved")\n', 'main.mjs': 'console.log("saved");\n', 'main.ts': 'const a: number = 1;\n', 'data.json': '{}\n', 'style.css': 'a { color: red; }\n', 'page.html': '<div></div>\n', 'custom.scan': 'console.log("saved");\n' };
  for (const [file, text] of Object.entries(saved)) writeFileSync(path.join(workspace, file), text);
  let app = await startServer({ workspace, port: 0, phase: 'preparation' });
  t.after(async () => app.close());
  const owner = { clientId: 'diagnostics-qa', writerId: 'diagnostics-qa' };
  const request = async (route, body, headers = {}) => {
    const response = await fetch(app.origin + '/api/' + route, body === undefined ? { headers } : { method: 'POST', headers: { 'content-type': 'application/json', 'x-student-ide': '1', ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const open = async (file, text, version = 1) => {
    assert.equal((await request('events', { ...owner, events: [{ id: crypto.randomUUID(), type: 'document.open', payload: { path: file, modelId: file, version, text, diskHash: hash(saved[file]) } }] })).status, 200);
    return { ...owner, path: file, modelId: file, version };
  };
  const check = async (file, text) => {
    const data = await open(file, text);
    const result = await request('diagnostics', data);
    assert.equal(result.status, 200);
    assert.equal(result.body.status, 'ready', JSON.stringify(result.body));
    assert.equal(result.body.hash, hash(text));
    assert.equal(readFileSync(path.join(workspace, file), 'utf8'), saved[file]);
    return result.body;
  };
  await t.test('GCC, C++, UTF-16 columns and legitimate custom type names', async () => {
    for (const id of ['c', 'cpp']) {
      const profile = referenceProfiles().find(item => item.id === id);
      assert.equal((await request('languages', { profile })).status, 200);
      assert.equal((await request('languages/verify', { id })).body.status, 'ready');
    }
    const text = "int main(void) { /* 中文 🐍 */ cahr letter = 'a'; return 0; }\n";
    const typo = await check('main.c', text);
    const issue = typo.diagnostics.find(issue => issue.message.includes('cahr'));
    assert.ok(issue);
    assert.equal(issue.startColumn, text.indexOf('cahr') + 1);
    assert.equal(issue.endColumn, text.indexOf('cahr') + 5);
    assert.ok((await check('main.cpp', 'int main(){char a = 0\nreturn 0;}\n')).diagnostics.some(issue => issue.message.includes(';')));
    assert.equal((await check('main.c', 'typedef char cahr; int main(void){cahr a = 0; return a;}\n')).diagnostics.length, 0);
  });
  await t.test('Python AST syntax checks do not execute code', async () => {
    assert.equal((await request('languages/verify', { id: 'python' })).body.status, 'ready');
    assert.ok((await check('main.py', 'def broken(\n')).diagnostics.length);
    assert.equal((await check('main.py', 'raise RuntimeError("must not execute")\n')).diagnostics.length, 0);
  });
  await t.test('JavaScript/TypeScript, JSON, CSS and HTML use real parsers', async () => {
    const cases = [
      ['main.mjs', 'const a = ;\n', 'const a = 1\nconsole.log(a)\n'],
      ['main.ts', 'const a: number = "wrong";\n', 'const a: number = 1;\n'],
      ['data.json', '{"a": }\n', '{"a": 1}\n'],
      ['style.css', 'a { color red; }\n', 'a { color: red; }\n'],
      ['page.html', '<div><span></div>\n', '<div><span></span></div>\n']
    ];
    for (const [file, invalid, valid] of cases) {
      assert.ok((await check(file, invalid)).diagnostics.length, file);
      assert.equal((await check(file, valid)).diagnostics.length, 0, file);
    }
    assert.equal((await check('page.html', '<ul><li>one<li>two</ul>\n')).diagnostics.length, 0);
    const source = 'throw new Error("must not execute");\n';
    assert.equal((await check('main.mjs', source)).status, 'ready');
    assert.equal(app.journal.runs.size, 0);
  });
  await t.test('learning-phase custom language, stale replies, privacy and MCP read boundary', async () => {
    const helper = path.join(mkdtempSync(path.join(os.tmpdir(), 'student-ide-diagnostic-adapter-')), 'check.mjs');
    writeFileSync(helper, 'let s=""; for await(const x of process.stdin)s+=x; const d=JSON.parse(s); setTimeout(()=>console.log(JSON.stringify({diagnostics: d.text.includes("bad")?[{message:"custom error",severity:"error",startLineNumber:1,startColumn:1,endLineNumber:1,endColumn:2}]:[]})),d.text.includes("slow")?200:0);');
    const base = referenceProfiles().find(item => item.id === 'javascript');
    const profile = { ...base, id: 'custom', editorLanguage: 'plaintext', extensions: ['.scan'], captureExtensions: ['.scan'], smoke: { entry: 'check.scan', files: { 'check.scan': 'console.log("student-ide-ready");\n' }, expectedStdout: 'student-ide-ready\n' }, diagnostics: { format: 'json', command: process.execPath, args: [helper] } };
    assert.equal((await request('languages', { profile })).status, 200);
    const verified = (await request('languages/verify', { id: 'custom' })).body;
    assert.equal(verified.verification.diagnostics.status, 'ready');
    assert.equal((await request('phase', { ...owner, phase: 'student', expectedRevision: app.journal.phaseRevision })).status, 200);
    assert.equal((await check('custom.scan', 'bad\n')).diagnostics.length, 1);
    const data = await open('custom.scan', 'slow bad\n');
    const running = request('diagnostics', data);
    const until = Date.now() + 3000;
    while (!(await request('diagnostics', data)).body.status.includes('busy')) { assert.ok(Date.now() < until); await new Promise(resolve => setTimeout(resolve, 5)); }
    await open('custom.scan', 'fixed\n', 2);
    assert.equal((await running).body.status, 'stale');
    assert.equal((await request('state')).body.diagnostics.some(result => result.path === 'custom.scan'), false);
    assert.equal((await request('diagnostics', { ...data, version: 2 })).body.diagnostics.length, 0);
    assert.equal((await request('diagnostics', { ...data, version: 2 }, { 'x-student-ide-client': 'mcp' })).status, 403);
    assert.equal((await request('languages', { profile, expectedVersion: 1 })).status, 403);
    const before = app.journal.events.filter(event => event.type === 'diagnostics.updated').length;
    await request('diagnostics', { ...data, version: 2 });
    assert.equal(app.journal.events.filter(event => event.type === 'diagnostics.updated').length, before);
    assert.ok(app.journal.events.filter(event => event.type === 'diagnostics.updated').every(event => event.originChannel === 'language_service'));
    await request('capture', { recording: false });
    assert.equal((await request('diagnostics', { ...data, version: 2 })).body.status, 'paused');
    assert.equal((await request('state')).body.diagnostics.length, 0);
    const prefix = readFileSync(app.journal.file, 'utf8');
    await app.close(); app = await startServer({ workspace, port: 0 });
    assert.ok(readFileSync(app.journal.file, 'utf8').startsWith(prefix));
    assert.equal((await request('languages')).body.languages.find(item => item.id === 'custom').verification.diagnostics.status, 'ready');
    assert.equal(existsSync(path.join(workspace, 'program')), false);
  });
});
