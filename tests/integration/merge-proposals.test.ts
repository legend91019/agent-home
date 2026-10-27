/**
 * MergeService 集成测试。
 * 使用真实临时 git 仓库（init + config user + 在 main 上初始提交），
 * 通过 WorkspaceManager.createBranchWorkspace 建立隔离分支工作区，
 * 真实提交改动，再驱动 MergeService 的创建/刷新/应用流程。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { spawnSync } from "node:child_process";

import { makeDb, seedProject } from "../helpers/db";
import { SqliteDatabase } from "../../src/main/db/database";
import { WorkspaceManager } from "../../src/main/workspaces/git";
import { MergeService } from "../../src/main/merge/proposals";

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(r.stderr || r.stdout || "").toString().trim()}`);
  }
  return (r.stdout ?? "").toString().trim();
}

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "awb-repo-"));
  git(["init", "-b", "main"], dir);
  git(["config", "user.email", "t@t.com"], dir);
  git(["config", "user.name", "tester"], dir);
  git(["config", "core.autocrlf", "false"], dir);
  git(["config", "core.safecrlf", "false"], dir);
  fs.writeFileSync(path.join(dir, "README.md"), "# project\n");
  fs.writeFileSync(path.join(dir, "shared.txt"), "original\n");
  git(["add", "-A"], dir);
  git(["commit", "-m", "init"], dir);
  return dir;
}

interface BranchSpec {
  branch: string;
  write: (wsPath: string) => void;
}

interface SetupResult {
  workflowId: string;
  runIds: string[];
  base: string;
}

function setupWorkflow(
  db: SqliteDatabase,
  wm: WorkspaceManager,
  repoPath: string,
  specs: BranchSpec[],
): SetupResult {
  const now = () => new Date().toISOString();
  const base = git(["-C", repoPath, "rev-parse", "HEAD"], repoPath);

  const taskId = crypto.randomUUID();
  db.run(
    "INSERT INTO tasks (id, project_id, title, goal, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
    taskId,
    "p1",
    "task",
    "goal",
    "running",
    now(),
    now(),
  );

  const runIds: string[] = [];
  for (const spec of specs) {
    const runId = crypto.randomUUID();
    const ws = wm.createBranchWorkspace("p1", runId, base, { branch: spec.branch });
    spec.write(ws.path);
    git(["-C", ws.path, "add", "-A"], ws.path);
    git(["-C", ws.path, "commit", "-m", `edit ${spec.branch}`], ws.path);
    db.run(
      "INSERT INTO runs (id, task_id, agent_id, status, created_at, updated_at, workspace_id, controllable) VALUES (?,?,?,?,?,?,?,?)",
      runId,
      taskId,
      "claude-code",
      "succeeded",
      now(),
      now(),
      ws.id,
      0,
    );
    runIds.push(runId);
  }

  const workflowId = crypto.randomUUID();
  db.run(
    "INSERT INTO workflows (id, project_id, task_id, name, definition, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
    workflowId,
    "p1",
    taskId,
    "wf",
    "{}",
    now(),
    now(),
  );
  for (const runId of runIds) {
    db.run(
      "INSERT INTO workflow_nodes (id, workflow_id, node_id, status, run_id) VALUES (?,?,?,?,?)",
      crypto.randomUUID(),
      workflowId,
      crypto.randomUUID(),
      "succeeded",
      runId,
    );
  }

  return { workflowId, runIds, base };
}

describe("MergeService", () => {
  let db: SqliteDatabase;
  let repoPath: string;
  let managedRoot: string;
  const workspaceManager = () => new WorkspaceManager(db, () => managedRoot);

  beforeEach(() => {
    db = makeDb();
    repoPath = makeRepo();
    managedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "awb-worktrees-"));
    seedProject(db, "p1", repoPath);
  });

  afterEach(() => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(repoPath, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(managedRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("(a) 非冲突双分支：创建无冲突，应用后目标 main 工作区含两份改动", () => {
    const wm = workspaceManager();
    const ms = new MergeService(db, wm);

    const { workflowId } = setupWorkflow(db, wm, repoPath, [
      { branch: "branch-a", write: (p) => fs.writeFileSync(path.join(p, "fileA.txt"), "A content\n") },
      { branch: "branch-b", write: (p) => fs.writeFileSync(path.join(p, "fileB.txt"), "B content\n") },
    ]);

    const proposal = ms.createMergeProposal(workflowId);
    expect(proposal.branches.length).toBe(2);
    expect(proposal.conflicts).toEqual([]);
    expect(proposal.baselineValid).toBe(true);

    const res = ms.applyProposal(proposal.id, "apply");
    expect(res.ok, res.message).toBe(true);

    // 目标 main 工作区现在包含两份改动。
    expect(fs.readFileSync(path.join(repoPath, "fileA.txt"), "utf8")).toBe("A content\n");
    expect(fs.readFileSync(path.join(repoPath, "fileB.txt"), "utf8")).toBe("B content\n");
  });

  it("(b) 同文件冲突：创建检测到冲突，apply 返回失败且目标文件保持原样", () => {
    const wm = workspaceManager();
    const ms = new MergeService(db, wm);

    const { workflowId } = setupWorkflow(db, wm, repoPath, [
      { branch: "branch-a", write: (p) => fs.writeFileSync(path.join(p, "shared.txt"), "A version\n") },
      { branch: "branch-b", write: (p) => fs.writeFileSync(path.join(p, "shared.txt"), "B version\n") },
    ]);

    const proposal = ms.createMergeProposal(workflowId);
    expect(proposal.conflicts).toContain("shared.txt");

    const res = ms.applyProposal(proposal.id, "apply");
    expect(res.ok).toBe(false);

    // 目标 main 的 shared.txt 仍是最初内容，未被更改。
    expect(fs.readFileSync(path.join(repoPath, "shared.txt"), "utf8")).toBe("original\n");
  });

  it("(c) 过期基线：main 有新提交后刷新失效，apply 返回失败且目标不变", () => {
    const wm = workspaceManager();
    const ms = new MergeService(db, wm);

    const { workflowId } = setupWorkflow(db, wm, repoPath, [
      { branch: "branch-a", write: (p) => fs.writeFileSync(path.join(p, "fileA.txt"), "A content\n") },
      { branch: "branch-b", write: (p) => fs.writeFileSync(path.join(p, "fileB.txt"), "B content\n") },
    ]);

    const proposal = ms.createMergeProposal(workflowId);
    expect(proposal.baselineValid).toBe(true);

    // 在 main 上制造一个新提交，改变目标 HEAD。
    fs.writeFileSync(path.join(repoPath, "extra.txt"), "extra\n");
    git(["-C", repoPath, "add", "-A"], repoPath);
    git(["-C", repoPath, "commit", "-m", "change main"], repoPath);

    const refreshed = ms.refreshProposal(proposal.id);
    expect(refreshed.baselineValid).toBe(false);

    const res = ms.applyProposal(proposal.id, "apply");
    expect(res.ok).toBe(false);

    // 目标工作区不应包含来自分支的改动。
    expect(fs.existsSync(path.join(repoPath, "fileA.txt"))).toBe(false);
    expect(fs.existsSync(path.join(repoPath, "fileB.txt"))).toBe(false);
    // 新提交仍在。
    expect(fs.readFileSync(path.join(repoPath, "extra.txt"), "utf8")).toBe("extra\n");
  });

  it("(d) 拒绝：apply(reject) 返回成功且分支工作区目录保留", () => {
    const wm = workspaceManager();
    const ms = new MergeService(db, wm);

    const { workflowId } = setupWorkflow(db, wm, repoPath, [
      { branch: "branch-a", write: (p) => fs.writeFileSync(path.join(p, "fileA.txt"), "A content\n") },
      { branch: "branch-b", write: (p) => fs.writeFileSync(path.join(p, "fileB.txt"), "B content\n") },
    ]);

    const proposal = ms.createMergeProposal(workflowId);
    const res = ms.applyProposal(proposal.id, "reject");
    expect(res.ok).toBe(true);

    // 分支工作区保留。
    const wsRows = db.getRows("SELECT * FROM workspaces WHERE project_id = ?", "p1");
    expect(wsRows.length).toBe(2);
    for (const r of wsRows) {
      expect(fs.existsSync(String(r.path))).toBe(true);
    }
  });

  it("目标工作区有未提交改动时拒绝应用，保留用户内容", () => {
    const ms = new MergeService(db, workspaceManager());
    const { workflowId } = setupWorkflow(db, workspaceManager(), repoPath, [
      { branch: "branch-dirty-target", write: (p) => fs.writeFileSync(path.join(p, "fileA.txt"), "A\n") },
    ]);
    const proposal = ms.createMergeProposal(workflowId);
    fs.writeFileSync(path.join(repoPath, "README.md"), "用户尚未提交的内容\n");
    const result = ms.applyProposal(proposal.id, "apply");
    expect(result.ok).toBe(false);
    expect(fs.readFileSync(path.join(repoPath, "README.md"), "utf8")).toBe("用户尚未提交的内容\n");
    expect(fs.existsSync(path.join(repoPath, "fileA.txt"))).toBe(false);
  });

  it("分支包含未提交改动时拒绝应用，避免遗漏工作成果", () => {
    const wm = workspaceManager();
    const ms = new MergeService(db, wm);
    const { workflowId } = setupWorkflow(db, wm, repoPath, [
      { branch: "branch-dirty-source", write: (p) => fs.writeFileSync(path.join(p, "fileA.txt"), "A\n") },
    ]);
    const proposal = ms.createMergeProposal(workflowId);
    const ws = db.getRow("SELECT path FROM workspaces WHERE project_id = ?", "p1");
    fs.writeFileSync(path.join(String(ws!.path), "extra.txt"), "尚未提交\n");
    const result = ms.applyProposal(proposal.id, "apply");
    expect(result.ok).toBe(false);
    expect(fs.existsSync(path.join(repoPath, "fileA.txt"))).toBe(false);
  });

  it("三个分支的累积冲突会出现在提案中", () => {
    const wm = workspaceManager();
    const ms = new MergeService(db, wm);
    const { workflowId } = setupWorkflow(db, wm, repoPath, [
      { branch: "branch-three-a", write: (p) => fs.writeFileSync(path.join(p, "shared.txt"), "A\n") },
      { branch: "branch-three-b", write: (p) => fs.writeFileSync(path.join(p, "fileB.txt"), "B\n") },
      { branch: "branch-three-c", write: (p) => fs.writeFileSync(path.join(p, "shared.txt"), "C\n") },
    ]);
    const proposal = ms.createMergeProposal(workflowId);
    expect(proposal.conflicts).toContain("shared.txt");
  });
});
