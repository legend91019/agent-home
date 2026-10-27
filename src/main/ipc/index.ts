import { AppContext } from "../services";
import { IpcChannel } from "../../shared/contracts";
import { WorkbenchError } from "../../shared/errors";
import * as projects from "./projects";
import * as config from "./config";
import * as memory from "./memory";
import * as handoff from "./handoff";
import * as tasks from "./tasks";
import * as workflow from "./workflow";
import * as merge from "./merge";
import * as usage from "./usage";

// IPC 边界：input 在边界处统一以 any 接收，内部各 handler 负责按契约解析与校验。
export async function handle(
  ctx: AppContext,
  channel: IpcChannel,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: any,
): Promise<unknown> {
  switch (channel) {
    case "projects.list":
      return projects.listProjects(ctx);
    case "projects.register":
      return projects.registerProject(ctx, input);
    case "projects.get":
      return projects.getProject(ctx, input);
    case "projects.capabilities":
      return projects.capabilities(ctx, input);
    case "sessions.list":
      return projects.listSessions(ctx, input);
    case "workbuddy.importSession":
      return projects.importWorkBuddySession(ctx, input);
    case "config.scan":
      return config.scanConfig(ctx, input);
    case "config.previewPublish":
      return config.previewPublish(ctx, input);
    case "config.publish":
      return config.publish(ctx, input);
    case "config.rollback":
      return config.rollback(ctx, input);
    case "memory.list":
      return memory.listMemories(ctx, input);
    case "memory.previewTransfer":
      return memory.previewTransfer(ctx, input);
    case "memory.applyTransfer":
      return memory.applyTransfer(ctx, input);
    case "handoff.create":
      return handoff.createHandoff(ctx, input);
    case "handoff.search":
      return handoff.searchHandoff(ctx, input);
    case "handoff.integrity":
      return handoff.integrityHandoff(ctx, input);
    case "handoff.summary":
      return handoff.summaryHandoff(ctx, input);
    case "handoff.findings":
      return handoff.findingsHandoff(ctx, input);
    case "handoff.edit":
      return handoff.editHandoff(ctx, input);
    case "handoff.consume":
      return handoff.consumeHandoff(ctx, input);
    case "tasks.list":
      return tasks.listTasks(ctx, input);
    case "tasks.create":
      return tasks.createTask(ctx, input);
    case "tasks.startRun":
      return tasks.startRun(ctx, input);
    case "tasks.interrupt":
      return tasks.interruptRun(ctx, input);
    case "tasks.state":
      return tasks.runState(ctx, input);
    case "workflow.start":
      return workflow.startWorkflow(ctx, input);
    case "workflow.get":
      return workflow.getWorkflow(ctx, input);
    case "workflow.advance":
      return workflow.advanceWorkflow(ctx, input);
    case "workflow.pause":
      return workflow.pauseWorkflow(ctx, input);
    case "workflow.resume":
      return workflow.resumeWorkflow(ctx, input);
    case "workflow.approve":
      return workflow.approveWorkflowNode(ctx, input);
    case "workflow.retry":
      return workflow.retryWorkflowNode(ctx, input);
    case "merge.create":
      return merge.createMerge(ctx, input);
    case "merge.refresh":
      return merge.refreshMerge(ctx, input);
    case "merge.apply":
      return merge.applyMerge(ctx, input);
    case "usage.summary":
      return usage.usageSummary(ctx, input);
    case "usage.skills":
      return usage.skillUsage(ctx, input);
    case "recovery.reconcile":
      return usage.reconcile(ctx);
    default:
      throw new WorkbenchError("unknown", `未知 IPC 通道: ${String(channel)}`);
  }
}
