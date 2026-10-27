/**
 * 合并提案服务：基于 workflow 的运行结果，探测各分支工作区相对基线的冲突，
 * 并把选择的分支合并进目标分支工作区（不自动提交/推送）。
 *
 * 设计要点：
 *  - 所有 git 命令均通过 child_process.spawnSync 以「参数数组」形式调用，绝不拼接 shell 字符串。
 *  - 冲突探测使用 `git merge-tree --write-tree --merge-base=<base> <b1> ... <bN>`，
 *    依据非零退出与输出中的 CONFLICT / 未合并条目行判定。
 *  - 应用合并时，先在「临时集成 worktree」中完成合并（可丢弃），得到合并后的树，
 *    再以 `git checkout -f <tree> -- .` 把结果落到目标分支工作区，绝不触碰目标分支 ref。
 *  - 仅使用已有的 merge_proposals / workflows / workflow_nodes / runs / workspaces / tasks / projects 表。
 */
import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteDatabase } from "../db/database";
import { WorkspaceManager } from "../workspaces/git";
import { ProjectRegistry } from "../projects/registry";
import { WorkbenchError } from "../../shared/errors";
import type {
  AgentId,
  MergeBranchDTO,
  MergeDecision,
  MergeProposalDTO,
} from "../../shared/contracts";

interface ProposalRow {
  id: string;
  workflow_run_id: string;
  target_branch: string;
  baseline_commit: string;
  branches: string; // JSON
  conflicts: string; // JSON
  baseline_valid: number;
  created_at: string;
  updated_at: string;
}

export class MergeService {
  private readonly registry: ProjectRegistry;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly workspaces: WorkspaceManager,
  ) {
    this.registry = new ProjectRegistry(db);
  }

  /* --------------------------- git 辅助 --------------------------- */

  /** 以参数数组调用 git；失败抛 WorkbenchError。 */
  private runGit(args: string[], cwd?: string): string {
    const res = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (res.error) {
      throw new WorkbenchError("process_failed", res.error.message);
    }
    if (res.status !== 0) {
      const msg = (res.stderr || res.stdout || "").toString().trim();
      throw new WorkbenchError("process_failed", msg || "git 命令执行失败");
    }
    return (res.stdout ?? "").toString().trim();
  }

  /** 以参数数组调用 git；失败返回 null（不抛）。 */
  private tryGit(args: string[], cwd?: string): string | null {
    const res = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (res.error || res.status !== 0) return null;
    return (res.stdout ?? "").toString().trim();
  }

  /* --------------------------- 读路径 --------------------------- */

  /** 由 workflow（或其 proposal）得到项目路径；不存在则抛错。 */
  private projectPathFor(workflowRunId: string): string {
    const wf = this.db.getRow("SELECT * FROM workflows WHERE id = ?", workflowRunId);
    if (!wf) {
      throw new WorkbenchError("invalid_data", `workflow 不存在: ${workflowRunId}`);
    }
    const projectId = String(wf.project_id);
    const project = this.registry.getProject(projectId);
    if (!project) {
      throw new WorkbenchError("invalid_data", `项目不存在: ${projectId}`);
    }
    return project.path;
  }

  /* --------------------------- DTO 转换 --------------------------- */

  private rowToDTO(row: Record<string, unknown>): MergeProposalDTO {
    return {
      id: String(row.id),
      workflowRunId: String(row.workflow_run_id),
      targetBranch: String(row.target_branch),
      baselineCommit: String(row.baseline_commit),
      branches: JSON.parse(String(row.branches)) as MergeBranchDTO[],
      conflicts: JSON.parse(String(row.conflicts)) as string[],
      baselineValid: Number(row.baseline_valid) === 1,
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
    };
  }

  /* --------------------------- 创建提案 --------------------------- */

  createMergeProposal(workflowRunId: string): MergeProposalDTO {
    const projectPath = this.projectPathFor(workflowRunId);

    // 目标分支 = 项目当前检出分支；基线 = 当前 HEAD。
    const targetBranch =
      this.tryGit(["-C", projectPath, "branch", "--show-current"]) || "HEAD";
    const baselineCommit = this.runGit(["-C", projectPath, "rev-parse", "HEAD"]);

    // 收集分支工作区（来自 workflow_node -> run -> workspace）。
    const nodeRows = this.db.getRows(
      "SELECT * FROM workflow_nodes WHERE workflow_id = ?",
      workflowRunId,
    );

    const branches: MergeBranchDTO[] = [];
    const branchRefs: string[] = [];

    for (const node of nodeRows) {
      const runId = node.run_id != null ? String(node.run_id) : null;
      if (!runId) continue;

      const runRow = this.db.getRow("SELECT * FROM runs WHERE id = ?", runId);
      if (!runRow) continue;

      const workspaceId =
        runRow.workspace_id != null ? String(runRow.workspace_id) : null;
      if (!workspaceId) continue;

      const ws = this.workspaces.getWorkspace(workspaceId);
      if (!ws) continue;

      const agentId = String(runRow.agent_id) as AgentId;

      const committedRaw = this.tryGit(
        ["-C", ws.path, "rev-list", "--count", `${ws.baseCommit}..HEAD`],
        ws.path,
      );
      const committedChanges = committedRaw != null ? Number.parseInt(committedRaw, 10) || 0 : 0;

      const porcelain = this.tryGit(["-C", ws.path, "status", "--porcelain"], ws.path) ?? "";
      const porcelainLines = porcelain.split("\n").filter((l) => l.trim().length > 0);
      const uncommittedChanges = porcelainLines.length;
      const untrackedFiles = porcelainLines.filter((l) => l.startsWith("??")).length;

      branches.push({
        runId,
        agentId,
        branch: ws.branch,
        baseCommit: ws.baseCommit,
        committedChanges,
        uncommittedChanges,
        untrackedFiles,
        testResult: "not_run",
      });
      branchRefs.push(ws.branch);
    }

    // 探测冲突。
    const conflicts = this.detectConflictsAt(projectPath, baselineCommit, branchRefs);

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO merge_proposals
        (id, workflow_run_id, target_branch, baseline_commit, branches, conflicts, baseline_valid, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      workflowRunId,
      targetBranch,
      baselineCommit,
      JSON.stringify(branches),
      JSON.stringify(conflicts),
      1,
      now,
      now,
    );

    const row = this.db.getRow("SELECT * FROM merge_proposals WHERE id = ?", id);
    return this.rowToDTO(row!);
  }

  /** 真正执行冲突探测（带 cwd）。 */
  private detectConflictsAt(
    projectPath: string,
    baseCommit: string,
    branches: string[],
  ): string[] {
    if (branches.length < 2) return [];
    const args = [
      "merge-tree",
      "--write-tree",
      `--merge-base=${baseCommit}`,
      ...branches,
    ];
    const res = spawnSync("git", args, { cwd: projectPath, encoding: "utf8" });
    const out = `${(res.stdout ?? "").toString()}\n${(res.stderr ?? "").toString()}`;
    const conflicts = new Set<string>();
    for (const line of out.split("\n")) {
      const m = line.match(/CONFLICT \([^)]+\):\s*(?:Merge conflict in\s*)?(.+)$/);
      if (m) {
        conflicts.add(m[1].trim());
        continue;
      }
      // 未合并条目：100644 <hash> <stage>\t<path>
      const u = line.match(/^\d+ \S+ \S+ [123]\t(.+)$/);
      if (u) conflicts.add(u[1].trim());
    }
    return [...conflicts];
  }

  /* --------------------------- 刷新提案 --------------------------- */

  refreshProposal(id: string): MergeProposalDTO {
    const row = this.db.getRow("SELECT * FROM merge_proposals WHERE id = ?", id);
    if (!row) {
      throw new WorkbenchError("invalid_data", `提案不存在: ${id}`);
    }
    const proposal = row as unknown as ProposalRow;
    const projectPath = this.projectPathFor(proposal.workflow_run_id);
    const currentHead = this.runGit(["-C", projectPath, "rev-parse", "HEAD"]);

    if (currentHead !== proposal.baseline_commit) {
      const now = new Date().toISOString();
      this.db.run(
        "UPDATE merge_proposals SET baseline_valid = 0, updated_at = ? WHERE id = ?",
        now,
        id,
      );
      proposal.baseline_valid = 0;
      proposal.updated_at = now;
    }

    return this.rowToDTO(proposal as unknown as Record<string, unknown>);
  }

  /* --------------------------- 应用提案 --------------------------- */

  applyProposal(id: string, decision: MergeDecision): { ok: boolean; message: string } {
    if (decision === "reject") {
      return { ok: true, message: "已拒绝合并，所有分支保留" };
    }

    // 先刷新，重判基线有效性。
    const refreshed = this.refreshProposal(id);
    if (!refreshed.baselineValid) {
      return { ok: false, message: "目标分支 HEAD 已变化，提案过期，请刷新后重试" };
    }

    // 纯 apply 且存在冲突：禁止写入目标分支。
    if (refreshed.conflicts.length > 0 && decision === "apply") {
      return { ok: false, message: "存在冲突，需在隔离区解决后再合并" };
    }

    const row = this.db.getRow("SELECT * FROM merge_proposals WHERE id = ?", id);
    if (!row) {
      return { ok: false, message: "提案不存在" };
    }
    const proposal = row as unknown as ProposalRow;
    const projectPath = this.projectPathFor(proposal.workflow_run_id);
    const baseCommit = proposal.baseline_commit;
    const branches = JSON.parse(proposal.branches) as MergeBranchDTO[];

    if (branches.length === 0) {
      return { ok: true, message: "没有可合并的分支，已跳过" };
    }

    const tempPath = fs.mkdtempSync(path.join(os.tmpdir(), "awb-merge-"));
    let ok = false;
    let message = "";
    try {
      // 从基线创建临时集成 worktree。
      this.runGit(["worktree", "add", tempPath, baseCommit], projectPath);

      for (const b of branches) {
        const res = spawnSync(
          "git",
          ["-C", tempPath, "merge", "--no-commit", "--no-ff", b.branch],
          { encoding: "utf8" },
        );
        const out = `${(res.stdout ?? "").toString()}\n${(res.stderr ?? "").toString()}`;
        if (res.status !== 0) {
          // 合并冲突或失败：中止，绝不写入目标。
          this.tryGit(["-C", tempPath, "merge", "--abort"]);
          throw new WorkbenchError(
            "conflict",
            `合并分支 ${b.branch} 时发生冲突或失败: ${out.trim()}`,
          );
        }
        // 把本次合并落定（临时 worktree，可丢弃），以便继续合并后续分支。
        if (!/Already up to date/i.test(out)) {
          this.runGit([
            "-C",
            tempPath,
            "commit",
            "--no-edit",
            "--no-verify",
            "-m",
            `merge ${b.branch} (integration)`,
          ]);
        }
      }

      // 写出合并后的树。
      const tree = this.runGit(["-C", tempPath, "write-tree"]);

      // 安全校验：目标 HEAD 必须仍等于基线。
      const targetHead = this.runGit(["-C", projectPath, "rev-parse", "HEAD"]);
      if (targetHead !== baseCommit) {
        throw new WorkbenchError(
          "conflict",
          "目标分支 HEAD 在合并过程中发生变化，已中止以避免覆盖",
        );
      }

      // 把合并结果落到目标工作区（不提交、不推送）。
      this.runGit(["-C", projectPath, "checkout", "-f", tree, "--", "."]);

      ok = true;
      message = "已合并到目标分支（未自动提交/推送）";
    } catch (err) {
      ok = false;
      message = `合并失败：${err instanceof Error ? err.message : String(err)}`;
    } finally {
      // 清理临时 worktree。
      this.tryGit(["-C", projectPath, "worktree", "remove", tempPath, "--force"], projectPath);
      try {
        fs.rmSync(tempPath, { recursive: true, force: true });
      } catch {
        /* 忽略清理失败 */
      }
    }

    return { ok, message };
  }
}
