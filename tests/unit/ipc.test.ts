import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createContext, type AppContext } from "../../src/main/services";
import { AdapterRegistry } from "../../src/main/adapters/registry";
import { BaseAdapter } from "../../src/main/adapters/types";
import type { RunHandle, StartTaskInput } from "../../src/main/adapters/types";
import { handle } from "../../src/main/ipc";
import type {
  AgentId,
  CapabilityReport,
  SessionRef,
  VisibleEvent,
} from "../../src/shared/contracts";

const NOW = new Date().toISOString();

class FakeAdapter extends BaseAdapter {
  readonly id: AgentId;
  readonly displayName = "Fake";
  lastInput: StartTaskInput | null = null;
  failStart = false;
  firstMessage = "hello";
  constructor(id: AgentId) {
    super();
    this.id = id;
  }
  async probe(): Promise<CapabilityReport> {
    return {
      agentId: this.id,
      agentName: "Fake",
      installed: true,
      authenticated: true,
      checkedAt: NOW,
      capabilities: [
        this.entry("tasks.start", "supported", "fake"),
        this.entry("tasks.interrupt", "unsupported", "fake-no-interrupt"),
      ],
    };
  }
  async listSessions(projectPath: string): Promise<SessionRef[]> {
    return ["s1", "s2"].map((id) => ({ agentId: this.id, id, messageCount: 2, nativeProjectPath: projectPath }));
  }
  async *readVisibleSession(): AsyncIterable<VisibleEvent> {
    yield { index: 0, role: "user", timestamp: NOW, text: this.firstMessage };
    yield { index: 1, role: "assistant", timestamp: NOW, text: "world" };
  }
  async startTask(input: StartTaskInput): Promise<RunHandle> {
    this.lastInput = input;
    if (this.failStart) throw new Error("无法启动目标 Agent");
    return { runId: "fake-run", nativeSessionId: "fake-native", startedAt: NOW };
  }
}

function buildContext(): { ctx: AppContext; dir: string; projPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "awb-ipc-"));
  // 先建一个上下文拿到 db，再用假适配器注册表重建（覆盖默认真实适配器）。
  const base = createContext(dir);
  const reg = new AdapterRegistry(base.db);
  reg.register(new FakeAdapter("claude-code"));
  reg.register(new FakeAdapter("codex"));
  const ctx = createContext(dir, reg);
  const projPath = fs.mkdtempSync(path.join(os.tmpdir(), "awb-proj-"));
  return { ctx, dir, projPath };
}

describe("ipc integration", () => {
  let ctx: AppContext;
  let projPath: string;
  beforeEach(() => {
    const b = buildContext();
    ctx = b.ctx;
    projPath = b.projPath;
  });

  it("projects.register then tasks.create + startRun via fake adapter", async () => {
    const proj = (await handle(ctx, "projects.register", { path: projPath })) as {
      id: string;
    };
    expect(proj.id).toBeTruthy();

    const task = (await handle(ctx, "tasks.create", {
      projectId: proj.id,
      title: "t",
      goal: "g",
    })) as { id: string };
    expect(task.id).toBeTruthy();

    const run = (await handle(ctx, "tasks.startRun", {
      taskId: task.id,
      agentId: "claude-code",
    })) as { status: string; controllable: boolean };
    expect(run.status).toBe("running");
    expect(run.controllable).toBe(false); // 假适配器未实现 interrupt
  });

  it("handoff.create archives, search finds, consume starts target run", async () => {
    const proj = (await handle(ctx, "projects.register", { path: projPath })) as { id: string };
    const session: SessionRef = {
      agentId: "claude-code",
      id: "s1",
      messageCount: 2,
    };
    const summary = (await handle(ctx, "handoff.create", {
      projectId: proj.id,
      session,
    })) as { id: string; messageCount: number };
    expect(summary.messageCount).toBe(2);

    const found = (await handle(ctx, "handoff.search", {
      handoffId: summary.id,
      query: "world",
    })) as VisibleEvent[];
    expect(found).toHaveLength(1);
    expect(found[0].text).toBe("world");

    const run = (await handle(ctx, "handoff.consume", {
      handoffId: summary.id,
      targetAgentId: "codex",
      goal: "continue",
    })) as { status: string };
    expect(run.status).toBe("running");
    const target = ctx.adapters.get("codex") as FakeAdapter;
    const handoffPath = target.lastInput?.handoffPath;
    expect(handoffPath).toBeTruthy();
    const handoff = JSON.parse(fs.readFileSync(handoffPath!, "utf8"));
    expect(handoff.events.map((event: VisibleEvent) => event.text)).toEqual(["hello", "world"]);
    expect(ctx.db.getRow("SELECT consumed FROM handoffs WHERE id = ?", summary.id)?.consumed).toBe(1);
    await expect(handle(ctx, "handoff.consume", {
      handoffId: summary.id,
      targetAgentId: "codex",
      goal: "again",
    })).rejects.toThrow("已分发");
  });

  it("不能把未归属该项目的任意会话伪装成交接来源", async () => {
    const proj = (await handle(ctx, "projects.register", { path: projPath })) as { id: string };
    await expect(handle(ctx, "handoff.create", {
      projectId: proj.id,
      session: { agentId: "claude-code", id: "foreign-session", messageCount: 2 },
    })).rejects.toThrow("不属于当前项目");
  });

  it("目标 Agent 启动失败时，交接包仍可再次使用", async () => {
    const proj = (await handle(ctx, "projects.register", { path: projPath })) as { id: string };
    const summary = (await handle(ctx, "handoff.create", {
      projectId: proj.id,
      session: { agentId: "claude-code", id: "s1", messageCount: 2 },
    })) as { id: string };
    (ctx.adapters.get("codex") as FakeAdapter).failStart = true;

    await expect(handle(ctx, "handoff.consume", {
      handoffId: summary.id,
      targetAgentId: "codex",
      goal: "continue",
    })).rejects.toThrow("无法启动目标 Agent");
    expect(ctx.db.getRow("SELECT consumed FROM handoffs WHERE id = ?", summary.id)?.consumed).toBe(0);
  });

  it("交接副本可在预览后删改，目标只收到删改后的历史", async () => {
    const proj = (await handle(ctx, "projects.register", { path: projPath })) as { id: string };
    const summary = (await handle(ctx, "handoff.create", {
      projectId: proj.id,
      session: { agentId: "claude-code", id: "s1", messageCount: 2 },
    })) as { id: string };
    const source = (await handle(ctx, "handoff.search", { handoffId: summary.id, query: "" })) as VisibleEvent[];
    expect(source.map((event) => event.text)).toEqual(["hello", "world"]);
    await handle(ctx, "handoff.edit", {
      handoffId: summary.id,
      edits: [{ eventIndex: 0, text: "edited hello" }, { eventIndex: 1, text: null }],
    });
    const copy = (await handle(ctx, "handoff.search", { handoffId: summary.id, query: "" })) as VisibleEvent[];
    expect(copy.map((event) => event.text)).toEqual(["edited hello"]);
    await handle(ctx, "handoff.consume", { handoffId: summary.id, targetAgentId: "codex", goal: "continue" });
    const file = (ctx.adapters.get("codex") as FakeAdapter).lastInput?.handoffPath;
    expect(JSON.parse(fs.readFileSync(file!, "utf8")).events.map((event: VisibleEvent) => event.text)).toEqual(["edited hello"]);
  });

  it("分次保存交接删改不会撤销先前的修改", async () => {
    const proj = (await handle(ctx, "projects.register", { path: projPath })) as { id: string };
    const summary = (await handle(ctx, "handoff.create", {
      projectId: proj.id,
      session: { agentId: "claude-code", id: "s1", messageCount: 2 },
    })) as { id: string };
    await handle(ctx, "handoff.edit", { handoffId: summary.id, edits: [{ eventIndex: 0, text: "first edit" }] });
    await handle(ctx, "handoff.edit", { handoffId: summary.id, edits: [{ eventIndex: 1, text: "second edit" }] });
    const copy = (await handle(ctx, "handoff.search", { handoffId: summary.id, query: "" })) as VisibleEvent[];
    expect(copy.map((event) => event.text)).toEqual(["first edit", "second edit"]);
  });

  it("敏感提示针对当前交接副本，删改后随之更新", async () => {
    const proj = (await handle(ctx, "projects.register", { path: projPath })) as { id: string };
    const source = ctx.adapters.get("claude-code") as FakeAdapter;
    source.firstMessage = "email user@example.com";
    const summary = (await handle(ctx, "handoff.create", {
      projectId: proj.id,
      session: { agentId: "claude-code", id: "s2", messageCount: 2 },
    })) as { id: string };
    const before = (await handle(ctx, "handoff.findings", { handoffId: summary.id })) as { kind: string }[];
    expect(before.some((finding) => finding.kind === "personal")).toBe(true);
    await handle(ctx, "handoff.edit", {
      handoffId: summary.id,
      edits: [{ eventIndex: 0, text: null }],
    });
    const after = (await handle(ctx, "handoff.findings", { handoffId: summary.id })) as { kind: string }[];
    expect(after).toEqual([]);
  });

  it("usage.summary aggregates ingested records; unknown stays null", async () => {
    ctx.usage.ingestUsage({
      agentId: "claude-code",
      sourceType: "managed_event",
      quality: "exact",
      inputTokens: 10,
      outputTokens: 5,
      nativeSessionId: "s1",
      nativeEventId: "e1",
    });
    const summary = (await handle(ctx, "usage.summary", {
      filter: { agentId: "claude-code" },
    })) as { inputTokens: number | null; outputTokens: number | null; events: number };
    expect(summary.inputTokens).toBe(10);
    expect(summary.outputTokens).toBe(5);
    expect(summary.events).toBe(1);
  });

  it("工作流的读取、人工审批、失败重试与暂停恢复可经 IPC 控制", async () => {
    const proj = (await handle(ctx, "projects.register", { path: projPath })) as { id: string };
    const task = (await handle(ctx, "tasks.create", { projectId: proj.id, title: "流程", goal: "完成流程" })) as { id: string };
    const definition = {
      id: "flow-1", name: "审查流程", nodes: [{
        id: "step-1", agentId: "claude-code", input: "单独步骤", dependsOn: [],
        writesRepo: false, optional: false, completionCondition: "user_review",
      }],
    };
    const started = (await handle(ctx, "workflow.start", { taskId: task.id, definition })) as { id: string };
    const blocked = (await handle(ctx, "workflow.advance", { workflowRunId: started.id })) as { nodes: { status: string }[] };
    expect(blocked.nodes[0].status).toBe("blocked");
    await handle(ctx, "workflow.pause", { workflowRunId: started.id });
    expect((await handle(ctx, "workflow.get", { workflowRunId: started.id }) as { paused: boolean }).paused).toBe(true);
    await handle(ctx, "workflow.resume", { workflowRunId: started.id });
    expect((await handle(ctx, "workflow.approve", { workflowRunId: started.id, nodeId: "step-1" }) as { nodes: { status: string }[] }).nodes[0].status).toBe("ready");
    const running = (await handle(ctx, "workflow.advance", { workflowRunId: started.id })) as { nodes: { runId: string }[] };
    ctx.tasks.setRunStatus(running.nodes[0].runId, "failed");
    await handle(ctx, "workflow.advance", { workflowRunId: started.id });
    expect((await handle(ctx, "workflow.retry", { workflowRunId: started.id, nodeId: "step-1" }) as { nodes: { status: string }[] }).nodes[0].status).toBe("running");
  });

  it("recovery.reconcile returns a report", async () => {
    const report = (await handle(ctx, "recovery.reconcile", undefined)) as {
      checkedAt: string;
    };
    expect(report.checkedAt).toBeTruthy();
  });
});
