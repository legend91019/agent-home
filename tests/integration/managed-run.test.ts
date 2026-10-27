import { describe, it, expect } from "vitest";
import { makeDb, seedProject } from "../helpers/db";
import { TaskRuntime } from "../../src/main/tasks/runtime";
import { AdapterRegistry } from "../../src/main/adapters/registry";
import { BaseAdapter, RunHandle, StartTaskInput } from "../../src/main/adapters/types";
import { AgentId, CapabilityReport } from "../../src/shared/contracts";

/** 受控的假适配器：记录 startTask/interrupt 调用，并声明可控能力。 */
class FakeAdapter extends BaseAdapter {
  readonly id: AgentId;
  readonly displayName: string;
  startCalled = false;
  lastInput: StartTaskInput | null = null;
  interruptCalled = false;
  readonly declareInterrupt: boolean;

  constructor(id: AgentId, declareInterrupt: boolean) {
    super();
    this.id = id;
    this.displayName = `Fake ${id}`;
    this.declareInterrupt = declareInterrupt;
  }

  async probe(): Promise<CapabilityReport> {
    return {
      agentId: this.id,
      agentName: this.displayName,
      installed: true,
      authenticated: true,
      version: "1.0.0",
      checkedAt: new Date().toISOString(),
      capabilities: [
        {
          capability: "tasks.start",
          status: "supported",
          evidence: "fake",
          checkedAt: new Date().toISOString(),
        },
        {
          capability: "tasks.interrupt",
          status: this.declareInterrupt ? "supported" : "unsupported",
          evidence: "fake",
          checkedAt: new Date().toISOString(),
        },
      ],
    };
  }

  async listSessions(): Promise<never[]> {
    return [];
  }

  async *readVisibleSession(): AsyncIterable<never> {
    return;
  }

  async startTask(input: StartTaskInput): Promise<RunHandle> {
    this.startCalled = true;
    this.lastInput = input;
    return {
      runId: "<ignored>",
      nativeSessionId: "native-1",
      startedAt: new Date().toISOString(),
    };
  }

  async interrupt(): Promise<void> {
    this.interruptCalled = true;
  }
}

describe("managed run（真实 TaskRuntime + 真实 AdapterRegistry）", () => {
  it("不可控适配器：startRun 成功且 controllable=false", async () => {
    const db = makeDb();
    seedProject(db);
    const adapters = new AdapterRegistry(db);

    const fake = new FakeAdapter("claude-code", false);
    adapters.register(fake);

    const rt = new TaskRuntime(db, adapters);
    const task = rt.createTask("p1", "标题", "目标");

    const run = await rt.startRun(task.id, "claude-code");
    expect(run.status).toBe("running");
    expect(run.controllable).toBe(false);
    expect(fake.startCalled).toBe(true);
    expect(fake.lastInput?.goal).toBe("目标");
    expect(fake.lastInput?.projectPath).toBe("/tmp/proj");
    // 任务被推进到 running
    expect(rt.getTask(task.id)!.status).toBe("running");
  });

  it("可控适配器：controllable=true 且 interruptRun 调用 adapter.interrupt", async () => {
    const db = makeDb();
    seedProject(db);
    const adapters = new AdapterRegistry(db);

    const fake = new FakeAdapter("codex", true);
    adapters.register(fake);

    const rt = new TaskRuntime(db, adapters);
    const task = rt.createTask("p1", "标题", "目标");

    const run = await rt.startRun(task.id, "codex");
    expect(run.controllable).toBe(true);

    const result = await rt.interruptRun(run.id);
    expect(result).toEqual({ ok: true });
    expect(fake.interruptCalled).toBe(true);
    expect(rt.getRun(run.id)!.status).toBe("cancelled");
  });

  it("workspaceId 透传：startRun 时传入 workspaceId 并持久化到 Run", async () => {
    const db = makeDb();
    seedProject(db);
    const adapters = new AdapterRegistry(db);
    const fake = new FakeAdapter("claude-code", false);
    adapters.register(fake);

    const rt = new TaskRuntime(db, adapters);
    const task = rt.createTask("p1", "t", "g");
    const run = await rt.startRun(task.id, "claude-code", { workspaceId: "ws-9" });
    expect(run.workspaceId).toBe("ws-9");
  });
});
