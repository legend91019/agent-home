import { AppContext } from "../services";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  AgentId,
  EventRole,
  HandoffEdit,
  HandoffSummary,
  IntegrityReport,
  RunDTO,
  SessionRef,
  VisibleEvent,
} from "../../shared/contracts";
import { archiveSession } from "../handoff/archive";
import { createPackage, consumePackage, getSummary, applyPackageEdits } from "../handoff/package";
import { readCopy, searchPackage, verifyPackage } from "../handoff/search";
import { WorkbenchError } from "../../shared/errors";

const consumingHandoffs = new Set<string>();

export async function createHandoff(
  ctx: AppContext,
  input: { projectId: string; session: SessionRef; edits?: HandoffEdit[] },
): Promise<HandoffSummary> {
  const project = ctx.projects.getProject(input.projectId);
  if (!project) throw new WorkbenchError("invalid_data", "项目不存在");
  const adapter = ctx.adapters.get(input.session.agentId);
  const sessions = await adapter.listSessions(project.path);
  const discovered = sessions.find((session) => session.id === input.session.id);
  if (!discovered) throw new WorkbenchError("session_unavailable", "源会话不属于当前项目或已不可读取");
  const source = adapter.readVisibleSession(discovered);
  const ref = await archiveSession(ctx.db, source, discovered, input.projectId);
  return createPackage(ctx.db, ref.handoffId, input.edits ?? []);
}

export async function searchHandoff(
  ctx: AppContext,
  input: { handoffId: string; query: string; role?: EventRole },
): Promise<VisibleEvent[]> {
  return searchPackage(ctx.db, input.handoffId, input.query, input.role);
}

export async function integrityHandoff(
  ctx: AppContext,
  input: { handoffId: string },
): Promise<IntegrityReport> {
  return verifyPackage(ctx.db, input.handoffId);
}

export async function summaryHandoff(
  ctx: AppContext,
  input: { handoffId: string },
): Promise<HandoffSummary> {
  return getSummary(ctx.db, input.handoffId);
}

export async function findingsHandoff(
  ctx: AppContext,
  input: { handoffId: string },
) {
  getSummary(ctx.db, input.handoffId);
  return ctx.redaction.scanCopy(input.handoffId);
}

export async function editHandoff(
  ctx: AppContext,
  input: { handoffId: string; edits: HandoffEdit[] },
): Promise<HandoffSummary> {
  return applyPackageEdits(ctx.db, input.handoffId, input.edits);
}

export async function consumeHandoff(
  ctx: AppContext,
  input: { handoffId: string; targetAgentId: AgentId; goal: string },
): Promise<RunDTO> {
  if (consumingHandoffs.has(input.handoffId)) {
    throw new WorkbenchError("conflict", "交接包正在分发");
  }
  consumingHandoffs.add(input.handoffId);
  try {
  const summary = getSummary(ctx.db, input.handoffId);
  if (summary.consumed) throw new WorkbenchError("conflict", "交接包已分发");
  const handoffDir = path.join(ctx.dataDir, "handoffs");
  await fs.mkdir(handoffDir, { recursive: true });
  const safeName = createHash("sha256").update(input.handoffId).digest("hex");
  const handoffPath = path.join(handoffDir, `${safeName}.json`);
  const tempPath = path.join(handoffDir, `${safeName}.${randomUUID()}.tmp`);
  const contents = JSON.stringify({
    format: "agent-workbench-visible-history-v1",
    sourceAgentId: summary.sourceAgentId,
    sourceSessionId: summary.sourceSessionId,
    sourceSnapshotHash: summary.sourceSnapshotHash,
    events: readCopy(ctx.db, input.handoffId),
  });
  try {
    await fs.writeFile(tempPath, contents, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tempPath, handoffPath);
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
  const task = ctx.tasks.createTask(
    summary.projectId,
    `交接自 ${summary.sourceAgentId}`,
    input.goal,
  );
  const run = await ctx.tasks.startRun(task.id, input.targetAgentId, {
    handoffId: input.handoffId,
    handoffPath,
  });
  consumePackage(ctx.db, input.handoffId, input.targetAgentId);
  return run;
  } finally {
    consumingHandoffs.delete(input.handoffId);
  }
}
