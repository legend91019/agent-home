import { AppContext } from "../services";
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
import { createPackage, consumePackage, getSummary } from "../handoff/package";
import { searchPackage, verifyPackage } from "../handoff/search";

export async function createHandoff(
  ctx: AppContext,
  input: { projectId: string; session: SessionRef; edits?: HandoffEdit[] },
): Promise<HandoffSummary> {
  const adapter = ctx.adapters.get(input.session.agentId);
  const source = adapter.readVisibleSession(input.session);
  const ref = await archiveSession(ctx.db, source, input.session, input.projectId);
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

export async function consumeHandoff(
  ctx: AppContext,
  input: { handoffId: string; targetAgentId: AgentId; goal: string },
): Promise<RunDTO> {
  const summary = getSummary(ctx.db, input.handoffId);
  consumePackage(ctx.db, input.handoffId, input.targetAgentId);
  const task = ctx.tasks.createTask(
    summary.projectId,
    `交接自 ${summary.sourceAgentId}`,
    input.goal,
  );
  return ctx.tasks.startRun(task.id, input.targetAgentId, { handoffId: input.handoffId });
}
