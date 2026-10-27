/**
 * 项目登记与身份。项目目录移动后可重新绑定：以 Git remote 作为稳定身份，
 * 路径只作规范化缓存。第三方 ID 不作为全局主键（设计 3、4.4）。
 */
import { execFileSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { SqliteDatabase } from "../db/database";
import { ProjectDTO } from "../../shared/contracts";
import { WorkbenchError } from "../../shared/errors";

function uuid(): string {
  return crypto.randomUUID();
}

function normalizePath(p: string): string {
  const resolved = path.resolve(p);
  // 大小写不敏感比较（Windows），但存储保留原样。
  return resolved;
}

function detectGit(dir: string): { gitRoot?: string; gitRemote?: string } {
  try {
    const gitRoot = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    let gitRemote: string | undefined;
    try {
      gitRemote = execFileSync(
        "git",
        ["-C", dir, "remote", "get-url", "origin"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
    } catch {
      gitRemote = undefined;
    }
    return { gitRoot: gitRoot || undefined, gitRemote: gitRemote || undefined };
  } catch {
    return {};
  }
}

export class ProjectRegistry {
  constructor(private readonly db: SqliteDatabase) {}

  registerProject(rawPath: string): ProjectDTO {
    if (!fs.existsSync(rawPath) || !fs.statSync(rawPath).isDirectory()) {
      throw new WorkbenchError("invalid_data", `目录不存在: ${rawPath}`);
    }
    const norm = normalizePath(rawPath);
    const existing = this.db.getRow("SELECT * FROM projects WHERE path = ?", norm);
    if (existing) {
      return this.rowToDto(existing);
    }
    const { gitRoot, gitRemote } = detectGit(norm);
    const now = new Date().toISOString();
    const id = uuid();
    this.db.run(
      `INSERT INTO projects (id, name, path, git_root, git_remote, created_at, registered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id,
      path.basename(norm),
      norm,
      gitRoot ?? null,
      gitRemote ?? null,
      now,
      now,
    );
    return this.getProject(id)!;
  }

  getProject(id: string): ProjectDTO | null {
    const row = this.db.getRow("SELECT * FROM projects WHERE id = ?", id);
    return row ? this.rowToDto(row) : null;
  }

  getProjectByPath(rawPath: string): ProjectDTO | null {
    const row = this.db.getRow("SELECT * FROM projects WHERE path = ?", normalizePath(rawPath));
    return row ? this.rowToDto(row) : null;
  }

  listProjects(): ProjectDTO[] {
    return this.db.getRows("SELECT * FROM projects ORDER BY registered_at DESC").map(this.rowToDto);
  }

  /**
   * 目录移动后重新绑定：更新已有记录的路径。
   * 若给定 gitRemote 能匹配到历史记录（且旧路径已失效），也执行重绑。
   */
  rebindProject(id: string, newPath: string): ProjectDTO {
    if (!fs.existsSync(newPath) || !fs.statSync(newPath).isDirectory()) {
      throw new WorkbenchError("invalid_data", `新目录不存在: ${newPath}`);
    }
    const norm = normalizePath(newPath);
    const row = this.db.getRow("SELECT * FROM projects WHERE id = ?", id);
    if (!row) throw new WorkbenchError("invalid_data", `未知项目: ${id}`);
    const { gitRoot, gitRemote } = detectGit(norm);
    this.db.run(
      "UPDATE projects SET path = ?, git_root = ?, git_remote = ? WHERE id = ?",
      norm,
      gitRoot ?? row.git_root ?? null,
      gitRemote ?? row.git_remote ?? null,
      id,
    );
    return this.getProject(id)!;
  }

  removeProject(id: string): void {
    // 默认保留原生 Agent 数据与项目仓库文件，仅删除工作台登记与索引。
    this.db.run("DELETE FROM projects WHERE id = ?", id);
  }

  private rowToDto(row: Record<string, unknown>): ProjectDTO {
    return {
      id: String(row.id),
      name: String(row.name),
      path: String(row.path),
      gitRoot: row.git_root ? String(row.git_root) : undefined,
      gitRemote: row.git_remote ? String(row.git_remote) : undefined,
      createdAt: String(row.created_at),
      registeredAt: String(row.registered_at),
    };
  }
}
