/**
 * TaskRuntime：任务与运行（Run）的生命周期管理。
 * 所有状态变更落库（SQLite BOOLEAN = 0/1），因此"重启恢复"即重新读取 getRun/getTask。
 * 状态机在 setRunStatus / setTaskStatus 中强制校验，非法转换抛 WorkbenchError('invalid_data')。
 */
import * as crypto from "node:crypto";
import { SqliteDatabase } from "../db/database";
import { AdapterRegistry } from "../adapters/registry";
import { ProjectRegistry } from "../projects/registry";
import { StartTaskInput } from "../adapters/types";
import {
  AgentId,
  RunDTO,
  RunStatus,
  TaskDTO,
  TaskStatus,
} from "../../shared/contracts";
import { WorkbenchError, toWorkbenchError } from "../../shared/errors";
import { recordRunEvent, recordRunEventIdempotent } from "./events";

/** 任务状态机：键为当前态，值为允许到达的下一态。 */
const TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  draft: ["ready", "running"],
  ready: ["running"],
  running: ["review_required", "failed", "cancelled"],
  review_required: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

/** 运行状态机：线性推进，终态可于运行/等待用户输入期间进入。 */
const RUN_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  queued: ["starting"],
  starting: ["running"],
  running: ["waiting_for_user", "succeeded", "failed", "cancelled"],
  waiting_for_user: ["running", "succeeded", "failed", "cancelled"],
  succeeded: [],
  failed: [],
  cancelled: [],
};

interface RunRow {
  id: string;
  task_id: string;
  agent_id: string;
  native_session_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  workspace_id: string | null;
  controllable: number;
  handoff_id: string | null;
}

interface TaskRow {
  id: string;
  project_id: string;
  title: string;
  goal: string;
  status: string;
  created_at: string;
  updated_at: string;
}

export class TaskRuntime {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly adapters: AdapterRegistry,
  ) {}

  /* ----------------------------- 任务 ----------------------------- */

  createTask(projectId: string, title: string, goal: string): TaskDTO {
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    this.db.run(
      `INSERT INTO tasks (id, project_id, title, goal, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      projectId,
      title,
      goal,
      "draft",
      now,
      now,
    );
    return this.getTask(id)!;
  }

  getTask(taskId: string): TaskDTO | null {
    const row = this.db.getRow("SELECT * FROM tasks WHERE id = ?", taskId);
    return row ? this.buildTaskDto(row) : null;
  }

  listTasks(projectId: string): TaskDTO[] {
    const rows = this.db.getRows(
      "SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC",
      projectId,
    );
    return rows.map((row) => this.buildTaskDto(row));
  }

  setTaskStatus(taskId: string, status: TaskStatus): void {
    const row = this.db.getRow("SELECT status FROM tasks WHERE id = ?", taskId);
    if (!row) throw new WorkbenchError("invalid_data", `未知任务: ${taskId}`);
    const current = row.status as TaskStatus;
    if (current === status) {
      this.db.run(
        "UPDATE tasks SET updated_at = ? WHERE id = ?",
        new Date().toISOString(),
        taskId,
      );
      return;
    }
    if (!TASK_TRANSITIONS[current].includes(status)) {
      throw new WorkbenchError(
        "invalid_data",
        `非法任务状态转换: ${current} -> ${status}`,
      );
    }
    this.db.run(
      "UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?",
      status,
      new Date().toISOString(),
      taskId,
    );
  }

  /* ----------------------------- Run ------------------------------ */

  async startRun(
    taskId: string,
    agentId: AgentId,
    opts?: { sessionId?: string; workspaceId?: string; handoffId?: string },
  ): Promise<RunDTO> {
    const taskRow = this.db.getRow("SELECT * FROM tasks WHERE id = ?", taskId);
    if (!taskRow) throw new WorkbenchError("invalid_data", `未知任务: ${taskId}`);

    const adapter = this.adapters.get(agentId);

    const project = new ProjectRegistry(this.db).getProject(
      String(taskRow.project_id),
    );
    if (!project) {
      throw new WorkbenchError("invalid_data", `未知项目: ${taskRow.project_id}`);
    }

    // 能力协商：决定该 Run 是否可由工作台中断（适配器声明 tasks.interrupt）。
    const report = await this.adapters.getReport(agentId, project.id, project.path);
    const controllable = this.adapters.isCapability(report, "tasks.interrupt") ? 1 : 0;

    const now = new Date().toISOString();
    const runId = crypto.randomUUID();
    const workspaceId = opts?.workspaceId ?? null;
    const handoffId = opts?.handoffId ?? null;

    // 初始落库：queued -> starting -> running 的状态推进。
    this.db.transaction((tx) => {
      tx.run(
        `INSERT INTO runs
           (id, task_id, agent_id, native_session_id, status, created_at, updated_at, workspace_id, controllable, handoff_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        runId,
        taskId,
        agentId,
        null,
        "queued",
        now,
        now,
        workspaceId,
        controllable,
        handoffId,
      );
      tx.run("UPDATE runs SET status = ?, updated_at = ? WHERE id = ?", "starting", now, runId);
      tx.run("UPDATE runs SET status = ?, updated_at = ? WHERE id = ?", "running", now, runId);
    });

    const input: StartTaskInput = {
      projectId: project.id,
      projectPath: project.path,
      agentId,
      goal: String(taskRow.goal),
      workspaceId: opts?.workspaceId,
      sessionId: opts?.sessionId,
      handoffId: opts?.handoffId,
      memoryEntryIds: undefined,
    };

    try {
      const handle = await adapter.startTask(input);
      this.db.run(
        "UPDATE runs SET native_session_id = ?, updated_at = ? WHERE id = ?",
        handle.nativeSessionId ?? null,
        new Date().toISOString(),
        runId,
      );
      // 任务进入 running（draft/ready -> running 在本状态机中合法）。
      this.setTaskStatus(taskId, "running");
    } catch (err) {
      this.db.run(
        "UPDATE runs SET status = ?, updated_at = ? WHERE id = ?",
        "failed",
        new Date().toISOString(),
        runId,
      );
      throw toWorkbenchError(err);
    }

    return this.getRun(runId)!;
  }

  getRun(runId: string): RunDTO | null {
    const row = this.db.getRow("SELECT * FROM runs WHERE id = ?", runId);
    return row ? this.buildRunDto(row) : null;
  }

  setRunStatus(runId: string, status: RunStatus): void {
    const row = this.db.getRow("SELECT status FROM runs WHERE id = ?", runId);
    if (!row) throw new WorkbenchError("invalid_data", `未知 Run: ${runId}`);
    const current = row.status as RunStatus;
    if (current === status) {
      this.db.run(
        "UPDATE runs SET updated_at = ? WHERE id = ?",
        new Date().toISOString(),
        runId,
      );
      return;
    }
    if (!RUN_TRANSITIONS[current].includes(status)) {
      throw new WorkbenchError(
        "invalid_data",
        `非法运行状态转换: ${current} -> ${status}`,
      );
    }
    this.db.run(
      "UPDATE runs SET status = ?, updated_at = ? WHERE id = ?",
      status,
      new Date().toISOString(),
      runId,
    );
  }

  appendRunEvent(
    runId: string,
    type: string,
    payload: unknown,
    eventId?: string,
  ): void {
    if (eventId !== undefined) {
      recordRunEventIdempotent(this.db, runId, eventId, type, payload);
    } else {
      recordRunEvent(this.db, runId, type, payload);
    }
  }

  async interruptRun(runId: string): Promise<{ ok: boolean }> {
    const run = this.getRun(runId);
    if (!run) throw new WorkbenchError("invalid_data", `未知 Run: ${runId}`);
    if (!run.controllable) {
      throw new WorkbenchError("permission_denied", "该 Run 不可由工作台中断");
    }
    const adapter = this.adapters.get(run.agentId);
    const handle = {
      runId,
      nativeSessionId: run.nativeSessionId,
      pid: undefined,
      startedAt: run.createdAt,
    };
    if (typeof adapter.interrupt === "function") {
      try {
        await adapter.interrupt(handle);
        this.setRunStatus(runId, "cancelled");
        return { ok: true };
      } catch (err) {
        this.setRunStatus(runId, "failed");
        throw toWorkbenchError(err);
      }
    }
    // 声明可控但缺失 interrupt 实现时的兜底。
    this.setRunStatus(runId, "cancelled");
    return { ok: true };
  }

  /* --------------------------- 内部构建 --------------------------- */

  private buildRunDto(row: Record<string, unknown>): RunDTO {
    const r = row as unknown as RunRow;
    return {
      id: String(r.id),
      taskId: String(r.task_id),
      agentId: r.agent_id as AgentId,
      nativeSessionId: r.native_session_id ?? undefined,
      status: r.status as RunStatus,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
      workspaceId: r.workspace_id ?? undefined,
      handoffId: r.handoff_id ?? undefined,
      controllable: Number(r.controllable) === 1,
    };
  }

  private buildTaskDto(row: Record<string, unknown>): TaskDTO {
    const t = row as unknown as TaskRow;
    const runs = this.db
      .getRows("SELECT * FROM runs WHERE task_id = ? ORDER BY created_at ASC", t.id)
      .map((r) => this.buildRunDto(r));
    return {
      id: String(t.id),
      projectId: String(t.project_id),
      title: String(t.title),
      goal: String(t.goal),
      status: t.status as TaskStatus,
      createdAt: String(t.created_at),
      updatedAt: String(t.updated_at),
      runs,
    };
  }
}
