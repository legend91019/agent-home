import { AppContext } from "../services";
import { ProjectDTO, CapabilityReport, SessionRef, AgentId } from "../../shared/contracts";
import { WorkbenchError } from "../../shared/errors";
import { WorkBuddyAdapter } from "../adapters/workbuddy";
import { DeepSeekAdapter } from "../adapters/deepseek";

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

export async function importWorkBuddySession(
  ctx: AppContext,
  input: { projectId: string; filePath: string },
): Promise<SessionRef> {
  const project = ctx.projects.getProject(input.projectId);
  if (!project) throw new WorkbenchError("invalid_data", "项目不存在");
  if (typeof input.filePath !== "string" || !input.filePath.trim())
    throw new WorkbenchError("invalid_data", "请选择要导入的 WorkBuddy 会话文件");
  const adapter = ctx.adapters.get("workbuddy");
  if (!(adapter instanceof WorkBuddyAdapter))
    throw new WorkbenchError("unsupported_version", "WorkBuddy 适配器不可用");
  return adapter.importSession(project.path, input.filePath);
}

export async function pickDeepSeekExport(): Promise<string | null> {
  const { dialog } = await import('electron');
  const result = await dialog.showOpenDialog({
    title: '选择 DeepSeek Harness 官方会话导出',
    properties: ['openFile'],
    filters: [{ name: 'dsh 会话导出', extensions: ['zip', 'md'] }],
  });
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

export async function importDeepSeekSession(
  ctx: AppContext,
  input: { projectId: string; filePath: string },
): Promise<SessionRef> {
  const project = ctx.projects.getProject(input.projectId);
  if (!project) throw new WorkbenchError('invalid_data', '项目不存在');
  if (typeof input.filePath !== 'string' || !input.filePath.trim())
    throw new WorkbenchError('invalid_data', '请选择 dsh 官方会话导出文件');
  const adapter = ctx.adapters.get('deepseek-harness');
  if (!(adapter instanceof DeepSeekAdapter)) throw new WorkbenchError('unsupported_version', 'DeepSeek Harness 适配器不可用');
  return adapter.importSession(project.path, input.filePath);
}
