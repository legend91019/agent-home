import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createContext, type AppContext } from "../../src/main/services";
import { AdapterRegistry } from "../../src/main/adapters/registry";
import { BaseAdapter } from "../../src/main/adapters/types";
import type { RunHandle } from "../../src/main/adapters/types";
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
  async listSessions() {
    return [];
  }
  async *readVisibleSession(): AsyncIterable<VisibleEvent> {
    yield { index: 0, role: "user", timestamp: NOW, text: "hello" };
    yield { index: 1, role: "assistant", timestamp: NOW, text: "world" };
  }
  async startTask(): Promise<RunHandle> {
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

  it("recovery.reconcile returns a report", async () => {
    const report = (await handle(ctx, "recovery.reconcile", undefined)) as {
      checkedAt: string;
    };
    expect(report.checkedAt).toBeTruthy();
  });
});
