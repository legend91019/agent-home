import { AppContext } from "../services";
import {
  AgentId,
  MemoryDestination,
  MemoryEntryDTO,
  MemoryTransferDiff,
  PublishReceipt,
} from "../../shared/contracts";

export async function listMemories(
  ctx: AppContext,
  input: { projectId: string; agentId: AgentId },
): Promise<MemoryEntryDTO[]> {
  return ctx.memory.listVisibleMemories(input.projectId, input.agentId);
}

export async function previewTransfer(
  ctx: AppContext,
  input: { entryIds: string[]; targetAgentId: AgentId; destination: MemoryDestination },
): Promise<MemoryTransferDiff> {
  return ctx.memoryTransfer.previewMemoryTransfer(
    input.entryIds,
    input.targetAgentId,
    input.destination,
  );
}

export async function applyTransfer(
  ctx: AppContext,
  input: { diffId: string },
): Promise<PublishReceipt> {
  return ctx.memoryTransfer.applyMemoryTransfer(input.diffId);
}
