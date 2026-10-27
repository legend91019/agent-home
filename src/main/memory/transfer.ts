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
    const entries = entryIds
      .map((id) => this.inventory.getEntry(id))
      .filter((e): e is MemoryEntryDTO => e !== null);
    const previewText = entries.map((e) => `[${e.source}] ${e.originalText}`).join("\n\n");
    const nativeWriteSupported = opts?.nativeWriteSupported ?? false;
    const projectId = entries.length ? (entries[0].projectId ?? null) : null;

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

    // 仅写入工作台托管的 guidance 文件；绝不改写 Agent 的原生自动记忆文件。
    const memDir = path.join(projectPath, ".agent-workbench", "memory");
    fs.mkdirSync(memDir, { recursive: true });
    const fileName =
      destination === "task_context" ? `${targetAgentId}-task.md` : `${targetAgentId}.md`;
    const targetFile = path.join(memDir, fileName);

    const tmp = `${targetFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, previewText);
    fs.renameSync(tmp, targetFile); // 原子写入

    const now = new Date().toISOString();
    this.db.transaction((tx) => {
      for (const id of entryIds) {
        tx.run("UPDATE memory_entries SET published = 1 WHERE id = ?", id);
      }
    });

    return {
      id: crypto.randomUUID(),
      diffId,
      appliedChoices: {},
      backupPath: targetFile,
      appliedAt: now,
    };
  }
}
