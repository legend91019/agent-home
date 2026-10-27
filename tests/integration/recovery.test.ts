import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { makeDb, seedProject } from "../helpers/db";
import { RecoveryService } from "../../src/main/recovery/reconcile";

function nowIso(): string {
  return new Date().toISOString();
}

describe("RecoveryService.reconcileOnStartup", () => {
  it("(a) reports tasks left in 'running' and does not change their status", () => {
    const db = makeDb();
    seedProject(db, "p1");
    db.run(
      "INSERT INTO tasks (id, project_id, title, goal, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
      "t1",
      "p1",
      "Leftover task",
      "goal",
      "running",
      nowIso(),
      nowIso(),
    );

    const svc = new RecoveryService(db, "/tmp");
    const report = svc.reconcileOnStartup();

    expect(report.recoveredTasks).toBeGreaterThanOrEqual(1);
    const row = db.getRow("SELECT status FROM tasks WHERE id = ?", "t1");
    expect(String(row!.status)).toBe("running");
  });

  it("(b) lists orphan worktrees whose path still exists, without deleting the directory", () => {
    const db = makeDb();
    seedProject(db, "p1");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wb-orphan-"));
    expect(fs.existsSync(dir)).toBe(true);

    db.run(
      "INSERT INTO workspaces (id, project_id, run_id, base_commit, branch, path, created_at, retained) VALUES (?,?,?,?,?,?,?,?)",
      "w1",
      "p1",
      null,
      "deadbeef",
      "main",
      dir,
      nowIso(),
      0,
    );

    const svc = new RecoveryService(db, "/tmp");
    const report = svc.reconcileOnStartup();

    expect(report.orphanWorktrees).toContain(dir);
    // 目录绝不被删除。
    expect(fs.existsSync(dir)).toBe(true);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("(c) lists half-written publications whose backup file no longer exists", () => {
    const db = makeDb();
    seedProject(db, "p1");
    db.run(
      "INSERT INTO shared_artifacts (id, project_id, kind, name, scope, created_at) VALUES (?,?,?,?,?,?)",
      "a1",
      "p1",
      "rule",
      "r1",
      "project",
      nowIso(),
    );

    const missingBackup = path.join(os.tmpdir(), `wb-missing-backup-${Date.now()}.bak`);
    expect(fs.existsSync(missingBackup)).toBe(false);

    db.run(
      "INSERT INTO publications (id, artifact_id, applied_at, backup_path) VALUES (?,?,?,?)",
      "pub1",
      "a1",
      nowIso(),
      missingBackup,
    );

    const svc = new RecoveryService(db, "/tmp");
    const report = svc.reconcileOnStartup();

    expect(report.halfWrittenPublications).toContain("pub1");
  });
});
