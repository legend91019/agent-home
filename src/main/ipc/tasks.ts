import { AppContext } from "../services";
import { AgentId, RunDTO, TaskDTO } from "../../shared/contracts";
import { WorkbenchError } from "../../shared/errors";

export async function listTasks(
  ctx: AppContext,
  input: { projectId: string },
): Promise<TaskDTO[]> {
  return ctx.tasks.listTasks(input.projectId);
}

export async function createTask(
  ctx: AppContext,
  input: { projectId: string; title: string; goal: string },
): Promise<TaskDTO> {
  return ctx.tasks.createTask(input.projectId, input.title, input.goal);
}

export async function startRun(
  ctx: AppContext,
  input: { taskId: string; agentId: AgentId; sessionId?: string },
): Promise<RunDTO> {
  return ctx.tasks.startRun(input.taskId, input.agentId, { sessionId: input.sessionId });
}

export async function interruptRun(
  ctx: AppContext,
  input: { runId: string },
): Promise<{ ok: boolean }> {
  return ctx.tasks.interruptRun(input.runId);
}

export async function respondPermission(
  ctx: AppContext,
  input: { runId: string; toolCallId: string; optionId: string | null },
): Promise<{ ok: boolean }> {
  return ctx.tasks.respondPermission(input.runId, input.toolCallId, input.optionId);
}

export async function runState(
  ctx: AppContext,
  input: { runId: string },
): Promise<RunDTO> {
  const r = ctx.tasks.getRun(input.runId);
  if (!r) throw new WorkbenchError("invalid_data", "Run 不存在");
  return r;
}
