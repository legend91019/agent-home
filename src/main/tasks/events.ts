/**
 * Run 事件记录与读取。事件用于审计、断点续跑与用量统计去重。
 * run_events 表仅持久化 (id, run_id, type, payload, created_at)，payload 为 JSON 文本。
 */
import * as crypto from "node:crypto";
import { SqliteDatabase } from "../db/database";

export interface RunEventRecord {
  type: string;
  payload: unknown;
  createdAt: string;
}

/** 记录一条 Run 事件（每次调用都会落库，不做幂等判断）。 */
export function recordRunEvent(
  db: SqliteDatabase,
  runId: string,
  type: string,
  payload: unknown,
): void {
  db.run(
    `INSERT INTO run_events (id, run_id, type, payload, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    crypto.randomUUID(),
    runId,
    type,
    JSON.stringify(payload ?? null),
    new Date().toISOString(),
  );
}

/** 读取某 Run 的全部事件，按时间升序。payload 反序列化为原始对象。 */
export function getRunEvents(db: SqliteDatabase, runId: string): RunEventRecord[] {
  const rows = db.getRows(
    `SELECT type, payload, created_at FROM run_events
     WHERE run_id = ? ORDER BY created_at ASC, rowid ASC`,
    runId,
  );
  return rows.map((row) => ({
    type: String(row.type),
    payload: JSON.parse(String(row.payload)),
    createdAt: String(row.created_at),
  }));
}

/**
 * 幂等记录 Run 事件：以 eventId 作为 run_events 主键。
 * 若已存在同 eventId 的行则跳过，返回 false；否则插入并返回 true。
 * 用于防止适配器重复投递的同一事件被重复计数。
 */
export function recordRunEventIdempotent(
  db: SqliteDatabase,
  runId: string,
  eventId: string,
  type: string,
  payload: unknown,
): boolean {
  const existing = db.getRow("SELECT id FROM run_events WHERE id = ?", eventId);
  if (existing) return false;
  db.run(
    `INSERT INTO run_events (id, run_id, type, payload, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    eventId,
    runId,
    type,
    JSON.stringify(payload ?? null),
    new Date().toISOString(),
  );
  return true;
}
