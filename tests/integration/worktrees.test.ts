import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeDb, seedProject } from "../helpers/db";
import { WorkspaceManager } from "../../src/main/workspaces/git";
import { SqliteDatabase } from "../../src/main/db/database";
import { WorkbenchError } from "../../src/shared/errors";

/** 以参数数组调用 git（测试用，非生产路径）。 */
function git(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  const res = spawnSync("git", args, { cwd, encoding: "utf8" });
  return {
    status: res.status ?? -1,
    stdout: (res.stdout ?? "").toString().trim(),
    stderr: (res.stderr ?? "").toString().trim(),
  };
}

/** 初始化一个真实、干净、有初始提交的 git 仓库，返回其根目录。 */
function initRealRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "awb-repo-"));
  git(["init"], dir);
  git(["config", "user.email", "test@example.com"], dir);
  git(["config", "user.name", "Test User"], dir);
  git(["config", "core.autocrlf", "false"], dir);
  git(["config", "core.eol", "lf"], dir);
  const file = path.join(dir, "hello.txt");
  fs.writeFileSync(file, "original content\n");
  git(["add", "hello.txt"], dir);
  git(["commit", "-m", "initial"], dir);
  return dir;
}

/** 创建一个普通（非 git）目录。 */
function makePlainDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "awb-plain-"));
}

/** 读取文件并归一化换行符（屏蔽 Windows CRLF 差异）。 */
function readNorm(p: string): string {
  return fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
}

describe("WorkspaceManager (git worktree)", () => {
  let db: SqliteDatabase;
  let repoPath: string;
  let baseCommit: string;
  let manager: WorkspaceManager;

  const createdPaths: string[] = [];

  beforeAll(() => {
    db = makeDb();
    repoPath = initRealRepo();
    baseCommit = git(["rev-parse", "HEAD"], repoPath).stdout;
    seedProject(db, "p1", repoPath);
    manager = new WorkspaceManager(db);
  });

  afterAll(() => {
    // 尽力清理：删除所有 worktree 与临时目录。
    for (const p of createdPaths) {
      try {
        spawnSync("git", ["worktree", "remove", p, "--force"], { cwd: repoPath });
      } catch {
        /* ignore */
      }
    }
    try {
      fs.rmSync(repoPath, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("(a) 从同一基准提交创建两个分支工作区，互不相同", () => {
    const a = manager.createBranchWorkspace("p1", "run-1", baseCommit);
    const b = manager.createBranchWorkspace("p1", "run-2", baseCommit);
    createdPaths.push(a.path, b.path);

    expect(a.id).not.toEqual(b.id);
    expect(a.branch).not.toEqual(b.branch);
    expect(a.path).not.toEqual(b.path);

    const gotA = manager.getWorkspace(a.id);
    const gotB = manager.getWorkspace(b.id);
    expect(gotA).not.toBeNull();
    expect(gotB).not.toBeNull();
    expect(gotA!.branch).toEqual(a.branch);
    expect(gotB!.branch).toEqual(b.branch);
  });

  it("(b) 修改工作区 A 的文件不影响主仓库与另一工作区", () => {
    const a = manager.createBranchWorkspace("p1", "run-3", baseCommit);
    const b = manager.createBranchWorkspace("p1", "run-4", baseCommit);
    createdPaths.push(a.path, b.path);

    // 在主仓库与 B 中应看到原始内容。
    const mainFile = path.join(repoPath, "hello.txt");
    const bFile = path.join(b.path, "hello.txt");
    expect(readNorm(mainFile)).toEqual("original content\n");
    expect(readNorm(bFile)).toEqual("original content\n");

    // 修改 A 中的文件。
    const aFile = path.join(a.path, "hello.txt");
    fs.writeFileSync(aFile, "changed in A\n");

    // 主仓库与 B 的文件保持不变。
    expect(readNorm(mainFile)).toEqual("original content\n");
    expect(readNorm(bFile)).toEqual("original content\n");

    // inspect 应反映 A 为脏、B 为干净。
    expect(manager.inspectWorkspace(a.id).dirty).toBe(true);
    expect(manager.inspectWorkspace(b.id).dirty).toBe(false);
    expect(manager.inspectWorkspace(a.id).headCommit).toEqual(baseCommit);
  });

  it("(c) 脏工作区 / 已保留工作区禁止删除", () => {
    const a = manager.createBranchWorkspace("p1", "run-5", baseCommit);
    createdPaths.push(a.path);

    // 制造脏状态。
    fs.writeFileSync(path.join(a.path, "hello.txt"), "dirty change\n");
    expect(manager.inspectWorkspace(a.id).dirty).toBe(true);

    // 脏 -> 删除抛 conflict。
    expect(() => manager.removeCleanWorkspace(a.id)).toThrow(WorkbenchError);

    // 即使保留后，仍因 dirty 抛 conflict（此处先验证 retain 后的逻辑）。
    manager.retainWorkspace(a.id);
    expect(() => manager.removeCleanWorkspace(a.id)).toThrow(WorkbenchError);

    // 清理：直接删除登记并移除 worktree（测试结束后由 afterAll 兜底）。
    // 这里主动移除以免 worktree 残留影响后续用例。
    spawnSync("git", ["worktree", "remove", a.path, "--force"], { cwd: repoPath });
  });

  it("(d) 非 Git 项目创建工作区 -> invalid_data", () => {
    const plain = makePlainDir();
    seedProject(db, "p2", plain);
    expect(() => manager.createBranchWorkspace("p2", "run-x", "abc")).toThrow(WorkbenchError);
    try {
      manager.createBranchWorkspace("p2", "run-x", "abc");
    } catch (e) {
      expect(e).toBeInstanceOf(WorkbenchError);
      expect((e as WorkbenchError).code).toEqual("invalid_data");
    }
    fs.rmSync(plain, { recursive: true, force: true });
  });

  it("(e) 自定义路径位于受管理目录之外 -> permission_denied", () => {
    const outside = makePlainDir(); // 任意受管理根目录之外的路径
    expect(() =>
      manager.createBranchWorkspace("p1", "run-y", baseCommit, { path: outside }),
    ).toThrow(WorkbenchError);
    try {
      manager.createBranchWorkspace("p1", "run-y", baseCommit, { path: outside });
    } catch (e) {
      expect(e).toBeInstanceOf(WorkbenchError);
      expect((e as WorkbenchError).code).toEqual("permission_denied");
    }
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it("(f) 干净且未保留的工作区可被删除", () => {
    const a = manager.createBranchWorkspace("p1", "run-6", baseCommit);
    createdPaths.push(a.path);
    expect(manager.getWorkspace(a.id)).not.toBeNull();
    expect(manager.inspectWorkspace(a.id).dirty).toBe(false);

    manager.removeCleanWorkspace(a.id);
    expect(manager.getWorkspace(a.id)).toBeNull();

    // 物理 worktree 已移除。
    expect(fs.existsSync(a.path)).toBe(false);
  });
});
