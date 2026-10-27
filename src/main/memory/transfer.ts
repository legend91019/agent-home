/**
 * 记忆转移：把若干已导入记忆条目组合成一段指引文本，并（按需）写入项目的
 * guidance 文件。默认不会改写目标 Agent 的原生自动记忆文件（除非显式声明
 * nativeWriteSupported，本实现亦仅以此开关保护，实际写入仍只落 guidance 文件）。
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { SqliteDatabase } from "../db/database";
import { ProjectRegistry } from "../projects/registry";
import { WorkbenchError } from "../../shared/errors";
import {
  type AgentId,
  type MemoryDestination,
  type MemoryEntryDTO,
  type MemoryTransferDiff,
  type PublishReceipt,
} from "../../shared/contracts";
import { MemoryInventory } from "./inventory";
import { ConfigPublisher } from "../config/publisher";

interface StoredTransfer {
  entryIds: string[];
  targetAgentId: AgentId;
  destination: MemoryDestination;
  nativeWriteSupported: boolean;
  previewText: string;
  projectId: string | null;
}

export class MemoryTransfer {
  private readonly inventory: MemoryInventory;
  private readonly registry: ProjectRegistry;
  private readonly diffs = new Map<string, StoredTransfer>();

  constructor(
    private readonly db: SqliteDatabase,
    _publisher: ConfigPublisher,
  ) {
    this.inventory = new MemoryInventory(db);
    this.registry = new ProjectRegistry(db);
  }

  previewMemoryTransfer(
    entryIds: string[],
    targetAgentId: AgentId,
    destination: MemoryDestination,
    opts?: { nativeWriteSupported?: boolean },
  ): MemoryTransferDiff {
    const entries = entryIds.map((id) => this.inventory.getEntry(id));
    if (entries.length === 0 || entries.some((entry) => entry === null)) {
      throw new WorkbenchError("invalid_data", "记忆条目不可用，请刷新来源清单");
    }
    const validEntries = entries as MemoryEntryDTO[];
    const projectIds = new Set(validEntries.map((entry) => entry.projectId));
    if (projectIds.size !== 1 || validEntries[0].projectId === null) {
      throw new WorkbenchError("invalid_data", "一次转移只能包含同一项目的记忆");
    }
    const previewText = validEntries.map((e) => `[${e.source}] ${e.originalText}`).join("\n\n");
    const nativeWriteSupported = opts?.nativeWriteSupported ?? false;
    const projectId = validEntries[0].projectId;

    const diff: MemoryTransferDiff = {
      id: crypto.randomUUID(),
      entryIds,
      targetAgentId,
      destination,
      nativeWriteSupported,
      previewText,
      createdAt: new Date().toISOString(),
    };
    this.diffs.set(diff.id, {
      entryIds,
      targetAgentId,
      destination,
      nativeWriteSupported,
      previewText,
      projectId,
    });
    return diff;
  }

  applyMemoryTransfer(diffId: string): PublishReceipt {
    const stored = this.diffs.get(diffId);
    if (!stored) throw new WorkbenchError("invalid_data", `未知 transfer diff: ${diffId}`);
    const { entryIds, targetAgentId, destination, previewText } = stored;
    const projectId = stored.projectId;
    if (!projectId) {
      throw new WorkbenchError("invalid_data", "记忆转移需要关联一个项目");
    }
    const project = this.registry.getProject(projectId);
    if (!project) throw new WorkbenchError("invalid_data", `未知项目: ${projectId}`);
    const projectPath = project.path;
    const currentEntries = entryIds.map((id) => this.inventory.getEntry(id));
    if (currentEntries.some((entry) => entry === null) ||
        currentEntries.map((entry) => `[${entry!.source}] ${entry!.originalText}`).join("\n\n") !== previewText) {
      throw new WorkbenchError("conflict", "来源记忆已变化，请重新预览");
    }

    // 仅写入工作台托管的 guidance 文件；绝不改写 Agent 的原生自动记忆文件。
    const memDir = path.join(projectPath, ".agent-workbench", "memory");
    fs.mkdirSync(memDir, { recursive: true });
    const fileName =
      destination === "task_context" ? `${targetAgentId}-task.md` : `${targetAgentId}.md`;
    const targetFile = path.join(memDir, fileName);

    const now = new Date().toISOString();
    const original = fs.existsSync(targetFile) ? fs.readFileSync(targetFile) : null;
    const backupPath = original === null ? null : `${targetFile}.bak-${crypto.randomUUID()}`;
    const tmp = `${targetFile}.tmp-${crypto.randomUUID()}`;
    if (backupPath) fs.writeFileSync(backupPath, original!);
    try {
      fs.writeFileSync(tmp, previewText, "utf8");
      fs.renameSync(tmp, targetFile);
      this.db.transaction((tx) => {
        for (const id of entryIds) {
          const entry = this.inventory.getEntry(id);
          if (!entry) throw new WorkbenchError("invalid_data", "记忆条目在发布前已失效");
          const persisted = id.startsWith("native:")
            ? this.inventory.importMemory(entry.agentId, entry.projectId, entry.source, entry.originalText, entry.scope)
            : entry;
          tx.run("UPDATE memory_entries SET published = 1 WHERE id = ?", persisted.id);
        }
      });
    } catch (error) {
      if (original === null) fs.rmSync(targetFile, { force: true });
      else fs.writeFileSync(targetFile, original);
      fs.rmSync(tmp, { force: true });
      throw error;
    }
    this.diffs.delete(diffId);

    return {
      id: crypto.randomUUID(),
      diffId,
      appliedChoices: {},
      backupPath: backupPath ?? targetFile,
      appliedAt: now,
    };
  }
}
