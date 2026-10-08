import path from 'node:path';
import { statSync } from 'node:fs';
import { Worker } from 'node:worker_threads';
import { runProcess, resolveExecutable } from './runner.mjs';
import { sensitive, safeOutput, hash } from './journal.mjs';

const builtin = new Set(['javascript', 'typescript', 'json', 'html', 'css']);
export function toolchainCurrent(record) {
  const fingerprint = record?.verification?.probe?.fingerprint;
  if (!fingerprint) return true;
  try {
    const executable = resolveExecutable(record.profile.toolchain.command, record.profile.environment?.PATH ?? process.env.PATH ?? process.env.Path), current = statSync(executable);
    return executable === fingerprint.path && current.size === fingerprint.size && current.mtimeMs === fingerprint.modified;
  } catch { return false; }
}
export function diagnosticCapability(record, syntax) {
  if (record?.profile.diagnostics) return { provider: 'configured-json', status: record.verification?.diagnostics?.status === 'ready' ? 'available' : 'needs_preparation', scope: 'configured' };
  if (builtin.has(syntax)) return { provider: 'monaco-' + syntax, status: 'available', scope: syntax === 'html' ? 'structure' : ['javascript', 'typescript', 'css'].includes(syntax) ? 'syntax-and-types' : 'syntax' };
  if (syntax === 'python') return { provider: 'python-ast', status: record?.verification?.status === 'ready' ? 'available' : 'needs_preparation', scope: 'syntax' };
  if (syntax === 'cpp' && record && /^(?:.*-)?(?:gcc|g\+\+)(?:\.exe)?$/i.test(path.basename(record.profile.toolchain.command))) return { provider: 'gcc', status: record.verification?.status === 'ready' ? 'available' : 'needs_preparation', scope: 'syntax-and-types' };
  if (syntax === 'cpp' && !record) return { provider: 'gcc', status: 'needs_preparation', scope: 'syntax-and-types' };
  return { provider: null, status: 'unsupported', scope: null };
}

export function normalizeDiagnostics(items, entry, sources) {
  if (!Array.isArray(items)) throw new Error('诊断器未返回诊断数组');
  return items.slice(0, 100).map(issue => {
    const file = issue.path ?? entry;
    if (!Object.hasOwn(sources, file) || typeof issue.message !== 'string' || !issue.message || issue.message.length > 4000 || !['error', 'warning', 'info'].includes(issue.severity ?? 'error')) throw new Error('诊断字段或文件范围无效');
    const lines = sources[file].split('\n');
    for (const name of ['startLineNumber', 'startColumn', 'endLineNumber', 'endColumn']) if (!Number.isSafeInteger(issue[name]) || issue[name] < 1) throw new Error('诊断位置无效');
    if (issue.startLineNumber > lines.length || issue.endLineNumber > lines.length || issue.startColumn > lines[issue.startLineNumber - 1].replace(/\r$/, '').length + 1 || issue.endColumn > lines[issue.endLineNumber - 1].replace(/\r$/, '').length + 1 || issue.endLineNumber < issue.startLineNumber || (issue.endLineNumber === issue.startLineNumber && issue.endColumn < issue.startColumn)) throw new Error('诊断位置越过源码范围');
    return { path: file, contentHash: hash(sources[file]), message: issue.message, severity: issue.severity ?? 'error', code: String(issue.code ?? '').slice(0, 120), startLineNumber: issue.startLineNumber, startColumn: issue.startColumn, endLineNumber: issue.endLineNumber, endColumn: issue.endColumn };
  });
}

export async function configuredDiagnostics(profile, entry, sources, cwd) {
  const result = await runProcess(profile.diagnostics.command, profile.diagnostics.args, { cwd, input: JSON.stringify({ path: entry, text: sources[entry], sources }), timeoutMs: 3000, environment: profile.environment });
  if (result.outputRedacted) throw new Error('诊断输出含敏感内容，已隐藏');
  if (result.exitCode !== 0 || result.timedOut || result.truncated) throw new Error(result.timedOut ? '诊断超时' : '诊断器不可用：' + result.stderr);
  const value = JSON.parse(result.stdout);
  return normalizeDiagnostics(Array.isArray(value) ? value : value.diagnostics, entry, sources);
}

const pythonParser = "import ast,json,sys\ns=sys.stdin.read()\nr=[]\ntry: ast.parse(s,filename=sys.argv[1])\nexcept SyntaxError as e:\n lines=s.split('\\n'); line=max(1,e.lineno or 1); endline=max(line,e.end_lineno or line); a=max(0,(e.offset or 1)-1); b=max(a+1,(e.end_offset or a+2)-1) if endline==line else max(0,(e.end_offset or 1)-1); start=len(lines[line-1][:a].encode('utf-16-le'))//2+1; end=len(lines[endline-1][:b].encode('utf-16-le'))//2+1; r=[dict(message=e.msg,severity='error',startLineNumber=line,startColumn=start,endLineNumber=endline,endColumn=end)]\nprint(json.dumps(r,ensure_ascii=False))";
const utf16Column = (text, byteColumn, inclusive = false) => {
  const bytes = Buffer.from(text.replace(/\r$/, ''));
  const prefix = bytes.subarray(0, Math.max(0, byteColumn - 1)).toString('utf8');
  return prefix.length + 1 + (inclusive ? [...text.slice(prefix.length)][0]?.length ?? 0 : 0);
};

function gccDiagnostics(raw, entry, sources, root) {
  const issues = [], pending = [...raw];
  while (pending.length && issues.length < 100) {
    const issue = pending.shift();
    pending.push(...(issue.children ?? []));
    const location = issue.locations?.[0];
    if (!location?.caret) continue;
    const point = location.start ?? location.caret, finish = location.finish ?? location.caret;
    const file = point.file === '<stdin>' ? entry : path.relative(root, path.resolve(root, point.file)).split(path.sep).join('/');
    if (!Object.hasOwn(sources, file)) continue;
    const lines = sources[file].split('\n');
    if (!lines[point.line - 1] && lines[point.line - 1] !== '') continue;
    issues.push({ path: file, message: issue.message, severity: issue.kind === 'warning' ? 'warning' : issue.kind === 'note' ? 'info' : 'error', startLineNumber: point.line, startColumn: utf16Column(lines[point.line - 1], point['byte-column'] ?? point.column), endLineNumber: finish.line, endColumn: utf16Column(lines[finish.line - 1] ?? '', finish['byte-column'] ?? finish.column, true) });
  }
  return normalizeDiagnostics(issues, entry, sources);
}

function compileFlags(profile, root) {
  const flags = [];
  const args = profile.compile[0]?.args ?? [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (/^-std=|^-W|^-D.|^-U.|^-I./.test(arg)) flags.push(arg.replaceAll('{workspace}', root));
    else if (['-I', '-D', '-U', '-isystem', '-iquote'].includes(arg) && args[index + 1]) flags.push(arg, args[++index].replaceAll('{workspace}', root));
  }
  return flags;
}

export class DiagnosticEngine {
  constructor({ idleMs = 60000 } = {}) { this.busy = false; this.worker = null; this.idleMs = idleMs; this.idleTimer = null; }
  async web(data) {
    clearTimeout(this.idleTimer);
    if (!this.worker) {
      this.worker = new Worker(new URL('../runtime/diagnostics-worker.mjs', import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: 256 } });
      this.worker.unref();
    }
    const worker = this.worker;
    return new Promise((resolve, reject) => {
      const finish = (failure, diagnostics) => {
        clearTimeout(timer); worker.off('message', message); worker.off('error', error); worker.off('exit', exited);
        if (!failure) {
          this.idleTimer = setTimeout(() => { if (this.worker === worker) { this.worker = null; worker.terminate(); } }, this.idleMs);
          this.idleTimer.unref();
        }
        failure ? reject(failure) : resolve(diagnostics);
      };
      const message = data => data.error ? finish(new Error(data.error)) : finish(null, data.diagnostics);
      const error = failure => { this.worker = null; finish(failure); };
      const exited = code => { this.worker = null; finish(new Error('诊断进程退出：' + code)); };
      const timer = setTimeout(() => { this.worker = null; finish(new Error('诊断超时')); worker.terminate(); }, 5000);
      worker.once('message', message); worker.once('error', error); worker.once('exit', exited); worker.postMessage(data);
    });
  }
  async analyze({ path: entry, sources, record, syntax, root }) {
    this.busy = true;
    const began = Date.now(), capability = diagnosticCapability(record, syntax);
    const base = { provider: capability.provider, scope: capability.scope, diagnostics: [] };
    try {
      if (capability.status !== 'available') return { ...base, status: capability.status, message: capability.status === 'unsupported' ? '此语言尚未接入诊断' : '诊断环境未确认，请在准备阶段配置并验证' };
      let issues;
      if (capability.provider === 'configured-json') issues = await configuredDiagnostics(record.profile, entry, sources, root);
      else if (builtin.has(syntax)) issues = await this.web({ path: entry, text: sources[entry], sources, syntax });
      else {
        if (!toolchainCurrent(record)) return { ...base, status: 'needs_preparation', message: '工具链已变化，请切回准备阶段验证' };
        const python = capability.provider === 'python-ast';
        const args = python ? ['-I', '-X', 'utf8', '-c', pythonParser, entry] : [...compileFlags(record.profile, root), '-x', /g\+\+/.test(record.profile.toolchain.command) ? 'c++' : 'c', '-fsyntax-only', '-fdiagnostics-format=json', '-fmax-errors=30', '-iquote', path.dirname(path.join(root, entry)), '-'];
        const result = await runProcess(record.profile.toolchain.command, args, { cwd: root, input: sources[entry], timeoutMs: 3000, environment: record.profile.environment });
        if (result.outputRedacted) return { ...base, status: 'blocked', message: '诊断输出含敏感内容，已隐藏' };
        if (result.failureKind || result.truncated) return { ...base, status: result.timedOut ? 'timeout' : 'unavailable', message: result.timedOut ? '诊断超时' : '诊断器不可用或输出超过上限' };
        if (python) { if (result.exitCode !== 0) throw new Error(result.stderr); issues = JSON.parse(result.stdout); }
        else { issues = gccDiagnostics(JSON.parse(result.stderr), entry, sources, root); if (result.exitCode !== 0 && !issues.length) throw new Error('错误发生在当前采集范围之外，未将空列表视为检查通过'); }
      }
      const diagnostics = normalizeDiagnostics(issues, entry, sources);
      if (sensitive(JSON.stringify(diagnostics))) return { ...base, status: 'blocked', message: '诊断信息含敏感内容，已隐藏' };
      return { ...base, status: 'ready', diagnostics, durationMs: Date.now() - began };
    } catch (failure) { return { ...base, status: failure.message.includes('超时') ? 'timeout' : 'unavailable', message: safeOutput(failure.message).slice(0, 1000), durationMs: Date.now() - began }; }
    finally { this.busy = false; }
  }
  async close() { clearTimeout(this.idleTimer); if (this.worker) { const worker = this.worker; this.worker = null; await worker.terminate(); } }
}
