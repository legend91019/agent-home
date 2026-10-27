/**
 * 原始记录存档：把可见会话事件按源顺序完整存入不可变快照（handoff_messages），
 * 并计算源快照内容哈希。删改副本不影响这里的数据（设计 5）。
 */
import { createHash, randomUUID } from "node:crypto";
import { SqliteDatabase } from "../db/database";
import { SessionRef, VisibleEvent } from "../../shared/contracts";

export interface ArchiveRef {
  handoffId: string;
  snapshotHash: string;
  messageCount: number;
}

function canonicalRow(e: VisibleEvent): string {
  return [
    e.role,
    e.timestamp,
    e.nativeId ?? "",
    e.text ?? "",
    JSON.stringify(e.toolCalls ?? []),
    JSON.stringify(e.attachments ?? []),
  ].join("");
}

export async function archiveSession(
  db: SqliteDatabase,
  source: AsyncIterable<VisibleEvent>,
  session: SessionRef,
  projectId: string,
): Promise<ArchiveRef> {
  const handoffId = randomUUID();
  const rows: string[] = [];
  let idx = 0;
  // 先建 handoffs 占位行以满足 handoff_messages 的外键约束，消息写完后回填快照哈希。
  db.run(
    `INSERT INTO handoffs
      (id, project_id, source_agent_id, target_agent_id, source_session_id, source_message_count, source_snapshot_hash, manifest_path, created_at, consumed)
     VALUES (?, ?, ?, NULL, ?, ?, '', ?, ?, 0)`,
    handoffId,
    projectId,
    session.agentId,
    session.id,
    session.messageCount ?? null,
    `${handoffId}.json`,
    new Date().toISOString(),
  );
  for await (const ev of source) {
    const toolCalls = JSON.stringify(ev.toolCalls ?? []);
    const attachments = JSON.stringify(ev.attachments ?? []);
    db.run(
      `INSERT INTO handoff_messages
        (handoff_id, idx, role, timestamp, native_id, text, tool_calls, attachments, redacted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      handoffId,
      idx,
      ev.role,
      ev.timestamp,
      ev.nativeId ?? null,
      ev.text ?? null,
      toolCalls,
      attachments,
      ev.redacted ? 1 : 0,
    );
    rows.push(canonicalRow({ ...ev, toolCalls: ev.toolCalls ?? [], attachments: ev.attachments ?? [] }));
    idx++;
  }
  const snapshotHash = "sha256-" + createHash("sha256").update(rows.join("\n")).digest("hex");
  db.run("UPDATE handoffs SET source_snapshot_hash = ? WHERE id = ?", snapshotHash, handoffId);
  return { handoffId, snapshotHash, messageCount: idx };
}
