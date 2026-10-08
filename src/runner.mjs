import { spawn, execFile } from 'node:child_process';
import { mkdirSync, writeFileSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';
import { hash, safeOutput, sensitive } from './journal.mjs';

export function safeRelative(file) {
  if (typeof file !== 'string' || !file || file.length > 240 || path.isAbsolute(file) || /[\\:\0]/.test(file) || file.split('/').some(part => !part || part.startsWith('.') || /^(?:credentials|secrets?|passwords?|id_rsa)(?:\.|$)/i.test(part))) throw Object.assign(new Error('快照路径不在允许范围'), { status: 403 });
  return file;
}

export const runtimeEnvironmentKeys = ['PATH', 'HOME', 'INCLUDE', 'LIB', 'LIBPATH', 'JAVA_HOME', 'DOTNET_ROOT', 'GOPATH', 'GOCACHE', 'GOMODCACHE', 'CARGO_HOME', 'RUSTUP_HOME', 'GEM_HOME', 'GEM_PATH', 'RUBYLIB', 'SDKROOT', 'LANG', 'LC_ALL', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH', 'PYTHONIOENCODING'];
function environment(commands, overrides = {}) {
  const env = {};
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA']) if (process.env[key]) env[key] = process.env[key];
  for (const key of runtimeEnvironmentKeys) if (key !== 'PATH' && process.env[key]) env[key] = process.env[key];
  env.PYTHONIOENCODING = 'utf-8';
  Object.assign(env, overrides);
  const searchPath = overrides.PATH ?? process.env.PATH ?? process.env.Path ?? '';
  const folders = commands.map(command => resolveExecutable(command, searchPath)).filter(command => path.isAbsolute(command)).map(command => path.dirname(command));
  env.PATH = [...new Set(folders), searchPath].join(path.delimiter);
  return env;
}

export function resolveExecutable(command, searchPath = process.env.PATH ?? process.env.Path ?? '') {
  if (path.isAbsolute(command)) return command;
  const suffixes = process.platform === 'win32' ? ['', '.exe'] : [''];
  for (const directory of searchPath.split(path.delimiter)) {
    for (const suffix of suffixes) {
      const candidate = path.join(directory, command + suffix);
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
  }
  return command;
}

export async function runProcess(command, args, { cwd, input = '', timeoutMs = 10000, commands = [], environment: overrides = {} } = {}) {
  const began = Date.now();
  const env = environment(commands, overrides);
  const executable = resolveExecutable(command, env.PATH);
  if (path.isAbsolute(executable)) env.PATH = path.dirname(executable) + path.delimiter + env.PATH;
  return new Promise(resolve => {
    let stdout = '', stderr = '', truncated = false, timedOut = false, settled = false;
    const child = spawn(executable, args, { cwd, env, windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    const collect = (current, chunk) => { const text = current + chunk; if (text.length > 64000) truncated = true; return text.slice(0, 64000); };
    child.stdout.on('data', chunk => { stdout = collect(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = collect(stderr, chunk); });
    const finish = (exitCode, signal, failure) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      resolve({ command: executable, args, exitCode, signal, stdout: safeOutput(stdout), stderr: safeOutput(failure ?? stderr), truncated, timedOut, durationMs: Date.now() - began, failureKind: failure ? 'toolchain_start' : timedOut ? 'timeout' : null, outputRedacted: sensitive(stdout + stderr) });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      // ponytail: best-effort process-tree termination, use an OS sandbox/job object for hostile workloads.
      const release = () => { child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); finish(null, 'SIGKILL'); };
      if (process.platform === 'win32' && child.pid) execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }, release);
      else { child.kill('SIGKILL'); release(); }
    }, timeoutMs);
    child.on('error', failure => finish(null, null, failure.message));
    child.on('close', (code, signal) => finish(code, signal));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

export async function probeToolchain(profile, cwd) {
  const result = await runProcess(profile.toolchain.command, profile.toolchain.args, { cwd, timeoutMs: 5000, environment: profile.environment });
  let fingerprint = null;
  try { const stat = statSync(result.command); fingerprint = { path: result.command, size: stat.size, modified: stat.mtimeMs }; } catch {}
  return { ...result, fingerprint, signature: hash(JSON.stringify([result.command, result.stdout, result.stderr, fingerprint])) };
}

export function createSnapshot(directory, entry, files) {
  const workspace = path.join(directory, 'workspace');
  mkdirSync(workspace, { recursive: true });
  let bytes = 0;
  const snapshots = Object.entries(files).map(([file, text]) => {
    safeRelative(file);
    if (typeof text !== 'string' || sensitive(text)) throw Object.assign(new Error('快照包含敏感内容或非文本数据'), { status: 422 });
    bytes += Buffer.byteLength(text);
    if (bytes > 1024 * 1024 || Object.keys(files).length > 200) throw Object.assign(new Error('源码快照超过 1 MiB 或 200 个文件的限制'), { status: 413 });
    const target = path.join(workspace, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text, { encoding: 'utf8', flag: 'wx' });
    return { path: file, text, hash: hash(text) };
  });
  if (!Object.hasOwn(files, entry)) throw new Error('快照缺少执行入口');
  return { directory, workspace, entry: path.join(workspace, entry), artifact: path.join(directory, 'program' + (process.platform === 'win32' ? '.exe' : '')), files: snapshots };
}

export async function executeProfile(profile, snapshot, { input = '', executeTimeout = 10000, compileTimeout = 30000, onStage = () => {} } = {}) {
  const context = { entry: snapshot.entry, artifact: snapshot.artifact, workspace: snapshot.workspace, runDir: snapshot.directory };
  const replace = value => value.replace(/\{(entry|artifact|workspace|runDir)\}/g, (_, name) => context[name]);
  const steps = [...profile.compile.map(step => ({ ...step, stage: 'compile' })), { ...profile.execute, stage: 'execute' }];
  const stages = [];
  for (let index = 0; index < steps.length; index++) {
    const step = steps[index];
    const command = replace(step.command), args = step.args.map(replace);
    onStage('started', { index, stage: step.stage, command, args });
    const result = { index, stage: step.stage, ...await runProcess(command, args, { cwd: snapshot.workspace, input: step.stage === 'execute' ? input : '', timeoutMs: step.stage === 'compile' ? compileTimeout : executeTimeout, commands: [profile.toolchain.command, ...profile.compile.map(item => item.command)], environment: profile.environment }) };
    stages.push(result);
    onStage('completed', result);
    if (result.exitCode !== 0 || result.timedOut) break;
  }
  const last = stages.at(-1);
  return { stages, status: last.timedOut ? 'timeout' : last.exitCode === 0 ? 'passed' : last.stage === 'compile' ? 'compile_failed' : 'failed', exitCode: last.exitCode, signal: last.signal, stdout: last.stdout, stderr: last.stderr, timedOut: last.timedOut, truncated: stages.some(stage => stage.truncated), outputRedacted: stages.some(stage => stage.outputRedacted), failureKind: last.failureKind ?? (last.exitCode === 0 ? null : last.stage), durationMs: stages.reduce((sum, stage) => sum + stage.durationMs, 0) };
}
