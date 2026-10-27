import { AppContext } from "../services";
import { MergeDecision, MergeProposalDTO } from "../../shared/contracts";

export async function createMerge(
  ctx: AppContext,
  input: { workflowRunId: string },
): Promise<MergeProposalDTO> {
  return ctx.merge.createMergeProposal(input.workflowRunId);
}

export async function refreshMerge(
  ctx: AppContext,
  input: { proposalId: string },
): Promise<MergeProposalDTO> {
  return ctx.merge.refreshProposal(input.proposalId);
}

export async function applyMerge(
  ctx: AppContext,
  input: { proposalId: string; decision: MergeDecision },
): Promise<{ ok: boolean; message: string }> {
  return ctx.merge.applyProposal(input.proposalId, input.decision);
}
