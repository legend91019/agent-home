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
  const row = db.getRow("SELECT id FROM handoffs WHERE id = ?", handoffId);
  if (!row) throw new WorkbenchError("invalid_data", `交接包不存在: ${handoffId}`);
  db.run(
    "UPDATE handoffs SET target_agent_id = ?, consumed = 1 WHERE id = ?",
    targetAgentId,
    handoffId,
  );
}

export { LARGE_ATTACHMENT_BYTES };
