/**
 * 用量聚合：从多处来源（托管事件、本地文档记录、手动导入）摄入 token 用量，
 * 提供去重摄入、按过滤条件聚合、以及 skill 调用证据记录与统计。
 *
 * 设计要点：
 * - 摄入幂等：相同 dedup_key 只记一次，避免同一原生事件被多入口重复统计。
 * - token 字段在 SQLite 中是 INTEGER，可为 NULL；NULL 必须保持 NULL，
 *   绝不可当作 0 参与求和或覆盖率计算。
 * - skill 调用以 run_events 中的 type='skill_invocation' 证据为准；
 *   仅"发现"目录中的 SKILL.md 不构成调用证据。
 */
import * as crypto from "node:crypto";
import type {
  AgentId,
  Quality,
  SkillUsageSummary,
  SourceType,
  UsageFilter,
  UsageSummary,
} from "../../shared/contracts";
import { SqliteDatabase } from "../db/database";

export interface UsageRecordInput {
  agentId: AgentId;
  projectId?: string;
  taskId?: string;
  runId?: string;
  model?: string;
  sourceType: SourceType; // 'managed_event' | 'documented_local_record' | 'manual_import'
  quality: Quality; // 'exact' | 'verified_import' | 'unknown'
  nativeSessionId?: string;
  nativeEventId?: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheTokens?: number | null;
  reasoningTokens?: number | null;
  recordedAt?: string; // ISO; default now
  dedupKey?: string; // if provided, used for dedup; else derived
  rawFields?: Record<string, unknown>; // original provider fields, stored as JSON
}

const TOKEN_COLUMNS = [
  "input_tokens",
  "output_tokens",
  "cache_tokens",
  "reasoning_tokens",
] as const;

export class UsageAggregator {
  constructor(private readonly db: SqliteDatabase) {}

  /** 摄入一条用量记录；若 dedup_key 已存在则幂等跳过。 */
  ingestUsage(record: UsageRecordInput): void {
    const recordedAt = record.recordedAt ?? new Date().toISOString();
    const dedupKey =
      record.dedupKey ??
      `${record.nativeSessionId ?? ""}|${record.nativeEventId ?? ""}|${recordedAt}`;

    // 幂等：相同 dedup_key 已存在则跳过（不双算）。
    const existing = this.db.getRow(
      "SELECT id FROM usage_records WHERE dedup_key = ?",
      dedupKey,
    );
    if (existing) return;

    const rawFields = record.rawFields ? JSON.stringify(record.rawFields) : null;

    this.db.run(
      `INSERT INTO usage_records (
        id, agent_id, project_id, task_id, run_id, model, source_type, quality,
        native_session_id, native_event_id, input_tokens, output_tokens,
        cache_tokens, reasoning_tokens, recorded_at, dedup_key, raw_fields
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      record.agentId,
      record.projectId ?? null,
      record.taskId ?? null,
      record.runId ?? null,
      record.model ?? null,
      record.sourceType,
      record.quality,
      record.nativeSessionId ?? null,
      record.nativeEventId ?? null,
      record.inputTokens ?? null,
      record.outputTokens ?? null,
      record.cacheTokens ?? null,
      record.reasoningTokens ?? null,
      recordedAt,
      dedupKey,
      rawFields,
    );
  }

  /** 按过滤条件聚合用量统计。 */
  getUsage(filter: UsageFilter): UsageSummary {
    const where: string[] = [];
    const params: unknown[] = [];

    if (filter.projectId !== undefined) {
      where.push("project_id = ?");
      params.push(filter.projectId);
    }
    if (filter.agentId !== undefined) {
      where.push("agent_id = ?");
      params.push(filter.agentId);
    }
    if (filter.model !== undefined) {
      where.push("model = ?");
      params.push(filter.model);
    }
    if (filter.taskId !== undefined) {
      where.push("task_id = ?");
      params.push(filter.taskId);
    }
    if (filter.runId !== undefined) {
      where.push("run_id = ?");
      params.push(filter.runId);
    }
    if (filter.from !== undefined) {
      where.push("recorded_at >= ?");
      params.push(filter.from);
    }
    if (filter.to !== undefined) {
      where.push("recorded_at <= ?");
      params.push(filter.to);
    }

    const sql =
      "SELECT * FROM usage_records" +
      (where.length ? " WHERE " + where.join(" AND ") : "");
    const rows = this.db.getRows(sql, ...params);

    // 总量（每个 token 字段：若全部为 null 则结果为 null，绝不退化为 0）。
    const inputTokens = this.sumNullable(rows, "input_tokens");
    const outputTokens = this.sumNullable(rows, "output_tokens");
    const cacheTokens = this.sumNullable(rows, "cache_tokens");
    const reasoningTokens = this.sumNullable(rows, "reasoning_tokens");

    // 按 agent 聚合。
    const acc = new Map<
      string,
      { inputSum: number; inputAny: boolean; outputSum: number; outputAny: boolean; events: number }
    >();
    for (const r of rows) {
      const aid = String(r.agent_id);
      let a = acc.get(aid);
      if (!a) {
        a = { inputSum: 0, inputAny: false, outputSum: 0, outputAny: false, events: 0 };
        acc.set(aid, a);
      }
      a.events++;
      const it = r.input_tokens as number | null;
      if (it !== null && it !== undefined) {
        a.inputSum += it;
        a.inputAny = true;
      }
      const ot = r.output_tokens as number | null;
      if (ot !== null && ot !== undefined) {
        a.outputSum += ot;
        a.outputAny = true;
      }
    }
    const byAgent: Record<string, { input: number | null; output: number | null; events: number }> = {};
    for (const [aid, a] of acc) {
      byAgent[aid] = {
        input: a.inputAny ? a.inputSum : null,
        output: a.outputAny ? a.outputSum : null,
        events: a.events,
      };
    }

    // 未知覆盖率：在所有行的 4 个 token 字段中，为 null 的比例。
    let nullCount = 0;
    let total = 0;
    for (const r of rows) {
      for (const col of TOKEN_COLUMNS) {
        total++;
        const v = r[col] as number | null;
        if (v === null || v === undefined) nullCount++;
      }
    }
    const unknownCoverage = rows.length === 0 ? 0 : nullCount / total;

    return {
      inputTokens,
      outputTokens,
      cacheTokens,
      reasoningTokens,
      events: rows.length,
      unknownCoverage,
      byAgent,
    };
  }

  /** 记录一次 skill 实际调用证据（发现本身不算调用）。 */
  recordSkillInvocation(runId: string, skillName: string): void {
    this.db.run(
      `INSERT INTO run_events (id, run_id, type, payload, created_at)
       VALUES (?, ?, 'skill_invocation', ?, ?)`,
      crypto.randomUUID(),
      runId,
      JSON.stringify({ skill: skillName }),
      new Date().toISOString(),
    );
  }

  /** 统计已发现的 skill 与有实际调用证据的 skill。 */
  getSkillUsage(filter: { projectId?: string }): SkillUsageSummary {
    const discParams: unknown[] = [];
    let discSql = "SELECT name FROM shared_artifacts WHERE kind = 'skill'";
    if (filter.projectId !== undefined) {
      discSql += " AND project_id = ?";
      discParams.push(filter.projectId);
    }
    const discoveredRows = this.db.getRows(discSql, ...discParams);
    const discovered = discoveredRows.map((r) => String(r.name));

    const invokedRows = filter.projectId === undefined
      ? this.db.getRows("SELECT DISTINCT payload FROM run_events WHERE type = 'skill_invocation'")
      : this.db.getRows(
        `SELECT DISTINCT events.payload FROM run_events AS events
         JOIN runs ON runs.id = events.run_id
         JOIN tasks ON tasks.id = runs.task_id
         WHERE events.type = 'skill_invocation' AND tasks.project_id = ?`,
        filter.projectId,
      );
    const invoked: string[] = [];
    const seen = new Set<string>();
    for (const r of invokedRows) {
      const payload = r.payload as string;
      try {
        const parsed = JSON.parse(payload) as { skill?: string };
        const name = parsed.skill;
        if (typeof name === "string" && !seen.has(name)) {
          seen.add(name);
          invoked.push(name);
        }
      } catch {
        // 损坏的 payload 跳过，不计入调用证据。
      }
    }

    return { discovered, invoked };
  }

  private sumNullable(
    rows: Record<string, unknown>[],
    col: (typeof TOKEN_COLUMNS)[number],
  ): number | null {
    let sum = 0;
    let any = false;
    for (const r of rows) {
      const v = r[col] as number | null;
      if (v !== null && v !== undefined) {
        sum += v;
        any = true;
      }
    }
    return any ? sum : null;
  }
}
