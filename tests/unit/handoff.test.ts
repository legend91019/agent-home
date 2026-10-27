import { describe, it, expect } from "vitest";
import { makeDb, seedProject } from "../helpers/db";
import { archiveSession } from "../../src/main/handoff/archive";
import { createPackage, getSummary } from "../../src/main/handoff/package";
import { readSnapshot, readCopy, searchPackage, verifyPackage } from "../../src/main/handoff/search";
import { SessionRef, VisibleEvent } from "../../src/shared/contracts";

function makeSource(count: number): AsyncIterable<VisibleEvent> {
  return (async function* () {
    for (let i = 0; i < count; i++) {
      yield {
        index: i,
        role: i % 2 === 0 ? "user" : "assistant",
        timestamp: new Date(2026, 0, 1, 0, 0, i).toISOString(),
        nativeId: `m${i}`,
        text: `message ${i} keyword-alpha beta-${i}`,
      };
    }
  })();
}

const session: SessionRef = {
  agentId: "claude-code",
  id: "sess-1",
  messageCount: 1000,
};

describe("handoff archive", () => {
  it("保留 1000 条消息且顺序稳定", async () => {
    const db = makeDb();
    seedProject(db);
    const ref = await archiveSession(db, makeSource(1000), session, "p1");
    expect(ref.messageCount).toBe(1000);
    const snap = readSnapshot(db, ref.handoffId);
    expect(snap).toHaveLength(1000);
    expect(snap[0].text).toBe("message 0 keyword-alpha beta-0");
    expect(snap[999].text).toBe("message 999 keyword-alpha beta-999");
    // 顺序稳定
    expect(snap.every((e, i) => e.index === i)).toBe(true);
  });

  it("重复导入内容幂等（快照哈希一致）", async () => {
    const db = makeDb();
    seedProject(db);
    const a = await archiveSession(db, makeSource(50), session, "p1");
    const b = await archiveSession(db, makeSource(50), session, "p1");
    expect(a.snapshotHash).toBe(b.snapshotHash);
    expect(a.handoffId).not.toBe(b.handoffId);
  });

  it("缺失附件标记 incomplete", async () => {
    const db = makeDb();
    seedProject(db);
    const src = (async function* () {
      yield {
        index: 0,
        role: "user" as const,
        timestamp: new Date().toISOString(),
        text: "here is a file",
        attachments: [
          { name: "secret.key", sizeBytes: 1024, kind: "file", available: false },
        ],
      };
    })();
    const ref = await archiveSession(db, src, { ...session, messageCount: 1 }, "p1");
    const report = verifyPackage(db, ref.handoffId);
    expect(report.complete).toBe(false);
    expect(report.missing.some((m) => m.includes("缺失附件"))).toBe(true);
  });

  it("用户删改只改变副本，源快照哈希不变", async () => {
    const db = makeDb();
    seedProject(db);
    const ref = await archiveSession(db, makeSource(10), session, "p1");
    const originalHash = getSummary(db, ref.handoffId).sourceSnapshotHash;
    const originalFirst = readSnapshot(db, ref.handoffId)[0].text;

    createPackage(db, ref.handoffId, [
      { eventIndex: 0, text: "EDITED COPY", removeAttachments: [] },
    ]);

    // 源快照不受影响
    expect(readSnapshot(db, ref.handoffId)[0].text).toBe(originalFirst);
    // 副本被修改
    expect(readCopy(db, ref.handoffId)[0].text).toBe("EDITED COPY");
    // 哈希不变
    expect(getSummary(db, ref.handoffId).sourceSnapshotHash).toBe(originalHash);
  });

  it("用户移除全部附件后，副本不再保留附件", async () => {
    const db = makeDb();
    seedProject(db);
    const source = (async function* (): AsyncIterable<VisibleEvent> {
      yield {
        index: 0,
        role: "user",
        timestamp: new Date().toISOString(),
        text: "attachment",
        attachments: [{ name: "a.txt", kind: "file", sizeBytes: 1, available: true }],
      };
    })();
    const ref = await archiveSession(db, source, { ...session, messageCount: 1 }, "p1");
    createPackage(db, ref.handoffId, [{ eventIndex: 0, text: "attachment", removeAttachments: ["a.txt"] }]);
    expect(readCopy(db, ref.handoffId)[0].attachments).toEqual([]);
  });

  it("检索能找到首条和末条", async () => {
    const db = makeDb();
    seedProject(db);
    const ref = await archiveSession(db, makeSource(1000), session, "p1");
    const first = searchPackage(db, ref.handoffId, "beta-0");
    const last = searchPackage(db, ref.handoffId, "beta-999");
    expect(first).toHaveLength(1);
    expect(first[0].index).toBe(0);
    expect(last).toHaveLength(1);
    expect(last[0].index).toBe(999);
  });

  it("快照被修改后完整性校验能发现哈希不一致", async () => {
    const db = makeDb();
    seedProject(db);
    const ref = await archiveSession(db, makeSource(2), { ...session, messageCount: 2 }, "p1");
    db.run("UPDATE handoff_messages SET text = ? WHERE handoff_id = ? AND idx = 0", "changed", ref.handoffId);
    const report = verifyPackage(db, ref.handoffId);
    expect(report.complete).toBe(false);
    expect(report.missing).toContain("源快照哈希不匹配");
  });

  it("源会话读取中途失败时不留下半成品交接包", async () => {
    const db = makeDb();
    seedProject(db);
    const source = (async function* (): AsyncIterable<VisibleEvent> {
      yield { index: 0, role: "user", timestamp: new Date().toISOString(), text: "first" };
      throw new Error("source read failed");
    })();
    await expect(archiveSession(db, source, session, "p1")).rejects.toThrow("source read failed");
    expect(db.getRows("SELECT id FROM handoffs")).toEqual([]);
    expect(db.getRows("SELECT handoff_id FROM handoff_messages")).toEqual([]);
  });

  it("源工具不提供总条数时明确标记无法独立核对", async () => {
    const db = makeDb();
    seedProject(db);
    const ref = await archiveSession(db, makeSource(2), { ...session, messageCount: 0 }, "p1");
    const report = verifyPackage(db, ref.handoffId);
    expect(report.sourceCount).toBeNull();
    expect(report.complete).toBe(false);
    expect(report.missing).toContain("源工具未提供总条数，无法独立核对完整性");
  });
});
