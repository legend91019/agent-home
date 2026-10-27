# Windows 兼容性报告：Claude Code 与 Codex 适配器

> 2026-10-27 更新：下文是初始探测记录。Claude Code 已补齐本地 transcript 发现、可见历史读取和 CLI 启动，当前能力及验证边界以 [Claude 深度适配器说明](claude-deep-adapter.md) 为准。

> 本文档记录"Agent Workbench"在 **Windows** 环境下对 Claude Code 与 Codex 两类适配器的
> 能力探测结果与诚实降级说明。所有未在本环境验证的能力一律标记为 `unknown` 或 `unsupported`，
> **绝不谎报 `supported`**。无法程序化读取时以"手工导出导入"作为回退，而不是声称拥有实时访问。

## 1. 环境

| 项 | 值 |
| --- | --- |
| 操作系统 | Windows 11 (Home China) |
| Node.js | v22.22.2 |
| npm 全局 bin | 已配置（用户级 `%APPDATA%\npm`） |
| 探测时间 | 见各适配器 `probe().checkedAt`（运行时生成） |

## 2. 检测到的 CLI

| 工具 | 是否安装 | 版本 | 证据 |
| --- | --- | --- | --- |
| `claude` (Claude Code) | 是 | `2.1.153 (Claude Code)` | `claude --version` 返回（见 `ClaudeAdapter.versionHint()`） |
| `codex` (Codex) | 否 | — | `command -v codex` 未命中；`spawnSync("codex", ["--version"])` 抛 ENOENT |

> 说明：Claude Code CLI 已安装且可运行，但**仅代表 CLI 存在**。CLI 存在 ≠ 已鉴权 ≠ 会话/任务
> 可被本工作台程序化读取。因此即便 `claude` 存在，其会话读取、任务启动等能力仍标记为 `unknown`。

## 3. Claude Code 逐能力状态

| 能力 | 状态 | 证据 / 降级原因 |
| --- | --- | --- |
| `sessions.list` | `unknown` | `claude` CLI 存在；沙箱中未验证可程序化枚举会话列表 |
| `sessions.readVisible` | `unknown` | CLI 存在；实时会话读取未验证（需鉴权及私有会话存储） |
| `memory.readVisible` | `unknown` | 实时记忆读取未验证 |
| `config.read` | `supported` | `CLAUDE.md` 为可读项目文件，可通过文件系统读取 |
| `config.publish` | `supported` | `CLAUDE.md` 为可写项目文件，可通过文件系统发布 |
| `tasks.start` | `unknown` | CLI 任务启动需鉴权，沙箱未验证 |
| `tasks.interrupt` | `unsupported` | 适配器未实现 `interrupt`；且实时进程控制未验证 |
| `usage.exact` | `unknown` | 精确 token 用量需鉴权 API，未验证 |
| `skills.invocationEvidence` | `unknown` | skill 调用证据需实时会话，未验证 |

**回退路径**：`ClaudeAdapter.importSessionFromFile(path)` → `parseClaudeSession(json)` 可将用户手工导出的
JSON/JSONL 会话解析为 `VisibleEvent[]`；`readVisibleSession` 在 `session.id` 指向可读导出文件时复用该回退。
绝不读取隐藏推理（`thinking` 块被忽略）、凭据或第三方私有数据库。

## 4. Codex 逐能力状态

| 能力 | 状态 | 证据 / 降级原因 |
| --- | --- | --- |
| 全部能力 | 经 `notInstalled` 上报（`installed:false`） | `codex` CLI 在当前环境未安装，无法验证任何能力 |

**回退路径**：`CodexAdapter.importThreadFromFile(path)` → `parseCodexThread(json)` 解析手工导出的线程/轮次 JSON。
协议层 `CodexProtocol` 已实现完整的 JSON-RPC 请求/响应匹配、通知派发、超时与进程退出失败处理，待 Codex
在本环境安装并通过鉴权后可直接接入，无需重写解析逻辑。

## 5. 其余适配器（未在本环境验证）

| 适配器 | `installed` | 说明 |
| --- | --- | --- |
| `antigravity` | `false` | 无 CLI，回退 `importSessionFromFile` / `parseAntigravitySession` |
| `zcode` | `false` | 支持单向导入 Claude Code 历史（解析兼容其导出格式）；回退 `importSessionFromFile` |
| `workbuddy` | `false` | 记忆导入为手工粘贴（用户摘要），`memory.readVisible` 视为 `unknown`；提供 `parseWorkBuddyMemory` 回退 |

## 6. 总结

- 本环境**仅**确认 Claude Code CLI 存在（v2.1.153）。任何需要鉴权或私有存储的能力均诚实标记为 `unknown`/`unsupported`。
- `startTask` 在所有适配器中**均抛出结构化 `WorkbenchError`**，绝不假装任务启动成功。
- 所有"实时读取"缺失处均提供"手工导出导入"纯函数回退，保证迁移/交接流程可离线进行。
