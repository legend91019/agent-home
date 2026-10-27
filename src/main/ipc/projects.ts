import { AppContext } from "../services";
import { ProjectDTO, CapabilityReport, SessionRef, AgentId } from "../../shared/contracts";
import { WorkbenchError } from "../../shared/errors";

export async function listProjects(ctx: AppContext): Promise<ProjectDTO[]> {
  return ctx.projects.listProjects();
}

export async function registerProject(
  ctx: AppContext,
  input: { path: string },
): Promise<ProjectDTO> {
  return ctx.projects.registerProject(input.path);
}

export async function getProject(
  ctx: AppContext,
  input: { id: string },
): Promise<ProjectDTO | null> {
  return ctx.projects.getProject(input.id);
}

export async function capabilities(
  ctx: AppContext,
  input: { projectId: string },
): Promise<CapabilityReport[]> {
  const p = ctx.projects.getProject(input.projectId);
  if (!p) throw new WorkbenchError("invalid_data", "项目不存在");
  return ctx.adapters.probeAll(input.projectId, p.path);
}

export async function listSessions(
  ctx: AppContext,
  input: { projectId: string; agentId: AgentId },
): Promise<SessionRef[]> {
  const p = ctx.projects.getProject(input.projectId);
  if (!p) throw new WorkbenchError("invalid_data", "项目不存在");
  const adapter = ctx.adapters.get(input.agentId);
  return adapter.listSessions(p.path);
}
