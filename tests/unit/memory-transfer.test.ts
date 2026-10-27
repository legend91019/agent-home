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
});
