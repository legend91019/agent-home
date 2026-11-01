/**
 * 跨进程领域类型、能力枚举与 IPC 输入输出契约。
 * 本文件是主进程、渲染进程、适配器与测试的共同依赖（单一事实来源）。
 * 所有类型都可被结构化克隆（无函数、无 class 实例），因为它们要经 IPC 传输。
 */
import type { StructuredErrorCode } from "./errors";

/* ------------------------------------------------------------------ */
/* 适配器与能力协商                                                    */
/* ------------------------------------------------------------------ */

export type AgentId = "claude-code" | "codex" | "antigravity" | "zcode" | "workbuddy" | "deepseek-harness";

export const AGENT_LABELS: Record<AgentId, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  antigravity: "Antigravity",
  zcode: "ZCode",
  workbuddy: "Tencent WorkBuddy",
  "deepseek-harness": "DeepSeek Harness",
};

export type Capability =
  | "sessions.list"
  | "sessions.readVisible"
  | "memory.readVisible"
  | "memory.publishAsGuidance"
  | "config.read"
  | "config.publish"
  | "tasks.start"
  | "tasks.stream"
  | "tasks.interrupt"
  | "usage.exact"
  | "skills.invocationEvidence";

export type CapabilityStatus = "supported" | "unsupported" | "unknown" | "degraded";

export interface CapabilityReportEntry {
  capability: Capability;
  status: CapabilityStatus;
  /** 证据来源，例如 "claude-agent-sdk@x.y.z" 或 "manual-import" */
  evidence: string;
  /** ISO 时间戳，最近一次探测时间 */
  checkedAt: string;
  /** 降级/不支持/未知的原因；supported 时为 undefined */
  reason?: string;
  /** 探测到的适配器或 Agent 版本 */
  version?: string;
}

export interface CapabilityReport {
  agentId: AgentId;
  agentName: string;
  installed: boolean;
  /** null 表示无法判定（例如未探测） */
  authenticated: boolean | null;
  version?: string;
  capabilities: CapabilityReportEntry[];
  checkedAt: string;
}

/* ------------------------------------------------------------------ */
/* 会话与可见事件                                                      */
/* ------------------------------------------------------------------ */

export type EventRole = "user" | "assistant" | "tool" | "system";

export interface AttachmentRef {
  name: string;
  /** null 表示未知（例如源工具未提供字节数） */
  sizeBytes: number | null;
  kind: string;
  /** 若已存入本地 blob 存储，则为内容哈希 */
  blobHash?: string;
  /** 源工具中的原始引用（路径或 id），用于回溯 */
  externalRef?: string;
  /** 是否能在本地取得；false 时交接包标记为 incomplete */
  available: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  inputSummary: string;
  outputSummary: string;
  exitCode?: number;
  status: "ok" | "error" | "unknown";
}

export interface VisibleEvent {
  /** 在会话中的稳定序号（从 0 开始，按源顺序） */
  index: number;
  role: EventRole;
  /** ISO 时间戳 */
  timestamp: string;
  /** 源工具中的原始消息 id（保留用于溯源，但不伪造） */
  nativeId?: string;
  text?: string;
  toolCalls?: ToolCall[];
  attachments?: AttachmentRef[];
  /** 被敏感信息扫描器标记的字段（仅标记，不改动源快照） */
  redacted?: boolean;
}

export interface SessionRef {
  agentId: AgentId;
  /** 源工具的原生会话 id（仅作为带 Agent 命名空间的外部引用） */
  id: string;
  title?: string;
  messageCount: number;
  startedAt?: string;
  updatedAt?: string;
  nativeProjectPath?: string;
  /** 导入历史的结构完整度；原生会话若不支持回放则为 unavailable。 */
  historyFidelity?: "structured" | "text-only" | "unavailable";
  nativeSourceSessionId?: string;
}

/* ------------------------------------------------------------------ */
/* 项目                                                                */
/* ------------------------------------------------------------------ */

export interface ProjectDTO {
  id: string;
  name: string;
  /** 规范化后的绝对路径 */
  path: string;
  gitRoot?: string;
  gitRemote?: string;
  createdAt: string;
  registeredAt: string;
}

/* ------------------------------------------------------------------ */
/* 任务与运行                                                          */
/* ------------------------------------------------------------------ */

export type TaskStatus =
  | "draft"
  | "ready"
  | "running"
  | "review_required"
  | "completed"
  | "failed"
  | "cancelled";

export type RunStatus =
  | "queued"
  | "starting"
  | "running"
  | "waiting_for_user"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface RunDTO {
  id: string;
  taskId: string;
  agentId: AgentId;
  nativeSessionId?: string;
  status: RunStatus;
  createdAt: string;
  updatedAt: string;
  workspaceId?: string;
  /** 若该 Run 源于交接包消费，则记录来源交接包 id，保证可追溯 */
  handoffId?: string;
  /** 由工作台管理且适配器声明支持时，控制按钮才可用 */
  controllable: boolean;
  permissionRequest?: {
    toolCallId: string;
    title?: string;
    inputSummary?: string;
    options: { optionId: string; name: string; kind: string }[];
  };
}

export interface TaskDTO {
  id: string;
  projectId: string;
  title: string;
  goal: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  runs: RunDTO[];
}

/* ------------------------------------------------------------------ */
/* 交接包                                                              */
/* ------------------------------------------------------------------ */

export interface IntegrityReport {
  sessionRef: SessionRef;
  /** 已读取的可见消息条数 */
  readCount: number;
  /** 源记录条数（若源提供）；未知时为 null */
  sourceCount: number | null;
  /** 缺失/截断的项目说明 */
  missing: string[];
  /** 过大附件说明 */
  largeAttachments: string[];
  /** 完整性判定 */
  complete: boolean;
  checkedAt: string;
}

export interface HandoffSummary {
  id: string;
  projectId: string;
  sourceAgentId: AgentId;
  targetAgentId: AgentId | null;
  sourceSessionId: string;
  createdAt: string;
  /** 源快照的内容哈希（不可变，删改副本不影响它） */
  sourceSnapshotHash: string;
  messageCount: number;
  integrity: IntegrityReport;
  /** 是否已为目标 Agent 创建接续任务 */
  consumed: boolean;
}

/* ------------------------------------------------------------------ */
/* 规则 / skills / 共享产物                                            */
/* ------------------------------------------------------------------ */

export type ArtifactScope = "project" | "global";

export interface SharedArtifactDTO {
  id: string;
  projectId: string;
  kind: "rule" | "skill" | "knowledge" | "workflow";
  name: string;
  scope: ArtifactScope;
  targetAgents: AgentId[];
  version: number;
  createdAt: string;
  publishedAt: string | null;
  sourcePath?: string;
}

export type DiffChoice = "keep-native" | "overwrite-with-shared" | "manual-merge";

export interface PublishDiffEntry {
  /** choices 使用此来源标识为键；目标路径可能被多个来源共享。 */
  artifactId: string;
  sourcePath: string;
  kind: SharedArtifactDTO["kind"];
  path: string;
  status: "new" | "changed" | "identical" | "conflict";
  sharedHash: string | null;
  nativeHash: string | null;
  lastPublishedHash: string | null;
  /** false 表示没有已验证目标或来源不安全，禁止应用。 */
  publishable?: boolean;
  reason?: string;
}

export interface PublishDiff {
  id: string;
  projectId: string;
  targetAgentId: AgentId;
  entries: PublishDiffEntry[];
  createdAt: string;
}

export interface PublishReceipt {
  id: string;
  diffId: string;
  /** 配置发布以 artifactId 为键，只包含实际应用的条目。 */
  appliedChoices: Record<string, DiffChoice>;
  backupPath?: string;
  appliedAt: string;
}

/* ------------------------------------------------------------------ */
/* 持久记忆互转                                                        */
/* ------------------------------------------------------------------ */

export interface MemoryEntryDTO {
  id: string;
  agentId: AgentId;
  projectId: string | null;
  source: string;
  /** 原文保留，不重写第三方自动记忆文件 */
  originalText: string;
  scope: ArtifactScope;
  importedAt: string;
  published: boolean;
}

export type MemoryDestination = "project_guidance" | "task_context";

export interface MemoryTransferDiff {
  id: string;
  entryIds: string[];
  targetAgentId: AgentId;
  destination: MemoryDestination;
  /** 目标是否提供原生记忆写入接口；false 时不显示写入原生记忆选项 */
  nativeWriteSupported: boolean;
  previewText: string;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* Workflow                                                            */
/* ------------------------------------------------------------------ */

export type WorkflowNodeKind = "step" | "parallel" | "review-gate";

export interface WorkflowNodeDef {
  id: string;
  agentId: AgentId;
  input: string;
  dependsOn: string[];
  /** 写入同一仓库的并行节点强制隔离 */
  writesRepo: boolean;
  optional: boolean;
  completionCondition: "agent_reports" | "exit_code_0" | "user_review";
}

export interface WorkflowDef {
  id: string;
  name: string;
  nodes: WorkflowNodeDef[];
}

export type WorkflowNodeStatus =
  | "pending"
  | "ready"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped"
  | "blocked";

export interface WorkflowNodeState {
  id: string;
  status: WorkflowNodeStatus;
  runId?: string;
}

export interface WorkflowRunDTO {
  id: string;
  taskId: string;
  definition: WorkflowDef;
  nodes: WorkflowNodeState[];
  paused: boolean;
  createdAt: string;
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* 合并                                                                */
/* ------------------------------------------------------------------ */

export interface MergeProposalDTO {
  id: string;
  workflowRunId: string;
  targetBranch: string;
  baselineCommit: string;
  branches: MergeBranchDTO[];
  conflicts: string[];
  /** 目标 HEAD 是否仍匹配基线；不匹配则提案失效 */
  baselineValid: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MergeBranchDTO {
  runId: string;
  agentId: AgentId;
  branch: string;
  baseCommit: string;
  /** 创建提案时分支的 HEAD；旧提案缺失时不允许自动应用。 */
  headCommit?: string;
  committedChanges: number;
  uncommittedChanges: number;
  untrackedFiles: number;
  testCommand?: string;
  testResult?: "passed" | "failed" | "not_run";
}

export type MergeDecision = "apply" | "reject" | "resolve-then-apply";

/* ------------------------------------------------------------------ */
/* 用量统计                                                            */
/* ------------------------------------------------------------------ */

export type SourceType = "managed_event" | "documented_local_record" | "manual_import";
export type Quality = "exact" | "verified_import" | "unknown";

export interface UsageFilter {
  projectId?: string;
  agentId?: AgentId;
  model?: string;
  taskId?: string;
  runId?: string;
  from?: string;
  to?: string;
}

export interface UsageSummary {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheTokens: number | null;
  reasoningTokens: number | null;
  events: number;
  /** 未知字段占比（0..1）；用于表示数据覆盖率 */
  unknownCoverage: number;
  byAgent: Record<string, { input: number | null; output: number | null; events: number }>;
}

export interface SkillUsageSummary {
  /** 发现的 skill（目录中存在 SKILL.md） */
  discovered: string[];
  /** 有运行/日志证据实际调用的 skill */
  invoked: string[];
}

/* ------------------------------------------------------------------ */
/* 恢复与诊断                                                          */
/* ------------------------------------------------------------------ */

export interface RecoveryReport {
  recoveredTasks: number;
  orphanWorktrees: string[];
  halfWrittenPublications: string[];
  notes: string[];
  checkedAt: string;
}

export interface RedactionFinding {
  packageId: string;
  eventIndex: number;
  field: string;
  kind: "secret" | "personal" | "large-file";
  snippet: string;
}

/* ------------------------------------------------------------------ */
/* IPC 契约                                                            */
/* ------------------------------------------------------------------ */

export interface IpcError {
  code: StructuredErrorCode;
  message: string;
}

/**
 * 每个通道：输入类型 -> 输出类型。preload 只暴露白名单中的受验证方法，
 * 不暴露任意路径读写或任意命令执行。
 */
export interface IpcContract {
  "projects.list": { input: void; output: ProjectDTO[] };
  "projects.register": { input: { path: string }; output: ProjectDTO };
  "projects.get": { input: { id: string }; output: ProjectDTO | null };
  "projects.capabilities": { input: { projectId: string }; output: CapabilityReport[] };
  "sessions.list": { input: { projectId: string; agentId: AgentId }; output: SessionRef[] };
  "workbuddy.importSession": { input: { projectId: string; filePath: string }; output: SessionRef };
  "deepseek.pickExport": { input: void; output: string | null };
  "deepseek.importSession": { input: { projectId: string; filePath: string }; output: SessionRef };
  "config.scan": { input: { projectId: string }; output: SharedArtifactDTO[] };
  "config.previewPublish": {
    input: { projectId: string; targetAgentId: AgentId };
    output: PublishDiff;
  };
  "config.publish": {
    input: { diffId: string; choices: Record<string, DiffChoice> };
    output: PublishReceipt;
  };
  "config.rollback": { input: { receiptId: string }; output: { ok: boolean } };
  "memory.list": { input: { projectId: string; agentId: AgentId }; output: MemoryEntryDTO[] };
  "memory.previewTransfer": {
    input: { entryIds: string[]; targetAgentId: AgentId; destination: MemoryDestination };
    output: MemoryTransferDiff;
  };
  "memory.applyTransfer": { input: { diffId: string }; output: PublishReceipt };
  "handoff.create": {
    input: { projectId: string; session: SessionRef; edits?: HandoffEdit[] };
    output: HandoffSummary;
  };
  "handoff.search": {
    input: { handoffId: string; query: string; role?: EventRole };
    output: VisibleEvent[];
  };
  "handoff.integrity": { input: { handoffId: string }; output: IntegrityReport };
  "handoff.summary": { input: { handoffId: string }; output: HandoffSummary };
  "handoff.findings": { input: { handoffId: string }; output: RedactionFinding[] };
  "handoff.edit": {
    input: { handoffId: string; edits: HandoffEdit[] };
    output: HandoffSummary;
  };
  "handoff.consume": {
    input: { handoffId: string; targetAgentId: AgentId; goal: string };
    output: RunDTO;
  };
  "tasks.list": { input: { projectId: string }; output: TaskDTO[] };
  "tasks.create": {
    input: { projectId: string; title: string; goal: string };
    output: TaskDTO;
  };
  "tasks.startRun": {
    input: { taskId: string; agentId: AgentId; sessionId?: string };
    output: RunDTO;
  };
  "tasks.interrupt": { input: { runId: string }; output: { ok: boolean } };
  "tasks.permission": { input: { runId: string; toolCallId: string; optionId: string | null }; output: { ok: boolean } };
  "tasks.state": { input: { runId: string }; output: RunDTO };
  "workflow.start": { input: { taskId: string; definition: WorkflowDef }; output: WorkflowRunDTO };
  "workflow.get": { input: { workflowRunId: string }; output: WorkflowRunDTO | null };
  "workflow.advance": { input: { workflowRunId: string }; output: WorkflowRunDTO };
  "workflow.pause": { input: { workflowRunId: string }; output: { ok: boolean } };
  "workflow.resume": { input: { workflowRunId: string }; output: WorkflowRunDTO };
  "workflow.approve": { input: { workflowRunId: string; nodeId: string }; output: WorkflowRunDTO };
  "workflow.retry": { input: { workflowRunId: string; nodeId: string }; output: WorkflowRunDTO };
  "merge.create": { input: { workflowRunId: string }; output: MergeProposalDTO };
  "merge.refresh": { input: { proposalId: string }; output: MergeProposalDTO };
  "merge.apply": {
    input: { proposalId: string; decision: MergeDecision };
    output: { ok: boolean; message: string };
  };
  "usage.summary": { input: { filter: UsageFilter }; output: UsageSummary };
  "usage.skills": { input: { projectId: string }; output: SkillUsageSummary };
  "recovery.reconcile": { input: void; output: RecoveryReport };
}

/** 运行时通道清单：主进程据此注册 handler，preload 据此暴露方法，二者同源。 */
export const IPC_CHANNELS = [
  "projects.list",
  "projects.register",
  "projects.get",
  "projects.capabilities",
  "sessions.list",
  "workbuddy.importSession",
  "deepseek.pickExport",
  "deepseek.importSession",
  "config.scan",
  "config.previewPublish",
  "config.publish",
  "config.rollback",
  "memory.list",
  "memory.previewTransfer",
  "memory.applyTransfer",
  "handoff.create",
  "handoff.search",
  "handoff.integrity",
  "handoff.summary",
  "handoff.findings",
  "handoff.edit",
  "handoff.consume",
  "tasks.list",
  "tasks.create",
  "tasks.startRun",
  "tasks.interrupt",
  "tasks.permission",
  "tasks.state",
  "workflow.start",
  "workflow.get",
  "workflow.advance",
  "workflow.pause",
  "workflow.resume",
  "workflow.approve",
  "workflow.retry",
  "merge.create",
  "merge.refresh",
  "merge.apply",
  "usage.summary",
  "usage.skills",
  "recovery.reconcile",
] as const;

export type IpcChannel = (typeof IPC_CHANNELS)[number];

/** 交接时用户对副本的删改（源快照不变）。 */
export interface HandoffEdit {
  eventIndex: number;
  /** 替换为该文本；null 表示删除该事件 */
  text: string | null;
  /** 删除指定附件引用 */
  removeAttachments?: string[];
}
