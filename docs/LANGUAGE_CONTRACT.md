# 语言与静态诊断契约

0.6.0 将语法、运行、静态诊断、LSP 与调试视为不同能力。参考模板不是语言白名单，安装运行时也不自动证明项目已经可用。

## MCP 接口

| 工具 | 参数 | 阶段与结果 |
| --- | --- | --- |
| `get_language_capabilities` | `{}` | 只读；返回配置/版本、验证、语法模块、诊断能力和参考模板 |
| `register_language` | `{profile, expectedVersion?}` | 准备阶段；校验并追加配置，更新需匹配已有版本 |
| `verify_language` | `{id}` | 准备阶段；实际探测工具链，编译/执行独立 smoke 样例，记录阶段和输出 |

对应接口为 `GET /api/languages`、`POST /api/languages`、`POST /api/languages/verify`。学习阶段拒绝注册与验证；MCP 离线时不会启动服务。安装器由 Agent 的受控工具承担，服务不内置自动下载安装。

## 配置字段

| 字段 | 契约 |
| --- | --- |
| `id`, `displayName` | 稳定标识与显示名；同一项目最多 32 个配置 |
| `extensions` | 入口扩展名，不能静默抢占另一配置的类型 |
| `editorLanguage` | Monaco 语法标识；未知或加载失败明确降级为纯文本 |
| `mode` | `file` 或 `project`；验证样例须覆盖声明的执行方式 |
| `toolchain` | `{command, args}`，实际版本探测；可执行文件与参数分开 |
| `compile` | 最多四个 `{command, args}` 步骤，失败或超时后不执行 |
| `execute` | `{command, args}` 执行步骤 |
| `captureExtensions`, `captureFiles` | 需要快照的项目内源文件类型和明确文件路径 |
| `environment` | 可选的非敏感工具链变量；仅接受能力接口公布的白名单，不传凭据 |
| `smoke` | `{entry, files, expectedStdout, input?}`，独立验证样例，不改学生文件 |
| `diagnostics` | 可选的受信任 JSON 静态诊断适配器，见下文 |

编译/执行参数支持 `{entry}`、`{artifact}`、`{workspace}`、`{runDir}`。`workspace` 是本次源码快照，`artifact` 是独立输出目录内的程序路径。使用参数数组与 `shell:false`，不能把 `python -I` 整体作为 `command`，也不能传 shell 命令拼接字符串。工具链探测和诊断参数不接受模板。

配置来自获授权的准备操作，不能根据学生注释、工具输出或不可信脚本自动拼接执行命令。具体可运行参考配置由 `get_language_capabilities.templates` 提供；示例脚本为 [connect-languages.mjs](../scripts/connect-languages.mjs)。

注册追加 `language.registered`，验证追加 `language.verified`；配置含版本和 `definitionHash`。更新后旧验证失效。`verification.status=ready` 说明当时运行 smoke 成功，不等于整个工程、所有依赖和诊断器可用；自定义诊断验证单列于 `verification.diagnostics`。

## 执行与依赖

入口来自当前已确认的缓冲区，其他采集范围内的文件来自磁盘保存版本；一次运行内冻结这些文件，编译输出留在独立目录。未保存的其他模块不会自动参与运行，系统库与外部包没有冻结。

运行记录包括 `runId`、语言/版本/定义哈希、入口和依赖哈希、快照目录，以及编译/执行各阶段的命令、参数、输出、退出码、截断和耗时。启动失败、编译失败、执行失败与超时分别报告。退出码 0 不代表答案正确或测试完整。

学习阶段运行前探测工具链签名；未验证或变化时拒绝，不自动执行验证样例。源码快照上限 200 文件 / 1 MiB，单文件读取上限 250000 字节；编译单步默认 30 秒、执行默认 10 秒、探测 5 秒，每路输出最多 64000 字符。本机进程超时终止是尽力处理，不是恶意代码隔离。

## 内置静态诊断

| 语言 | 检查范围 | 前提 / 限制 |
| --- | --- | --- |
| C / C++ | GCC/G++ `-fsyntax-only` 与结构化诊断，检查错误类型名、缺分号等 | 工具链已验证且未变化；保留 std/include/宏参数，头文件来自磁盘；不将合法自定义类型当拼写错误 |
| Python | 解释器 AST 语法解析 | 工具链已准备；不执行/导入答案，不检查未定义名称与类型 |
| JavaScript / TypeScript | 受限源文件集的语法与类型检查 | 已确认模型优先于磁盘；标准类型库与基础 Node 全局，不自动加载外部包类型和完整 `tsconfig` |
| JSON / CSS | 包内真实语言分析库 | 与执行环境无关，JSON 使用 JSON 语法 |
| HTML | 标签、属性语法与基本结构 | 允许省略闭合标签的合法场景；不是完整 HTML 合规验证 |

UI 调用 `POST /api/diagnostics`，只传 `{path, modelId, version, clientId, writerId}`；服务取已确认文本，检查路径、租约、版本、采集与环境。不接受客户端源码或自定义命令。MCP 标记请求被拒绝，Agent 没有触发诊断工具。

结果状态包括 `ready`、`needs_preparation`、`unsupported`、`unavailable`、`timeout`、`paused`、`blocked`、`busy`、`stale`。只有 `ready` 表示本次检查完成。结果关联文件、模型、版本、内容/来源集哈希、时间、语言定义和依赖策略，并追加 `diagnostics.updated`；空结果不证明代码正确，过期结果不覆盖新版本。

## 自定义诊断适配器

准备阶段可注册：

```json
{
  "diagnostics": {
    "format": "json",
    "command": "/absolute/path/to/trusted-adapter",
    "args": []
  }
}
```

路径仅为占位示例，须替换为平台上真实、可信的可执行文件。参数不支持模板；标准输入为 `{path, text, sources}`，标准输出为诊断数组或 `{diagnostics: [...]}`。输出示例：

```json
{
  "diagnostics": [
    {
      "message": "示例静态诊断",
      "severity": "error",
      "path": "main.example",
      "startLineNumber": 1,
      "startColumn": 1,
      "endLineNumber": 1,
      "endColumn": 2
    }
  ]
}
```

坐标是一基 UTF-16 范围，必须属于输入文件；`message` 必填，`path`、`code`、`severity` 可选，严重度为 `error/warning/info`。适配器只分析输入，不执行学生答案；先独立验证协议和范围，再宣称可用。不要通过安装器成功或拥有某种语法高亮推断该语言的诊断能力。

适配器/原生任务超时 3 秒；内置 Worker 任务超时 5 秒、旧生代上限 256 MiB、空闲 60 秒释放。最多 100 条诊断、200 文件 / 1 MiB，单项目最多一个任务。全功能 LSP、补全、调试和外部工程配置尚未接入。
