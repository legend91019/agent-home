/**
 * 持久记忆清单：从各 Agent 的原生记忆文件（启发式路径）与数据库已导入条目中
 * 读取可见记忆。任何读取错误都优雅降级（返回已能拿到的部分），绝不抛出。
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { SqliteDatabase } from "../db/database";
import { ProjectRegistry } from "../projects/registry";
import { type AgentId, type ArtifactScope, type MemoryEntryDTO } from "../../shared/contracts";

/** 各 Agent 的原生记忆文件路径（启发式）。 */
function nativeMemoryPaths(projectPath: string, agentId: AgentId): string[] {
  if (agentId === "claude-code") {
    return [path.join(projectPath, "CLAUDE.md"), path.join(projectPath, ".claude", "CLAUDE.md")];
  }
  if (agentId === "codex") {
    return [path.join(projectPath, "AGENTS.md")];
  }
  if (agentId === "workbuddy") {
    return [path.join(projectPath, "CODEBUDDY.md")];
  }
  return [];
}

export class MemoryInventory {
  private readonly registry: ProjectRegistry;

  constructor(private readonly db: SqliteDatabase) {
    this.registry = new ProjectRegistry(db);
  }

  listVisibleMemories(projectId: string | null, agentId: AgentId): MemoryEntryDTO[] {
    const bySource = new Map<string, MemoryEntryDTO>();

    // 1) 原生记忆文件（degrade gracefully）
    const projectPath = projectId ? this.safeProjectPath(projectId) : null;
    if (projectPath) {
      for (const p of nativeMemoryPaths(projectPath, agentId)) {
        try {
          if (fs.existsSync(p) && fs.statSync(p).isFile()) {
            const text = fs.readFileSync(p, "utf8");
            const id = "native:" + crypto.createHash("sha256").update(p).digest("hex");
            bySource.set(p, {
              id,
              agentId,
              projectId,
              source: p,
              originalText: text,
              scope: projectId ? "project" : "global",
              importedAt: new Date(0).toISOString(),
              published: false,
            });
          }
        } catch {
          // 读取失败：跳过该文件，继续其它来源
        }
      }
    }

    // 2) 数据库已导入条目（若与某原生文件同源，优先用 DB 版本）
    const rows = this.db.getRows(
      `SELECT * FROM memory_entries
       WHERE agent_id = ? AND (project_id = ? OR (project_id IS NULL AND ? IS NULL))`,
      agentId,
      projectId,
      projectId,
    );
    for (const row of rows) {
      const dto = this.rowToDto(row);
      const live = bySource.get(dto.source);
      if (!live || live.originalText === dto.originalText) bySource.set(dto.source, dto);
    }

    return Array.from(bySource.values());
  }

  /**
   * 导入一条记忆。按 (source + 原文) 去重：若已存在完全相同条目则直接返回，
   * 不插入重复。
   */
  importMemory(
    agentId: AgentId,
    projectId: string | null,
    source: string,
    originalText: string,
    scope: ArtifactScope,
  ): MemoryEntryDTO {
    const existing = this.db.getRow(
      "SELECT * FROM memory_entries WHERE source = ? AND original_text = ?",
      source,
      originalText,
    );
    if (existing) return this.rowToDto(existing);

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO memory_entries (id, agent_id, project_id, source, original_text, scope, imported_at, published)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      id,
      agentId,
      projectId,
      source,
      originalText,
      scope,
      now,
    );
    return this.rowToDto(this.db.getRow("SELECT * FROM memory_entries WHERE id = ?", id)!);
  }

  getEntry(id: string): MemoryEntryDTO | null {
    const row = this.db.getRow("SELECT * FROM memory_entries WHERE id = ?", id);
    if (row) return this.rowToDto(row);
    if (!id.startsWith("native:")) return null;
    for (const project of this.registry.listProjects()) {
      for (const agentId of ["claude-code", "codex", "workbuddy"] as const) {
        for (const source of nativeMemoryPaths(project.path, agentId)) {
          const nativeId = "native:" + crypto.createHash("sha256").update(source).digest("hex");
          if (nativeId !== id) continue;
          try {
            if (!fs.statSync(source).isFile()) return null;
            return {
              id,
              agentId,
              projectId: project.id,
              source,
              originalText: fs.readFileSync(source, "utf8"),
              scope: "project",
              importedAt: new Date(0).toISOString(),
              published: false,
            };
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }

  private safeProjectPath(projectId: string): string | null {
    try {
      const project = this.registry.getProject(projectId);
      return project ? project.path : null;
    } catch {
      return null;
    }
  }

  private rowToDto(row: Record<string, unknown>): MemoryEntryDTO {
    return {
      id: String(row.id),
      agentId: row.agent_id as AgentId,
      projectId: row.project_id ? String(row.project_id) : null,
      source: String(row.source),
      originalText: String(row.original_text),
      scope: row.scope as ArtifactScope,
      importedAt: String(row.imported_at),
      published: !!Number(row.published),
    };
  }
}
