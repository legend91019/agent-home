import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { mkdtempSync } from "node:fs";
import { makeDb, seedProject } from "../helpers/db";
import { SqliteDatabase } from "../../src/main/db/database";
import { MemoryInventory } from "../../src/main/memory/inventory";
import { MemoryTransfer } from "../../src/main/memory/transfer";
import { ConfigPublisher } from "../../src/main/config/publisher";

function tmpProject(): string {
  return mkdtempSync(path.join(os.tmpdir(), "cw-mem-"));
}

describe("MemoryInventory + MemoryTransfer", () => {
  let db: SqliteDatabase;
  let dir: string;
  let inventory: MemoryInventory;
  let transfer: MemoryTransfer;

  beforeEach(() => {
    db = makeDb();
    dir = tmpProject();
    seedProject(db, "p1", dir);
    inventory = new MemoryInventory(db);
    transfer = new MemoryTransfer(db, new ConfigPublisher(db));
  });
  afterEach(() => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("(a) original text + source preserved in MemoryEntryDTO after import", () => {
    const e = inventory.importMemory("claude-code", "p1", "meeting-notes.md", "remember to ship v2", "project");
    expect(e.originalText).toBe("remember to ship v2");
    expect(e.source).toBe("meeting-notes.md");
    expect(e.scope).toBe("project");
    expect(e.published).toBe(false);
  });

  it("(b) importing the same text twice does NOT create a duplicate", () => {
    const a = inventory.importMemory("claude-code", "p1", "src.md", "dup-text", "project");
    const b = inventory.importMemory("claude-code", "p1", "src.md", "dup-text", "project");
    expect(b.id).toBe(a.id);
    const rows = db.getRows("SELECT * FROM memory_entries WHERE source = ? AND original_text = ?", "src.md", "dup-text");
    expect(rows).toHaveLength(1);
  });

  it("(c) publishing with scope 'project' does NOT auto-upgrade to global", () => {
    const e = inventory.importMemory("claude-code", "p1", "scope.md", "scope-text", "project");
    const diff = transfer.previewMemoryTransfer([e.id], "codex", "project_guidance");
    transfer.applyMemoryTransfer(diff.id);
    const row = db.getRow("SELECT scope, published FROM memory_entries WHERE id = ?", e.id)!;
    expect(String(row.scope)).toBe("project");
    expect(Number(row.published)).toBe(1);
  });

  it("(d) preview.nativeWriteSupported is false by default", () => {
    const e = inventory.importMemory("claude-code", "p1", "nw.md", "nw-text", "project");
    const diff = transfer.previewMemoryTransfer([e.id], "codex", "project_guidance");
    expect(diff.nativeWriteSupported).toBe(false);
  });

  it("(e) if applyMemoryTransfer is NOT called, the target guidance file is NOT created", () => {
    const e = inventory.importMemory("claude-code", "p1", "cancel.md", "cancel-text", "project");
    transfer.previewMemoryTransfer([e.id], "codex", "project_guidance");
    const targetFile = path.join(dir, ".agent-workbench", "memory", "codex.md");
    expect(fs.existsSync(targetFile)).toBe(false);
    // 确认 preview 本身不会创建文件
    expect(fs.existsSync(path.dirname(targetFile))).toBe(false);
  });

  it("项目原生规则条目可直接预览并转移为目标任务指导文件", () => {
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), "只在本项目修改登录模块", "utf8");
    const native = inventory.listVisibleMemories("p1", "claude-code").find((entry) => entry.id.startsWith("native:"));
    expect(native).toBeDefined();
    const diff = transfer.previewMemoryTransfer([native!.id], "codex", "project_guidance");
    expect(diff.previewText).toContain("只在本项目修改登录模块");
    transfer.applyMemoryTransfer(diff.id);
    expect(fs.readFileSync(path.join(dir, ".agent-workbench", "memory", "codex.md"), "utf8")).toContain("只在本项目修改登录模块");
  });

  it("WorkBuddy 的项目指令可作为用户选择的记忆来源", () => {
    fs.writeFileSync(path.join(dir, "CODEBUDDY.md"), "只使用项目批准的依赖", "utf8");
    const source = inventory.listVisibleMemories("p1", "workbuddy");
    expect(source).toHaveLength(1);
    expect(source[0]).toMatchObject({ agentId: "workbuddy", originalText: "只使用项目批准的依赖" });
    const diff = transfer.previewMemoryTransfer([source[0].id], "codex", "project_guidance");
    expect(diff.previewText).toContain("只使用项目批准的依赖");
  });

  it("未知来源条目不能生成空白转移", () => {
    expect(() => transfer.previewMemoryTransfer(["unknown"], "codex", "project_guidance")).toThrow("记忆条目不可用");
  });

  it("预览后原生记忆变动时拒绝发布旧快照", () => {
    const source = path.join(dir, "CLAUDE.md");
    fs.writeFileSync(source, "old", "utf8");
    const native = inventory.listVisibleMemories("p1", "claude-code")[0];
    const diff = transfer.previewMemoryTransfer([native.id], "codex", "project_guidance");
    fs.writeFileSync(source, "new", "utf8");
    expect(() => transfer.applyMemoryTransfer(diff.id)).toThrow("来源记忆已变化");
    expect(fs.existsSync(path.join(dir, ".agent-workbench", "memory", "codex.md"))).toBe(false);
  });

  it("已发布来源发生新变化时清单显示最新内容且撤销已发布标识", () => {
    const source = path.join(dir, "CLAUDE.md");
    fs.writeFileSync(source, "old", "utf8");
    const native = inventory.listVisibleMemories("p1", "claude-code")[0];
    transfer.applyMemoryTransfer(transfer.previewMemoryTransfer([native.id], "codex", "project_guidance").id);
    fs.writeFileSync(source, "new", "utf8");
    const latest = inventory.listVisibleMemories("p1", "claude-code")[0];
    expect(latest.originalText).toBe("new");
    expect(latest.published).toBe(false);
  });
});
