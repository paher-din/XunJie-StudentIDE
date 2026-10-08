import * as monaco from 'monaco-editor/editor/editor.api.js';
import 'monaco-editor/features/find/register.js';
import 'monaco-editor/features/multicursor/register.js';
import 'monaco-editor/features/clipboard/register.js';
import 'monaco-editor/features/contextmenu/register.js';
import 'monaco-editor/features/comment/register.js';
import 'monaco-editor/features/bracketMatching/register.js';
import 'monaco-editor/features/hover/register.js';
import 'monaco-editor/features/gotoError/register.js';
import { sensitive } from '../shared.mjs';

self.MonacoEnvironment = { getWorker: () => new Worker('/build/editor.worker.js', { type: 'module' }) };
const loadedSyntax = new Set(['plaintext']);
const $ = id => document.getElementById(id);
const dark = matchMedia('(prefers-color-scheme: dark)');
const models = new Map();
let editor, active, recording = true, queue = [], flushing, queueKey, clientId, writerId, allEvents = [], eventCursor = 0, replayPoints = [], blocked = false, running = false, fileOperation = false, selectionTimer, lastError = '', capturesAvailable = true;
let capabilities = { revision: -1, languages: [], templates: [], syntax: {} }, fileListing = [];
let phase = 'student', phaseRevision = 0, projectName = '';
let diagnosticTimer, diagnosticRequest = false, problemKey;
const diagnosticOwner = 'student-ide';
const diagnosticStatuses = { pending: '检查中', ready: '检查完成', unsupported: '诊断未接入', needs_preparation: '诊断未准备', unavailable: '诊断不可用', timeout: '诊断超时', paused: '采集已暂停', blocked: '敏感内容阻断', offline: '诊断离线', busy: '等待检查', stale: '等待最新版本' };

function renderProblems() {
  const result = current()?.diagnostics;
  const issues = result?.diagnostics ?? [];
  const errors = issues.filter(issue => issue.severity === 'error').length, warnings = issues.filter(issue => issue.severity === 'warning').length;
  $('problems-count').textContent = issues.length ? String(issues.length) : '';
  $('diagnostic-badge').textContent = !current() ? '未打开文件' : result?.status === 'ready' ? errors ? errors + ' 错误' : warnings ? warnings + ' 警告' : '无诊断' : diagnosticStatuses[result?.status ?? 'pending'];
  $('diagnostic-badge').dataset.state = errors ? 'error' : warnings ? 'warning' : '';
  $('diagnostic-summary').textContent = result ? [diagnosticStatuses[result.status] ?? result.status, result.scope === 'syntax' ? '语法检查' : result.scope === 'structure' ? '结构检查' : '', result.version ? 'v' + result.version : '', result.message ?? (result.status === 'ready' && !issues.length ? '本次检查没有发现问题，不代表答案已经正确。' : '')].filter(Boolean).join(' · ') : current() ? '输入后自动检查已确认的未保存代码。' : '打开或新建文件后查看诊断。';
  const key = JSON.stringify([active, issues]);
  if (key === problemKey) return;
  problemKey = key;
  $('problems').replaceChildren(...issues.map(issue => {
    const item = document.createElement('li'), button = document.createElement('button');
    button.className = 'problem ' + issue.severity;
    button.textContent = `${issue.severity === 'error' ? '错误' : issue.severity === 'warning' ? '警告' : '提示'} · ${issue.path}:${issue.startLineNumber}:${issue.startColumn} · ${issue.message}`;
    button.addEventListener('click', action(async () => {
      if (issue.path !== active) await openFile(issue.path);
      const data = current();
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data.model.getValue())))].map(byte => byte.toString(16).padStart(2, '0')).join('');
      if (digest !== issue.contentHash) { notify('诊断对应的代码已变化，请查看该文件的新检查结果。'); return; }
      const position = { lineNumber: issue.startLineNumber, column: issue.startColumn };
      editor.revealPositionInCenter(position); editor.setPosition(position); editor.focus();
    }));
    item.append(button); return item;
  }));
}
function scheduleDiagnostics(data = current(), changed = false) {
  clearTimeout(diagnosticTimer);
  if (!data || data.model.isDisposed()) { renderProblems(); return; }
  if (changed || !recording || blocked) {
    monaco.editor.setModelMarkers(data.model, diagnosticOwner, []);
    data.diagnostics = { status: !recording ? 'paused' : blocked ? 'blocked' : 'pending', diagnostics: [] };
  }
  renderProblems();
  if (!recording || blocked || !capturesAvailable) return;
  diagnosticTimer = setTimeout(() => checkDiagnostics().catch(() => {}), 500);
}
async function checkDiagnostics() {
  const data = current(), file = active;
  if (!data || !recording || blocked || !capturesAvailable) return;
  if (diagnosticRequest || running) { scheduleDiagnostics(); return; }
  diagnosticRequest = true;
  let requestedVersion = null;
  try {
    await flush();
    if (models.get(file) !== data || active !== file) return;
    const version = data.model.getVersionId();
    requestedVersion = version;
    const result = await api('diagnostics', { path: file, modelId: data.id, version, clientId, writerId });
    if (models.get(file) !== data || data.model.isDisposed() || data.model.getVersionId() !== version || !recording || blocked) return;
    if (['stale', 'busy'].includes(result.status)) { if (active === file) scheduleDiagnostics(); return; }
    data.diagnostics = result;
    monaco.editor.setModelMarkers(data.model, diagnosticOwner, (result.diagnostics ?? []).filter(issue => issue.path === file).map(issue => ({ ...issue, severity: issue.severity === 'warning' ? monaco.MarkerSeverity.Warning : issue.severity === 'info' ? monaco.MarkerSeverity.Info : monaco.MarkerSeverity.Error, source: result.provider })));
  } catch (failure) {
    if (models.get(file) === data && !data.model.isDisposed() && recording && !blocked && (requestedVersion === null || data.model.getVersionId() === requestedVersion)) { data.diagnostics = { status: failure.status ? 'unavailable' : 'offline', message: failure.message, diagnostics: [] }; monaco.editor.setModelMarkers(data.model, diagnosticOwner, []); }
  } finally { diagnosticRequest = false; renderProblems(); }
}

function refreshPhase(state) {
  phase = state.phase;
  phaseRevision = state.phaseRevision;
  $('phase-status').textContent = phase === 'preparation' ? '准备阶段' : '学生操作阶段';
  $('phase-toggle').textContent = phase === 'preparation' ? '开始学习' : '暂停学习并准备';
  $('project').textContent = projectName + (phase === 'preparation' ? ' · 准备中' : ' · 学习中');
}

function notify(message = '') { $('notice').textContent = message; $('notice').hidden = !message; }
function syncLabel(message, state = '') { $('sync').textContent = message; $('sync').dataset.state = state; }
async function api(route, body) {
  const response = await fetch('/api/' + route, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json', 'x-student-ide': '1' }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw Object.assign(new Error(value.error ?? '请求失败'), { status: response.status });
  return value;
}
function persist() {
  try { localStorage.setItem(queueKey, JSON.stringify(queue)); }
  catch { capturesAvailable = false; editor?.updateOptions({ readOnly: true }); refreshVersion(); syncLabel('队列存储失败', 'error'); notify('浏览器无法保存待发送记录，已停止编辑以避免遗漏。请导出草稿并恢复存储后再继续。'); throw new Error('事件队列无法持久保存'); }
}
function enqueue(type, payload) {
  if (!recording || !capturesAvailable) return;
  const event = { id: crypto.randomUUID(), type, timestamp: new Date().toISOString(), payload };
  if (sensitive(JSON.stringify(payload))) { notify('检测到常见敏感内容，已阻断采集。请先移除秘密。'); return; }
  queue.push(event);
  persist();
  syncLabel(`待同步 ${queue.length}`, '');
}
async function flush() {
  if (flushing) { await flushing; if (queue.length) return flush(); return; }
  flushing = (async () => {
    while (queue.length) {
      const batch = queue.slice(0, 100);
      const result = await api('events', { clientId, writerId, events: batch });
      const accepted = new Set(result.accepted);
      queue = queue.filter(e => !accepted.has(e.id));
      persist();
      if (!accepted.size) throw new Error('服务未确认事件，队列已保留');
    }
    if (!blocked) syncLabel(recording ? '已同步 · 本地采集' : '采集已暂停', recording ? 'ok' : '');
    lastError = '';
  })().catch(failure => {
    syncLabel('未同步 · 队列保留', 'error');
    if (lastError !== failure.message) notify(failure.message);
    lastError = failure.message;
    throw failure;
  }).finally(() => { flushing = null; });
  return flushing;
}
function current() { return models.get(active); }
function runtimeFor(file) { return capabilities.languages.find(language => language.extensions.includes('.' + file.split('.').at(-1).toLowerCase())); }
async function loadSyntax(file, model) {
  const runtime = runtimeFor(file);
  const requested = runtime?.requestedEditorLanguage ?? fileListing.find(item => item.path === file)?.syntax.requested ?? ({ md: 'markdown', json: 'json', ts: 'typescript', tsx: 'typescript', jsx: 'javascript', html: 'html', css: 'css' }[file.split('.').at(-1)] ?? 'plaintext');
  const url = capabilities.syntax[requested];
  let id = url ? requested : 'plaintext';
  if (!loadedSyntax.has(id)) {
    try {
      const grammar = await import(url);
      monaco.languages.register({ id });
      monaco.languages.setMonarchTokensProvider(id, grammar.language);
      monaco.languages.setLanguageConfiguration(id, grammar.conf);
      loadedSyntax.add(id);
    } catch (failure) { id = 'plaintext'; notify('语法加载失败，已显示纯文本：' + failure.message); }
  }
  monaco.editor.setModelLanguage(model, id);
}
function refreshVersion() {
  $('new-file').disabled = !editor || !recording || !capturesAvailable || running || fileOperation;
  const data = current();
  $('delete-file').disabled = !data || !recording || blocked || !capturesAvailable || running || fileOperation;
  $('draft').disabled = !data;
  if (!data) { $('save').disabled = $('run').disabled = true; $('dirty').textContent = ''; $('version').textContent = '未打开文件'; $('language-status').textContent = ''; renderProblems(); return; }
  const runtime = runtimeFor(active);
  const language = runtime?.displayName ?? data.model.getLanguageId();
  $('version').textContent = `v${data.model.getVersionId()} · ${language}`;
  $('dirty').textContent = data.model.getValue() === data.savedText ? '已保存' : '未保存';
  $('dirty').classList.toggle('unsaved', data.model.getValue() !== data.savedText);
  $('run').disabled = running || !recording || blocked || !capturesAvailable || !runtime;
  $('run').title = runtime ? `${language} · ${runtime.status === 'ready' ? '已验证' : phase === 'student' ? '需要切回准备阶段验证' : '运行前验证工具链'} (Ctrl+Enter)` : '此语言尚未接入，请在准备阶段让 agent 注册并验证';
  $('language-status').textContent = runtime ? ({ ready: '可用', unavailable: '不可用，运行前复查', unverified: '待验证' }[runtime.status] ?? runtime.status) : '未接入运行环境';
  $('save').disabled = !recording || blocked || !capturesAvailable;
  renderProblems();
}
function setFileListing(listing) {
  fileListing = listing;
  $('files').replaceChildren(...listing.map(file => { const option = document.createElement('option'); option.value = file.path; option.textContent = file.path; return option; }));
  $('files').disabled = !listing.length;
  if (!listing.length) { const option = document.createElement('option'); option.value = ''; option.textContent = '暂无文件'; $('files').append(option); }
  else if (active) $('files').value = active;
}
async function refreshFiles() { setFileListing((await api('files')).files); }
async function createFile(event) {
  event.preventDefault();
  if (fileOperation) return;
  fileOperation = true;
  $('create-submit').disabled = true;
  $('file-error').textContent = '';
  refreshVersion();
  try {
    await flush();
    const result = await api('files/create', { path: $('file-path').value.trim(), clientId, writerId });
    $('create-dialog').close();
    await refreshFiles();
    await openFile(result.path);
    notify('已新建 ' + result.path);
    editor.focus();
    await refreshEvents();
  } catch (failure) { $('file-error').textContent = failure.message; if (!$('create-dialog').open) notify(failure.message); }
  finally { fileOperation = false; $('create-submit').disabled = false; refreshVersion(); }
}
async function deleteFile() {
  const data = current(), file = active;
  if (!data || fileOperation) return;
  $('delete-description').textContent = `移除 ${file}？` + (data.model.getValue() !== data.savedText ? ' 此文件有未保存内容，将一并保留。' : '');
  const dialog = $('delete-dialog');
  dialog.returnValue = '';
  dialog.showModal();
  await new Promise(resolve => dialog.addEventListener('close', resolve, { once: true }));
  if (dialog.returnValue !== 'archive') return;
  await flush();
  clearTimeout(selectionTimer);
  fileOperation = true;
  refreshVersion();
  try {
    await api('files/archive', { path: file, modelId: data.id, version: data.model.getVersionId(), clientId, writerId });
    active = null;
    editor.setModel(null);
    models.delete(file);
    data.model.dispose();
    blocked = false;
    await refreshFiles();
    if (fileListing.length) await openFile(fileListing[0].path);
    else notify('项目中没有文件。使用“文件 → 新建文件”开始编辑。');
    if (fileListing.length) notify('已移入回收区，磁盘文件和草稿均已保留。');
    await refreshEvents();
  } finally { fileOperation = false; refreshVersion(); }
}
function snapshot(data, type = 'document.snapshot', gap = false) {
  enqueue(type, { path: data.path, modelId: data.id, text: data.model.getValue(), version: data.model.getVersionId(), diskHash: data.diskHash, gap });
}
async function openFile(file) {
  await flush();
  let data = models.get(file);
  if (!data) {
    const loaded = await api('file?path=' + encodeURIComponent(file));
    const model = monaco.editor.createModel(loaded.text, 'plaintext', monaco.Uri.parse('inmemory://student/' + file));
    await loadSyntax(file, model);
    data = { path: file, id: crypto.randomUUID(), model, diskHash: loaded.diskHash, savedText: loaded.recovered ? null : loaded.text, blocked: false };
    models.set(file, data);
    snapshot(data, 'document.open');
    let version = model.getVersionId();
    model.onDidChangeContent(event => {
      const baseVersion = version;
      version = event.versionId;
      monaco.editor.setModelMarkers(model, diagnosticOwner, []);
      data.diagnostics = { status: 'pending', diagnostics: [] };
      refreshVersion();
      if (!recording) { data.gap = true; scheduleDiagnostics(data, true); return; }
      if (sensitive(model.getValue())) {
        data.blocked = blocked = true;
        enqueue('capture.blocked', { path: file, reason: '常见凭据检测' });
        syncLabel('敏感内容 · 采集阻断', 'error');
        notify('检测到常见凭据，当前内容不会进入记录或 Codex 上下文。移除后恢复快照，并标记采集缺口。');
        refreshVersion();
        scheduleDiagnostics(data, true);
        return;
      }
      if (data.blocked || data.gap) {
        data.blocked = blocked = false;
        snapshot(data, 'document.snapshot', true);
        data.gap = false;
        notify('采集已恢复，中断区间已标记。');
      } else {
        enqueue('document.edit', { path: file, modelId: data.id, baseVersion, version, undo: event.isUndoing, redo: event.isRedoing, flush: event.isFlush, composing: editor.inComposition, changes: event.changes.map(c => ({ offset: c.rangeOffset, length: c.rangeLength, text: c.text })).sort((a, b) => b.offset - a.offset) });
      }
      scheduleDiagnostics(data, true);
    });
    if (loaded.recovered) notify('已恢复未保存的草稿。' + (loaded.diskChanged ? '磁盘文件也有变化，保存前请比较。' : ''));
  }
  if (active && current()) current().viewState = editor.saveViewState();
  active = file;
  blocked = data.blocked;
  editor.setModel(data.model);
  if (data.viewState) editor.restoreViewState(data.viewState);
  $('files').value = file;
  enqueue('editor.state', { path: file, modelId: data.id, version: data.model.getVersionId(), selection: editor.getSelection(), visibleRanges: editor.getVisibleRanges() });
  refreshVersion();
  await flush();
  scheduleDiagnostics(data, true);
  if (!$('replay-panel').hidden) await renderReplay();
}
function showPanel(panel, expand = true) {
  for (const button of document.querySelectorAll('[data-panel]')) button.setAttribute('aria-selected', String(button.dataset.panel === panel));
  for (const element of document.querySelectorAll('[role=tabpanel]')) element.hidden = element.id !== panel + '-panel';
  $('panels').hidden = !expand;
  $('collapse').textContent = expand ? '收起' : '展开';
  $('collapse').setAttribute('aria-expanded', String(expand));
  $('collapse').setAttribute('aria-label', expand ? '收起底部面板' : '展开底部面板');
  if (panel === 'replay') renderReplay().catch(failure => notify(failure.message));
}
const names = { 'session.start': '开始实验', 'service.restart': '服务恢复', 'document.open': '打开文件', 'document.snapshot': '恢复快照', 'document.edit': '修改代码', 'document.saved': '保存文件', 'document.external': '磁盘外部变化', 'run.started': '开始运行', 'run.completed': '运行结束', 'run.stage.started': '开始运行阶段', 'run.stage.completed': '阶段结束', 'language.registered': '注册语言配置', 'language.verified': '工具链验证', 'editor.state': '编辑位置', 'editor.focus': '编辑区获得焦点', 'editor.blur': '编辑区失去焦点', 'editor.paste': '粘贴代码', 'editor.composition.start': '开始组合输入', 'editor.composition.end': '结束组合输入', 'capture.pause': '暂停采集', 'capture.resume': '恢复采集', 'capture.blocked': '敏感内容阻断', 'page.visibility': '页面可见性' };
const channels = { ui_endpoint: '编辑接口', agent_endpoint: '语言管理接口', hook_endpoint: 'Codex Hook 接口', runner: '运行器', language_service: '语言诊断器', external_unknown: '外部来源未知', system: '系统', unknown: '来源未知' };
Object.assign(names, { 'document.created': '新建文件', 'document.deleted': '移入回收区', 'session.phase': '切换会话阶段', 'policy.denied': '策略拒绝', 'diagnostics.updated': '更新代码诊断' });
async function refreshEvents() {
  refreshPhase(await api('health'));
  const next = await api('languages');
  if (next.revision !== capabilities.revision) {
    capabilities = next;
    await refreshFiles();
    for (const data of models.values()) await loadSyntax(data.path, data.model);
  } else capabilities = next;
  refreshVersion();
  scheduleDiagnostics();
  let result;
  do {
    result = await api('events?after=' + eventCursor);
    allEvents.push(...result.events);
    if (result.events.length) eventCursor = result.events.at(-1).seq;
  } while (result.events.length === 500 && eventCursor < result.seq);
  $('event-count').textContent = String(result.seq);
  $('events').replaceChildren(...allEvents.slice(-60).reverse().map(event => {
    const item = document.createElement('li');
    const time = document.createElement('time');
    time.dateTime = event.timestamp;
    time.textContent = new Date(event.timestamp).toLocaleTimeString('zh-CN', { hour12: false });
    const label = document.createElement('span');
    label.textContent = event.type === 'document.edit' && event.payload.undo ? '撤销修改' : event.type === 'document.edit' && event.payload.redo ? '重做修改' : names[event.type] ?? event.type;
    const detail = document.createElement('span');
    detail.className = 'event-detail';
    detail.textContent = [channels[event.originChannel] ?? '旧记录·来源未核实', event.payload.path ?? event.payload.id ?? event.payload.profile?.id ?? event.payload.operation, event.payload.phase === 'student' ? '学习' : event.payload.phase === 'preparation' ? '准备' : '', event.payload.version ? 'v' + event.payload.version : '', event.payload.stage, event.payload.verification?.status ?? event.payload.status, '#' + event.seq].filter(Boolean).join(' · ');
    item.append(time, label, detail);
    return item;
  }));
  const hooks = allEvents.filter(e => e.type.startsWith('codex.'));
  $('coverage').textContent = hooks.length ? `已收到 ${hooks.length} 个 Codex Hook` : 'Codex Hook 尚未连接';
  if (result.gaps.length) notify('日志存在 ' + result.gaps.length + ' 个已知缺口，回放需结合导出记录检查。');
}
async function renderReplay(seq) {
  if (!active) { $('replay-code').textContent = ''; $('replay-label').textContent = '未打开文件'; return; }
  await flush();
  const replay = await api('replay?path=' + encodeURIComponent(active) + (seq === undefined ? '' : '&seq=' + seq));
  if (seq === undefined) { replayPoints = replay.checkpoints; $('replay-range').max = Math.max(0, replayPoints.length - 1); $('replay-range').value = Math.max(0, replayPoints.length - 1); }
  $('replay-label').textContent = replay.hash ? `v${replay.version} · ${replay.hash.slice(0, 10)}` : '尚无编辑记录';
  $('replay-code').textContent = replay.text ?? '';
}
function download(name, value, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([value], { type }));
  const link = document.createElement('a'); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function save() {
  if (!current()) return;
  await flush();
  const data = current();
  const result = await api('save', { path: active, modelId: data.id, version: data.model.getVersionId() });
  data.diskHash = result.hash;
  data.savedText = data.model.getValue();
  refreshVersion();
  notify('');
  await refreshEvents();
}
async function run() {
  if (running || !current()) return;
  running = true;
  showPanel('output');
  $('run').disabled = true;
  $('run-badge').textContent = '同步中';
  $('output').textContent = '正在确认代码版本…';
  try {
    await flush();
    const data = current();
    const version = data.model.getVersionId();
    $('run-badge').textContent = '运行中';
    $('run-summary').textContent = `正在运行 ${active} · v${version}`;
    const result = await api('run', { path: active, modelId: data.id, version, input: $('stdin').value });
    $('run-summary').dataset.runId = result.runId;
    $('run-badge').textContent = result.status === 'passed' ? '通过' : result.status === 'timeout' ? '超时' : result.status === 'compile_failed' ? '编译失败' : result.failureKind === 'runtime_unavailable' ? '环境不可用' : '失败';
    $('run-summary').textContent = `${result.path} · ${result.language} · v${result.version} · ${result.hash.slice(0, 10)} · ${result.durationMs} ms · 退出码 ${result.exitCode ?? '无'}`;
    $('output').textContent = (result.stages?.length ? result.stages.map(stage => `[${stage.stage === 'compile' ? '编译' : '执行'}] ${stage.durationMs} ms · 退出码 ${stage.exitCode ?? '无'}\n${stage.stdout}${stage.stderr}`).join('\n') : [result.stdout, result.stderr].filter(Boolean).join('\n')) + (result.truncated ? '\n输出已截断（每路最多 64000 字符）' : '') + (result.timedOut ? '\n已达到运行时限' : '');
  } catch (failure) {
    $('run-badge').textContent = '未运行';
    $('run-summary').textContent = failure.message;
    $('output').textContent = '';
    throw failure;
  } finally { running = false; refreshVersion(); await refreshEvents(); }
}
function action(fn) { return async () => { try { await fn(); } catch (failure) { notify(failure.message); } }; }

async function initialize() {
  const listing = await api('files');
  const initial = await api('state');
  capabilities = await api('languages');
  fileListing = listing.files;
  recording = initial.recording;
  $('capture').textContent = recording ? '暂停采集' : '恢复采集';
  projectName = listing.workspace.split(/[\\/]/).at(-1);
  refreshPhase(initial);
  $('project').title = listing.workspace;
  writerId = sessionStorage.getItem('student-ide-writer') ?? crypto.randomUUID();
  sessionStorage.setItem('student-ide-writer', writerId);
  if (initial.writer?.id && initial.writer.id !== writerId && initial.writer.until > Date.now()) throw new Error('另一个编辑窗口正在使用此项目。请关闭它，等待 30 秒后重新打开，避免两份草稿相互覆盖。');
  const identityKey = 'student-ide-client:' + listing.workspace;
  clientId = localStorage.getItem(identityKey) ?? crypto.randomUUID();
  localStorage.setItem(identityKey, clientId);
  queueKey = 'student-ide-outbox:' + listing.workspace + ':' + clientId;
  try { queue = JSON.parse(localStorage.getItem(queueKey) ?? '[]'); if (!Array.isArray(queue)) throw new Error(); } catch { capturesAvailable = false; throw new Error('待发送队列无法解析，已停止采集。请保留浏览器数据并导出草稿。'); }
  await flush();
  setFileListing(listing.files);
  $('editor').replaceChildren();
  editor = monaco.editor.create($('editor'), { theme: dark.matches ? 'vs-dark' : 'vs', fontSize: 14, lineHeight: 23, fontFamily: 'Consolas, "Cascadia Code", "Microsoft YaHei", monospace', minimap: { enabled: false }, automaticLayout: true, fixedOverflowWidgets: true, scrollBeyondLastLine: false, padding: { top: 16, bottom: 12 }, tabSize: 4, glyphMargin: false, lineNumbersMinChars: 3, renderLineHighlight: 'gutter', wordWrap: 'off', ariaLabel: '编辑器内容', contextmenu: true });
  dark.addEventListener('change', event => monaco.editor.setTheme(event.matches ? 'vs-dark' : 'vs'));
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, action(save));
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, action(run));
  for (const [method, type] of [['onDidFocusEditorText', 'editor.focus'], ['onDidBlurEditorText', 'editor.blur'], ['onDidPaste', 'editor.paste'], ['onDidCompositionStart', 'editor.composition.start'], ['onDidCompositionEnd', 'editor.composition.end']]) editor[method](() => { if (active) enqueue(type, { path: active, modelId: current().id, version: current().model.getVersionId() }); });
  const recordPosition = () => {
    if (!active) return;
    const position = editor.getPosition();
    $('position').textContent = `行 ${position.lineNumber}，列 ${position.column}`;
    clearTimeout(selectionTimer);
    // ponytail: sample navigation at 250 ms; preserve every text change separately.
    selectionTimer = setTimeout(() => { if (active && current()) enqueue('editor.state', { path: active, modelId: current().id, version: current().model.getVersionId(), selection: editor.getSelection(), visibleRanges: editor.getVisibleRanges() }); }, 250);
  };
  editor.onDidChangeCursorSelection(recordPosition);
  editor.onDidScrollChange(recordPosition);
  $('files').addEventListener('change', action(() => openFile($('files').value)));
  $('save').addEventListener('click', action(save));
  $('run').addEventListener('click', action(run));
  $('diagnostic-badge').addEventListener('click', () => showPanel('problems'));
  $('file-actions').addEventListener('toggle', event => {
    if (event.newState !== 'open') return;
    const rect = $('file-menu').getBoundingClientRect();
    $('file-actions').style.top = rect.bottom + 4 + 'px';
    $('file-actions').style.left = Math.max(8, rect.right - $('file-actions').offsetWidth) + 'px';
  });
  $('new-file').addEventListener('click', () => { $('file-actions').hidePopover(); $('file-path').value = ''; $('file-error').textContent = ''; $('create-dialog').showModal(); });
  $('delete-file').addEventListener('click', action(async () => { $('file-actions').hidePopover(); await deleteFile(); }));
  $('create-form').addEventListener('submit', createFile);
  $('create-cancel').addEventListener('click', () => $('create-dialog').close());
  $('draft').addEventListener('click', () => { if (current()) download(active.split('/').at(-1) + '.draft.txt', current().model.getValue()); });
  for (const button of document.querySelectorAll('[data-panel]')) button.addEventListener('click', () => showPanel(button.dataset.panel));
  $('collapse').addEventListener('click', () => showPanel(document.querySelector('[data-panel][aria-selected=true]').dataset.panel, $('panels').hidden));
  $('replay-range').addEventListener('input', action(() => renderReplay(replayPoints[Number($('replay-range').value)]?.seq)));
  $('capture').addEventListener('click', action(async () => {
    await flush();
    const result = await api('capture', { recording: !recording });
    recording = result.recording;
    $('capture').textContent = recording ? '暂停采集' : '恢复采集';
    if (recording) for (const data of models.values()) { if (!sensitive(data.model.getValue())) snapshot(data, 'document.snapshot', true); }
    refreshVersion();
    for (const data of models.values()) monaco.editor.setModelMarkers(data.model, diagnosticOwner, []);
    scheduleDiagnostics(current(), true);
    notify(recording ? '采集已恢复，暂停区间已标记。' : '采集已暂停。仍可编辑和导出草稿；保存与运行需先恢复同步。');
    await flush();
    await refreshEvents();
  }));
  $('phase-toggle').addEventListener('click', action(async () => {
    refreshPhase(await api('health'));
    const target = phase === 'student' ? 'preparation' : 'student';
    const expectedRevision = phaseRevision;
    if (target === 'preparation') {
      const dialog = $('phase-dialog');
      dialog.returnValue = '';
      dialog.showModal();
      await new Promise(resolve => dialog.addEventListener('close', resolve, { once: true }));
      if (dialog.returnValue !== 'preparation') return;
    }
    $('phase-toggle').disabled = true;
    try {
      await flush();
      refreshPhase(await api('phase', { phase: target, expectedRevision, clientId, writerId }));
      notify(target === 'student' ? '已开始学习，agent 仅开放读取工具。' : '学习已暂停，agent 可准备并验证环境。');
      refreshVersion();
      await refreshEvents();
    } finally { $('phase-toggle').disabled = false; }
  }));
  document.addEventListener('visibilitychange', () => enqueue('page.visibility', { state: document.visibilityState }));
  window.addEventListener('beforeunload', event => { if (queue.length) { event.preventDefault(); event.returnValue = ''; } });
  if (listing.files.length) await openFile(initial.active && listing.files.some(f => f.path === initial.active) ? initial.active : listing.files.find(f => f.path === 'main.py')?.path ?? listing.files[0].path);
  else notify('项目中没有文件。使用“文件 → 新建文件”开始编辑。');
  await refreshEvents();
  performance.mark('student-ide-ready');
  setInterval(() => flush().catch(() => {}), 150);
  setInterval(() => refreshEvents().catch(() => syncLabel('服务离线 · 队列保留', 'error')), 2000);
  setInterval(() => { if (!queue.length && recording) api('events', { clientId, writerId, events: [] }).catch(() => syncLabel('服务离线', 'error')); }, 5000);
  if (typeof document.modelContext?.registerTool === 'function') {
    await document.modelContext.registerTool({ name: 'get_student_editor', description: 'Read acknowledged unsaved code, selections and versions from the student IDE.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, annotations: { readOnlyHint: true }, execute: () => api('state') });
  }
}
initialize().catch(failure => { notify(failure.message); syncLabel('启动失败', 'error'); });
