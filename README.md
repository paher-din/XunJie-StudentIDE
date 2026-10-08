# XunJie-StudentIDE

面向教学 Agent 的轻量 Codex 插件：在右侧内置浏览器中打开 Monaco IDE，由学生编码，Agent 读取已确认的代码、静态诊断、运行结果和过程轨迹。

当前版本 **0.6.0**，定位为功能验证工具包。项目独立于整体教学平台；本仓库只包含插件源码、独立文档和新建的演示文件，不包含学生答案、采集日志或原项目的研究证据。插件、MCP、Skill 和服务协议保留 `student-ide` 标识，展示名称为 XunJie-StudentIDE。

## 已有功能与边界

| 能力 | 当前范围 |
| --- | --- |
| 编辑器 | Monaco、语法高亮、选区、撤销/重做、保存；文件菜单支持新建空文件与确认后回收文件 |
| 编辑时诊断 | 波浪线、悬浮说明、问题列表和定位；检查服务已确认的未保存版本 |
| 语言接入 | 项目级语言配置、独立验证、编译/执行步骤；Python、JavaScript、C、C++ 是参考模板，可注册其他语言 |
| 过程日志 | 文本快照与增量、版本/哈希、选区/焦点、粘贴/组合输入、保存、文件操作、诊断、运行和实际收到的 Codex Hooks |
| Agent 观察 | 四个读取工具查询当前状态、分页事件、历史回放与语言能力；读取不自动启动服务 |
| 阶段限制 | 学生阶段只读；准备阶段增加返回已有 IDE 地址、注册语言和验证语言三个工具 |

C/C++ 诊断使用已验证的 GCC/G++ 静态检查，Python 只检查 AST 语法；JavaScript/TypeScript、JSON、CSS 和 HTML 复用 Monaco 包内的分析库。HTML 为基本结构检查，JS/TS 不自动加载外部包类型和完整 `tsconfig`。诊断完成且没有消息，不证明答案正确。

这里没有完整 VS Code、LSP、调试器或交互终端。插件内的阶段限制已实现；宿主的 shell、文件和浏览器权限仍未强制隔离。通道归因不证明操作者身份，本地执行不是沙箱，过程日志不能证明完整学习过程。

## 从源码启动

需要 **Node.js 22+**。只安装项目实际需要的解释器或编译器；不需要为了打开编辑器安装所有语言。以下命令在仓库根目录执行：

```sh
git clone https://github.com/paher-din/XunJie-StudentIDE.git
cd XunJie-StudentIDE
npm ci
npm run build
npm start -- --phase preparation
```

默认打开地址为 [本地 IDE](http://127.0.0.1:43127/)，默认项目为仓库中的 `lab/`。它是独立演示项目，可用于准备与试用。首次显式准备可使用上述阶段参数；如果已有阶段记录，重启会恢复它，`--phase preparation` 不会覆盖学生阶段。已有项目须由学生在“过程”面板选择“暂停学习并准备”。

服务启动不会自动验证全部工具链。准备阶段可使用 MCP 的 `get_language_capabilities → register_language → verify_language`，也可用现有示例脚本接入需要的参考语言：

```sh
node scripts/connect-languages.mjs python javascript cpp c
```

只传入实际需要且已安装的语言。脚本连接已有服务，不下载运行时；缺少环境时由具备受控 shell/下载能力的 Agent 按[使用与恢复指南](skills/student-ide/references/agent-guide.md)补齐、注册和验证。准备完成后，由学生在“过程”面板点击“开始学习”。

## 接入 Codex

先构建一个不带开发依赖的本地插件目录：

```sh
npm run package
```

命令返回新的 `marketplaceRoot` 和 `pluginRoot`；每次使用新目录，保留以前的包。将返回的 **marketplaceRoot** 注册为本地来源，再安装插件：

```sh
codex plugin marketplace add <marketplaceRoot>
codex plugin add student-ide@xunjie-studentide
```

在桌面端插件目录审阅并信任 Hooks，按宿主提示重新连接或在新聊天使用 `$student-ide`。准备阶段 Agent 可取得已有服务的 URL，通过 `open_in_codex` 的 browser 目标放在右侧；学生操作阶段由学生控制界面。不同宿主版本的本地插件入口可能不同，参见 [OpenAI 官方插件打包说明](https://developers.openai.com/plugins/build/plugins)。本仓库采用兼容的 `.codex-plugin/plugin.json`。

同一项目只启用一份 `student-ide` 安装。已有个人来源的旧插件时，在准备阶段核对安装根目录并选择保留启用的版本，避免两套 MCP/Hooks 重复接入；独立仓库不会自动替换旧缓存。

GitHub 仓库存放开发源码，**不是直接可运行的已构建安装包**。先克隆、构建、打包，再从返回的本地来源安装；不要将含 `node_modules` 的开发目录直接作为安装源。安装包需要宿主可用的 Node.js 22+，不需要运行 `npm install`。它不自动启动 IDE 服务。

## 绑定实际项目

服务、MCP 和 Hooks 必须指向同一项目与端口。服务支持 `--workspace`、`--port`、`--python`、`--phase`；MCP 子进程支持 `STUDENT_IDE_WORKSPACE`、`STUDENT_IDE_PORT`。默认 MCP 项目为 `<Codex 工作目录>/lab`，不会自动匹配任意已启动服务。

服务启动示例：

```sh
node src/server.mjs --workspace <projectRoot> --port 43127 --phase preparation
```

为 Codex 的 MCP 子进程显式提供对应环境，或在正确工作目录使用默认 `lab/`。修改终端环境不会更新已经运行的服务或 MCP。端口被另一项目占用时选择其他本机端口，不结束别人的进程。具体准备与故障恢复见 [Agent 指南](skills/student-ide/references/agent-guide.md)。

## 查看编码日志

- IDE 底部“过程”：最近 60 条事件；“回放”：查看当前文件历史内容。
- “过程 → 导出记录”：导出当前日志与覆盖/缺口信息，仅在授权位置保存。
- Agent：`get_editor_snapshot`、`get_coding_events`、`replay_document`、`get_language_capabilities`。
- 本地：`<projectRoot>/.student-ide/events.jsonl`，每个非空行是一批带校验和的事件，不能当成一行一个事件。

Agent 能读取已收到并落盘确认的具体修改，包括尚未保存的代码；浏览器尚未补传、采集暂停或敏感内容阻断期间的信息不完整。查看完整轨迹需要分页或导出，不能以过程面板的显示条数代替全日志。

## 文档与开发

| 文档 | 用途 |
| --- | --- |
| [ARCHITECTURE](docs/ARCHITECTURE.md) | 编辑器、服务、MCP、Hooks 与阶段边界 |
| [LANGUAGE_CONTRACT](docs/LANGUAGE_CONTRACT.md) | 语言配置、验证、静态诊断适配器协议 |
| [DATA_AND_SECURITY](docs/DATA_AND_SECURITY.md) | 日志结构、覆盖范围、隐私与归因限制 |
| [DEVELOPMENT](docs/DEVELOPMENT.md) | 源码结构、构建、测试、打包与安装排错 |
| [VERIFICATION](docs/VERIFICATION.md) | 本次独立化验证及历史验证的区别 |
| [Agent 指南](skills/student-ide/references/agent-guide.md) | 目标 Agent 的完整调用与异常恢复说明 |
| [AGENTS](AGENTS.md) | 仓库开发规范 |

```sh
npm test
```

测试自动构建，使用隔离临时项目；完整套件需要可实际执行的 `python`、`gcc`、`g++`。见[开发说明](docs/DEVELOPMENT.md)。第三方许可保留在 [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.txt)；本仓库尚未为自身代码选择公开发行许可。
