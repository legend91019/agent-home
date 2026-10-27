# WorkBuddy 兼容性说明

本文区分 **Tencent WorkBuddy 桌面应用**与它捆绑或使用的 **CodeBuddy Code CLI**。两者可能共享引擎，但 CLI 的公开 HTTP API 和会话目录不能直接视作桌面应用会话接口。

## 已接入

| 能力 | 实现与边界 |
| --- | --- |
| Windows 安装探测 | 读取当前用户及整机的卸载注册表项，核对 `WorkBuddy.exe` 是否存在，显示已安装版本；不读取账户凭据 |
| 项目规则与 skill | 扫描项目 `CODEBUDDY.md`、skill 目录；用户选择后预览并发布到 `CODEBUDDY.md` / `.codebuddy/skills/<name>/`；沿用现有备份、漂移检查和回滚流程 |
| 可见项目记忆 | 将 `CODEBUDDY.md` 作为可读取的项目指令来源；不读取桌面应用的私有记忆库 |
| 会话交接 | 用户在面板指定 JSON/JSONL 文件；解析可见消息与完整工具文本后，复制到 `%LOCALAPPDATA%/AgentWorkbench/workbuddy-imports/<项目哈希>/`；按项目列出，参与现有交接包审查流程 |

项目指令与 skill 路径依据 [CodeBuddy Code 的项目配置文档](https://www.workbuddy.ai/docs/cli/large-codebases)；WorkBuddy 所属的[产品文档](https://www.workbuddy.ai/docs/enterprise)也描述 `.codebuddy/skills/` 项目路径。WorkBuddy 的[记忆文档](https://www.workbuddy.ai/docs/workbuddy/From-Beginner-to-Expert-Guide/Function-Description/Memory)描述手工从其他 AI 导入记忆，因此这里不声明桌面记忆的自动读写能力。

## 会话文件格式

导入接受消息数组、`{ "messages": [...] }` 或 `{ "turns": [...] }`，也接受每行一条消息的 JSONL。每条消息须有 `role`（`user`、`assistant` 或 `system`）和 `content`。`content` 可为字符串，或由 `text`、`tool_use`、`tool_call`、`tool_result` 内容块组成的数组。`thinking` 块会跳过；未知块报错，防止生成看似完整但实际缺失的交接历史。工具输入输出不截断。来源时间戳及消息 ID 在存在时保留。

导入依赖用户自行取得并核对文件。当前没有确认 WorkBuddy 桌面应用的原生导出 JSON 格式与上述格式相同，因此无法保证直接导入其所有导出文件。导入源文件不被修改；应用私有副本在删除原文件后仍可用于交接。

## 待验证

- WorkBuddy 桌面实时会话列表、完整历史读取、任务启动及中断。
- 桌面记忆条目和 token / skill 调用统计的公开、稳定来源。
- 不同 WorkBuddy 版本对项目 `CODEBUDDY.md` 与 `.codebuddy/skills/` 的实际加载行为。

[CodeBuddy Code HTTP API](https://www.workbuddy.ai/docs/cli/http-api) 公开了 CLI 的 runs、sessions、jobs 等端点，但它处于 Beta，且不代表 WorkBuddy 桌面应用的会话接口。后续若要用它接管 CLI 任务，应作为独立的 CodeBuddy CLI 适配能力验证权限、会话归属和运行状态。
