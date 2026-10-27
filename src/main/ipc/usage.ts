import { AppContext } from "../services";
import { RecoveryReport, UsageFilter, UsageSummary, SkillUsageSummary } from "../../shared/contracts";

export async function usageSummary(
  ctx: AppContext,
  input: { filter: UsageFilter },
): Promise<UsageSummary> {
  return ctx.usage.getUsage(input.filter);
}

export async function skillUsage(
  ctx: AppContext,
  input: { projectId: string },
): Promise<SkillUsageSummary> {
  return ctx.usage.getSkillUsage(input);
}

export async function reconcile(ctx: AppContext): Promise<RecoveryReport> {
  return ctx.recovery.reconcileOnStartup();
}
