import { describe, it, expect } from "vitest";
import { makeDb, seedProject } from "../helpers/db";
import { TaskRuntime } from "../../src/main/tasks/runtime";
import { AdapterRegistry } from "../../src/main/adapters/registry";
import { BaseAdapter, RunHandle, StartTaskInput } from "../../src/main/adapters/types";
import { AgentId, CapabilityReport } from "../../src/shared/contracts";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** 受控的假适配器：记录 startTask/interrupt 调用，并声明可控能力。 */
class FakeAdapter extends BaseAdapter {
  readonly id: AgentId;
  readonly displayName: string;
  startCalled = false;
  lastInput: StartTaskInput | null = null;
  interruptCalled = false;
  readonly declareInterrupt: boolean;
  private complete!: (status: "succeeded" | "failed" | "cancelled") => void;
  private readonly completion = new Promise<"succeeded" | "failed" | "cancelled">((resolve) => {
    this.complete = resolve;
  });

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

  async waitForCompletion(): Promise<"succeeded" | "failed" | "cancelled"> {
    return this.completion;
  }

  finish(status: "succeeded" | "failed" | "cancelled"): void {
    this.complete(status);
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
    db.run(
      `INSERT INTO workspaces (id, project_id, run_id, base_commit, branch, path, created_at, retained)
       VALUES (?, ?, NULL, ?, ?, ?, ?, 0)`,
      "ws-9", "p1", "base", "test", "/tmp/ws-9", new Date().toISOString(),
    );
    const run = await rt.startRun(task.id, "claude-code", { workspaceId: "ws-9" });
    expect(run.workspaceId).toBe("ws-9");
    expect(fake.lastInput?.projectPath).toBe("/tmp/ws-9");
  });

  it("Agent 完成后 Run 和 Task 自动进入审查态", async () => {
    const db = makeDb();
    seedProject(db);
    const adapters = new AdapterRegistry(db);
    const fake = new FakeAdapter("codex", true);
    adapters.register(fake);
    const rt = new TaskRuntime(db, adapters);
    const task = rt.createTask("p1", "完成状态", "目标");

    const run = await rt.startRun(task.id, "codex");
    fake.finish("succeeded");
    await new Promise((resolve) => setImmediate(resolve));

    expect(rt.getRun(run.id)?.status).toBe("succeeded");
    expect(rt.getTask(task.id)?.status).toBe("review_required");
  });

  it("Agent 执行失败后 Run 和 Task 自动进入失败态", async () => {
    const db = makeDb();
    seedProject(db);
    const adapters = new AdapterRegistry(db);
    const fake = new FakeAdapter("codex", true);
    adapters.register(fake);
    const rt = new TaskRuntime(db, adapters);
    const task = rt.createTask("p1", "失败状态", "目标");

    const run = await rt.startRun(task.id, "codex");
    fake.finish("failed");
    await new Promise((resolve) => setImmediate(resolve));

    expect(rt.getRun(run.id)?.status).toBe("failed");
    expect(rt.getTask(task.id)?.status).toBe("failed");
  });

  it("启动目标 Agent 时明确传入用户已发布的项目记忆指导文件", async () => {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "awb-guidance-"));
    try {
      const guidance = path.join(projectPath, ".agent-workbench", "memory", "claude-code.md");
      fs.mkdirSync(path.dirname(guidance), { recursive: true });
      fs.writeFileSync(guidance, "已审查的项目知识", "utf8");
      const db = makeDb();
      seedProject(db, "p1", projectPath);
      const adapters = new AdapterRegistry(db);
      const fake = new FakeAdapter("claude-code", false);
      adapters.register(fake);
      const rt = new TaskRuntime(db, adapters);
      const task = rt.createTask("p1", "t", "修复登录");
      await rt.startRun(task.id, "claude-code");
      expect(fake.lastInput?.goal).toContain(guidance);
      expect(fake.lastInput?.goal).toContain("修复登录");
    } finally {
      const root = path.resolve(os.tmpdir()) + path.sep;
      if (path.resolve(projectPath).startsWith(root)) fs.rmSync(projectPath, { recursive: true, force: true });
    }
  });
});
