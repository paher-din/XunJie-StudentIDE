# 开发、测试与本地分发

本仓库是 XunJie-StudentIDE 0.6.0 的独立开发源。保留原有运行架构和机器接口；独立化只调整展示名称、仓库文档、分发入口与一个过时的自检调用。

## 目录

```text
.codex-plugin/               插件兼容 manifest
.mcp.json                   stdio MCP 配置
hooks/                      实际宿主 Hooks 配置
skills/student-ide/         目标 Agent 的操作/恢复契约
src/                        本机服务、日志、运行器、语言与诊断组件
web/                        Monaco 前端源码
public/                     页面和样式；build/ 是生成文件
scripts/                    构建、打包、Hook 与 MCP 示例
test/                       隔离项目的集成验证
lab/                        新建演示项目，不是实际学生答案
docs/                       独立架构、契约、数据和验收文档
runtime/                    生成的 MCP/诊断包，不提交
dist/                       新建本地分发目录，不提交
```

## 构建

```sh
npm ci
npm run build
```

需要 Node.js 22+；锁文件固定 SDK、Monaco、Zod 与 esbuild。构建生成前端 ESM、按需语法模块、独立 MCP 和诊断 Worker/chunks，并更新第三方许可。构建清单为 `public/build/manifest.json`、`runtime/diagnostics-manifest.json`，旧输出不会自动删除。

若锁定版本已经完整缓存，可使用 `npm ci --offline --no-audit --no-fund`。代理/证书失败时先查实际问题，不能修改全局代理、禁用 TLS 或把网络失败说成安装完成。接入 Agent 的恢复路径见[完整指南](../skills/student-ide/references/agent-guide.md)。

## 验证

```sh
npm test
```

`pretest` 自动构建，五个测试文件顺序运行。完整套件需要真实可用且可由命令查找到的 `python`、`gcc`、`g++`；环境缺失导致失败时说明阻断，不能跳过检查并称全部通过。准备阶段按课程版本复用/安装所需工具链；不要为验证安装不相关语言或修改学生项目。

| 测试文件 | 验证范围 |
| --- | --- |
| `integration.test.mjs` | 路径/同源、确认/去重、UTF-16 回放、Python、暂停、敏感内容、外部冲突、文件回收、Hooks、重启/损坏日志 |
| `multilanguage.test.mjs` | 配置/版本冲突、C/C++ 编译、多文件工程、未保存入口、自定义扩展名、重启恢复 |
| `phases.test.mjs` | 离线读取不启动服务、动态工具列表、学生阶段拒绝配置/写入、持久化阶段 |
| `diagnostics.test.mjs` | 八种语言真实诊断、UTF-16、自定义协议、答案未执行、旧结果与隐私、只读边界、Worker 释放 |
| `package.test.mjs` | 当前清单排除旧文件、重复打包保留历史、仓库外安装目录独立运行、MCP 阶段与诊断 Worker |

`node scripts/smoke-mcp.mjs` 只检查**已有服务**的工具列表与已确认快照；它适用于学生与准备阶段，不调用准备专属工具或自动启动服务。MCP 子进程的项目/端口须与服务一致。

## 生成轻量安装目录

```sh
npm run package
```

`prepackage` 先构建。`scripts/package.mjs` 创建新的 `dist/xunjie-studentide-0.6.0-<id>/`，包含 `student-ide/` 插件和 `.agents/plugins/marketplace.json` 本地来源。命令返回两者的绝对路径与构建产物字节数；重复打包创建新目录，不删除或覆盖历史包。

打包仅选择固定服务/Skill/Hook 文件，以及**当前**前端/诊断清单列出的文件。保留 `THIRD_PARTY_NOTICES.txt`。不打包 `node_modules`、开发测试、演示 `lab`、学生项目、日志或过去构建残留。不要把开发目录整体复制到安装缓存。

宿主需要 Node.js 22+，解释器/编译器按项目准备；安装目录无需 npm 依赖。MCP 引用 `${PLUGIN_ROOT}/runtime/mcp.mjs`，服务入口为 `${PLUGIN_ROOT}/src/server.mjs`，Hooks 同样使用安装根目录。安装缓存和开发源可能不同，启动/排错必须核对真实目录。

本地来源使用 `xunjie-studentide`，内部插件名为 `student-ide`。注册命令和信任步骤见[README](../README.md)。本仓库未添加 CI、npm 发布或公共插件目录提交流程。源码托管与插件安装是两步，不能直接安装尚未构建的 GitHub 源码并期待它工作。

## 项目与连接排错

- `/api/health` 必须返回 `name=student-ide`、匹配版本、项目、端口、阶段和 PID；版本不匹配不能静默复用。
- 默认服务/MCP 项目均为 `<各自工作目录>/lab`；工作目录不同就显式对齐 `STUDENT_IDE_WORKSPACE`。Hooks 还会检查宿主事件的工作目录，未匹配时不记录。
- Node 不在 MCP 的 PATH 时，宿主使用已验证的 Node 绝对路径；不要将本机路径提交到源码。
- 学生阶段断开连接/缺环境时只报告，由学生/教师明确暂停并切回准备后修复。不要删除日志或换数据目录解锁。
- 400/600/800 像素宽度、波浪线/悬浮/定位、输入法、离线补传和冲突需要独立 UI 验收；HTTP 测试不代替宿主体验验证。

本仓库自身代码的开源许可证尚待维护者选择；公开 GitHub 源码与后续发布安装包分别管理。第三方许可继续保留。后续发布仍遵守[工作规范](../AGENTS.md)。
