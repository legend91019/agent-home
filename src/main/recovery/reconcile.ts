/**
 * 启动期恢复对账。只读 DB + 文件系统，只「报告」不自动修改：
 *  - 残留 running 任务：仅计数（不自动改状态）。
 *  - 孤儿工作树：run_id 为空或指向已不存在的 run、且未保留、且目录仍在磁盘。仅列出路径，不删除。
 *  - 半写入发布：backup_path 已记录但备份文件已不存在（中断发布，应回滚）。仅列出 id，不自动回滚。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { SqliteDatabase } from "../db/database";
import type { RecoveryReport } from "../../shared/contracts";

export class RecoveryService {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly dataDir: string,
  ) {}

  reconcileOnStartup(): RecoveryReport {
    const notes: string[] = [];

    // 1. 可恢复任务：停留在 'running' 状态的任务（仅报告，不改状态）。
    const runningRows = this.db.getRows("SELECT id FROM tasks WHERE status = 'running'");
    const recoveredTasks = runningRows.length;
    notes.push(
      `Detected ${recoveredTasks} task(s) left in 'running' status (recoverable; not auto-modified).`,
    );

    // 2. 孤儿工作树：workspaces 行中 run_id 为空或指向不存在的 run，且 retained != 1，且路径仍在磁盘。
    const wsRows = this.db.getRows(
      "SELECT id, run_id, path, retained FROM workspaces",
    );
    const orphanWorktrees: string[] = [];
    for (const ws of wsRows) {
      const retained = Number(ws.retained);
      if (retained === 1) continue;
      const runId = ws.run_id == null ? null : String(ws.run_id);
      let orphan = false;
      if (runId === null) {
        orphan = true;
      } else {
        const run = this.db.getRow("SELECT id FROM runs WHERE id = ?", runId);
        if (!run) orphan = true;
      }
      const rawPath = String(ws.path);
      const p = path.isAbsolute(rawPath) ? rawPath : path.resolve(this.dataDir, rawPath);
      if (orphan && p.length > 0 && fs.existsSync(p)) {
        orphanWorktrees.push(p);
      }
    }
    notes.push(
      `Detected ${orphanWorktrees.length} orphan worktree(s) with existing path on disk.`,
    );

    // 3. 半写入发布：backup_path 已记录但备份文件已不存在。
    const pubRows = this.db.getRows("SELECT id, backup_path FROM publications");
    const halfWrittenPublications: string[] = [];
    for (const p of pubRows) {
      const rawBackup = p.backup_path == null ? null : String(p.backup_path);
      const backup =
        rawBackup && rawBackup.length > 0
          ? path.isAbsolute(rawBackup)
            ? rawBackup
            : path.resolve(this.dataDir, rawBackup)
          : null;
      if (backup && !fs.existsSync(backup)) {
        halfWrittenPublications.push(String(p.id));
      }
    }
    notes.push(
      `Detected ${halfWrittenPublications.length} half-written publication(s) (missing backup file).`,
    );

    return {
      recoveredTasks,
      orphanWorktrees,
      halfWrittenPublications,
      notes,
      checkedAt: new Date().toISOString(),
    };
  }
}
