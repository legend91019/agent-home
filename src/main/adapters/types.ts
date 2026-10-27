/**
 * 适配器契约。所有 Agent（Claude Code、Codex 及后续三种）都通过能力协商式
 * 适配器接入。接口以设计文档「核心接口约定」与开发计划 Task 3 为准，后续任务
 * 不得私自改名。
 */
import {
  AgentId,
  Capability,
  CapabilityReport,
  CapabilityReportEntry,
  CapabilityStatus,
  SessionRef,
  VisibleEvent,
} from "../../shared/contracts";
import { WorkbenchError } from "../../shared/errors";

export interface StartTaskInput {
  projectId: string;
  projectPath: string;
  agentId: AgentId;
  goal: string;
  /** 并行分支使用的独立 worktree 工作区；未提供则使用主目录 */
  workspaceId?: string;
  /** 来自交接包的历史索引路径，供目标 Agent 按需读取原文 */
  handoffId?: string;
  /** 用户审查后选定为上下文的持久记忆条目 */
  memoryEntryIds?: string[];
  /** 若适配器支持，恢复既有原生会话 */
  sessionId?: string;
}

export interface RunHandle {
  /** 工作台管理的 Run 主键 */
  runId: string;
  /** 目标工具原生会话 id（带 Agent 命名空间的外部引用，不作全局主键） */
  nativeSessionId?: string;
  /** 进程句柄信息，仅在适配器声明 tasks.interrupt 时使用 */
  pid?: number;
  startedAt: string;
}

/**
 * 适配器必须实现的契约。readVisibleSession 返回按源顺序的可迭代可见事件，
 * 不读取隐藏推理、凭据或第三方私有数据库。
 */
export interface AgentAdapter {
  readonly id: AgentId;
  readonly displayName: string;

  probe(projectPath: string): Promise<CapabilityReport>;

  listSessions(projectPath: string): Promise<SessionRef[]>;

  readVisibleSession(session: SessionRef): AsyncIterable<VisibleEvent>;

  startTask(input: StartTaskInput): Promise<RunHandle>;

  /** 可选：仅当适配器声明 tasks.interrupt 能力时存在 */
  interrupt?(handle: RunHandle): Promise<void>;
}

export abstract class BaseAdapter implements AgentAdapter {
  abstract readonly id: AgentId;
  abstract readonly displayName: string;

  abstract probe(projectPath: string): Promise<CapabilityReport>;
  abstract listSessions(projectPath: string): Promise<SessionRef[]>;
  abstract readVisibleSession(session: SessionRef): AsyncIterable<VisibleEvent>;
  abstract startTask(input: StartTaskInput): Promise<RunHandle>;

  /** 构造一条能力报告项，强制带证据与探测时间。 */
  protected entry(
    capability: Capability,
    status: CapabilityStatus,
    evidence: string,
    opts?: { reason?: string; version?: string },
  ): CapabilityReportEntry {
    return {
      capability,
      status,
      evidence,
      checkedAt: new Date().toISOString(),
      reason: opts?.reason,
      version: opts?.version,
    };
  }
}

export function notInstalled(adapterId: AgentId, name: string): CapabilityReport {
  return {
    agentId: adapterId,
    agentName: name,
    installed: false,
    authenticated: null,
    checkedAt: new Date().toISOString(),
    capabilities: [],
  };
}

/** 安全地把适配器异常映射为结构化报告，绝不抛出到 UI 层。 */
export function reportFromError(adapterId: AgentId, name: string, err: unknown): CapabilityReport {
  const msg = err instanceof Error ? err.message : String(err);
  return {
    agentId: adapterId,
    agentName: name,
    installed: true,
    authenticated: null,
    checkedAt: new Date().toISOString(),
    capabilities: [],
    // @ts-expect-error 兼容非契约字段，仅用于日志
    note: msg,
  };
}

export function toStructured(err: unknown): WorkbenchError {
  if (err instanceof WorkbenchError) return err;
  return new WorkbenchError("unknown", err instanceof Error ? err.message : String(err));
}
