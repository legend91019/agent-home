/**
 * 交接包检索与完整性校验。支持按区间、角色、关键词检索原文，
 * 首轮只给目标 Agent 索引，完整历史仍可逐段读取（设计 5）。
 */
import { SqliteDatabase } from "../db/database";
import {
  EventRole,
  HandoffEdit,
  IntegrityReport,
  SessionRef,
  VisibleEvent,
} from "../../shared/contracts";
import { WorkbenchError } from "../../shared/errors";
import { LARGE_ATTACHMENT_BYTES } from "./package";

function rowToEvent(row: Record<string, unknown>): VisibleEvent {
  return {
    index: Number(row.idx),
    role: row.role as EventRole,
    timestamp: String(row.timestamp),
    nativeId: row.native_id ? String(row.native_id) : undefined,
    text: row.text ? String(row.text) : undefined,
    toolCalls: row.tool_calls ? JSON.parse(String(row.tool_calls)) : undefined,
    attachments: row.attachments ? JSON.parse(String(row.attachments)) : undefined,
    redacted: Number(row.redacted) === 1,
  };
}

/** 不可变源快照（忽略用户删改）。 */
export function readSnapshot(db: SqliteDatabase, handoffId: string): VisibleEvent[] {
  return db
    .getRows(
      "SELECT * FROM handoff_messages WHERE handoff_id = ? ORDER BY idx ASC",
      handoffId,
    )
    .map(rowToEvent);
}

function readEdits(db: SqliteDatabase, handoffId: string): Map<number, HandoffEdit> {
  const map = new Map<number, HandoffEdit>();
  for (const row of db.getRows(
    "SELECT * FROM handoff_edits WHERE handoff_id = ?",
    handoffId,
  )) {
    map.set(Number(row.idx), {
      eventIndex: Number(row.idx),
      text: (row.text as string | null) ?? null,
      removeAttachments: row.removed_attachments
        ? JSON.parse(String(row.removed_attachments))
        : [],
    });
  }
  return map;
}

/** 应用用户删改后的副本（源快照不变）。 */
export function readCopy(db: SqliteDatabase, handoffId: string): VisibleEvent[] {
  const edits = readEdits(db, handoffId);
  return readSnapshot(db, handoffId)
    .map((ev) => {
      const ed = edits.get(ev.index);
      if (!ed) return ev;
      if (ed.text === null) return null; // 用户删除该事件
      const atts = (ev.attachments ?? []).filter(
        (a) => !(ed.removeAttachments ?? []).includes(a.name),
      );
      return { ...ev, text: ed.text, attachments: atts.length ? atts : ev.attachments };
    })
    .filter((e): e is VisibleEvent => e !== null);
}

export function readRange(
  db: SqliteDatabase,
  handoffId: string,
  from: number,
  to: number,
): VisibleEvent[] {
  return readCopy(db, handoffId).filter((e) => e.index >= from && e.index <= to);
}

export function searchPackage(
  db: SqliteDatabase,
  handoffId: string,
  query: string,
  role?: EventRole,
): VisibleEvent[] {
  const q = query.toLowerCase();
  return readCopy(db, handoffId).filter((e) => {
    if (role && e.role !== role) return false;
    const hay = [
      e.text ?? "",
      ...(e.toolCalls ?? []).map((t) => `${t.name} ${t.inputSummary} ${t.outputSummary}`),
    ]
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
}

/** 完整性报告：读取条数、与源记录的差异、缺失/过大附件、是否完整。 */
export function verifyPackage(db: SqliteDatabase, handoffId: string): IntegrityReport {
  const row = db.getRow("SELECT * FROM handoffs WHERE id = ?", handoffId);
  if (!row) throw new WorkbenchError("invalid_data", `交接包不存在: ${handoffId}`);
  const countRow = db.getRow(
    "SELECT COUNT(*) AS c FROM handoff_messages WHERE handoff_id = ?",
    handoffId,
  );
  const readCount = Number(countRow?.c ?? 0);
  const sourceCount = row.source_message_count != null ? Number(row.source_message_count) : null;

  const missing: string[] = [];
  if (sourceCount !== null && readCount < sourceCount) {
    missing.push(`读取条数少于源记录：已读 ${readCount} / 源 ${sourceCount}`);
  }

  const largeAttachments: string[] = [];
  for (const ev of readSnapshot(db, handoffId)) {
    for (const a of ev.attachments ?? []) {
      if (a.available === false) missing.push(`缺失附件: ${a.name}`);
      if (a.sizeBytes != null && a.sizeBytes > LARGE_ATTACHMENT_BYTES) {
        largeAttachments.push(`${a.name} (${(a.sizeBytes / 1_000_000).toFixed(1)}MB)`);
      }
    }
  }

  const sessionRef: SessionRef = {
    agentId: row.source_agent_id as SessionRef["agentId"],
    id: String(row.source_session_id),
    messageCount: sourceCount ?? 0,
  };

  const complete = sourceCount !== null && readCount === sourceCount && missing.length === 0;

  return {
    sessionRef,
    readCount,
    sourceCount,
    missing,
    largeAttachments,
    complete,
    checkedAt: new Date().toISOString(),
  };
}
