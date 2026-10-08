import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { hash, sensitive } from './journal.mjs';
import { safeRelative, createSnapshot, executeProfile, probeToolchain, runtimeEnvironmentKeys } from './runner.mjs';
import { diagnosticCapability, configuredDiagnostics } from './diagnostics.mjs';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const blockedExtensions = new Set(['.env', '.key', '.pem', '.exe', '.dll', '.so', '.a', '.o', '.obj', '.bin', '.zip', '.pdb']);
const pythonWrapper = "import runpy,sys,os; p=sys.argv[1]; sys.argv=[p]; sys.path.insert(0,os.path.dirname(p)); sys.path.insert(1,os.getcwd()); runpy.run_path(p,run_name='__main__')";
export function referenceProfiles(python = 'python') {
  const interpreted = (id, name, extensions, editorLanguage, command, args, text, captureExtensions = extensions) => ({ id, displayName: name, extensions, editorLanguage, mode: 'file', toolchain: { command, args: ['--version'] }, compile: [], execute: { command, args }, captureExtensions, captureFiles: [], smoke: { entry: 'check' + extensions[0], files: { ['check' + extensions[0]]: text }, expectedStdout: 'student-ide-ready\n', input: '' } });
  const compiled = (id, name, extension, command, text, standard) => ({ id, displayName: name, extensions: [extension], editorLanguage: 'cpp', mode: 'file', toolchain: { command, args: ['--version'] }, compile: [{ command, args: ['{entry}', '-std=' + standard, '-o', '{artifact}'] }], execute: { command: '{artifact}', args: [] }, captureExtensions: [extension, '.h', '.hpp'], captureFiles: [], smoke: { entry: 'check' + extension, files: { ['check' + extension]: text }, expectedStdout: 'student-ide-ready\n', input: '' } });
  return [
    interpreted('python', 'Python', ['.py'], 'python', python, ['-I', '-X', 'utf8', '-u', '-c', pythonWrapper, '{entry}'], 'print("student-ide-ready")\n'),
    interpreted('javascript', 'JavaScript', ['.js', '.mjs', '.cjs'], 'javascript', process.execPath, ['{entry}'], 'console.log("student-ide-ready");\n', ['.js', '.mjs', '.cjs', '.json']),
    compiled('cpp', 'C++', '.cpp', 'g++', '#include <iostream>\nint main(){std::cout << "student-ide-ready\\n";}\n', 'c++17'),
    compiled('c', 'C', '.c', 'gcc', '#include <stdio.h>\nint main(void){puts("student-ide-ready");return 0;}\n', 'c17')
  ];
}

function validateStep(step, probe = false) {
  if (!step || typeof step.command !== 'string' || !step.command || step.command.length > 1000 || /[\r\n\0]/.test(step.command) || !Array.isArray(step.args) || step.args.length > 80 || step.args.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))) throw fail('工具链命令或参数无效');
  for (const value of [step.command, ...step.args]) {
    for (const match of value.matchAll(/\{([^{}]+)\}/g)) if (probe || !['entry', 'artifact', 'workspace', 'runDir'].includes(match[1])) throw fail('使用了不支持的命令模板');
  }
  return { command: step.command, args: [...step.args] };
}

export function validateProfile(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw fail('语言配置必须是对象');
  const keys = new Set(['id', 'displayName', 'extensions', 'editorLanguage', 'mode', 'toolchain', 'compile', 'execute', 'captureExtensions', 'captureFiles', 'environment', 'smoke', 'diagnostics']);
  if (Object.keys(raw).some(key => !keys.has(key))) throw fail('语言配置包含未知字段');
  if (typeof raw.id !== 'string' || !/^[a-z][a-z0-9-]{0,31}$/.test(raw.id) || typeof raw.displayName !== 'string' || !raw.displayName || raw.displayName.length > 80 || typeof raw.editorLanguage !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(raw.editorLanguage) || !['file', 'project'].includes(raw.mode ?? 'file')) throw fail('语言标识或显示信息无效');
  const extensions = value => {
    if (!Array.isArray(value) || !value.length || value.length > 32 || value.some(item => typeof item !== 'string' || !/^\.[a-zA-Z0-9]{1,12}$/.test(item) || blockedExtensions.has(item.toLowerCase()))) throw fail('入口或采集扩展名无效');
    return [...new Set(value.map(item => item.toLowerCase()))];
  };
  if (!Array.isArray(raw.compile ?? []) || (raw.compile ?? []).length > 4 || !Array.isArray(raw.captureFiles ?? []) || (raw.captureFiles ?? []).length > 32) throw fail('编译步骤或采集文件无效');
  const smoke = raw.smoke;
  if (!smoke || !smoke.files || typeof smoke.files !== 'object' || Array.isArray(smoke.files) || Object.keys(smoke.files).length > 20 || !Object.hasOwn(smoke.files, smoke.entry) || typeof smoke.expectedStdout !== 'string' || smoke.expectedStdout.length > 4096 || (smoke.input !== undefined && (typeof smoke.input !== 'string' || smoke.input.length > 10000))) throw fail('独立验证样例无效');
  for (const [file, text] of Object.entries(smoke.files)) { safeRelative(file); if (typeof text !== 'string' || text.length > 16000 || sensitive(text) || blockedExtensions.has(path.extname(file).toLowerCase())) throw fail('验证样例文件无效'); }
  if (sensitive(smoke.expectedStdout) || sensitive(smoke.input ?? '')) throw fail('验证输入/输出样例包含敏感内容', 422);
  const environment = raw.environment ?? {};
  if (typeof environment !== 'object' || Array.isArray(environment) || Object.entries(environment).some(([key, value]) => !runtimeEnvironmentKeys.includes(key) || typeof value !== 'string' || value.length > 8192 || value.includes('\0') || sensitive(value))) throw fail('仅允许非敏感工具链环境变量');
  const profile = { id: raw.id, displayName: raw.displayName, extensions: extensions(raw.extensions), editorLanguage: raw.editorLanguage, mode: raw.mode ?? 'file', toolchain: validateStep(raw.toolchain, true), compile: (raw.compile ?? []).map(step => validateStep(step)), execute: validateStep(raw.execute), captureExtensions: extensions(raw.captureExtensions ?? raw.extensions), captureFiles: (raw.captureFiles ?? []).map(safeRelative), environment: { ...environment }, smoke: { entry: safeRelative(smoke.entry), files: { ...smoke.files }, expectedStdout: smoke.expectedStdout, input: smoke.input ?? '' } };
  if (raw.diagnostics !== undefined) {
    if (!raw.diagnostics || raw.diagnostics.format !== 'json' || Object.keys(raw.diagnostics).some(key => !['format', 'command', 'args'].includes(key))) throw fail('诊断配置只支持 JSON 协议和命令参数');
    profile.diagnostics = { format: 'json', ...validateStep(raw.diagnostics, true) };
  }
  if (!profile.extensions.includes(path.extname(smoke.entry).toLowerCase()) || profile.captureFiles.some(file => blockedExtensions.has(path.extname(file).toLowerCase()))) throw fail('验证入口或采集范围不匹配');
  if (sensitive(JSON.stringify(profile))) throw fail('配置或验证样例含敏感内容', 422);
  return profile;
}

export class LanguageRegistry {
  constructor(journal, directory, pluginRoot, python) {
    this.journal = journal; this.directory = directory;
    this.templates = referenceProfiles(python);
    this.profiles = new Map(); this.revision = 0;
    const fallback = validateProfile(this.templates[0]);
    this.profiles.set(fallback.id, { profile: fallback, version: 0, definitionHash: hash(JSON.stringify(fallback)), verification: null, builtin: true });
    for (const event of journal.events) {
      if (event.type === 'language.registered') {
        const record = event.payload;
        const profile = validateProfile(record.profile);
        if (hash(JSON.stringify(record.profile)) !== record.definitionHash) throw new Error('语言配置校验失败，原日志保留');
        this.profiles.set(profile.id, { ...record, profile, verification: null });
        this.revision++;
      } else if (event.type === 'language.verified') {
        const record = this.profiles.get(event.payload.id);
        if (record?.definitionHash === event.payload.definitionHash) record.verification = event.payload.verification;
      }
    }
    const manifest = path.join(pluginRoot, 'public/build/syntax-manifest.json');
    this.syntax = existsSync(manifest) ? JSON.parse(readFileSync(manifest, 'utf8')) : { python: '/build/languages/python.js', markdown: '/build/languages/markdown.js' };
  }

  register(raw, expectedVersion) {
    const profile = validateProfile(raw);
    const definitionHash = hash(JSON.stringify(profile));
    const current = this.profiles.get(profile.id);
    if (expectedVersion !== undefined && expectedVersion !== current?.version) throw fail('语言配置版本冲突', 409);
    if (current?.definitionHash === definitionHash) return this.describe(current);
    if (current && expectedVersion === undefined) throw fail('更新配置需要 expectedVersion，不能静默替换', 409);
    if (!current && this.profiles.size >= 32) throw fail('本项目语言配置已达 32 个上限', 413);
    for (const record of this.profiles.values()) if (record.profile.id !== profile.id && profile.extensions.some(extension => record.profile.extensions.includes(extension))) throw fail('入口扩展名已经由另一语言配置占用', 409);
    const record = { profile, version: (current?.version ?? 0) + 1, definitionHash, verification: null, builtin: false };
    this.journal.append([{ type: 'language.registered', source: 'agent_endpoint', payload: record }]);
    this.profiles.set(profile.id, record); this.revision++;
    return this.describe(record);
  }

  forFile(file) { const extension = path.extname(file).toLowerCase(); return [...this.profiles.values()].find(record => record.profile.extensions.includes(extension)); }
  forDiagnostics(file) { return this.forFile(file) ?? [...this.profiles.values()].find(record => record.profile.editorLanguage === 'cpp' && record.profile.captureExtensions.includes(path.extname(file).toLowerCase())); }
  syntaxForFile(file) {
    const extension = path.extname(file).toLowerCase();
    const profile = this.forFile(file)?.profile;
    const id = profile?.editorLanguage ?? ({ '.md': 'markdown', '.json': 'json', '.ts': 'typescript', '.tsx': 'typescript', '.jsx': 'javascript', '.html': 'html', '.css': 'css' }[extension] ?? this.templates.find(item => item.extensions.includes(extension) || item.captureExtensions.includes(extension))?.editorLanguage ?? 'plaintext');
    return { id: this.syntax[id] ? id : 'plaintext', url: this.syntax[id] ?? null, requested: id };
  }
  allowedExtensions() { return new Set(['.txt', '.md', '.json', '.js', '.ts', '.tsx', '.jsx', '.html', '.css', ...this.templates.flatMap(profile => [...profile.extensions, ...profile.captureExtensions]), ...[...this.profiles.values()].flatMap(record => [...record.profile.extensions, ...record.profile.captureExtensions, ...record.profile.captureFiles.map(file => path.extname(file))])]); }
  describe(record) {
    return { id: record.profile.id, displayName: record.profile.displayName, version: record.version, definitionHash: record.definitionHash, mode: record.profile.mode, extensions: record.profile.extensions, editorLanguage: this.syntax[record.profile.editorLanguage] ? record.profile.editorLanguage : 'plaintext', requestedEditorLanguage: record.profile.editorLanguage, syntaxUrl: this.syntax[record.profile.editorLanguage] ?? null, status: record.verification?.status ?? 'unverified', verification: record.verification, profile: record.profile, builtin: record.builtin, diagnostics: diagnosticCapability(record, record.profile.editorLanguage) };
  }
  capabilities() { return { revision: this.revision, languages: [...this.profiles.values()].map(record => this.describe(record)), templates: this.templates, syntax: this.syntax, diagnostics: { bundled: ['javascript', 'typescript', 'json', 'html', 'css'], toolchain: ['python', 'c', 'cpp'], customProtocol: 'json', limit: 100 }, limits: { profiles: 32, compileSteps: 4, environmentKeys: runtimeEnvironmentKeys }, semantics: '语法、静态诊断、运行、LSP/调试是不同能力。内置诊断不执行答案；外部包类型和完整 LSP/调试尚未接入。验证结果不是持续健康证明。' }; }

  async verify(id, probe, originChannel = 'agent_endpoint') {
    const record = this.profiles.get(id);
    if (!record) throw fail('语言尚未注册', 404);
    probe ??= await probeToolchain(record.profile, this.directory);
    let verification;
    if (probe.exitCode !== 0 || probe.timedOut) {
      verification = { status: 'unavailable', checkedAt: new Date().toISOString(), probe, failureKind: 'toolchain_start', result: null };
    } else {
      const snapshot = createSnapshot(path.join(this.directory, 'language-checks', randomUUID()), record.profile.smoke.entry, record.profile.smoke.files);
      const result = await executeProfile(record.profile, snapshot, { input: record.profile.smoke.input });
      const matched = result.status === 'passed' && result.stdout.replaceAll('\r\n', '\n') === record.profile.smoke.expectedStdout.replaceAll('\r\n', '\n');
      verification = { status: matched ? 'ready' : 'unavailable', checkedAt: new Date().toISOString(), probe, result, failureKind: matched ? null : result.failureKind ?? 'smoke_output_mismatch', snapshotDirectory: snapshot.directory };
    }
    if (record.profile.diagnostics) {
      try { await configuredDiagnostics(record.profile, record.profile.smoke.entry, record.profile.smoke.files, this.directory); verification.diagnostics = { status: 'ready' }; }
      catch (failure) { verification.diagnostics = { status: 'unavailable', message: failure.message }; }
    }
    this.journal.append([{ type: 'language.verified', source: originChannel, payload: { id, definitionHash: record.definitionHash, verification } }]);
    record.verification = verification;
    return this.describe(record);
  }

  async ensure(id, allowVerification = true) {
    const record = this.profiles.get(id);
    if (!record) throw fail('语言尚未接入', 409);
    const probe = await probeToolchain(record.profile, this.directory);
    if (record.verification?.status !== 'ready' || record.verification.probe.signature !== probe.signature) {
      if (!allowVerification) throw fail('运行环境未验证或已变化，请由学生暂停学习并切回准备阶段', 409);
      await this.verify(id, probe, 'runner');
    }
    return record;
  }
}
