import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import path from 'node:path';
import { realpathSync, existsSync } from 'node:fs';
import { DEFAULT_PORT, VERSION } from '../src/server.mjs';

const origin = `http://127.0.0.1:${Number(process.env.STUDENT_IDE_PORT ?? DEFAULT_PORT)}`;
const workspace = path.resolve(process.env.STUDENT_IDE_WORKSPACE ?? path.join(process.cwd(), 'lab'));
const preparationTools = [];
let checking;
function updateAccess(preparation) {
  for (const tool of preparationTools) if (tool.enabled !== preparation) tool.update({ enabled: preparation });
}
async function requireService() {
  if (checking) return checking;
  checking = (async () => {
    let response;
    try { response = await fetch(origin + '/api/health', { headers: { 'x-student-ide-client': 'mcp' }, signal: AbortSignal.timeout(1500) }); }
    catch { throw new Error('学生 IDE 服务离线；读取不会启动服务。请由学生/教师切回准备阶段后显式启动。'); }
    if (!response.ok) throw new Error('学生 IDE 健康检查失败；未启动或替换服务');
    const health = await response.json();
    if (health.name !== 'student-ide' || !existsSync(workspace) || health.workspace !== realpathSync(workspace)) throw new Error('此端口服务属于另一个项目，请设置 STUDENT_IDE_PORT');
    if (health.version !== VERSION) throw new Error('服务版本不匹配；请在准备阶段确认草稿已同步后显式重启');
    updateAccess(health.phase === 'preparation');
    return health;
  })().catch(failure => { updateAccess(false); throw failure; }).finally(() => { checking = null; });
  return checking;
}

const server = new McpServer({ name: 'student-ide', version: VERSION });
const respond = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value });
async function query(endpoint, body, timeout = 5000) {
  const health = await requireService();
  if (body !== undefined && health.phase !== 'preparation') throw new Error('学习阶段仅允许读取；请由学生暂停并切回准备阶段');
  const headers = { 'x-student-ide-client': 'mcp', ...(body === undefined ? {} : { 'content-type': 'application/json', 'x-student-ide': '1' }) };
  const response = await fetch(origin + endpoint, { headers, signal: AbortSignal.timeout(timeout), ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error);
  return respond(value);
}
const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
preparationTools.push(server.registerTool('open_student_ide', { title: '打开学生 IDE', description: '仅在准备阶段返回已有服务的 URL 与采集范围，不自动启动服务。不证明页面已经打开或学生输入已同步。', inputSchema: {}, annotations }, async () => {
  const health = await requireService();
  if (health.phase !== 'preparation') throw new Error('学习阶段不允许 agent 控制 IDE；由学生操作界面');
  return respond(health);
}));
server.registerTool('get_editor_snapshot', { title: '读取未保存代码与 IDE 状态', description: '读取最新服务已确认的编辑缓冲区、文件、选区、版本、未保存标记及运行结果。可能有客户端待发送编辑，必须引用 lastClientAt 和版本，暂停或 blocked 时不能声称看到当前输入。', inputSchema: {}, annotations }, () => query('/api/state'));
server.registerTool('get_coding_events', { title: '读取编码过程事件', description: '按事件序号分页读取原始编辑、撤销、运行和已接收的 Codex Hook 记录，返回缺口信息。', inputSchema: { after: z.number().int().min(0).default(0) }, annotations }, ({ after }) => query('/api/events?after=' + after));
server.registerTool('replay_document', { title: '回放代码版本', description: '从原始快照及增量重建指定文件在某个事件序号时的内容，附带哈希和已知缺口。', inputSchema: { path: z.string().max(240), seq: z.number().int().min(0).optional() }, annotations }, ({ path: file, seq }) => query('/api/replay?path=' + encodeURIComponent(file) + (seq === undefined ? '' : '&seq=' + seq)));
server.registerTool('get_language_capabilities', { title: '查询语言能力', description: '读取本项目已注册语言、配置版本、最后验证状态、语法模块和参考配置。未验证不等于可用；单文件验证不证明整个工程已支持。', inputSchema: {}, annotations }, () => query('/api/languages'));
preparationTools.push(server.registerTool('register_language', { title: '按需注册语言', description: '仅在准备阶段注册项目语言配置，参数使用实际可执行文件与数组；更新检查 expectedVersion。学习阶段拒绝，不授权改学生答案。', inputSchema: { profile: z.record(z.string(), z.unknown()), expectedVersion: z.number().int().min(0).optional() }, annotations: { ...annotations, readOnlyHint: false } }, body => query('/api/languages', body)));
preparationTools.push(server.registerTool('verify_language', { title: '验证语言接入', description: '仅在准备阶段探测工具链并执行独立 smoke 样例；学习阶段拒绝，不执行学生答案。失败后只在获授权的准备阶段修复。', inputSchema: { id: z.string().max(32) }, annotations: { ...annotations, readOnlyHint: false } }, body => query('/api/languages/verify', body, 180000)));
await requireService().catch(() => {});
await server.connect(new StdioServerTransport());
// ponytail: poll one local service at 1 s; a push channel is only needed for multiple projects.
const monitor = setInterval(() => { requireService().catch(() => {}); }, 1000);
monitor.unref();
server.server.onclose = () => clearInterval(monitor);
