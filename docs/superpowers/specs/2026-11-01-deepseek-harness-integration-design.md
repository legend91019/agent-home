# DeepSeek Harness（dsh）接入设计

日期：2026-11-01  
状态：设计已口头确认，待文档审阅  
范围：Windows 本地桌面版、项目级能力、官方 `deepseek-ai/deepseek-harness`

## 目标与边界

Agent Home 将官方 `dsh` 纳入现有 Agent 选择、能力探测、项目规则与 skill 发布、任务运行、会话交接和统计入口。用户明确选择源会话并确认交接时，目标 Agent 得到 dsh 已提交的**完整可见历史**与任务进度；不传输隐藏推理、凭据或未提交的实时 token。保持“预览后发布、用户触发交接”的现有产品约束。

首版不修改 dsh 内部会话、不自动同步历史、不声称支持跨工具原生会话恢复。用户在 Agent Home 发起的 dsh 任务可由面板控制；外部 dsh 进程仅可列举或通过官方导出导入，不认领其进程控制权。

## 方案选择

1. **选用：官方 ACP + 官方会话导出。** `dsh --profile acp` 提供项目工作目录上的会话列举、新建、提交、取消与恢复；dsh Web 的完整会话导出提供可见历史和附件。ACP 不回放历史，因此两条通道分别承担控制与交接。能力按实际连接和导出状态报告。
2. **仅配置与任务。** 实现快，但不能满足用户对完整历史交接的要求。
3. **直接解析 dsh 私有持久化文件。** 可免去导出步骤，但默认日志包含 Zstandard 帧，格式有版本迁移；官方明确要求通过 persistence handle 读取。该路径不作为产品能力。

## 组件与数据流

### 1. Agent 注册与能力探测

在 `AgentId`、标签、选择器与适配器注册表加入 `deepseek-harness`，显示名为 `DeepSeek Harness`。适配器检测 Windows `dsh` 可执行文件与版本，尝试 ACP 握手及会话列举，分别报告 `sessions.list`、`tasks.start`、`tasks.interrupt` 等能力。`sessions.readVisible` 只在存在经过验证的导出读取路径时标为 `supported` 或 `degraded`；未导入时明确提示“需要从 dsh 导出会话”。认证状态只能在有官方可验证信号时设置，否则保持 `null`。不把“安装成功”等同于“可运行任务”。

### 2. ACP 控制连接

独立的 ACP 传输模块管理 `dsh --profile acp` 的 stdio、请求 ID、超时、进程退出和取消。按注册项目的绝对工作目录创建会话；用户启动任务时提交目标及已确认的交接包路径。运行句柄只记录 Agent Home 启动的会话与进程，结束后归还现有任务状态流。若 dsh 请求需要交互授权，面板必须显示等待状态并使用明确的授权处理；在处理能力完成前，探测结果应把任务运行标为降级，不能悄悄批准。

### 3. 完整可见历史

优先消费 dsh 官方 Web 会话导出的 ZIP；它含所选会话日志、子会话和附件。用户通过文件选择器明确导入，Agent Home 在应用私有目录保留原始归档的校验副本，并解析版本已知的 `user/message`、`assistant/message`、工具调用及结果，按原序映射为 `VisibleEvent`。保留来源会话 ID、序号、时间戳和附件引用；附件字节能读取时纳入现有 blob 存储，否则标记交接不完整。忽略隐藏推理、系统/开发者消息、运行时记录和失败尝试中的内部内容；不把派生的当前模型上下文误认作完整历史。未知格式或缺失事件必须明确报错，不生成声称完整的交接包。

若首版对 ZIP 的某个官方版本尚未验证，允许用户从 dsh Web 使用 `Copy Session as Markdown` 保存并导入 Markdown。此时原文作为不可截断的会话转录进入交接包，角色粒度和附件可用性按可验证程度标记；显示“文本完整、结构或附件有限”。导入与原生 ACP 会话关联后，现有会话列表、交接预览和目标 Agent 的新任务复用当前流程。运行中的未提交内容不进入导出；UI 显示采集时间。

### 4. 项目规则、skills 与 memory

dsh 默认项目指令候选是 `AGENTS.md` 和 `CLAUDE.md`，因此规则发布复用现有 `AGENTS.md` 目标，并通过已有差异预览、冲突检查、备份和回滚处理。由于 Codex 也使用这个文件，两个 Agent 的发布记录与基线需要指向同一物理目标，禁止在两次预览之间静默覆盖。dsh 专属 skill 目标为 `<project>/.dsh/skills/<skill>`；扫描时将该目录识别为原生副本，避免再次作为共享源形成循环。已位于 `.agents/skills` 的共享 skill 可被 dsh 自身发现，发布预览应标明已覆盖，避免无意义复制。memory 的项目指导目标为 `AGENTS.md`，任务上下文沿用交接包；不写入 dsh 会话内部。

### 5. 用量与 workflow

复用现有任务、workflow、并行工作区和冲突合并模型。对 ACP 运行中能确定的 token 使用记录按来源和可信度入账；无法核实的历史消耗显示“未知”，不得由字符数伪造精确 token。skill 发现与“已调用”分别统计，只有官方事件中可确认调用时才计入后者。

## 错误与安全处理

- dsh 不存在、ACP 握手失败、版本不兼容、权限等待、进程中断、导出损坏或项目不匹配时，能力与任务状态分别展示具体原因。
- 文件导入限制体积、展开后总大小、条目数与路径；拒绝 ZIP 路径穿越、符号链接和异常压缩比。临时文件失败即清理，原归档与解析记录带哈希；仅在用户确认后进入交接。
- 不读取 `~/.dsh` 私有日志或认证文件，不调用会话导出端点绕过 dsh 身份验证。
- 项目规则和 skill 只在现有发布预览确认后写入，保留回滚证据。

## 验收条件

1. 在 Windows 安装官方 dsh 后，项目面板显示版本和按实际探测得到的能力；未安装时不出现可执行按钮。
2. 用户可以在注册项目启动 dsh 新任务、查看运行状态，并中断由 Agent Home 启动的任务；交互授权有明确状态。
3. 用户导入官方 dsh 导出后能审阅完整可见历史、附件可用性和原始来源，并手动交接给另一 Agent 的新任务；反向交接到 dsh 也可读到完整已确认交接包。
4. 规则与 skills 发布可预览、识别冲突并回滚；Codex/dsh 共用 `AGENTS.md` 时不产生静默覆盖。
5. 不兼容或不完整导出会明确失败或降级；用量与 skill 调用统计不猜测。
6. 协议、导出解析、共享发布的关键边界有自动化测试；具备 dsh 的环境执行真实 ACP 与导出往返验证。当前开发机无 `dsh` 命令时，明确记录真实往返未验证。

## 官方依据

- [DeepSeek Harness CLI](https://github.com/deepseek-ai/deepseek-harness/blob/master/apps/cli/README.md)
- [ACP 能力与限制](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md)
- [会话导出契约](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/session-query/session-log-export/README.md)
- [会话事件模型](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/session)
- [持久化边界](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/persistence)
- [项目指令](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/context/agent-instructions/README.md)
- [skills 目录](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/skills)
