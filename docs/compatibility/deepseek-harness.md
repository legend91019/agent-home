# DeepSeek Harness（dsh）兼容性说明

本文只针对官方 [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) 的 `dsh`。Agent Home 在 Windows 本地项目内使用官方 ACP v1 控制托管会话，使用用户主动取得的官方 Web 导出建立交接历史。

## 已实现

| 能力 | 路径和边界 |
| --- | --- |
| 安装与能力探测 | 执行 `dsh --version`，随后启动 `dsh --profile acp` 并调用 `initialize`、`session/list`；不读取 dsh 的凭据或私有会话库 |
| 项目规则 | dsh 默认读取项目 `AGENTS.md` 与 `CLAUDE.md`；共享规则经预览、冲突检查与备份发布到 `AGENTS.md`，与 Codex 共用物理文件 |
| 项目 skill | 目标为 `.dsh/skills/<name>/`；若来源本身是 dsh 同样可读的 `.agents/skills/<name>/`，不复制第二份 |
| 托管任务 | ACP `session/new` / `session/prompt`，可对本工作台启动的 Run 发送 `session/cancel`；权限请求在任务面板逐项展示并由用户点选，未知请求明确取消 |
| 会话导入 | 用户从 dsh Web 下载 ZIP 或复制 Markdown，面板选择文件并导入项目私有副本；导入后可审查、编辑交接副本和启动目标 Agent |

[ACP 官方说明](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md)说明会话可跨进程列举与恢复，但不提供历史回放。因此 `sessions.list` 可列出原生会话，`sessions.readVisible` 对原生会话要求先导入官方导出。面板会把未导入项标为“需导入”，不允许直接创建看似完整的交接包。

## 导出格式与完整性

ZIP 来自 dsh Web 的 `Download session log`。当前解析器只接受根目录 `session.v4.jsonl`、同版本子会话日志和合法的附件目录；按会话头与单调事件序号验证后，将 `user/message`、`assistant/message`、`tool/call`、`tool/result` 映射到 Agent Home 的可见事件。非完成轮次会保留状态标记。消息中的 `reasoning` 块、`assistant/attempt`、系统/开发者消息及注入的非用户上下文不转移。未知必要事件、未知内容块或其他日志版本会拒绝导入，避免静默丢失。ZIP 在解压前检查条目路径、重复名、加密、符号链接、压缩类型、数量、体积与压缩比；源归档和解析快照带 SHA-256 校验。附件保存在私有导入目录并在交接事件中记录本机路径和内容哈希。

Markdown 来自 dsh Web 的 `Copy Session as Markdown`，用户需保存为 UTF-8 `.md`。该官方操作包含所选会话的已提交可见文本，含压缩前历史；但不包含附件字节或子会话日志。Agent Home 原样保存全文为一个文本转录事件，并把来源记录条数标为未知，完整性面板提醒人工审查。普通任意 `.md` 不会被当作结构化会话。导入文件不是原生 dsh 会话，也不会被写回 dsh 内部。

导入后原文件可删除；应用私有副本保留在 `%LOCALAPPDATA%/AgentWorkbench/deepseek-imports/<项目哈希>/` 或 `AGENT_WORKBENCH_DATA_DIR` 指定的目录中。源 ZIP / Markdown 与事件快照的哈希在读取交接时再次核对。导入只有用户点击操作时发生，规则与 skill 只有用户确认发布时写入。

## 当前验证与限制

- 已通过 ACP 模拟连接与项目任务状态测试，包括会话分页、任务完成/取消、授权请求等待与用户选择。
- 已通过合成的官方 v4 日志 ZIP 与 Markdown 测试，包括隐藏推理排除、项目路径、版本和路径穿越检查。
- 当前开发机未检测到 `dsh` 命令，尚未对真实 dsh 执行 ACP 任务或官方 Web 导出往返；实际权限项、模型认证与附件格式仍需在安装环境验收。
- token 消耗和 skill 调用只有可核实事件才入账；当前 dsh 适配器不声明这两项的精确统计。ACP 对原生会话不提供回放，且工作台重启后不能继续控制此前 Run。

依据：[CLI](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.md)、[ACP](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md)、[Web 会话导出](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session-query/session-log-export/README.md)、[项目指令](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/context/agent-instructions/README.md)、[skills](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/skills)。
