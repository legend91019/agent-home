# agent-home Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 交付一个 Windows 本地桌面工作台，让个人用户在项目内管理 Claude Code 与 Codex 的共享配置、主动记忆互转、完整对话交接、顺序和并行任务、审查合并及有来源标记的统计；为另外三种 Agent 留出可验证的适配接口。

**Architecture:** Electron 主进程持有 SQLite、文件系统、Git 和 Agent 进程；React 渲染进程只通过受限 IPC 调用。核心使用 Project、Task、Run、HandoffPackage、Workflow 和 UsageRecord 统一模型，各 Agent 通过能力协商式适配器接入。

**Tech Stack:** Windows 11 x64；Node.js 24 LTS；Electron + Electron Forge + Vite；React + TypeScript strict；SQLite（better-sqlite3）；Zod；Vitest；Playwright Electron；系统 Git CLI。依赖精确版本由首个提交的 package-lock.json 固定。

## Global Constraints

- 首版深度适配 Claude Code 与 Codex；WorkBuddy、Antigravity、ZCode 按后续独立适配任务推进。
- 项目共享配置可进 Git；完整交接历史、用户选定的原生记忆快照和事件默认仅在本机应用数据目录。
- 交接由用户明确触发，保留完整可见对话历史；不主动读取隐藏推理或凭据文件，可见历史中的敏感内容由用户预览并决定删改。
- 目标 Agent 新建任务；长历史完整存档并支持按需读取，首轮上下文不伪称包含全部历史。
- 写代码的并行任务使用独立 Git worktree；用户审查后合并。
- 缺失用量是 unknown，不能记为 0；skill 被发现与实际调用分开。
- 项目默认最多两个并行写入节点；Agent 完成不自动触发合并。
- 主进程不读取或保存第三方登录凭据；只使用官方授权接口和文档化本地数据入口。
- 任何第三方版本差异导致的能力下降都必须反映到能力矩阵和 UI。
- 本计划基于设计文档 docs/superpowers/specs/2026-10-25-agent-workbench-design.md；执行前先阅读该文件。

---

## 交付顺序与里程碑

| 里程碑 | 交付物 | 退出条件 |
|---|---|---|
| A 接口验证 | Windows 能力矩阵、最小 Claude/Codex 探针、样本记录 | 读取、启动、事件、取消、用量各项有实测结果和降级路径 |
| B 项目与交接 | 项目登记、共享配置、完整交接、两个适配器、单任务运行 | Claude ↔ Codex 双向新任务交接，原文任意消息可检索 |
| C 协作与合并 | Workflow、并行 worktree、差异审查、冲突处理 | 两个写入任务并行完成后能安全审查合并 |
| D 发布 | 整机首页、统计、恢复、Windows 安装包 | 端到端验收、升级/崩溃恢复、安装与卸载检查通过 |
| E 扩展 | Antigravity、ZCode、WorkBuddy 适配器 | 每个工具只开放实测支持的能力，不影响 A-D 的核心路径 |

阶段 A 是技术门。若现有用户会话的原文无法通过官方或文档化入口读取，应先实现用户手工导出导入，并在界面标记交接不完整；不得读写私有数据库或假造能力。

## 目标文件结构

- package.json、package-lock.json、forge.config.ts、vite.main.config.ts、vite.preload.config.ts、vite.renderer.config.ts：构建与脚本。
- src/shared/contracts.ts：跨进程领域类型、能力枚举和 IPC 输入输出类型。
- src/main/index.ts、src/preload/index.ts：Electron 生命周期和受限桥接。
- src/main/db/database.ts、src/main/db/migrations.ts：SQLite 连接、迁移和事务。
- src/main/projects/registry.ts：项目登记、路径身份、权限边界。
- src/main/adapters/types.ts、registry.ts、claude.ts、codex.ts：适配器契约与首版实现。
- src/main/handoff/archive.ts、package.ts、search.ts：原始记录存档、交接包、按需读取。
- src/main/memory/inventory.ts、transfer.ts：用户可见持久记忆的读取、审查与发布。
- src/main/config/inventory.ts、publisher.ts：规则与 skills 清单、三方差异、发布回滚。
- src/main/tasks/runtime.ts、events.ts：任务执行状态和事件。
- src/main/workspaces/git.ts：worktree 创建、状态与保留。
- src/main/workflows/schema.ts、scheduler.ts：DAG 与调度。
- src/main/merge/proposals.ts：差异、冲突、审查与合并。
- src/main/usage/aggregate.ts：来源、去重和统计。
- src/main/recovery/reconcile.ts：重启后恢复。
- src/main/ipc/：按项目、配置、交接、任务、工作流、合并、用量分开的 IPC handler。
- src/renderer/pages/、src/renderer/components/：页面和通用组件。
- tests/unit/、tests/integration/、tests/e2e/、tests/fixtures/：测试与脱敏样本。
- docs/compatibility/：每个适配器的实测能力记录。

## 核心接口约定

    type Capability =
      | "sessions.list" | "sessions.readVisible"
      | "memory.readVisible" | "memory.publishAsGuidance"
      | "config.read" | "config.publish"
      | "tasks.start" | "tasks.stream" | "tasks.interrupt"
      | "usage.exact" | "skills.invocationEvidence";

    type CapabilityStatus = "supported" | "unsupported" | "unknown" | "degraded";

    interface AgentAdapter {
      id: "claude-code" | "codex" | "antigravity" | "zcode" | "workbuddy";
      probe(projectPath: string): Promise<CapabilityReport>;
      listSessions(projectPath: string): Promise<SessionRef[]>;
      readVisibleSession(session: SessionRef): AsyncIterable<VisibleEvent>;
      startTask(input: StartTaskInput): Promise<RunHandle>;
      interrupt?(handle: RunHandle): Promise<void>;
    }

每个调用返回结构化错误（not_installed、not_authenticated、permission_denied、unsupported_version、session_unavailable、process_failed、invalid_data），不得将异常文字直接作为 UI 状态。实际 TypeScript 声明以 Task 3 为准，后续任务不得私自改名。

## Task 0：建立仓库、应用骨架和质量门

**Files:** Create package.json、forge.config.ts、vite.*.config.ts、tsconfig.json、src/main/index.ts、src/preload/index.ts、src/renderer/main.tsx、src/renderer/App.tsx、tests/e2e/boot.spec.ts、README.md。

**Interfaces:** 产出 npm run dev、npm run typecheck、npm test、npm run e2e、npm run make；所有后续任务依赖该构建入口。

- [ ] Step 1：在空工作区初始化 Git 和 Electron Forge + Vite TypeScript 工程；锁定依赖到 package-lock.json，建立 .gitignore，排除构建产物、SQLite 和交接存档。
- [ ] Step 2：先写 boot.spec.ts，启动 Electron，断言主窗口标题为 agent-home，且渲染进程没有 Node require。
- [ ] Step 3：运行 npm run e2e，确认测试因应用入口未实现而失败。
- [ ] Step 4：实现最小窗口与 preload 桥接；BrowserWindow 设置 contextIsolation: true、nodeIntegration: false、sandbox: true，设置本地内容 CSP。
- [ ] Step 5：运行 npm run typecheck、npm test、npm run e2e；预期全部通过，打包后的主窗口可以打开。
- [ ] Step 6：提交 feat: bootstrap local desktop shell。

## Task 1：Windows 适配能力探针

**Files:** Create scripts/probe-claude.mts、scripts/probe-codex.mts、docs/compatibility/windows-claude-codex.md、tests/fixtures/claude-session.json、tests/fixtures/codex-thread.json。

**Interfaces:** 输出每项 CapabilityStatus、证据与最低测试版本；供 Task 4、5 的实现选择使用。

- [ ] Step 1：记录当前 Windows、Git、Claude Code、Codex 版本及登录方式，绝不输出凭据。
- [ ] Step 2：用官方 Claude Agent SDK 读取测试项目中的会话列表与消息；用官方 Codex app-server 完成 initialize、thread/list、thread/turns/list、thread/start、turn/start、turn/interrupt 的最小探针。分别验证用户可见的自动记忆读取范围及项目指导文件路径，探针只操作专用临时项目。
- [ ] Step 3：为未安装、未登录、空会话、完整会话、大附件、自动记忆样本、取消和用量事件保存脱敏样本；记录源记录条数与事件字段。
- [ ] Step 4：运行 npm run probe:adapters；预期生成结构化报告。任何失败写明实际错误、版本和降级方案，不推断支持。
- [ ] Step 5：提交 docs: record Windows adapter capabilities。Task 4、5 只能实现报告证实的功能。

## Task 2：数据库、项目身份和内容存储

**Files:** Create src/main/db/database.ts、migrations.ts、src/main/projects/registry.ts、src/main/storage/blobs.ts、tests/unit/projects.test.ts、tests/unit/blobs.test.ts。

**Interfaces:** registerProject(path): Project；getProject(id): Project；putBlob(bytes): ContentHash；getBlob(hash): bytes。Project id 由 UUID 生成，路径另存规范化形式与 Git remote/根目录证据。

- [ ] Step 1：写测试：同一目录不同大小写只登记一次；不存在目录拒绝；项目目录移动后可重新绑定；相同 blob 只存一次；哈希不匹配拒绝读取。
- [ ] Step 2：运行 npm test -- projects.test.ts blobs.test.ts；预期失败。
- [ ] Step 3：实现 SQLite WAL、版本化迁移、项目表、blob 索引与原子写入；把 Electron userData 明确设置到 %LOCALAPPDATA%/AgentWorkbench，并验证 Windows 路径解析。
- [ ] Step 4：运行上述测试及 npm run typecheck；预期通过。手工断电模拟后数据库可打开，未完成 blob 不进入索引。
- [ ] Step 5：提交 feat: add project registry and content store。

## Task 3：适配器契约和能力注册表

**Files:** Create src/shared/contracts.ts、src/main/adapters/types.ts、registry.ts、tests/unit/adapter-registry.test.ts。

**Interfaces:** probe、listSessions、readVisibleSession、startTask、interrupt 与核心接口约定一致；registry.get(id) 返回适配器；capabilityReport 包含 status、evidence、checkedAt、reason。

- [ ] Step 1：写测试：unknown 不启用控制按钮；版本变化后旧探测结果失效；异常适配器仅使该适配器 degraded；未实现可选方法报告 unsupported。
- [ ] Step 2：运行 npm test -- adapter-registry.test.ts；预期失败。
- [ ] Step 3：实现类型、Zod 校验、注册表、探测缓存失效与结构化错误映射。
- [ ] Step 4：运行单测与 typecheck；预期通过。
- [ ] Step 5：提交 feat: define capability-based adapters。

## Task 4：Claude Code 适配器

**Files:** Create src/main/adapters/claude.ts、tests/integration/claude-adapter.test.ts；Update docs/compatibility/windows-claude-codex.md。

**Interfaces:** 实现 Task 3 的 AgentAdapter；会话读取输出按原顺序的 VisibleEvent；启动任务返回 RunHandle 和原生会话 ID；能力以 Task 1 实测为准。

- [ ] Step 1：先写脱敏样本测试：用户／助手消息顺序、可见工具块、附件引用与异常会话；未登录和损坏记录返回结构化错误。
- [ ] Step 2：运行 npm test -- claude-adapter.test.ts；预期失败。
- [ ] Step 3：使用官方 SDK 的会话读取与执行接口实现已验证能力，保留源 UUID 与时间；不读取隐藏推理。
- [ ] Step 4：运行测试；再在专用临时项目启动一项只读任务，核对输出与原生 CLI 会话；记录完整性与用量字段。
- [ ] Step 5：提交 feat: integrate Claude Code sessions and runs。

## Task 5：Codex 适配器

**Files:** Create src/main/adapters/codex.ts、src/main/adapters/codex-protocol.ts、tests/integration/codex-adapter.test.ts；Update docs/compatibility/windows-claude-codex.md。

**Interfaces:** 实现 AgentAdapter；codex-protocol 负责 JSON-RPC 请求 ID、通知、超时与进程退出，不将协议细节泄漏给业务层。

- [ ] Step 1：写协议测试：乱序响应正确匹配；turn/completed 的 failed 和 interrupted 不算成功；进程退出使所有待决请求失败；历史分页不漏条。
- [ ] Step 2：运行 npm test -- codex-adapter.test.ts；预期失败。
- [ ] Step 3：按 Task 1 已证实的方法实现 app-server 握手、会话读取、任务启动、流式事件和中断；沿用用户现有授权状态，不提取令牌。
- [ ] Step 4：运行测试；在专用临时项目做一次新建和中断，核对原生 Codex 会话与记录。
- [ ] Step 5：提交 feat: integrate Codex app server。

## Task 6：完整可见历史与交接包

**Files:** Create src/main/handoff/archive.ts、package.ts、search.ts、tests/unit/handoff.test.ts、tests/fixtures/long-session.json。

**Interfaces:** archiveSession(source): ArchiveRef；createPackage(archive, edits): HandoffPackage；searchPackage(id, query): VisibleEvent[]；verifyPackage(id): IntegrityReport。

- [ ] Step 1：写测试：1000 条消息全部保留且顺序稳定；重复导入幂等；缺失附件标记 incomplete；用户删改只改变交接副本；源快照哈希不变；检索能找到首条和末条。
- [ ] Step 2：运行 npm test -- handoff.test.ts；预期失败。
- [ ] Step 3：实现版本化 manifest、内容寻址原文、附件引用、哈希校验、分页和关键词检索；生成完整性报告。
- [ ] Step 4：运行测试；人工检查一个 Claude→Codex 和 Codex→Claude 的样本包，确认无隐藏推理与凭据文件。
- [ ] Step 5：提交 feat: preserve complete visible handoff history。

## Task 7：规则与 skills 清单及安全发布

**Files:** Create src/main/config/inventory.ts、publisher.ts、tests/unit/config-publisher.test.ts、tests/fixtures/config-drift/。

**Interfaces:** scanArtifacts(projectId): Inventory；previewPublish(target): PublishDiff；publish(diffId, choice): PublishReceipt；rollback(receiptId): void。

- [ ] Step 1：写测试：新建发布、原生文件被外部修改、两边冲突、写入途中失败、回滚后字节一致；skill 目录包含资源文件时不丢失。
- [ ] Step 2：运行 npm test -- config-publisher.test.ts；预期失败。
- [ ] Step 3：实现共享配置读取、原生目录映射、三方哈希比较、临时文件写入、备份与回滚日志。发布只写当前项目或用户明确选中的全局范围。
- [ ] Step 4：运行测试；在临时仓库检查 Git diff，确认交接历史未被加入版本控制。
- [ ] Step 5：提交 feat: publish shared rules and skills safely。

## Task 7A：用户触发的持久记忆互转

**Files:** Create src/main/memory/inventory.ts、transfer.ts、tests/unit/memory-transfer.test.ts、tests/fixtures/memory-sources/；Modify src/main/adapters/claude.ts、codex.ts、src/main/config/publisher.ts。

**Interfaces:** listVisibleMemories(projectId, agentId): MemoryEntry[]；previewMemoryTransfer(entryIds, targetAgent, destination): MemoryTransferDiff；applyMemoryTransfer(diffId): PublishReceipt。destination 仅为 project_guidance 或 task_context；原生记忆写入需另有已验证能力。

- [ ] Step 1：写测试：原文和来源保留；同一条目重复导入不重复发布；项目事实不能无确认升级为全局准则；目标原生自动记忆没有写接口时不显示该选项；用户取消时目标文件不变。
- [ ] Step 2：运行 npm test -- memory-transfer.test.ts；预期失败。
- [ ] Step 3：用 Task 1 实测结果实现可读取的 Claude/Codex 记忆来源；允许用户手工导入未开放的记忆。复用 Task 7 的三方差异与回滚，把选中条目发布为目标项目指导或任务上下文，记录映射而不改写生成记忆文件。
- [ ] Step 4：运行测试；在临时项目验证 Claude→Codex 与 Codex→Claude 的手工选取、预览、发布和回滚。
- [ ] Step 5：提交 feat: transfer reviewed durable memories。

## Task 8：任务运行和用户控制

**Files:** Create src/main/tasks/runtime.ts、events.ts、tests/unit/task-runtime.test.ts、tests/integration/managed-run.test.ts。

**Interfaces:** createTask、startRun、interruptRun、appendRunEvent、getRunState；控制操作仅作用于由工作台管理且适配器声明支持的 Run。

- [ ] Step 1：写状态机测试：非法转换拒绝；重复事件不重复计数；waiting_for_user 可恢复；外部导入会话不可中断；应用退出时状态可重建。
- [ ] Step 2：运行 npm test -- task-runtime.test.ts；预期失败。
- [ ] Step 3：实现状态机、事件持久化、适配器调用、进程句柄登记和取消超时。调度暂停只阻止新节点启动，不等同于暂停运行中的模型。
- [ ] Step 4：运行测试及两个 Agent 的临时项目集成测试，确认 UI 状态与原生任务一致。
- [ ] Step 5：提交 feat: manage agent task lifecycle。

## Task 9：Git worktree 管理

**Files:** Create src/main/workspaces/git.ts、tests/integration/worktrees.test.ts。

**Interfaces:** createBranchWorkspace(projectId, runId, baseCommit): WorkspaceRef；inspectWorkspace(id): GitStatus；retainWorkspace(id): void；removeCleanWorkspace(id): void。

- [ ] Step 1：写测试：两条分支从同一提交创建；任一工作区改动不影响主目录；脏工作区不能自动删除；非 Git 项目写入并行被拒绝；路径必须在应用管理目录内。
- [ ] Step 2：运行 npm test -- worktrees.test.ts；预期失败。
- [ ] Step 3：通过 spawn 参数数组调用系统 Git，禁止字符串拼接命令；记录真实路径、仓库 common dir、基线提交及生命周期。
- [ ] Step 4：运行集成测试，检查两个 worktree 的 diff 相互独立。
- [ ] Step 5：提交 feat: isolate parallel runs in git worktrees。

## Task 10：Workflow DAG 与调度

**Files:** Create src/main/workflows/schema.ts、scheduler.ts、tests/unit/workflow-scheduler.test.ts。

**Interfaces:** validateWorkflow(definition): ValidationResult；startWorkflow(taskId): WorkflowRun；advanceWorkflow(event): WorkflowRun；pauseScheduling(id): void。

- [ ] Step 1：写测试：环被拒绝；顺序依赖等待；两个独立节点并行启动；失败节点阻断后继；可选节点跳过；审查门未通过不启动下一节点；重试生成新 Run。
- [ ] Step 2：运行 npm test -- workflow-scheduler.test.ts；预期失败。
- [ ] Step 3：实现 DAG 验证、ready 节点选择、并发上限、人工审查门和状态持久化；写入节点从 Task 9 获得 worktree。
- [ ] Step 4：运行测试；端到端执行一个 A→(B,C)→D 流程，确认 B/C 独立，D 等待审查。
- [ ] Step 5：提交 feat: schedule sequential and parallel workflows。

## Task 11：差异审查与冲突合并

**Files:** Create src/main/merge/proposals.ts、tests/integration/merge-proposals.test.ts。

**Interfaces:** createMergeProposal(workflowRunId): MergeProposal；refreshProposal(id): MergeProposal；applyProposal(id, userDecision): MergeReceipt。

- [ ] Step 1：写测试：非冲突两分支合并成功；同文件冲突不写主分支；目标 HEAD 变化使旧提案失效；拒绝合并保持所有原分支；冲突解决后可继续。
- [ ] Step 2：运行 npm test -- merge-proposals.test.ts；预期失败。
- [ ] Step 3：收集每个分支的提交、未提交差异和未跟踪文件，在临时集成 worktree 中按用户选择顺序试应用；仅在用户明确确认、目标基线再次匹配后应用到目标工作区；保留原分支和回滚证据，不自动提交或推送。
- [ ] Step 4：运行测试；人工检查合并页对应的文件差异和冲突路径。
- [ ] Step 5：提交 feat: review and merge parallel work safely。

## Task 12：用量与 skill 调用证据

**Files:** Create src/main/usage/aggregate.ts、tests/unit/usage.test.ts。

**Interfaces:** ingestUsage(record): void；getUsage(filter): UsageSummary；getSkillUsage(filter): SkillUsageSummary。每条事实保留 sourceType、quality、nativeSessionId、nativeEventId 和原始字段。

- [ ] Step 1：写测试：重复原生事件只计一次；null 不变成 0；输入／输出／缓存分列；同一 session 两个入口导入不双算；发现 skill 不产生调用计数。
- [ ] Step 2：运行 npm test -- usage.test.ts；预期失败。
- [ ] Step 3：实现标准化、原始事实保存、去重键、覆盖率和筛选；费用列首版不显示推算值。
- [ ] Step 4：运行测试；用两个适配器实测样本核对原始字段与汇总。
- [ ] Step 5：提交 feat: aggregate provenance-aware usage。

## Task 13：项目与整机 UI、交接向导

**Files:** Create src/main/ipc/ 下的分域 handler、src/renderer/pages/Home.tsx、Project.tsx、Config.tsx、Memory.tsx、Tasks.tsx、Handoff.tsx、Workflow.tsx、Merge.tsx、Usage.tsx、src/renderer/components/CapabilityBadge.tsx、tests/e2e/user-journeys.spec.ts。

**Interfaces:** preload 只公开 listProjects、getProject、listCapabilities、previewPublish、publish、createHandoff、startTask、runWorkflow、reviewMerge、getUsage 等受验证方法；不暴露任意路径读写或任意命令执行。

- [ ] Step 1：写 E2E 测试：登记项目→查看 Agent 能力→预览规则差异→选择持久记忆发布→选会话交接→新任务启动→并行任务→冲突审查→统计来源；禁用按钮有清楚原因。
- [ ] Step 2：运行 npm run e2e；预期失败。
- [ ] Step 3：实现逐页 UI 和 IPC，所有写操作展示明确的目标、差异和结果；历史页提供分页、搜索、缺失提示与敏感字段提示。
- [ ] Step 4：运行 e2e、typecheck；在 125% Windows 缩放下手动走完流程，检查键盘操作与长历史性能。
- [ ] Step 5：提交 feat: add project and machine dashboards。

## Task 14：恢复、权限与隐私检查

**Files:** Create src/main/recovery/reconcile.ts、src/main/security/redaction.ts、tests/integration/recovery.test.ts、tests/unit/redaction.test.ts。

**Interfaces:** reconcileOnStartup(): RecoveryReport；scanHandoff(packageId): Finding[]；exportDiagnostics(selection): FilePath。

- [ ] Step 1：写测试：任务中途退出后保留状态；孤儿 worktree 可被发现但不自动删除；半写入发布可回滚；疑似密钥只提示不篡改源快照；诊断包默认不含 prompt。
- [ ] Step 2：运行对应测试，确认失败。
- [ ] Step 3：实现启动恢复、事务日志巡检、路径白名单、敏感字段扫描、导出预览和最小日志。
- [ ] Step 4：运行测试；强制结束应用并重启，核对任务、交接包和待合并分支仍可打开。
- [ ] Step 5：提交 feat: recover safely and protect local data。

## Task 15：发布验证与 Windows 安装包

**Files:** Modify forge.config.ts、package.json、README.md；Create docs/release-checklist.md、tests/e2e/installed-app.spec.ts。

**Interfaces:** npm run make 生成 Windows 安装包；安装后数据目录、应用菜单和卸载行为与设计一致。

- [ ] Step 1：写安装版烟测：首次启动、项目登记、关闭重启、数据保留；卸载不误删用户项目或 Agent 原生配置。
- [ ] Step 2：运行 npm run make 和安装版烟测；修复打包中 native SQLite 模块与路径问题。
- [ ] Step 3：运行全套 npm run typecheck、npm test、npm run e2e、npm run make；逐项记录实际结果与版本。
- [ ] Step 4：按设计文档 8 条首版验收标准做人工走查，记录未满足项并修复；复测后再发布候选版。
- [ ] Step 5：提交 build: package Windows release candidate。

## Task 16：Antigravity 适配器扩展

**Files:** Create src/main/adapters/antigravity.ts、tests/integration/antigravity-adapter.test.ts、docs/compatibility/antigravity.md。

- [ ] Step 1：在 Windows 验证 CLI 的会话路径、Headless JSON 输出、项目范围与任务控制；写明版本及账号模式。
- [ ] Step 2：先写历史顺序、运行事件、用量字段和错误降级测试。
- [ ] Step 3：只实现官方文档与探针共同证实的能力；未证实的原生应用会话保持 unknown。
- [ ] Step 4：运行适配器测试与完整回归；提交 feat: add Antigravity adapter。

## Task 17：ZCode 适配器扩展

**Files:** Create src/main/adapters/zcode.ts、tests/integration/zcode-adapter.test.ts、docs/compatibility/zcode.md。

- [ ] Step 1：验证官方迁移向导对 Claude Code 历史的导入、项目记忆与 AGENTS.md 的范围、skill 目录和本地用量来源。
- [ ] Step 2：写“可导入方向”和“不可导入方向”的明确测试，避免把单向迁移表现为双向同步。
- [ ] Step 3：实现已证实的清单、规则和交接能力；无法自动新建任务时提供完整交接包复制与打开目标应用流程。
- [ ] Step 4：运行测试与回归；提交 feat: add ZCode adapter。

## Task 18：Tencent WorkBuddy 适配器扩展

**Files:** Create src/main/adapters/workbuddy.ts、tests/integration/workbuddy-adapter.test.ts、docs/compatibility/workbuddy.md。

- [ ] Step 1：验证官方产品对记忆导入、skills、项目与会话导出的实际接口和 Windows 文件范围。
- [ ] Step 2：写手动导入、缺失会话 API、能力降级和用户预览测试。
- [ ] Step 3：只实现已证实能力；若仍无程序化会话入口，提供用户选择导出内容的手动交接路径并标记完整性。
- [ ] Step 4：运行测试与回归；提交 feat: add WorkBuddy adapter。

## 计划自检与发布判定

需求覆盖：项目／整机两层在 Task 2、13；完整交接在 Task 4–6、13；持久记忆互转在 Task 7A、13；规则和 skills 在 Task 7、13；顺序／并行 workflow 在 Task 8–11；用量在 Task 12；隐私与恢复在 Task 14；Windows 发布在 Task 15；其余三 Agent 在 Task 16–18。

每个任务完成后执行其专项测试、npm run typecheck，并提交可独立审查的改动。阶段 B、C、D 结束时运行全套回归。任何适配器能力变更必须同步更新 docs/compatibility 与能力矩阵测试。发布候选版只以实际通过的命令、实测 Agent 版本和设计文档验收项为依据，不以计划中的预期结果代替验证。
