import { AppContext } from "../services";
import { AgentId, DiffChoice, PublishDiff, PublishReceipt, SharedArtifactDTO } from "../../shared/contracts";

export async function scanConfig(
  ctx: AppContext,
  input: { projectId: string },
): Promise<SharedArtifactDTO[]> {
  return ctx.config.scanArtifacts(input.projectId);
}

export async function previewPublish(
  ctx: AppContext,
  input: { projectId: string; targetAgentId: AgentId },
): Promise<PublishDiff> {
  return ctx.publisher.previewPublish(input.projectId, input.targetAgentId);
}

export async function publish(
  ctx: AppContext,
  input: { diffId: string; choices: Record<string, DiffChoice> },
): Promise<PublishReceipt> {
  return ctx.publisher.publish(input.diffId, input.choices);
}

export async function rollback(
  ctx: AppContext,
  input: { receiptId: string },
): Promise<{ ok: boolean }> {
  ctx.publisher.rollback(input.receiptId);
  return { ok: true };
}
