import { describe, it, expect } from "vitest";
import { makeDb, seedProject } from "../helpers/db";
import { SqliteDatabase } from "../../src/main/db/database";
import { UsageAggregator } from "../../src/main/usage/aggregate";

function base() {
  const db: SqliteDatabase = makeDb();
  seedProject(db, "p1", "/tmp/proj");
  const agg = new UsageAggregator(db);
  return { db, agg };
}

function seedRun(db: SqliteDatabase, runId = "r1", taskId = "t1", projectId = "p1") {
  const now = new Date().toISOString();
  db.run(
    "INSERT INTO tasks (id, project_id, title, goal, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    taskId,
    projectId,
    "t",
    "g",
    "draft",
    now,
    now,
  );
  db.run(
    "INSERT INTO runs (id, task_id, agent_id, status, created_at, updated_at, controllable) VALUES (?, ?, ?, ?, ?, ?, ?)",
    runId,
    taskId,
    "claude-code",
    "running",
    now,
    now,
    0,
  );
}

describe("UsageAggregator.ingestUsage + getUsage", () => {
  it("(a) 同一原生事件摄入两次只计一次", () => {
    const { agg } = base();
    const common = {
      agentId: "claude-code" as const,
      sourceType: "managed_event" as const,
      quality: "exact" as const,
      nativeSessionId: "sess-1",
      nativeEventId: "evt-1",
      recordedAt: "2026-01-01T00:00:00.000Z",
      inputTokens: 10,
      outputTokens: 20,
    };
    agg.ingestUsage(common);
    agg.ingestUsage(common);
    const summary = agg.getUsage({});
    expect(summary.events).toBe(1);
    expect(summary.inputTokens).toBe(10);
    expect(summary.outputTokens).toBe(20);
  });

  it("(b) null 的 token 字段在 summary 中保持 null", () => {
    const { agg } = base();
    agg.ingestUsage({
      agentId: "codex",
      sourceType: "manual_import",
      quality: "unknown",
      nativeSessionId: "s2",
      nativeEventId: "e2",
      recordedAt: "2026-01-02T00:00:00.000Z",
      inputTokens: null,
      outputTokens: 5,
    });
    const summary = agg.getUsage({});
    expect(summary.inputTokens).toBe(null);
    expect(summary.outputTokens).toBe(5);
  });

  it("(c) input/output/cache 分别求和不合并", () => {
    const { agg } = base();
    const mk = (o: { inputTokens?: number | null; outputTokens?: number | null; cacheTokens?: number | null; reasoningTokens?: number | null }) =>
      agg.ingestUsage({
        agentId: "claude-code",
        sourceType: "managed_event",
        quality: "exact",
        nativeSessionId: "s3",
        nativeEventId: `e3-${Math.random()}`,
        recordedAt: new Date().toISOString(),
        ...o,
      });
    mk({ inputTokens: 1, outputTokens: 2, cacheTokens: 3, reasoningTokens: 4 });
    mk({ inputTokens: 10, outputTokens: 20, cacheTokens: 30, reasoningTokens: 40 });
    mk({ inputTokens: 100, outputTokens: 200, cacheTokens: 300, reasoningTokens: 400 });
    const summary = agg.getUsage({});
    expect(summary.inputTokens).toBe(111);
    expect(summary.outputTokens).toBe(222);
    expect(summary.cacheTokens).toBe(333);
    expect(summary.reasoningTokens).toBe(444);
    expect(summary.events).toBe(3);
  });

  it("(d) 同一 session 两个入口导入不双算（dedupKey 相同）", () => {
    const { agg } = base();
    const dedupKey = "sess-x|evt-x|2026-01-04T00:00:00.000Z";
    agg.ingestUsage({
      agentId: "antigravity",
      sourceType: "documented_local_record",
      quality: "verified_import",
      nativeSessionId: "sess-x",
      nativeEventId: "evt-x",
      recordedAt: "2026-01-04T00:00:00.000Z",
      dedupKey,
      inputTokens: 7,
    });
    // 第二条来自不同入口（例如不同的 source_type），但 dedupKey 相同。
    agg.ingestUsage({
      agentId: "antigravity",
      sourceType: "manual_import",
      quality: "unknown",
      nativeSessionId: "sess-x",
      nativeEventId: "evt-x",
      recordedAt: "2026-01-04T00:00:00.000Z",
      dedupKey,
      inputTokens: 99,
    });
    const summary = agg.getUsage({});
    expect(summary.events).toBe(1);
    expect(summary.inputTokens).toBe(7); // 仅首条计入
  });

  it("(e) 发现的 skill 无调用证据 -> invoked 为空；记录调用后 invoked 包含它", () => {
    const { db, agg } = base();
    db.run(
      "INSERT INTO shared_artifacts (id, project_id, kind, name, scope, created_at, version) VALUES (?, ?, 'skill', ?, 'project', ?, 1)",
      "a1",
      "p1",
      "my-skill",
      new Date().toISOString(),
    );

    let summary = agg.getSkillUsage({ projectId: "p1" });
    expect(summary.discovered).toContain("my-skill");
    expect(summary.invoked.length).toBe(0);

    seedRun(db, "r-e", "t-e", "p1");
    agg.recordSkillInvocation("r-e", "my-skill");

    summary = agg.getSkillUsage({ projectId: "p1" });
    expect(summary.discovered).toContain("my-skill");
    expect(summary.invoked).toContain("my-skill");
  });

  it("项目 skill 调用统计不混入其他项目的运行事件", () => {
    const { db, agg } = base();
    seedProject(db, "p2", "/tmp/other-project");
    seedRun(db, "r-other", "t-other", "p2");
    agg.recordSkillInvocation("r-other", "other-only-skill");
    expect(agg.getSkillUsage({ projectId: "p1" }).invoked).not.toContain("other-only-skill");
    expect(agg.getSkillUsage({ projectId: "p2" }).invoked).toContain("other-only-skill");
  });

  it("byAgent 按 agent 聚合且 null 保持 null", () => {
    const { agg } = base();
    agg.ingestUsage({
      agentId: "claude-code",
      sourceType: "managed_event",
      quality: "exact",
      nativeSessionId: "s-b",
      nativeEventId: "e-b1",
      recordedAt: "2026-02-01T00:00:00.000Z",
      inputTokens: 10,
      outputTokens: 20,
    });
    agg.ingestUsage({
      agentId: "claude-code",
      sourceType: "managed_event",
      quality: "exact",
      nativeSessionId: "s-b",
      nativeEventId: "e-b2",
      recordedAt: "2026-02-02T00:00:00.000Z",
      inputTokens: null,
      outputTokens: 5,
    });
    agg.ingestUsage({
      agentId: "codex",
      sourceType: "manual_import",
      quality: "unknown",
      nativeSessionId: "s-b",
      nativeEventId: "e-b3",
      recordedAt: "2026-02-03T00:00:00.000Z",
      inputTokens: 100,
      outputTokens: null,
    });
    const summary = agg.getUsage({});
    expect(summary.byAgent["claude-code"].input).toBe(10); // 一行 null 不影响总和
    expect(summary.byAgent["claude-code"].output).toBe(25);
    expect(summary.byAgent["claude-code"].events).toBe(2);
    expect(summary.byAgent["codex"].input).toBe(100);
    expect(summary.byAgent["codex"].output).toBe(null);
    expect(summary.byAgent["codex"].events).toBe(1);
  });

  it("unknownCoverage 反映 null 占比", () => {
    const { agg } = base();
    // 行1：input=1, 其余 3 个 null -> 3 null
    agg.ingestUsage({
      agentId: "claude-code",
      sourceType: "managed_event",
      quality: "unknown",
      nativeSessionId: "s-u",
      nativeEventId: "e-u1",
      recordedAt: "2026-03-01T00:00:00.000Z",
      inputTokens: 1,
    });
    // 行2：全部 null -> 4 null
    agg.ingestUsage({
      agentId: "claude-code",
      sourceType: "managed_event",
      quality: "unknown",
      nativeSessionId: "s-u",
      nativeEventId: "e-u2",
      recordedAt: "2026-03-02T00:00:00.000Z",
    });
    const summary = agg.getUsage({});
    // 总计 8 个 token 字段，7 个为 null -> 0.875
    expect(summary.unknownCoverage).toBeCloseTo(7 / 8);
  });
});
