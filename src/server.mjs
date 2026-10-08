import http from 'node:http';
import { readFileSync, writeFileSync, realpathSync, readdirSync, statSync, lstatSync, existsSync, mkdirSync, openSync, fsyncSync, closeSync, renameSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Journal, hash, sensitive, safeOutput } from './journal.mjs';
import { LanguageRegistry } from './languages.mjs';
import { createSnapshot, executeProfile } from './runner.mjs';
import { DiagnosticEngine, toolchainCurrent } from './diagnostics.mjs';

export const pluginRoot = fileURLToPath(new URL('../', import.meta.url));
export const DEFAULT_PORT = 43127;
export const VERSION = '0.6.0';
const extensions = new Set(['.py', '.txt', '.md', '.json', '.js', '.ts', '.html', '.css', '.c', '.cpp', '.h', '.hpp', '.mjs', '.cjs']);
const error = (message, status = 400) => Object.assign(new Error(message), { status });

export function workspacePath(root, relative, creating = false, allowed = extensions) {
  if (typeof relative !== 'string' || relative.length > 240 || path.isAbsolute(relative) || relative.includes('\\') || relative.includes(':') || relative.split('/').length > 6 || relative.split('/').some(part => !part || part === '..' || part.startsWith('.') || /[<>"|?*\x00-\x1f]|[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || /^(?:credentials|secrets?|passwords?|id_rsa)(?:\.|$)/i.test(part)) || !allowed.has(path.extname(relative).toLowerCase())) throw error('此文件不在允许采集的范围', 403);
  const candidate = path.resolve(root, relative);
  let actual;
  if (creating && !existsSync(candidate)) {
    let ancestor = path.dirname(candidate);
    while (!existsSync(ancestor)) ancestor = path.dirname(ancestor);
    actual = path.resolve(realpathSync(ancestor), path.relative(ancestor, candidate));
  } else actual = realpathSync(candidate);
  const relation = path.relative(root, actual);
  if (relation.startsWith('..') || path.isAbsolute(relation)) throw error('文件路径越过项目目录', 403);
  return actual;
}

function readSource(file) {
  if (statSync(file).size > 250000) throw error('首轮限制单文件 250 KB', 413);
  const text = readFileSync(file, 'utf8');
  if (text.includes('\0') || sensitive(text)) throw error('文件含敏感内容或不是文本文件，已排除', 422);
  return text;
}

function files(root, directory = root, depth = 0, allowed = extensions) {
  if (depth > 5) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    if (entry.name.startsWith('.') || entry.isSymbolicLink() || ['node_modules', '__pycache__'].includes(entry.name)) return [];
    const location = path.join(directory, entry.name);
    if (entry.isDirectory()) return files(root, location, depth + 1, allowed);
    const relative = path.relative(root, location).split(path.sep).join('/');
    try { workspacePath(root, relative, false, allowed); return [{ path: relative, bytes: statSync(location).size }]; } catch { return []; }
  }).slice(0, 201);
}

export async function startServer(options = {}) {
  if (options.phase !== undefined && !['student', 'preparation'].includes(options.phase)) throw error('会话阶段无效');
  const requestedRoot = path.resolve(options.workspace ?? process.env.STUDENT_IDE_WORKSPACE ?? path.join(process.cwd(), 'lab'));
  if (!existsSync(requestedRoot)) throw error('项目目录不存在，请先创建项目或传入 --workspace', 404);
  const root = realpathSync(requestedRoot);
  const pythonCommand = options.python ?? process.env.STUDENT_IDE_PYTHON ?? 'python';
  const directory = path.resolve(options.data ?? path.join(root, '.student-ide'));
  const journal = new Journal(directory);
  if (!journal.phaseRevision) journal.append([{ type: 'session.phase', source: 'system', payload: { previous: journal.phase, phase: options.phase ?? 'student', reason: options.phase ? '首次显式启动' : '默认学习阶段' } }]);
  const languages = new LanguageRegistry(journal, directory, pluginRoot, pythonCommand);
  const diagnosticEngine = new DiagnosticEngine();
  const projectFile = relative => workspacePath(root, relative, false, languages.allowedExtensions());
  let origin, busy = false;
  const startedAt = Date.now();
  const external = new Map();
  const info = () => ({ name: 'student-ide', version: VERSION, phase: journal.phase, phaseRevision: journal.phaseRevision, busy, url: origin, workspace: root, python: pythonCommand, logDirectory: directory, sessionId: journal.sessionId, pid: process.pid, nodeMemory: process.memoryUsage(), uptimeMs: Date.now() - startedAt });
  const state = () => ({ ...journal.snapshot(), ...info(), languages: languages.capabilities(), buffers: journal.snapshot().buffers.map(buffer => ({ ...buffer, language: languages.forFile(buffer.path) ? languages.describe(languages.forFile(buffer.path)) : null, syntax: languages.syntaxForFile(buffer.path) })), coverage: { editor: '文本增量、撤销重做、选区、焦点、粘贴、组合输入、页面可见性', codex: journal.hooksSeen.size ? '已收到部分 Hook 事件，完整回复覆盖需另验' : '尚未收到 Hook，未声称采集 Codex 对话', external: '监测已打开文件的磁盘变化；不能归属修改者', runner: '本机工具链，非沙箱；源码快照内冻结，系统库/外部包不冻结；编译与执行分阶段记录', attribution: 'originChannel 只说明服务入口，不证明操作者身份；旧日志缺少此字段时来源未核实', privacy: '常见凭据检测；未知格式仍需实验项目不含秘密', paused: !journal.recording } });

  function validateEntries(entries) {
    if (!Array.isArray(entries)) throw error('事件批次无效');
    for (const event of entries) if (event.payload?.path) projectFile(event.payload.path);
  }

  function diagnosticSources(buffer, syntax) {
    const extensions = new Set(['javascript', 'typescript'].includes(syntax) ? ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'] : syntax === 'cpp' ? ['.h', '.hpp'] : []);
    const sources = { [buffer.path]: buffer.text };
    let bytes = Buffer.byteLength(buffer.text);
    for (const file of files(root, root, 0, extensions)) {
      if (file.path === buffer.path) continue;
      if (Object.keys(sources).length >= 200) throw error('诊断依赖超过 200 文件上限', 413);
      const confirmed = journal.buffers.get(file.path);
      if (confirmed?.blocked) throw error('诊断依赖包含已阻断文件', 422);
      const text = ['javascript', 'typescript'].includes(syntax) && confirmed && !confirmed.deleted ? confirmed.text : readSource(projectFile(file.path));
      bytes += Buffer.byteLength(text);
      if (bytes > 1024 * 1024) throw error('诊断依赖超过 1 MiB 上限', 413);
      sources[file.path] = text;
    }
    return sources;
  }

  async function diagnose(data) {
    projectFile(data.path);
    const current = journal.buffers.get(data.path);
    if (!current || current.deleted || current.modelId !== data.modelId || current.version !== data.version) throw error('诊断请求的文档版本已过期', 409);
    const identity = { path: data.path, modelId: current.modelId, version: current.version, hash: hash(current.text) };
    if (!journal.recording || current.blocked) return { ...identity, status: current.blocked ? 'blocked' : 'paused', diagnostics: [] };
    journal.accept([], data.clientId, data.writerId);
    if (busy || diagnosticEngine.busy) return { ...identity, status: 'busy', diagnostics: [] };
    const buffer = { ...current }, syntax = languages.syntaxForFile(data.path).requested, record = languages.forDiagnostics(data.path);
    const sources = diagnosticSources(buffer, syntax), sourceHash = hash(JSON.stringify(sources));
    const definitionHash = record?.definitionHash ?? null;
    const cached = journal.diagnostics.get(data.path);
    if (cached?.modelId === buffer.modelId && cached.version === buffer.version && cached.sourceHash === sourceHash && cached.definitionHash === definitionHash && cached.status === 'ready' && !record?.profile.diagnostics && toolchainCurrent(record)) return cached;
    const result = await diagnosticEngine.analyze({ path: data.path, sources, record, syntax, root });
    const latest = journal.buffers.get(data.path);
    if (!journal.recording || latest?.blocked) return { ...identity, status: latest?.blocked ? 'blocked' : 'paused', diagnostics: [] };
    if (!latest || latest.deleted || latest.modelId !== buffer.modelId || latest.version !== buffer.version || hash(JSON.stringify(diagnosticSources(latest, syntax))) !== sourceHash || languages.forDiagnostics(data.path)?.definitionHash !== record?.definitionHash) return { ...identity, status: 'stale', diagnostics: [] };
    const completed = { ...identity, ...result, checkedAt: new Date().toISOString(), definitionHash, languageVersion: record?.version ?? null, sourceHash, dependencyPolicy: syntax === 'cpp' ? '入口为确认草稿；头文件为已保存磁盘内容，未冻结外部库' : '解析入口及受限确认/磁盘源文件；外部包类型未自动加载' };
    const previous = journal.diagnostics.get(data.path);
    if (!previous || hash(JSON.stringify([previous.hash, previous.sourceHash, previous.status, previous.diagnostics, previous.message])) !== hash(JSON.stringify([completed.hash, completed.sourceHash, completed.status, completed.diagnostics, completed.message]))) journal.append([{ type: 'diagnostics.updated', source: 'language_service', payload: completed }]);
    return completed;
  }

  async function run(data) {
    if (busy) throw error('已有代码正在运行', 409);
    if (!journal.recording) throw error('采集暂停时不能运行并记录代码', 409);
    projectFile(data.path);
    const language = languages.forFile(data.path);
    if (!language) throw error('此语言尚未接入，请让 agent 注册并验证配置', 409);
    const currentBuffer = journal.buffers.get(data.path);
    if (!currentBuffer || currentBuffer.blocked || currentBuffer.version !== data.version || currentBuffer.modelId !== data.modelId) throw error('请先同步当前编辑版本', 409);
    const buffer = { ...currentBuffer };
    if (typeof data.input !== 'string' || data.input.length > 10000 || sensitive(data.input)) throw error('标准输入过大或含敏感内容', 422);
    busy = true;
    const runId = randomUUID();
    try {
      const profile = language.profile;
      let checked;
      try { checked = await languages.ensure(profile.id, journal.phase === 'preparation'); }
      catch (failure) {
        if (failure.status === 409) journal.append([{ type: 'policy.denied', source: 'system', payload: { operation: '/api/run', phase: journal.phase, reason: failure.message } }]);
        throw failure;
      }
      const selected = files(root, root, 0, new Set(profile.captureExtensions)).filter(entry => entry.path !== data.path);
      if (selected.length > 200) throw error('源码采集范围超过 200 项，未开始执行', 413);
      const sources = Object.fromEntries(selected.map(entry => [entry.path, readSource(projectFile(entry.path))]));
      for (const file of profile.captureFiles) sources[file] = readSource(projectFile(file));
      sources[data.path] = buffer.text;
      const snapshot = createSnapshot(path.join(directory, 'runs', runId), data.path, sources);
      const dependencies = snapshot.files.filter(file => file.path !== data.path);
      const started = { runId, path: data.path, modelId: buffer.modelId, version: buffer.version, hash: hash(buffer.text), text: buffer.text, dependencies, dependencyPolicy: '入口使用确认缓冲区；其余源码使用运行前已保存快照；外部包/系统库不冻结', language: profile.id, languageVersion: language.version, definitionHash: language.definitionHash, mode: profile.mode, snapshotDirectory: snapshot.directory, startedAt: new Date().toISOString(), status: 'running' };
      journal.append([{ type: 'run.started', source: 'runner', payload: started }]);
      const result = checked.verification.status !== 'ready'
        ? { status: 'failed', exitCode: null, stdout: '', stderr: profile.displayName + ' 启动失败：' + (checked.verification.probe.stderr || checked.verification.result?.stderr || '工具链或独立验证失败'), failureKind: 'runtime_unavailable', stages: [], timedOut: false, truncated: false, durationMs: 0 }
        : await executeProfile(profile, snapshot, { input: data.input, executeTimeout: options.runTimeout ?? 10000, compileTimeout: options.compileTimeout ?? 30000, onStage: (phase, stage) => { if (journal.recording) journal.append([{ type: 'run.stage.' + phase, source: 'runner', payload: { runId, path: data.path, language: profile.id, ...stage } }]); } });
      const completed = { runId, path: data.path, toolchain: checked.verification.probe, ...result };
      journal.append([{ type: 'run.completed', source: 'runner', payload: journal.recording ? completed : { runId, path: data.path, status: 'capture_paused', captureSuppressed: true } }]);
      return { ...started, ...completed };
    } finally { busy = false; }
  }

  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; font-src 'self' data:; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    const send = (body, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(body)); };
    try {
      if (request.headers.host !== new URL(origin).host || (request.headers.origin && request.headers.origin !== origin) || request.headers['sec-fetch-site'] === 'cross-site') throw error('仅接受本机同源访问', 403);
      const url = new URL(request.url, origin);
      if (!['GET', 'POST'].includes(request.method)) throw error('请求方法不支持', 405);
      const deny = reason => {
        journal.append([{ type: 'policy.denied', source: 'system', payload: { operation: url.pathname, phase: journal.phase, reason } }]);
        throw error(reason, 403);
      };
      const checkAccess = () => {
        if (request.headers['x-student-ide-client'] === 'mcp') {
          const reads = ['/api/health', '/api/state', '/api/events', '/api/replay', '/api/languages'];
          const writes = ['/api/languages', '/api/languages/verify'];
          if (!(request.method === 'GET' && reads.includes(url.pathname)) && !(request.method === 'POST' && writes.includes(url.pathname) && journal.phase === 'preparation')) {
            // Only fixed API names enter audit records; arbitrary URLs may contain secrets.
            if (['/api/phase', '/api/events', '/api/save', '/api/run', '/api/capture', '/api/diagnostics', '/api/files/create', '/api/files/archive', ...writes].includes(url.pathname)) deny('MCP 通道无权执行此操作');
            throw error('MCP 通道仅允许当前阶段的工具接口', 403);
          }
        }
        if (request.method === 'POST' && ['/api/languages', '/api/languages/verify'].includes(url.pathname) && journal.phase !== 'preparation') deny('学习阶段不能变更或验证环境，请由学生暂停并切回准备阶段');
      };
      checkAccess();
      let body;
      if (request.method === 'POST') {
        if (request.headers['x-student-ide'] !== '1' || !request.headers['content-type']?.startsWith('application/json')) throw error('缺少同源请求标记', 403);
        let size = 0;
        const chunks = [];
        for await (const chunk of request) { size += chunk.length; if (size > 2 * 1024 * 1024) throw error('请求过大', 413); chunks.push(chunk); }
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw error('JSON 无效'); }
        checkAccess(); // Phase may have changed while the request body was arriving.
      }
      if (url.pathname === '/api/health' && request.method === 'GET') return send(info());
      if (url.pathname === '/api/state' && request.method === 'GET') return send(state());
      if (url.pathname === '/api/phase' && request.method === 'POST') {
        if (!['student', 'preparation'].includes(body.phase)) throw error('会话阶段无效');
        if (!Number.isSafeInteger(body.expectedRevision) || body.expectedRevision !== journal.phaseRevision) throw error('阶段已变化，请刷新状态后重试', 409);
        if (busy) throw error('请等待运行或验证结束后再切换阶段', 409);
        journal.accept([], body.clientId, body.writerId);
        if (body.phase !== journal.phase) journal.append([{ type: 'session.phase', source: 'ui_endpoint', payload: { previous: journal.phase, phase: body.phase } }]);
        return send({ phase: journal.phase, phaseRevision: journal.phaseRevision });
      }
      if (url.pathname === '/api/languages' && request.method === 'GET') return send(languages.capabilities());
      if (url.pathname === '/api/languages' && request.method === 'POST') {
        if (busy || diagnosticEngine.busy) throw error('工具链正在使用中，不能更新配置', 409);
        return send(languages.register(body.profile, body.expectedVersion));
      }
      if (url.pathname === '/api/languages/verify' && request.method === 'POST') {
        if (busy || diagnosticEngine.busy) throw error('已有运行、诊断或验证任务', 409);
        busy = true;
        try { return send(await languages.verify(body.id)); } finally { busy = false; }
      }
      if (url.pathname === '/api/files' && request.method === 'GET') {
        const listing = files(root, root, 0, languages.allowedExtensions());
        return send({ files: listing.slice(0, 200).map(file => ({ ...file, syntax: languages.syntaxForFile(file.path), language: languages.forFile(file.path) ? languages.describe(languages.forFile(file.path)) : null })), truncated: listing.length > 200, workspace: root });
      }
      if (url.pathname === '/api/files/create' && request.method === 'POST') {
        if (busy || !journal.recording) throw error('请结束运行并恢复采集后再新建文件', 409);
        const file = workspacePath(root, body.path, true, languages.allowedExtensions());
        if (existsSync(file)) throw error('同名文件已存在，未覆盖', 409);
        if (files(root, root, 0, languages.allowedExtensions()).length >= 200) throw error('当前项目已达到 200 个文件上限', 413);
        journal.accept([], body.clientId, body.writerId);
        mkdirSync(path.dirname(file), { recursive: true });
        const fd = openSync(file, 'wx');
        try { fsyncSync(fd); } finally { closeSync(fd); }
        journal.append([{ type: 'document.created', source: 'ui_endpoint', payload: { path: body.path, hash: hash('') } }]);
        return send({ created: true, path: body.path });
      }
      if (url.pathname === '/api/files/archive' && request.method === 'POST') {
        if (busy || !journal.recording) throw error('请结束运行并恢复采集后再删除文件', 409);
        const file = projectFile(body.path);
        if (lstatSync(path.resolve(root, body.path)).isSymbolicLink()) throw error('不支持删除符号链接', 403);
        const buffer = journal.buffers.get(body.path);
        if (!buffer || buffer.deleted || buffer.blocked || buffer.modelId !== body.modelId || buffer.version !== body.version) throw error('文档版本冲突，未删除', 409);
        const disk = readSource(file);
        if (hash(disk) !== buffer.diskHash) throw error('磁盘文件已被外部修改，未删除；请先比较两份内容', 409);
        journal.accept([], body.clientId, body.writerId);
        const trashDirectory = path.join(directory, 'trash', randomUUID());
        const archivedFile = path.join(trashDirectory, 'files', body.path);
        mkdirSync(path.dirname(archivedFile), { recursive: true });
        const draftFile = path.join(trashDirectory, 'draft.txt');
        const draftFd = openSync(draftFile, 'wx');
        try { writeFileSync(draftFd, buffer.text, 'utf8'); fsyncSync(draftFd); } finally { closeSync(draftFd); }
        const payload = { path: body.path, modelId: buffer.modelId, version: buffer.version, hash: hash(buffer.text), diskHash: buffer.diskHash, dirty: buffer.dirty, trashDirectory };
        writeFileSync(path.join(trashDirectory, 'record.json'), JSON.stringify(payload, null, 2));
        renameSync(file, archivedFile);
        journal.append([{ type: 'document.deleted', source: 'ui_endpoint', payload }]);
        external.delete(body.path);
        return send({ deleted: true, ...payload });
      }
      if (url.pathname === '/api/file' && request.method === 'GET') {
        const relative = url.searchParams.get('path');
        const text = readSource(projectFile(relative));
        const buffer = journal.buffers.get(relative);
        const recovered = !!buffer?.dirty && !buffer.blocked && !buffer.deleted;
        return send({ path: relative, diskHash: recovered ? buffer.diskHash : hash(text), currentDiskHash: hash(text), text: recovered ? buffer.text : text, recovered, diskChanged: !buffer?.deleted && buffer?.diskHash !== undefined && buffer.diskHash !== hash(text) });
      }
      if (url.pathname === '/api/diagnostics' && request.method === 'POST') return send(await diagnose(body));
      if (url.pathname === '/api/events' && request.method === 'POST') {
        validateEntries(body.events);
        return send(journal.accept(body.events, body.clientId, body.writerId));
      }
      if (url.pathname === '/api/events' && request.method === 'GET') {
        const after = Number(url.searchParams.get('after') ?? 0);
        if (!Number.isSafeInteger(after) || after < 0) throw error('事件序号无效');
        return send({ events: journal.events.filter(e => e.seq > after).slice(0, 500), seq: journal.events.at(-1).seq, gaps: journal.gaps });
      }
      if (url.pathname === '/api/save' && request.method === 'POST') {
        if (!journal.recording) throw error('请先恢复采集并同步', 409);
        const file = projectFile(body.path);
        const buffer = journal.buffers.get(body.path);
        if (!buffer || buffer.blocked || buffer.version !== body.version || buffer.modelId !== body.modelId) throw error('文档版本冲突，未保存', 409);
        if (hash(readSource(file)) !== buffer.diskHash) throw error('磁盘文件已被外部修改；为保护两份代码，未覆盖。请导出草稿后重新打开文件比较。', 409);
        writeFileSync(file, buffer.text, 'utf8');
        const fd = openSync(file, 'r+');
        try { fsyncSync(fd); } finally { closeSync(fd); }
        journal.append([{ type: 'document.saved', source: 'ui_endpoint', payload: { path: body.path, modelId: buffer.modelId, version: buffer.version, hash: hash(buffer.text) } }]);
        return send({ saved: true, hash: buffer.diskHash, version: buffer.version });
      }
      if (url.pathname === '/api/run' && request.method === 'POST') return send(await run(body));
      if (url.pathname === '/api/capture' && request.method === 'POST') {
        if (typeof body.recording !== 'boolean') throw error('采集状态无效');
        const current = journal.buffers.get(journal.active);
        journal.append([{ type: body.recording ? 'capture.resume' : 'capture.pause', source: 'ui_endpoint', payload: { gap: !body.recording || !journal.recording, path: journal.active, modelId: current?.modelId, version: current?.version } }]);
        return send({ recording: journal.recording });
      }
      if (url.pathname === '/api/replay' && request.method === 'GET') {
        const file = url.searchParams.get('path');
        workspacePath(root, file, true, languages.allowedExtensions());
        const through = url.searchParams.has('seq') ? Number(url.searchParams.get('seq')) : Infinity;
        if (through !== Infinity && (!Number.isSafeInteger(through) || through < 0)) throw error('回放位置无效');
        return send(journal.replay(file, through));
      }
      if (url.pathname === '/api/export' && request.method === 'GET') {
        response.setHeader('Content-Disposition', 'attachment; filename="student-ide-session.json"');
        return send({ schemaVersion: 2, info: info(), coverage: state().coverage, gaps: journal.gaps, events: journal.events });
      }
      if (url.pathname === '/api/hook' && request.method === 'POST') {
        if (!journal.recording) return send({ recorded: false, reason: '采集暂停' });
        if (!['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionStart', 'SessionEnd'].includes(body.event)) throw error('Hook 类型无效');
        const payload = { codexSessionId: body.sessionId, turnId: body.turnId, toolUseId: typeof body.toolUseId === 'string' && /^[\w:-]{1,120}$/.test(body.toolUseId) ? body.toolUseId : null, toolName: body.toolName, prompt: safeOutput(String(body.prompt ?? '').slice(0, 20000)), lastAssistantMessage: safeOutput(String(body.lastAssistantMessage ?? '').slice(0, 20000)), truncated: !!body.truncated };
        journal.append([{ type: 'codex.' + body.event, source: 'hook_endpoint', payload }]);
        const current = journal.buffers.get(journal.active);
        return send({ recorded: true, context: current && !current.blocked ? { path: current.path, version: current.version, dirty: current.dirty, text: current.text.slice(0, 6000), truncated: current.text.length > 6000, recording: journal.recording, lastClientAt: journal.lastClientAt, seq: current.seq } : null });
      }
      if (url.pathname.startsWith('/api/')) throw error('接口不存在', 404);
      if (request.method !== 'GET') throw error('资源不可写', 405);
      const publicRoot = path.join(pluginRoot, 'public');
      const resource = path.resolve(publicRoot, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
      if (path.relative(publicRoot, resource).startsWith('..') || !existsSync(resource) || !statSync(resource).isFile()) throw error('页面资源不存在，请先运行 npm run build', 404);
      const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.ttf': 'font/ttf', '.json': 'application/json' }[path.extname(resource)] ?? 'application/octet-stream';
      response.writeHead(200, { 'Content-Type': mime });
      response.end(readFileSync(resource));
    } catch (failure) { if (!response.headersSent) send({ error: safeOutput(failure.status ? failure.message : '服务操作失败：' + failure.message) }, failure.status ?? 500); else response.end(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? DEFAULT_PORT, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
  // ponytail: poll only opened files once per second; use fs.watch for larger workspaces.
  const watcher = setInterval(() => {
    for (const [file, buffer] of journal.buffers) {
      if (buffer.deleted) continue;
      try {
        const currentHash = hash(readSource(projectFile(file)));
        const lastHash = external.get(file) ?? buffer.diskHash;
        external.set(file, currentHash);
        if (currentHash !== lastHash && currentHash !== buffer.diskHash && journal.recording) journal.append([{ type: 'document.external', source: 'external_unknown', payload: { path: file, diskHash: currentHash } }]);
      } catch { /* An excluded or missing external file is reported when opened or saved. */ }
    }
  }, 1000);
  watcher.unref();
  return { server, journal, origin, root, close: async () => { clearInterval(watcher); await diagnosticEngine.close(); return new Promise(resolve => server.close(resolve)); } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const get = name => { const index = process.argv.indexOf(name); return index === -1 ? undefined : process.argv[index + 1]; };
  try {
    const app = await startServer({ workspace: get('--workspace'), data: get('--data'), phase: get('--phase'), python: get('--python'), port: get('--port') ? Number(get('--port')) : undefined });
    console.error(`Student IDE: ${app.origin}\nWorkspace: ${app.root}`);
  } catch (failure) { console.error(failure.message); process.exitCode = 1; }
}
