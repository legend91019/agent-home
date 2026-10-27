/**
 * 配置发布器：把工作台发现的共享产物（rules/skills/knowledge）发布到某个
 * 目标 Agent 的原生配置文件中。所有写入均先备份、再写入，且数据库记录与
 * 文件系统写入在失败时回滚，保证不会留下半写入状态。
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { SqliteDatabase } from "../db/database";
import { ProjectRegistry } from "../projects/registry";
import { WorkbenchError } from "../../shared/errors";
import {
  type AgentId,
  type DiffChoice,
  type PublishDiff,
  type PublishDiffEntry,
  type PublishReceipt,
  type SharedArtifactDTO,
} from "../../shared/contracts";
import { ConfigInventory } from "./inventory";

interface StoredDiff {
  projectId: string;
  targetAgentId: AgentId;
  artifacts: SharedArtifactDTO[];
}

interface PlanItem {
  artifact: SharedArtifactDTO;
  entry: PublishDiffEntry;
  choice: DiffChoice;
  sharedHash: string | null;
}

function hashBytes(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function hashFile(p: string): string | null {
  if (!fs.existsSync(p) || !fs.statSync(p).isFile()) return null;
  return hashBytes(fs.readFileSync(p));
}

function walk(dir: string, cb: (file: string, rel: string) => void, base: string = dir): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, cb, base);
    else if (entry.isFile()) cb(full, path.relative(base, full));
  }
}

function hashDir(dir: string): string | null {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null;
  const parts: { rel: string; h: string }[] = [];
  walk(dir, (file, rel) => parts.push({ rel, h: hashBytes(fs.readFileSync(file)) }));
  parts.sort((a, b) => a.rel.localeCompare(b.rel));
  const h = crypto.createHash("sha256");
  for (const p of parts) h.update(p.rel + "\0" + p.h + "\0");
  return h.digest("hex");
}

export class ConfigPublisher {
  private readonly registry: ProjectRegistry;
  private readonly diffs = new Map<string, StoredDiff>();

  constructor(private readonly db: SqliteDatabase) {
    this.registry = new ProjectRegistry(db);
  }

  /** 预览：对每个已知产物计算共享哈希、原生哈希与上次发布哈希，并给出状态。 */
  previewPublish(projectId: string, targetAgentId: AgentId): PublishDiff {
    const projectPath = this.resolveProjectPath(projectId);
    const artifacts = new ConfigInventory(this.db).scanArtifacts(projectId);
    const entries = this.buildEntries(artifacts, projectPath, targetAgentId).map((b) => b.entry);
    const diff: PublishDiff = {
      id: crypto.randomUUID(),
      projectId,
      targetAgentId,
      entries,
      createdAt: new Date().toISOString(),
    };
    this.diffs.set(diff.id, { projectId, targetAgentId, artifacts });
    return diff;
  }

  /**
   * 应用发布：按 choices 对每个条目执行对应策略。所有写操作在出错时回滚
   * （文件系统已写部分从备份恢复，数据库通过事务回滚）。
   */
  publish(diffId: string, choices: Record<string, DiffChoice>): PublishReceipt {
    const stored = this.diffs.get(diffId);
    if (!stored) throw new WorkbenchError("invalid_data", `未知 diff: ${diffId}`);
    const { projectId, targetAgentId, artifacts } = stored;
    const projectPath = this.resolveProjectPath(projectId);
    const backupDir = path.join(projectPath, ".agent-workbench", "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    const timestamp = Date.now().toString();
    const now = new Date().toISOString();

    // 仅处理用户明确选择的条目；未给出的视为 keep-native（不改动）。
    const plan: PlanItem[] = this.buildEntries(artifacts, projectPath, targetAgentId)
      .filter((b) => {
        const c = choices[b.entry.path];
        return c === "overwrite-with-shared" || c === "manual-merge";
      })
      .map((b) => ({ ...b, choice: choices[b.entry.path] as DiffChoice }));

    // 阶段 1：备份现有原生文件（仅读取 + 写入备份目录，安全）。
    const backups = new Map<string, string | null>();
    for (const item of plan) {
      backups.set(item.entry.path, this.backupNative(item.entry.path, backupDir, timestamp));
    }

    const written: string[] = [];
    try {
      // 阶段 2：写入原生文件（可能抛错，例如目标目录不可写）。
      for (const item of plan) {
        this.writeSharedToNative(item.artifact, item.entry.path, projectPath);
        written.push(item.entry.path);
      }
      // 阶段 3：记录上次发布哈希的侧车文件（供后续 preview 判定 conflict）。
      for (const item of plan) {
        const hp = path.join(backupDir, `pubhash-${item.artifact.id}.txt`);
        fs.writeFileSync(hp, item.sharedHash ?? "");
      }
      // 阶段 4：数据库事务写入 publications 与 published_at。
      this.db.transaction((tx) => {
        for (const item of plan) {
          const pubId = crypto.randomUUID();
          tx.run(
            `INSERT INTO publications (id, artifact_id, diff_id, applied_at, backup_path)
             VALUES (?, ?, ?, ?, ?)`,
            pubId,
            item.artifact.id,
            diffId,
            now,
            backups.get(item.entry.path) ?? null,
          );
          tx.run("UPDATE shared_artifacts SET published_at = ? WHERE id = ?", now, item.artifact.id);
        }
      });
    } catch (err) {
      // 文件系统或数据库失败：把已写入的原生文件从备份恢复（新文件则删除），
      // 数据库事务已在抛错时自动回滚。
      for (const nativePath of written) {
        const bk = backups.get(nativePath);
        if (bk && fs.existsSync(bk)) {
          this.copyPath(bk, nativePath);
        } else {
          try {
            fs.rmSync(nativePath, { recursive: true, force: true });
          } catch {
            /* 忽略清理失败 */
          }
        }
      }
      throw err;
    }

    const firstBackup = plan.length ? backups.get(plan[0].entry.path) ?? backupDir : backupDir;
    return {
      id: diffId,
      diffId,
      appliedChoices: choices,
      backupPath: firstBackup,
      appliedAt: now,
    };
  }

  /** 回滚一次发布：把每个产物的原生文件从备份恢复，并删除 publications 记录。 */
  rollback(receiptId: string): void {
    const stored = this.diffs.get(receiptId);
    const pubs = this.db.getRows("SELECT * FROM publications WHERE diff_id = ?", receiptId);
    if (pubs.length === 0) return;

    for (const pub of pubs) {
      const artifactRow = this.db.getRow(
        "SELECT project_id, kind, name FROM shared_artifacts WHERE id = ?",
        pub.artifact_id,
      );
      if (!artifactRow) continue;
      const projectPath = this.resolveProjectPath(String(artifactRow.project_id));
      const agentId: AgentId = stored ? stored.targetAgentId : "workbuddy";
      const artifact: SharedArtifactDTO = {
        id: String(pub.artifact_id),
        projectId: String(artifactRow.project_id),
        kind: artifactRow.kind as SharedArtifactDTO["kind"],
        name: String(artifactRow.name),
        scope: "project",
        targetAgents: [],
        version: 1,
        createdAt: "",
        publishedAt: null,
        sourcePath: undefined,
      };
      const nativePath = this.nativeTargetFor(artifact, projectPath, agentId);
      const backupPath = pub.backup_path ? String(pub.backup_path) : null;

      if (backupPath && fs.existsSync(backupPath)) {
        this.copyPath(backupPath, nativePath);
      } else {
        // 该产物是首次发布（之前没有原生文件），回滚即删除已发布的文件。
        try {
          fs.rmSync(nativePath, { recursive: true, force: true });
        } catch {
          /* 忽略 */
        }
      }

      // 清理侧车哈希并复位 published_at
      try {
        fs.rmSync(path.join(projectPath, ".agent-workbench", "backups", `pubhash-${pub.artifact_id}.txt`), {
          force: true,
        });
      } catch {
        /* 忽略 */
      }
      this.db.run("UPDATE shared_artifacts SET published_at = NULL WHERE id = ?", pub.artifact_id);
      this.db.run("DELETE FROM publications WHERE id = ?", pub.id);
    }
  }

  private resolveProjectPath(projectId: string): string {
    const project = this.registry.getProject(projectId);
    if (!project) throw new WorkbenchError("invalid_data", `未知项目: ${projectId}`);
    return project.path;
  }

  private nativeTargetFor(
    artifact: SharedArtifactDTO,
    projectPath: string,
    agentId: AgentId,
  ): string {
    if (artifact.kind === "skill") {
      return path.join(projectPath, ".agent-workbench", "skills", artifact.name);
    }
    if (agentId === "claude-code") return path.join(projectPath, "CLAUDE.md");
    if (agentId === "codex") return path.join(projectPath, "AGENTS.md");
    return path.join(projectPath, `.${agentId}.md`);
  }

  private sharedPathFor(artifact: SharedArtifactDTO, projectPath: string): string {
    const sp = artifact.sourcePath;
    if (sp && fs.existsSync(sp)) return sp;
    return path.join(projectPath, ".agent-workbench", artifact.kind, artifact.name);
  }

  private lastPublishedHash(artifactId: string, projectPath: string): string | null {
    const hp = path.join(projectPath, ".agent-workbench", "backups", `pubhash-${artifactId}.txt`);
    if (fs.existsSync(hp)) {
      try {
        const content = fs.readFileSync(hp, "utf8").trim();
        return content || null;
      } catch {
        return null;
      }
    }
    return null;
  }

  private buildEntries(
    artifacts: SharedArtifactDTO[],
    projectPath: string,
    targetAgentId: AgentId,
  ): { artifact: SharedArtifactDTO; entry: PublishDiffEntry; sharedHash: string | null }[] {
    return artifacts.map((artifact) => {
      const nativePath = this.nativeTargetFor(artifact, projectPath, targetAgentId);
      const sharedPath = this.sharedPathFor(artifact, projectPath);
      const isDir = artifact.kind === "skill";
      const sharedHash = isDir ? hashDir(sharedPath) : hashFile(sharedPath);
      const nativeHash = isDir ? hashDir(nativePath) : hashFile(nativePath);
      const lastPublishedHash = this.lastPublishedHash(artifact.id, projectPath);

      let status: PublishDiffEntry["status"];
      if (nativeHash === null && sharedHash !== null) status = "new";
      else if (sharedHash !== null && nativeHash !== null && sharedHash === nativeHash)
        status = "identical";
      else if (
        nativeHash !== null &&
        sharedHash !== null &&
        nativeHash !== sharedHash &&
        lastPublishedHash !== null
      )
        status = "conflict";
      else status = "changed";

      return {
        artifact,
        sharedHash,
        entry: { path: nativePath, status, sharedHash, nativeHash, lastPublishedHash },
      };
    });
  }

  private backupNative(nativePath: string, backupDir: string, timestamp: string): string | null {
    if (fs.existsSync(nativePath)) {
      const rel = path.basename(nativePath).replace(/[^a-zA-Z0-9._-]/g, "_");
      const dest = path.join(backupDir, `${timestamp}-${rel}`);
      this.copyPath(nativePath, dest);
      return dest;
    }
    return null;
  }

  private writeSharedToNative(
    artifact: SharedArtifactDTO,
    nativePath: string,
    projectPath: string,
  ): void {
    const sharedPath = this.sharedPathFor(artifact, projectPath);
    if (artifact.kind === "skill") {
      fs.rmSync(nativePath, { recursive: true, force: true });
      this.copyDir(sharedPath, nativePath);
    } else {
      const content = fs.readFileSync(sharedPath);
      fs.mkdirSync(path.dirname(nativePath), { recursive: true });
      const tmp = `${nativePath}.tmp-${process.pid}-${Date.now()}`;
      fs.writeFileSync(tmp, content);
      fs.renameSync(tmp, nativePath); // 原子替换，避免半写入
    }
  }

  private copyPath(src: string, dest: string): void {
    const st = fs.statSync(src);
    if (st.isDirectory()) this.copyDir(src, dest);
    else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    }
  }

  private copyDir(src: string, dest: string): void {
    fs.rmSync(dest, { recursive: true, force: true });
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const s = path.join(src, entry.name);
      const d = path.join(dest, entry.name);
      if (entry.isDirectory()) this.copyDir(s, d);
      else fs.copyFileSync(s, d);
    }
  }
}
