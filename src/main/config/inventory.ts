/**
 * 项目级共享产物的发现（扫描）。
 * 不修改任何原生 Agent 文件，仅读取文件系统并（必要时）把发现结果
 * 写入 shared_artifacts 表，以便 publisher 能通过稳定的 id 引用产物。
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { SqliteDatabase } from "../db/database";
import { ProjectRegistry } from "../projects/registry";
import { WorkbenchError } from "../../shared/errors";
import type { ArtifactScope, SharedArtifactDTO } from "../../shared/contracts";

const RULE_FILES = ["CLAUDE.md", "AGENTS.md", "GEMINI.md", "CODEBUDDY.md"];

interface UpsertInput {
  projectId: string;
  kind: "rule" | "skill" | "knowledge" | "workflow";
  name: string;
  sourcePath: string;
}

export class ConfigInventory {
  private readonly registry: ProjectRegistry;

  constructor(private readonly db: SqliteDatabase) {
    this.registry = new ProjectRegistry(db);
  }

  /** 发现项目中的共享产物（规则 / 知识 / skill），并返回其 DTO。 */
  scanArtifacts(projectId: string): SharedArtifactDTO[] {
    const project = this.registry.getProject(projectId);
    if (!project) throw new WorkbenchError("invalid_data", `未知项目: ${projectId}`);
    const root = project.path;

    const discovered: UpsertInput[] = [];

    // 规则文件：项目根目录下的固定文件名
    for (const name of RULE_FILES) {
      const p = path.join(root, name);
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        discovered.push({ projectId, kind: "rule", name, sourcePath: p });
      }
    }

    // 知识文件：.agent-workbench/knowledge.md
    const knowledgePath = path.join(root, ".agent-workbench", "knowledge.md");
    if (fs.existsSync(knowledgePath) && fs.statSync(knowledgePath).isFile()) {
      discovered.push({
        projectId,
        kind: "knowledge",
        name: "knowledge.md",
        sourcePath: knowledgePath,
      });
    }

    // Skills：项目中任意位置的子目录，只要其中包含 SKILL.md 即视为 skill。
    for (const dir of this.discoverSkillDirs(root)) {
      discovered.push({
        projectId,
        kind: "skill",
        name: path.basename(dir),
        sourcePath: dir,
      });
    }

    return discovered.map((d) => this.upsertAndToDto(d));
  }

  /** 递归查找包含 SKILL.md 的目录（跳过 node_modules/.git 等无关目录）。 */
  private discoverSkillDirs(root: string): string[] {
    const SKILL = "SKILL.md";
    const IGNORE = new Set(["node_modules", ".git"]);
    const dirs: string[] = [];

    const visit = (dir: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      // 当前目录自身是否为 skill
      if (entries.some((e) => e.isFile() && e.name === SKILL)) {
        dirs.push(dir);
        return; // skill 目录内部不再向下钻取
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (IGNORE.has(entry.name)) continue;
        visit(path.join(dir, entry.name));
      }
    };

    visit(root);
    return dirs;
  }

  /**
   * 把发现的产物写入 shared_artifacts（按 project_id+kind+name 幂等），并返回 DTO。
   * 这样 publisher 始终能拿到一个稳定的、满足外键约束的 artifact id。
   */
  private upsertAndToDto(input: UpsertInput): SharedArtifactDTO {
    const existing = this.db.getRow(
      "SELECT id, version, created_at, published_at FROM shared_artifacts WHERE project_id = ? AND kind = ? AND name = ?",
      input.projectId,
      input.kind,
      input.name,
    );

    if (existing) {
      // 路径可能随项目重绑变化，刷新 source_path 保持最新
      this.db.run(
        "UPDATE shared_artifacts SET source_path = ? WHERE id = ?",
        input.sourcePath,
        existing.id,
      );
      const id = String(existing.id);
      return {
        id,
        projectId: input.projectId,
        kind: input.kind,
        name: input.name,
        scope: "project" as ArtifactScope,
        targetAgents: [],
        version: Number(existing.version),
        createdAt: String(existing.created_at),
        publishedAt: existing.published_at ? String(existing.published_at) : null,
        sourcePath: input.sourcePath,
      };
    }

    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.run(
      `INSERT INTO shared_artifacts
        (id, project_id, kind, name, scope, target_agents, version, created_at, published_at, source_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      input.projectId,
      input.kind,
      input.name,
      "project",
      "[]",
      1,
      now,
      null,
      input.sourcePath,
    );
    return {
      id,
      projectId: input.projectId,
      kind: input.kind,
      name: input.name,
      scope: "project",
      targetAgents: [],
      version: 1,
      createdAt: now,
      publishedAt: null,
      sourcePath: input.sourcePath,
    };
  }
}
