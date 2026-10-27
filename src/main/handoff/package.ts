/**
 * 交接包：在不可变源快照之上叠加用户删改副本（handoff_edits），
 * 生成完整性报告，并支持在确认后选定目标 Agent 接续（consume）。
 * 源快照哈希不受副本删改影响。
 */
import { SqliteDatabase } from "../db/database";
import { AgentId, HandoffEdit, HandoffSummary, IntegrityReport } from "../../shared/contracts";
import { WorkbenchError } from "../../shared/errors";
import { verifyPackage } from "./search";

const LARGE_ATTACHMENT_BYTES = 5_000_000;

export function createPackage(
  db: SqliteDatabase,
  handoffId: string,
  edits: HandoffEdit[] = [],
): HandoffSummary {
  for (const e of edits) {
    db.run(
      "INSERT OR REPLACE INTO handoff_edits (handoff_id, idx, text, removed_attachments) VALUES (?, ?, ?, ?)",
      handoffId,
      e.eventIndex,
      e.text,
      JSON.stringify(e.removeAttachments ?? []),
    );
  }
  return getSummary(db, handoffId);
}

/** 预览后逐项保存交接副本删改；未提交的旧删改保持有效。 */
export function applyPackageEdits(
  db: SqliteDatabase,
  handoffId: string,
  edits: HandoffEdit[],
): HandoffSummary {
  const row = db.getRow("SELECT consumed FROM handoffs WHERE id = ?", handoffId);
  if (!row) throw new WorkbenchError("invalid_data", `交接包不存在: ${handoffId}`);
  if (Number(row.consumed) === 1) throw new WorkbenchError("invalid_data", "已分发的交接包不可修改");
  const indexes = new Set(
    db.getRows("SELECT idx FROM handoff_messages WHERE handoff_id = ?", handoffId)
      .map((entry) => Number(entry.idx)),
  );
  for (const edit of edits) {
    if (!Number.isInteger(edit.eventIndex) || !indexes.has(edit.eventIndex)) {
      throw new WorkbenchError("invalid_data", `交接消息序号不存在: ${edit.eventIndex}`);
    }
    if (edit.text !== null && typeof edit.text !== "string") {
      throw new WorkbenchError("invalid_data", "交接副本文本格式错误");
    }
    if (edit.removeAttachments && !Array.isArray(edit.removeAttachments)) {
      throw new WorkbenchError("invalid_data", "附件删改格式错误");
    }
  }
  db.transaction((tx) => {
    for (const edit of edits) {
      tx.run(
        "INSERT OR REPLACE INTO handoff_edits (handoff_id, idx, text, removed_attachments) VALUES (?, ?, ?, ?)",
        handoffId,
        edit.eventIndex,
        edit.text,
        JSON.stringify(edit.removeAttachments ?? []),
      );
    }
  });
  return getSummary(db, handoffId);
}

export function getSummary(db: SqliteDatabase, handoffId: string): HandoffSummary {
  const row = db.getRow("SELECT * FROM handoffs WHERE id = ?", handoffId);
  if (!row) throw new WorkbenchError("invalid_data", `交接包不存在: ${handoffId}`);
  const countRow = db.getRow(
    "SELECT COUNT(*) AS c FROM handoff_messages WHERE handoff_id = ?",
    handoffId,
  );
  const messageCount = Number(countRow?.c ?? 0);
  const integrity: IntegrityReport = verifyPackage(db, handoffId);
  return {
    id: handoffId,
    projectId: String(row.project_id),
    sourceAgentId: row.source_agent_id as AgentId,
    targetAgentId: row.target_agent_id ? (row.target_agent_id as AgentId) : null,
    sourceSessionId: String(row.source_session_id),
    createdAt: String(row.created_at),
    sourceSnapshotHash: String(row.source_snapshot_hash),
    messageCount,
    integrity,
    consumed: Number(row.consumed) === 1,
  };
}

/** 源会话保持不变；仅在用户确认后记录目标 Agent 并标记已消费。 */
export function consumePackage(
  db: SqliteDatabase,
  handoffId: string,
  targetAgentId: AgentId,
): void {
  const row = db.getRow("SELECT id, consumed FROM handoffs WHERE id = ?", handoffId);
  if (!row) throw new WorkbenchError("invalid_data", `交接包不存在: ${handoffId}`);
  if (Number(row.consumed) === 1) throw new WorkbenchError("conflict", "交接包已分发");
  db.run(
    "UPDATE handoffs SET target_agent_id = ?, consumed = 1 WHERE id = ?",
    targetAgentId,
    handoffId,
  );
}

export { LARGE_ATTACHMENT_BYTES };
