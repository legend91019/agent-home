/**
 * TaskRuntime：任务与运行（Run）的生命周期管理。
 * 所有状态变更落库（SQLite BOOLEAN = 0/1），因此"重启恢复"即重新读取 getRun/getTask。
 * 状态机在 setRunStatus / setTaskStatus 中强制校验，非法转换抛 WorkbenchError('invalid_data')。
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { SqliteDatabase } from "../db/database";
import { AdapterRegistry } from "../adapters/registry";
import { ProjectRegistry } from "../projects/registry";
import { RunHandle, StartTaskInput } from "../adapters/types";
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
  draft: ["ready", "running", "failed"],
  ready: ["running", "failed"],
  running: ["review_required", "failed", "cancelled"],
  review_required: ["running", "completed", "failed", "cancelled"],
  completed: [],
  failed: ["running"],
  cancelled: ["running"],
};

/** 运行状态机：线性推进，终态可于运行/等待用户输入期间进入。 */
const RUN_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  queued: ["starting"],
  starting: ["running", "failed"],
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
  private readonly liveHandles = new Map<string, RunHandle>();

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
    opts?: { sessionId?: string; workspaceId?: string; handoffId?: string; handoffPath?: string; goalOverride?: string },
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
    let executionPath = project.path;
    if (opts?.workspaceId) {
      const workspace = this.db.getRow(
        "SELECT project_id, path FROM workspaces WHERE id = ?",
        opts.workspaceId,
      );
      if (!workspace || String(workspace.project_id) !== project.id) {
        throw new WorkbenchError("invalid_data", "工作区不存在或不属于当前项目");
      }
      executionPath = String(workspace.path);
    }

    // 能力协商：决定该 Run 是否可由工作台中断（适配器声明 tasks.interrupt）。
    const report = await this.adapters.getReport(agentId, project.id, project.path, { force: true });
    const controllable =
      this.adapters.isCapability(report, "tasks.interrupt") &&
      typeof adapter.interrupt === "function" ? 1 : 0;

    const now = new Date().toISOString();
    const runId = crypto.randomUUID();
    const workspaceId = opts?.workspaceId ?? null;
    const handoffId = opts?.handoffId ?? null;

    // 先持久化 starting；只有原生任务成功启动后才能进入 running。
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
    });

    const guidanceDir = path.join(project.path, ".agent-workbench", "memory");
    const guidancePaths = [`${agentId}.md`, `${agentId}-task.md`]
      .map((name) => path.join(guidanceDir, name))
      .filter((file) => fs.existsSync(file) && fs.statSync(file).isFile());
    const goal = opts?.goalOverride ?? String(taskRow.goal);
    const taskGoal = guidancePaths.length
      ? `请先读取工作台已发布的项目记忆指导文件：\n${guidancePaths.join("\n")}\n然后执行任务：\n${goal}`
      : goal;
    const input: StartTaskInput = {
      projectId: project.id,
      projectPath: executionPath,
      agentId,
      goal: taskGoal,
      workspaceId: opts?.workspaceId,
      sessionId: opts?.sessionId,
      handoffId: opts?.handoffId,
      handoffPath: opts?.handoffPath,
      memoryEntryIds: undefined,
    };

    try {
      const handle = await adapter.startTask(input);
      this.liveHandles.set(runId, handle);
      this.db.run(
        "UPDATE runs SET native_session_id = ?, updated_at = ? WHERE id = ?",
        handle.nativeSessionId ?? null,
        new Date().toISOString(),
        runId,
      );
      // 任务进入 running（draft/ready -> running 在本状态机中合法）。
      this.setTaskStatus(taskId, "running");
      this.setRunStatus(runId, "running");
      if (adapter.waitForCompletion) {
        void this.observeCompletion(runId, taskId, adapter.waitForCompletion(handle));
      }
    } catch (err) {
      this.liveHandles.delete(runId);
      this.setRunStatus(runId, "failed");
      this.setTaskStatus(taskId, "failed");
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
    const handle = this.liveHandles.get(runId);
    if (!handle || typeof adapter.interrupt !== "function") {
      throw new WorkbenchError("permission_denied", "该 Run 已失去可控制的原生进程");
    }
    try {
      await adapter.interrupt(handle);
    } catch (err) {
      throw toWorkbenchError(err);
    }
    this.liveHandles.delete(runId);
    if (this.getRun(runId)?.status === "running") this.setRunStatus(runId, "cancelled");
    if (this.getTask(run.taskId)?.status === "running") this.setTaskStatus(run.taskId, "cancelled");
    return { ok: true };
  }

  private async observeCompletion(
    runId: string,
    taskId: string,
    completion: Promise<"succeeded" | "failed" | "cancelled">,
  ): Promise<void> {
    let status: "succeeded" | "failed" | "cancelled";
    try {
      status = await completion;
    } catch (err) {
      status = "failed";
      this.appendRunEvent(runId, "adapter_error", {
        message: err instanceof Error ? err.message : String(err),
      });
    }
    this.liveHandles.delete(runId);
    if (this.getRun(runId)?.status !== "running") return;
    this.setRunStatus(runId, status);
    const otherActive = this.db.getRow(
      "SELECT 1 FROM runs WHERE task_id = ? AND id <> ? AND status IN ('queued', 'starting', 'running', 'waiting_for_user') LIMIT 1",
      taskId,
      runId,
    );
    if (!otherActive && this.getTask(taskId)?.status === "running") {
      this.setTaskStatus(taskId, status === "succeeded" ? "review_required" : status);
    }
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
      controllable:
        Number(r.controllable) === 1 &&
        (r.status === "running" || r.status === "waiting_for_user") &&
        this.liveHandles.has(String(r.id)),
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
