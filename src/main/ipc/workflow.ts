import { AppContext } from "../services";
import { WorkflowDef, WorkflowRunDTO } from "../../shared/contracts";

export async function startWorkflow(
  ctx: AppContext,
  input: { taskId: string; definition: WorkflowDef },
): Promise<WorkflowRunDTO> {
  return ctx.workflows.startWorkflow(input.taskId, input.definition);
}

export async function advanceWorkflow(
  ctx: AppContext,
  input: { workflowRunId: string },
): Promise<WorkflowRunDTO> {
  return ctx.workflows.advanceWorkflow(input.workflowRunId);
}

export async function getWorkflow(
  ctx: AppContext,
  input: { workflowRunId: string },
): Promise<WorkflowRunDTO | null> {
  return ctx.workflows.getWorkflow(input.workflowRunId);
}

export async function pauseWorkflow(
  ctx: AppContext,
  input: { workflowRunId: string },
): Promise<{ ok: boolean }> {
  ctx.workflows.pauseScheduling(input.workflowRunId);
  return { ok: true };
}

export async function resumeWorkflow(
  ctx: AppContext,
  input: { workflowRunId: string },
): Promise<WorkflowRunDTO> {
  ctx.workflows.resumeScheduling(input.workflowRunId);
  return ctx.workflows.getWorkflow(input.workflowRunId)!;
}

export async function approveWorkflowNode(
  ctx: AppContext,
  input: { workflowRunId: string; nodeId: string },
): Promise<WorkflowRunDTO> {
  return ctx.workflows.approveNode(input.workflowRunId, input.nodeId);
}

export async function retryWorkflowNode(
  ctx: AppContext,
  input: { workflowRunId: string; nodeId: string },
): Promise<WorkflowRunDTO> {
  return ctx.workflows.retryNode(input.workflowRunId, input.nodeId);
}
