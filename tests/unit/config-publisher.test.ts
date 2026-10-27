import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { mkdtempSync } from "node:fs";
import { makeDb, seedProject } from "../helpers/db";
import { SqliteDatabase } from "../../src/main/db/database";
import { ConfigInventory } from "../../src/main/config/inventory";
import { ConfigPublisher } from "../../src/main/config/publisher";

const FIXTURE = path.resolve(__dirname, "../fixtures/config-drift");

function tmpProject(): string {
  return mkdtempSync(path.join(os.tmpdir(), "cw-config-"));
}

function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function sha256File(p: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");
}

// 用 'antigravity' 作为目标 Agent，其原生目标为 <root>/.antigravity.md，
// 该路径不会被 scanArtifacts 当作 rule 自动发现，避免重复产物干扰。
const AGENT = "antigravity" as const;

describe("ConfigPublisher", () => {
  let db: SqliteDatabase;
  let dir: string;

  beforeEach(() => {
    db = makeDb();
    dir = tmpProject();
    seedProject(db, "p1", dir);
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

  it("(a) new publish creates native file from shared content", () => {
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), "SHARED CONTENT");
    const inventory = new ConfigInventory(db);
    inventory.scanArtifacts("p1");
    const publisher = new ConfigPublisher(db);
    const diff = publisher.previewPublish("p1", AGENT);
    expect(diff.entries).toHaveLength(1);
    expect(diff.entries[0].status).toBe("new");

    const receipt = publisher.publish(diff.id, { [diff.entries[0].path]: "overwrite-with-shared" });
    const native = path.join(dir, ".antigravity.md");
    expect(fs.existsSync(native)).toBe(true);
    expect(fs.readFileSync(native, "utf8")).toBe("SHARED CONTENT");
    expect(receipt.diffId).toBe(diff.id);
    // 发布记录已写入
    const pubs = db.getRows("SELECT * FROM publications WHERE diff_id = ?", diff.id);
    expect(pubs).toHaveLength(1);
  });

  it("(b) native externally modified before publish -> changed or conflict", () => {
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), "SHARED");
    fs.writeFileSync(path.join(dir, ".antigravity.md"), "MODIFIED-BY-USER");
    const publisher = new ConfigPublisher(db);
    const diff = publisher.previewPublish("p1", AGENT);
    expect(diff.entries).toHaveLength(1);
    expect(["changed", "conflict"]).toContain(diff.entries[0].status);
  });

  it("(c) both sides changed -> conflict, overwrite-with-shared restores shared bytes", () => {
    // 初始：shared=A，发布到 native（new）
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), "A");
    const publisher = new ConfigPublisher(db);
    const d1 = publisher.previewPublish("p1", AGENT);
    publisher.publish(d1.id, { [d1.entries[0].path]: "overwrite-with-shared" });
    expect(fs.readFileSync(path.join(dir, ".antigravity.md"), "utf8")).toBe("A");

    // 两边同时改变：shared -> B，native -> C
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), "B");
    fs.writeFileSync(path.join(dir, ".antigravity.md"), "C");

    const d2 = publisher.previewPublish("p1", AGENT);
    expect(d2.entries[0].status).toBe("conflict");

    publisher.publish(d2.id, { [d2.entries[0].path]: "overwrite-with-shared" });
    expect(fs.readFileSync(path.join(dir, ".antigravity.md"), "utf8")).toBe("B");
  });

  it("(d) write failure mid-way leaves no partial/corrupt state and rollback works", () => {
    // rule 产物（会被先写入）+ 一个 skill 产物（写入会失败）
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), "SHARED");
    fs.writeFileSync(path.join(dir, ".antigravity.md"), "ORIGINAL"); // rule 原生预存在
    fs.mkdirSync(path.join(dir, "my-skill"));
    fs.writeFileSync(path.join(dir, "my-skill", "SKILL.md"), "skill body");

    // 把 .agent-workbench/skills 建成一个【文件】，使 skill 原生目标目录
    // 的父级不是目录，从而在 copyDir 时稳定抛 ENOTDIR（跨平台可靠）。
    fs.mkdirSync(path.join(dir, ".agent-workbench"), { recursive: true });
    fs.writeFileSync(path.join(dir, ".agent-workbench", "skills"), "i-am-a-file-not-dir");

    const publisher = new ConfigPublisher(db);
    // 先成功发布一次 rule，得到可回滚的 receipt
    const dr = publisher.previewPublish("p1", AGENT);
    const rulePath = dr.entries.find((e) => e.path.endsWith(".antigravity.md"))!.path;
    const receipt1 = publisher.publish(dr.id, { [rulePath]: "overwrite-with-shared" });
    expect(fs.readFileSync(path.join(dir, ".antigravity.md"), "utf8")).toBe("SHARED");

    // 再次发布，但 skill 写入会失败
    const dr2 = publisher.previewPublish("p1", AGENT);
    const skillEntry = dr2.entries.find((e) => e.path.includes("skills" + path.sep + "my-skill"))!;
    expect(skillEntry).toBeTruthy();

    let threw = false;
    try {
      publisher.publish(dr2.id, { [skillEntry.path]: "overwrite-with-shared" });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // 失败后 rule 原生文件保持发布后的内容（未被损坏/部分写入）
    expect(fs.readFileSync(path.join(dir, ".antigravity.md"), "utf8")).toBe("SHARED");
    // 失败的发布没有留下 publications 记录（事务已回滚）
    expect(db.getRows("SELECT * FROM publications WHERE diff_id = ?", dr2.id)).toHaveLength(0);

    // 回滚先前的成功发布仍然可用
    publisher.rollback(receipt1.id);
    expect(fs.readFileSync(path.join(dir, ".antigravity.md"), "utf8")).toBe("ORIGINAL");
    expect(db.getRows("SELECT * FROM publications WHERE diff_id = ?", receipt1.id)).toHaveLength(0);
  });

  it("(e) rollback restores byte-identical original", () => {
    fs.writeFileSync(path.join(dir, "CLAUDE.md"), "NEW-SHARED");
    fs.writeFileSync(path.join(dir, ".antigravity.md"), "ORIGINAL-CONTENT");
    const origHash = sha256File(path.join(dir, ".antigravity.md"));

    const publisher = new ConfigPublisher(db);
    const diff = publisher.previewPublish("p1", AGENT);
    const receipt = publisher.publish(diff.id, { [diff.entries[0].path]: "overwrite-with-shared" });
    expect(fs.readFileSync(path.join(dir, ".antigravity.md"), "utf8")).toBe("NEW-SHARED");

    publisher.rollback(receipt.id);
    expect(fs.existsSync(path.join(dir, ".antigravity.md"))).toBe(true);
    expect(sha256File(path.join(dir, ".antigravity.md"))).toBe(origHash);
    expect(db.getRows("SELECT * FROM publications WHERE diff_id = ?", diff.id)).toHaveLength(0);
  });

  it("(f) skill directory with a resource file is copied when published (uses fixture)", () => {
    copyDir(FIXTURE, dir);
    const inventory = new ConfigInventory(db);
    const artifacts = inventory.scanArtifacts("p1");
    const skill = artifacts.find((a) => a.kind === "skill" && a.name === "my-skill");
    expect(skill).toBeTruthy();

    const publisher = new ConfigPublisher(db);
    const diff = publisher.previewPublish("p1", "claude-code");
    const skillEntry = diff.entries.find((e) => e.path.endsWith(path.join("skills", "my-skill")))!;
    expect(skillEntry).toBeTruthy();

    publisher.publish(diff.id, { [skillEntry.path]: "overwrite-with-shared" });
    const nativeSkill = path.join(dir, ".agent-workbench", "skills", "my-skill");
    expect(fs.existsSync(path.join(nativeSkill, "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(nativeSkill, "icon.png"))).toBe(true);
    // 资源内容原样保留
    expect(fs.readFileSync(path.join(nativeSkill, "icon.png"), "utf8")).toBe("PNG-ICON-BYTES-SAMPLE");
  });
});
