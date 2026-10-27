/**
 * 工作区管理：基于 git worktree 为每个运行（run）创建隔离的 Git 分支工作区，
 * 并在 workspaces 表中登记其元数据（受管理目录、分支、基准提交、保留标记）。
 *
 * 设计要点：
 *  - 所有 git 命令均通过 child_process.spawnSync 以「参数数组」形式调用，
 *    绝不拼接 shell 字符串，避免命令注入。
 *  - BOOLEAN（retained）以 0/1 整数存储于 SQLite。
 *  - 仅使用已有的 workspaces 表，不新增任何表或迁移。
 */
import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { SqliteDatabase } from "../db/database";
import { ProjectRegistry } from "../projects/registry";
import { WorkbenchError } from "../../shared/errors";

export interface WorkspaceRef {
  id: string;
  path: string;
  branch: string;
  baseCommit: string;
}

export interface GitStatus {
  branch: string;
  headCommit: string;
  dirty: boolean;
  untracked: number;
  ahead: number;
}

export class WorkspaceManager {
  private readonly registry: ProjectRegistry;

  constructor(
    private readonly db: SqliteDatabase,
    private readonly managedRootResolver?: (projectPath: string) => string,
  ) {
    this.registry = new ProjectRegistry(db);
  }

  /** 受管理根目录：默认 <projectPath>/.agent-workbench/worktrees。 */
  private resolveManagedRoot(projectPath: string): string {
    return this.managedRootResolver
      ? this.managedRootResolver(projectPath)
      : path.join(projectPath, ".agent-workbench", "worktrees");
  }

  /** 以参数数组调用 git；成功返回 trimmed stdout，失败返回 null（不抛异常）。 */
  private tryGit(args: string[], cwd?: string): string | null {
    const res = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (res.error || res.status !== 0) return null;
    return (res.stdout ?? "").toString().trim();
  }

  /** 以参数数组调用 git；失败抛 WorkbenchError('process_failed', stderr)。 */
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

  /** 将分支名净化为安全文件名（替换路径分隔符与 Windows 非法字符）。 */
  private sanitizeBranch(branch: string): string {
    return branch.replace(/[\\/:*?"<>|\s]+/g, "_");
  }

  /** 创建并登记一个基于指定基准提交的新分支工作区（git worktree）。 */
  createBranchWorkspace(
    projectId: string,
    runId: string | null,
    baseCommit: string,
    opts?: { branch?: string; path?: string },
  ): WorkspaceRef {
    const project = this.registry.getProject(projectId);
    if (!project) {
      throw new WorkbenchError("invalid_data", "项目不存在");
    }
    const projectPath = project.path;

    // 校验项目本身是 Git 仓库，且仓库根就是项目目录本身
    // （排除项目目录恰好位于某个祖先 Git 仓库之内的情形）。
    const inside = this.tryGit(["-C", projectPath, "rev-parse", "--is-inside-work-tree"]);
    const toplevel = this.tryGit(["-C", projectPath, "rev-parse", "--show-toplevel"]);
    if (inside === null || toplevel === null || path.resolve(toplevel) !== path.resolve(projectPath)) {
      throw new WorkbenchError("invalid_data", "非 Git 项目");
    }

    const branch = opts?.branch ?? `workbench/${runId ?? crypto.randomUUID()}`;
    const managedRoot = this.resolveManagedRoot(projectPath);

    let wsPath: string;
    if (opts?.path) {
      // 自定义路径必须位于受管理目录内，否则视为越权。
      const relative = path.relative(path.resolve(managedRoot), path.resolve(opts.path));
      if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new WorkbenchError("permission_denied", "工作区路径必须在受管理目录内");
      }
      wsPath = opts.path;
    } else {
      wsPath = path.join(managedRoot, this.sanitizeBranch(branch));
    }

    // 确保受管理根目录存在。
    fs.mkdirSync(managedRoot, { recursive: true });

    // 创建 worktree 并基于 baseCommit 新建分支。
    this.runGit(["worktree", "add", "-b", branch, wsPath, baseCommit], projectPath);

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO workspaces (id, project_id, run_id, base_commit, branch, path, created_at, retained)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      projectId,
      runId,
      baseCommit,
      branch,
      wsPath,
      now,
      0,
    );

    return { id, path: wsPath, branch, baseCommit };
  }

  /** 读取工作区登记信息；未命中返回 null。 */
  getWorkspace(id: string): WorkspaceRef | null {
    const row = this.db.getRow("SELECT * FROM workspaces WHERE id = ?", id);
    if (!row) return null;
    return this.rowToRef(row);
  }

  /** 探测工作区当前 Git 状态。 */
  inspectWorkspace(id: string): GitStatus {
    const row = this.db.getRow("SELECT * FROM workspaces WHERE id = ?", id);
    if (!row) {
      throw new WorkbenchError("invalid_data", "工作区不存在");
    }
    const wsPath = String(row.path);
    const branch = String(row.branch);

    const headCommit = this.tryGit(["-C", wsPath, "rev-parse", "HEAD"]) ?? "";
    const currentBranch =
      this.tryGit(["-C", wsPath, "branch", "--show-current"]) ?? branch;

    const porcelain = this.tryGit(["-C", wsPath, "status", "--porcelain"]) ?? "";
    const dirty = porcelain.trim().length > 0;
    const untracked = porcelain
      .split("\n")
      .filter((line) => line.startsWith("??")).length;

    // 上游不存在时（如新分支）ahead 计为 0。
    let ahead = 0;
    const aheadRaw = this.tryGit(["-C", wsPath, "rev-list", "--count", "@{u}..HEAD"]);
    if (aheadRaw !== null) {
      const parsed = Number.parseInt(aheadRaw, 10);
      ahead = Number.isFinite(parsed) ? parsed : 0;
    }

    return {
      branch: currentBranch,
      headCommit,
      dirty,
      untracked,
      ahead,
    };
  }

  /** 标记工作区为「保留」，禁止被清理。 */
  retainWorkspace(id: string): void {
    const row = this.db.getRow("SELECT * FROM workspaces WHERE id = ?", id);
    if (!row) {
      throw new WorkbenchError("invalid_data", "工作区不存在");
    }
    this.db.run("UPDATE workspaces SET retained = 1 WHERE id = ?", id);
  }

  /** 仅在「干净且未保留」时删除工作区；否则抛 conflict。 */
  removeCleanWorkspace(id: string): void {
    const row = this.db.getRow("SELECT * FROM workspaces WHERE id = ?", id);
    if (!row) {
      throw new WorkbenchError("invalid_data", "工作区不存在");
    }
    const retained = Number(row.retained) === 1;
    const status = this.inspectWorkspace(id);

    if (status.dirty || retained) {
      throw new WorkbenchError("conflict", "脏工作区或已保留，禁止删除");
    }

    const wsPath = String(row.path);
    const project = this.registry.getProject(String(row.project_id));
    const repoCwd = project ? project.path : wsPath;

    // 从主仓库执行 worktree remove，并强制（即便有残留）。
    this.runGit(["worktree", "remove", wsPath, "--force"], repoCwd);

    this.db.run("DELETE FROM workspaces WHERE id = ?", id);
  }

  private rowToRef(row: Record<string, unknown>): WorkspaceRef {
    return {
      id: String(row.id),
      path: String(row.path),
      branch: String(row.branch),
      baseCommit: String(row.base_commit),
    };
  }
}
