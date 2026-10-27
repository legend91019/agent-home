# Agent Workbench

Windows 本地桌面工作台，以项目为单位管理多个编码 Agent 的可见会话、记忆、规则、skills 和任务。首版重点接入 Claude Code 与 Codex；Antigravity、ZCode、WorkBuddy 通过能力探测展示已验证能力，未验证的操作不会伪装为可用。

## 快速开始

需要 Windows、Node.js 22 及以上、Git。Claude Code 和 Codex 需要分别安装其 CLI 并用各自官方方式登录。工作台不接收 API key，也不读取登录令牌。

```powershell
npm ci
npm run dev
```

首次打开后，在「项目」页登记本地目录并选中项目。项目内可以创建任务；「对话交接」从可读取的源会话创建不可变快照，审查完整性和敏感提示，编辑或删除交接副本，再主动启动目标 Agent。交接文件保存在本机数据目录，不自动同步到其他 Agent。写仓库的并行节点使用独立 Git worktree，合并前需在界面审查提案。

## 构建与验证

```powershell
npm run typecheck
npm run typecheck:electron
npm test
npm run e2e
npm run make
npm run smoke:package
```

`npm run make` 生成 Windows Squirrel 安装程序与 zip，输出在 `out/make/`。`smoke:package` 启动 `out/Agent Workbench-win32-x64/agent-workbench.exe`，在临时数据目录验证窗口、preload、IPC 与 SQLite。前端 E2E 使用模拟 IPC，不会调用付费模型。若 Electron 官方二进制下载连接失败，可在当前 PowerShell 会话设置 `ELECTRON_MIRROR` 后重试安装与构建；下载仍由 Electron 安装脚本按其清单校验。

## 数据与操作边界

- 默认数据目录：`%LOCALAPPDATA%/AgentWorkbench`；可用 `AGENT_WORKBENCH_DATA_DIR` 指向其他目录。SQLite、交接历史文件、应用管理的工作区及运行状态保存在本机。
- 项目中的 `.agent-workbench/` 保存用户审查后发布的记忆指导、配置备份等文件。运行中的 Agent 会得到这些指导文件路径；外部自行启动的 Agent 不保证自动读取它们。
- 交接保留适配器可取得的完整可见历史；隐藏推理不收集。不可取得的附件、未知源消息条数、协议格式变化会显示为不完整或能力降级。
- 操作仅以当前用户权限执行。发布配置、交接、任务启动、中断及合并均由用户主动触发。能力报告区分 `supported`、`degraded`、`unknown` 和 `unsupported`。
- 用量显示有来源的记录；缺少可信数据时显示“未知”，不会把估算值冒充精确 token。

当前适配器验证记录见 [Claude Code 兼容性](docs/compatibility/claude-deep-adapter.md) 与 [Codex app-server 兼容性](docs/compatibility/codex-app-server-2026-10-27.md)。配置发布的目标和恢复规则见 [配置兼容性](docs/compatibility/config-publishing.md)。设计目标与实施边界见 [设计文档](docs/superpowers/specs/2026-10-25-agent-workbench-design.md)。

## 已知限制

Claude Code 的本地 JSONL 和 Codex app-server 已通过只读或伪服务验证，尚未在本项目执行真实付费任务；相关启动、中断能力以界面能力报告为准。其他三个 Agent 的自动会话与任务控制仍需逐个验证。完整的原生权限交互、精确 token 摄入、无法读取的二进制附件及冲突的交互式三方合并尚未接入；有冲突的提案不会直接应用。无冲突合并也要求目标和参与分支工作区干净，分支改动须先提交，应用结果暂存到目标仓库但不自动提交。配置多文件发布被强制退出时目前保留备份与恢复清单，尚无自动恢复。
