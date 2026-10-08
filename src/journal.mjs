import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, openSync, writeSync, fsyncSync, closeSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { sensitive, applyChanges } from '../shared.mjs';
export { sensitive, applyChanges } from '../shared.mjs';

export const hash = text => createHash('sha256').update(text).digest('hex');
export const safeOutput = text => sensitive(text) ? '[敏感内容已隐藏]' : text;
const originChannels = new Set(['ui_endpoint', 'agent_endpoint', 'hook_endpoint', 'runner', 'language_service', 'external_unknown', 'system', 'unknown']);

export class Journal {
  constructor(directory) {
    mkdirSync(directory, { recursive: true });
    this.file = path.join(directory, 'events.jsonl');
    this.events = [];
    this.ids = new Map();
    this.buffers = new Map();
    this.active = null;
    this.recording = true;
    this.phase = 'student';
    this.phaseRevision = 0;
    this.gaps = [];
    this.hooksSeen = new Set();
    this.owner = null;
    this.lastClientAt = null;
    this.runs = new Map();
    this.diagnostics = new Map();
    // ponytail: one experiment's journal in memory; add a streaming index for multi-week courses.
    if (existsSync(this.file)) {
      if (statSync(this.file).size > 100 * 1024 * 1024) throw new Error('本轮日志超过 100 MiB，请使用新的实验目录');
      const lines = readFileSync(this.file, 'utf8').split('\n');
      for (let index = 0; index < lines.length; index++) {
        if (!lines[index].trim()) continue;
        try {
          const record = JSON.parse(lines[index]);
          if (!Array.isArray(record.events) || record.checksum !== hash(JSON.stringify(record.events))) throw new Error('校验失败');
          for (const event of record.events) this.reduce(event);
        } catch {
          this.gaps.push({ line: index + 1, reason: '不完整或损坏的日志记录，原文件保留' });
        }
      }
    }
    this.sessionId = this.events.find(e => e.type === 'session.start')?.sessionId ?? randomUUID();
    if (!this.events.length) this.append([{ type: 'session.start', source: 'system', payload: {} }]);
    else this.append([{ type: 'service.restart', source: 'system', payload: { recovered: this.events.length, gaps: this.gaps.length } }]);
  }

  reduce(event) {
    this.events.push(event);
    this.ids.set(event.id, event);
    const data = event.payload;
    if (['document.open', 'document.snapshot', 'document.edit', 'document.deleted', 'document.external', 'capture.pause', 'capture.blocked', 'language.registered', 'language.verified'].includes(event.type)) this.diagnostics.clear();
    if (['document.open', 'document.snapshot'].includes(event.type)) {
      this.buffers.set(data.path, { ...data, dirty: hash(data.text) !== data.diskHash, blocked: false, deleted: false, seq: event.seq });
      this.active = data.path;
    } else if (event.type === 'document.edit') {
      const buffer = this.buffers.get(data.path);
      if (!buffer || buffer.modelId !== data.modelId || buffer.version !== data.baseVersion) {
        this.gaps.push({ seq: event.seq, reason: '文档版本链中断' });
        return;
      }
      buffer.text = applyChanges(buffer.text, data.changes);
      buffer.version = data.version;
      buffer.dirty = hash(buffer.text) !== buffer.diskHash;
      buffer.seq = event.seq;
    } else if (event.type === 'document.saved') {
      const buffer = this.buffers.get(data.path);
      buffer.diskHash = data.hash;
      buffer.dirty = hash(buffer.text) !== data.hash;
      buffer.externalChanged = false;
    } else if (event.type === 'document.deleted') {
      const buffer = this.buffers.get(data.path);
      if (buffer) buffer.deleted = true;
      if (this.active === data.path) { this.active = null; this.editorState = null; }
    } else if (event.type === 'document.external') {
      const buffer = this.buffers.get(data.path);
      if (buffer) buffer.externalChanged = true;
    } else if (event.type === 'diagnostics.updated') {
      this.diagnostics.set(data.path, { ...data, seq: event.seq });
    } else if (event.type === 'session.phase') {
      this.phase = data.phase;
      this.phaseRevision = event.seq;
    } else if (event.type === 'capture.blocked') {
      const buffer = this.buffers.get(data.path);
      if (buffer) buffer.blocked = true;
      this.gaps.push({ seq: event.seq, path: data.path, reason: '常见敏感内容导致采集中断' });
    } else if (event.type === 'editor.state') {
      this.active = data.path;
      this.editorState = data;
    } else if (event.type === 'capture.pause' || event.type === 'capture.resume') {
      this.recording = event.type === 'capture.resume';
      if (!this.recording) this.gaps.push({ seq: event.seq, reason: '用户暂停采集，期间编辑不完整' });
    } else if (event.type === 'run.started' || event.type === 'run.completed') {
      this.runs.set(data.runId, { ...this.runs.get(data.runId), ...data });
    } else if (event.type.startsWith('codex.')) {
      this.hooksSeen.add(event.type.slice(6));
    }
  }

  append(entries) {
    const newEntries = entries.filter(e => !e.id || !this.ids.has(e.id));
    if (!newEntries.length) return [];
    const start = this.events.at(-1)?.seq ?? 0;
    const events = newEntries.map((entry, index) => ({
      id: entry.id ?? randomUUID(), sessionId: this.sessionId, seq: start + index + 1,
      type: entry.type, source: originChannels.has(entry.source) ? entry.source : 'unknown',
      originChannel: originChannels.has(entry.source) ? entry.source : 'unknown',
      timestamp: entry.timestamp ?? new Date().toISOString(), receivedAt: new Date().toISOString(),
      clientId: entry.clientId, payload: entry.payload ?? {}
    }));
    const serialized = JSON.stringify(events);
    if (sensitive(serialized)) throw Object.assign(new Error('检测到敏感内容，未写入日志'), { status: 422 });
    const fd = openSync(this.file, 'a');
    try {
      // A complete checksummed batch is durable before acknowledging it. Preserve damaged tails.
      const record = Buffer.from('\n' + JSON.stringify({ events, checksum: hash(serialized) }) + '\n');
      let written = 0;
      while (written < record.length) written += writeSync(fd, record, written, record.length - written);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    for (const event of events) this.reduce(event);
    return events;
  }

  accept(entries, clientId, writerId = clientId) {
    if (typeof clientId !== 'string' || clientId.length > 100 || !Array.isArray(entries) || entries.length > 100) throw Object.assign(new Error('事件批次无效'), { status: 400 });
    if (typeof writerId !== 'string' || writerId.length > 100) throw Object.assign(new Error('编辑窗口标识无效'), { status: 400 });
    if (this.owner && this.owner !== writerId && Date.now() - (this.ownerAt ?? 0) < 30000) throw Object.assign(new Error('另一个编辑窗口正在写入，请等待它关闭后重试'), { status: 409 });
    if (!this.recording && entries.length) throw Object.assign(new Error('采集已暂停'), { status: 409 });
    const buffers = new Map([...this.buffers].map(([key, value]) => [key, { ...value }]));
    const seen = new Set();
    const allowed = new Set(['document.open', 'document.snapshot', 'document.edit', 'editor.state', 'editor.focus', 'editor.blur', 'editor.paste', 'editor.composition.start', 'editor.composition.end', 'page.visibility', 'capture.blocked', 'student.note']);
    const pending = [];
    for (const event of entries) {
      if (!event || typeof event.id !== 'string' || event.id.length > 100 || !allowed.has(event.type) || !event.payload || typeof event.payload !== 'object') throw Object.assign(new Error('事件字段无效'), { status: 400 });
      if (this.ids.has(event.id) || seen.has(event.id)) continue;
      seen.add(event.id);
      const data = event.payload;
      if (event.type.startsWith('document.')) {
        if (!this.recording) throw Object.assign(new Error('采集已暂停'), { status: 409 });
        if (typeof data.path !== 'string' || typeof data.modelId !== 'string' || !Number.isSafeInteger(data.version) || data.version < 1) throw Object.assign(new Error('文档字段无效'), { status: 400 });
        if (event.type === 'document.edit') {
          const buffer = buffers.get(data.path);
          if (!buffer || buffer.deleted || buffer.modelId !== data.modelId || buffer.version !== data.baseVersion || data.version <= data.baseVersion || !Array.isArray(data.changes) || data.changes.length > 1000) throw Object.assign(new Error('文档版本冲突，请先同步待发送事件'), { status: 409 });
          const text = applyChanges(buffer.text, data.changes);
          if (text.length > 250000 || sensitive(text)) throw Object.assign(new Error('代码过大或含敏感内容，停止采集此编辑'), { status: 422 });
          buffers.set(data.path, { ...buffer, text, version: data.version });
        } else {
          if (typeof data.text !== 'string' || data.text.length > 250000 || sensitive(data.text) || typeof data.diskHash !== 'string') throw Object.assign(new Error('代码过大或含敏感内容'), { status: 422 });
          buffers.set(data.path, { ...data });
        }
      }
      pending.push({ ...event, source: 'ui_endpoint', clientId });
    }
    this.append(pending);
    this.owner = writerId;
    this.ownerAt = Date.now();
    this.lastClientAt = new Date().toISOString();
    return { accepted: entries.map(e => e.id), seq: this.events.at(-1).seq };
  }

  snapshot() {
    return {
      sessionId: this.sessionId, seq: this.events.at(-1).seq, recording: this.recording, phase: this.phase, phaseRevision: this.phaseRevision,
      active: this.active, editor: this.editorState ?? null,
      buffers: [...this.buffers.values()].filter(buffer => !buffer.deleted).map(buffer => ({ ...buffer, hash: hash(buffer.text) })),
      lastClientAt: this.lastClientAt, freshness: '仅含服务已确认内容；客户端待发送编辑不会冒充已同步内容',
      gaps: this.gaps, hooksSeen: [...this.hooksSeen], runs: [...this.runs.values()].slice(-10),
      diagnostics: this.recording ? [...this.diagnostics.values()].filter(result => { const buffer = this.buffers.get(result.path); return buffer && !buffer.deleted && !buffer.blocked && buffer.modelId === result.modelId && buffer.version === result.version; }) : [],
      writer: { id: this.owner, until: (this.ownerAt ?? 0) + 30000 }
    };
  }

  replay(file, through = Infinity) {
    let text = null, modelId, version;
    const checkpoints = [];
    for (const event of this.events) {
      if (event.seq > through || event.payload.path !== file) continue;
      const data = event.payload;
      if (event.type === 'document.open' || event.type === 'document.snapshot') ({ text, modelId, version } = data);
      else if (event.type === 'document.edit') {
        if (modelId !== data.modelId || version !== data.baseVersion) throw new Error('回放版本链中断');
        text = applyChanges(text, data.changes);
        version = data.version;
      } else continue;
      checkpoints.push({ seq: event.seq, version, hash: hash(text), type: event.type, originChannel: event.originChannel ?? 'legacy_unverified' });
    }
    return { path: file, text, version, hash: text === null ? null : hash(text), deleted: this.buffers.get(file)?.deleted ?? false, checkpoints, gaps: this.gaps };
  }
}
