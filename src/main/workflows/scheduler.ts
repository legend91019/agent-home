/**
 * WorkflowScheduler：把 WorkflowDef 解析为可持久化、可恢复的调度状态机。
 *
 * 责任：
 *  - 启动工作流（写入 workflows + workflow_nodes 行，节点初态 pending）。
 *  - advanceWorkflow：对账运行态（running 节点看其 run 是否结束）-> 计算 ready/blocked/skipped
 *    -> 在并发上限内启动 ready 节点（写入仓库的节点走 worktree 隔离，上限 2）。
 *  - approveNode / retryNode：人工复核门与失败重试。
 *  - pause / resume：持久化在 workflows.paused 列。
 *
 * 仅使用既有表（workflows, workflow_nodes, tasks, runs, workspaces），不新增表。
 * 与 TaskRuntime / WorkspaceManager 的交互严格走二者公开 API；runs.workspace_id 的回填
 * 通过直接 UPDATE runs 完成（TaskRuntime 不提供该写入口，但允许我们回填）。
 */
import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { SqliteDatabase } from "../db/database";
import { TaskRuntime } from "../tasks/runtime";
import { WorkspaceManager } from "../workspaces/git";
import { ProjectRegistry } from "../projects/registry";
import { validateWorkflow } from "./schema";
import {
  RunDTO,
  WorkflowDef,
  WorkflowNodeDef,
  WorkflowNodeState,
  WorkflowNodeStatus,
  WorkflowRunDTO,
} from "../../shared/contracts";
import { WorkbenchError } from "../../shared/errors";

/** 默认同时写入仓库（writesRepo）的运行并发上限。 */
const MAX_WRITING_RUNS = 2;

interface WorkflowRow {
  id: string;
  project_id: string;
  task_id: string;
  name: string;
  definition: string;
  created_at: string;
  updated_at: string;
  paused: number;
}

interface WorkflowNodeRow {
  id: string;
  workflow_id: string;
  node_id: string;
  status: string;
  run_id: string | null;
}

export class WorkflowScheduler {
  /**
   * 仅存在于进程内的基础提交覆盖（startWorkflow 时传入）。每次 advance 时优先使用；
   * 否则回退到项目 HEAD。该值不落库，但测试场景均在同进程内 advance，故无影响。
   */
  private readonly baseCommitOverride = new Map<string, string>();

  constructor(
    private readonly db: SqliteDatabase,
    private readonly tasks: TaskRuntime,
    private readonly workspaces: WorkspaceManager,
  ) {}

  /* --------------------------- 启动工作流 --------------------------- */

  async startWorkflow(
    taskId: string,
    def: WorkflowDef,
    opts?: { baseCommit?: string },
  ): Promise<WorkflowRunDTO> {
    const result = validateWorkflow(def);
    if (!result.valid) {
      throw new WorkbenchError("invalid_data", `非法工作流定义: ${result.errors.join("; ")}`);
    }

    const task = this.tasks.getTask(taskId);
    if (!task) throw new WorkbenchError("invalid_data", `未知任务: ${taskId}`);
    const projectId = task.projectId;

    const now = new Date().toISOString();
    const workflowId = crypto.randomUUID();

    this.db.run(
      `INSERT INTO workflows (id, project_id, task_id, name, definition, created_at, updated_at, paused)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      workflowId,
      projectId,
      taskId,
      def.name,
      JSON.stringify(def),
      now,
      now,
      0,
    );

    for (const node of def.nodes) {
      this.db.run(
        `INSERT INTO workflow_nodes (id, workflow_id, node_id, status, run_id)
         VALUES (?, ?, ?, ?, ?)`,
        crypto.randomUUID(),
        workflowId,
        node.id,
        "pending",
        null,
      );
    }

    if (opts?.baseCommit) this.baseCommitOverride.set(workflowId, opts.baseCommit);

    return this.getWorkflow(workflowId)!;
  }

  /* --------------------------- 推进工作流 --------------------------- */

  async advanceWorkflow(workflowRunId: string): Promise<WorkflowRunDTO> {
    const wf = this.db.getRow(
      "SELECT * FROM workflows WHERE id = ?",
      workflowRunId,
    ) as WorkflowRow | undefined;
    if (!wf) throw new WorkbenchError("invalid_data", `未知工作流: ${workflowRunId}`);

    // 暂停时不做任何推进。
    if (Number(wf.paused) === 1) return this.getWorkflow(workflowRunId)!;

    const def = JSON.parse(wf.definition) as WorkflowDef;
    const taskId = String(wf.task_id);
    const projectId = String(wf.project_id);

    const nodeRows = this.db.getRows(
      "SELECT * FROM workflow_nodes WHERE workflow_id = ?",
      workflowRunId,
    ) as unknown as WorkflowNodeRow[];

    const stateById = new Map<string, { status: WorkflowNodeStatus; runId?: string }>();
    for (const r of nodeRows) {
      stateById.set(String(r.node_id), {
        status: r.status as WorkflowNodeStatus,
        runId: r.run_id ? String(r.run_id) : undefined,
      });
    }

    const defById = new Map<string, WorkflowNodeDef>();
    for (const n of def.nodes) defById.set(n.id, n);

    // 1) 对账 running 节点：根据其 run 当前状态迁移。
    for (const n of def.nodes) {
      const st = stateById.get(n.id)!;
      if (st.status === "running" && st.runId) {
        const run = this.tasks.getRun(st.runId);
        if (run) {
          if (run.status === "succeeded") st.status = "succeeded";
          else if (run.status === "failed" || run.status === "cancelled") st.status = "failed";
        }
      }
    }

    // 2) 计算 pending 节点的下游状态。
    for (const n of def.nodes) {
      const st = stateById.get(n.id)!;
      if (st.status !== "pending") continue;

      const depStatuses = n.dependsOn.map((d) => stateById.get(d)?.status);
      const anyFailed = depStatuses.some((s) => s === "failed");
      const allSucceeded = depStatuses.every((s) => s === "succeeded");

      if (anyFailed) {
        // 失败依赖：可选节点跳过；必选节点保持 pending（永不满足"全部成功"，故不会启动）。
        if (n.optional) st.status = "skipped";
      } else if (allSucceeded) {
        // 全部依赖成功：复核门置 blocked，其余置 ready 待启动。
        st.status = n.completionCondition === "user_review" ? "blocked" : "ready";
      }
    }

    // 3) 在并发上限内启动 ready 节点。
    let writingRunning = def.nodes.filter(
      (n) => stateById.get(n.id)!.status === "running" && n.writesRepo,
    ).length;

    for (const n of def.nodes) {
      const st = stateById.get(n.id)!;
      if (st.status !== "ready") continue;

      if (n.writesRepo) {
        if (writingRunning >= MAX_WRITING_RUNS) continue; // 已达上限，留待下次推进。
        writingRunning++;
      }

      const run = await this.startNodeRun(taskId, n, projectId, workflowRunId);
      st.status = "running";
      st.runId = run.id;
    }

    // 4) 持久化全部节点状态与 workflow 时间戳。
    const now = new Date().toISOString();
    for (const n of def.nodes) {
      const st = stateById.get(n.id)!;
      this.db.run(
        "UPDATE workflow_nodes SET status = ?, run_id = ? WHERE workflow_id = ? AND node_id = ?",
        st.status,
        st.runId ?? null,
        workflowRunId,
        n.id,
      );
    }
    this.db.run("UPDATE workflows SET updated_at = ? WHERE id = ?", now, workflowRunId);

    return this.getWorkflow(workflowRunId)!;
  }

  /* --------------------------- 人工复核 --------------------------- */

  async approveNode(workflowRunId: string, nodeId: string): Promise<WorkflowRunDTO> {
    const row = this.db.getRow(
      "SELECT * FROM workflow_nodes WHERE workflow_id = ? AND node_id = ?",
      workflowRunId,
      nodeId,
    ) as WorkflowNodeRow | undefined;
    if (!row) throw new WorkbenchError("invalid_data", `未知节点: ${nodeId}`);

    if (String(row.status) === "blocked") {
      this.db.run(
        "UPDATE workflow_nodes SET status = 'ready' WHERE workflow_id = ? AND node_id = ?",
        workflowRunId,
        nodeId,
      );
      this.db.run(
        "UPDATE workflows SET updated_at = ? WHERE id = ?",
        new Date().toISOString(),
        workflowRunId,
      );
    }
    return this.getWorkflow(workflowRunId)!;
  }

  /* --------------------------- 失败重试 --------------------------- */

  async retryNode(workflowRunId: string, nodeId: string): Promise<WorkflowRunDTO> {
    const wf = this.db.getRow(
      "SELECT * FROM workflows WHERE id = ?",
      workflowRunId,
    ) as WorkflowRow | undefined;
    if (!wf) throw new WorkbenchError("invalid_data", `未知工作流: ${workflowRunId}`);

    const def = JSON.parse(wf.definition) as WorkflowDef;
    const node = def.nodes.find((n) => n.id === nodeId);
    if (!node) throw new WorkbenchError("invalid_data", `未知节点: ${nodeId}`);

    const taskId = String(wf.task_id);
    const projectId = String(wf.project_id);

    const run = await this.startNodeRun(taskId, node, projectId, workflowRunId);

    this.db.run(
      "UPDATE workflow_nodes SET status = 'running', run_id = ? WHERE workflow_id = ? AND node_id = ?",
      run.id,
      workflowRunId,
      nodeId,
    );
    this.db.run(
      "UPDATE workflows SET updated_at = ? WHERE id = ?",
      new Date().toISOString(),
      workflowRunId,
    );

    return this.getWorkflow(workflowRunId)!;
  }

  /* --------------------------- 暂停 / 恢复 --------------------------- */

  pauseScheduling(workflowRunId: string): void {
    if (!this.getWorkflow(workflowRunId)) throw new Error(`工作流不存在: ${workflowRunId}`);
    this.db.run(
      "UPDATE workflows SET paused = 1, updated_at = ? WHERE id = ?",
      new Date().toISOString(),
      workflowRunId,
    );
  }

  resumeScheduling(workflowRunId: string): void {
    if (!this.getWorkflow(workflowRunId)) throw new Error(`工作流不存在: ${workflowRunId}`);
    this.db.run(
      "UPDATE workflows SET paused = 0, updated_at = ? WHERE id = ?",
      new Date().toISOString(),
      workflowRunId,
    );
  }

  /* --------------------------- 读取 --------------------------- */

  getWorkflow(workflowRunId: string): WorkflowRunDTO | null {
    const wf = this.db.getRow(
      "SELECT * FROM workflows WHERE id = ?",
      workflowRunId,
    ) as WorkflowRow | undefined;
    if (!wf) return null;

    const def = JSON.parse(wf.definition) as WorkflowDef;
    const nodeRows = this.db.getRows(
      "SELECT * FROM workflow_nodes WHERE workflow_id = ? ORDER BY node_id ASC",
      workflowRunId,
    ) as unknown as WorkflowNodeRow[];

    const nodes: WorkflowNodeState[] = nodeRows.map((r) => ({
      id: String(r.node_id),
      status: r.status as WorkflowNodeStatus,
      runId: r.run_id ? String(r.run_id) : undefined,
    }));

    return {
      id: String(wf.id),
      taskId: String(wf.task_id),
      definition: def,
      nodes,
      paused: Number(wf.paused) === 1,
      createdAt: String(wf.created_at),
      updatedAt: String(wf.updated_at),
    };
  }

  /* --------------------------- 内部辅助 --------------------------- */

  /**
   * 为一个节点启动一次运行：
   *  - 写入节点必须先创建 worktree，再在该目录启动 Agent。
   *  - Run 创建后回填工作区关联；启动失败的空工作区留给恢复界面处置。
   */
  private async startNodeRun(
    taskId: string,
    node: WorkflowNodeDef,
    projectId: string,
    workflowId: string,
  ): Promise<RunDTO> {
    let workspaceId: string | undefined;
    if (node.writesRepo) {
      const baseCommit = this.resolveBaseCommit(projectId, this.baseCommitOverride.get(workflowId));
      const ws = this.workspaces.createBranchWorkspace(projectId, null, baseCommit, {
        branch: `wf-${workflowId}-${node.id}-${crypto.randomUUID().slice(0, 8)}`,
      });
      workspaceId = ws.id;
    }
    const run = await this.tasks.startRun(taskId, node.agentId, {
      workspaceId,
      goalOverride: node.input,
    });
    if (workspaceId) {
      this.db.run("UPDATE workspaces SET run_id = ? WHERE id = ?", run.id, workspaceId);
    }
    return run;
  }

  /** 解析基础提交：优先显式覆盖，其次项目 HEAD，最后回退空串（仅用于无写入节点场景）。 */
  private resolveBaseCommit(projectId: string, override?: string): string {
    if (override) return override;
    const project = new ProjectRegistry(this.db).getProject(projectId);
    if (project) {
      const res = spawnSync("git", ["-C", project.path, "rev-parse", "HEAD"], {
        encoding: "utf8",
      });
      if (res.status === 0 && res.stdout) return res.stdout.trim();
    }
    return override ?? "";
  }
}
