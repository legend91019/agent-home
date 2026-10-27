import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

import { SqliteDatabase } from "../../src/main/db/database";
import { makeDb, seedProject } from "../helpers/db";
import { AdapterRegistry } from "../../src/main/adapters/registry";
import { BaseAdapter, RunHandle, StartTaskInput } from "../../src/main/adapters/types";
import { TaskRuntime } from "../../src/main/tasks/runtime";
import { WorkspaceManager } from "../../src/main/workspaces/git";
import { WorkflowScheduler } from "../../src/main/workflows/scheduler";
import { validateWorkflow } from "../../src/main/workflows/schema";
import {
  AgentId,
  CapabilityReport,
  SessionRef,
  VisibleEvent,
  WorkflowDef,
  WorkflowNodeDef,
} from "../../src/shared/contracts";

/* ------------------------------------------------------------------ */
/* 测试夹具                                                            */
/* ------------------------------------------------------------------ */

const AGENT: AgentId = "claude-code";

/** 可控的假适配器：startTask 立即返回句柄，且未实现 interrupt -> controllable=false。 */
class FakeAdapter extends BaseAdapter {
  readonly id: AgentId = AGENT;
  readonly displayName = "Fake";
  readonly inputs: StartTaskInput[] = [];

  async probe(): Promise<CapabilityReport> {
    return {
      agentId: AGENT,
      agentName: "Fake",
      installed: true,
      authenticated: true,
      checkedAt: new Date().toISOString(),
      capabilities: [],
    };
  }

  async listSessions(): Promise<SessionRef[]> {
    return [];
  }

  async *readVisibleSession(): AsyncIterable<VisibleEvent> {
    return;
  }

  async startTask(input: StartTaskInput): Promise<RunHandle> {
    this.inputs.push(input);
    return { runId: "native", nativeSessionId: "s", startedAt: new Date().toISOString() };
  }
}

function makeNode(id: string, opts: Partial<WorkflowNodeDef> = {}): WorkflowNodeDef {
  return {
    id,
    agentId: AGENT,
    input: `input-${id}`,
    dependsOn: [],
    writesRepo: false,
    optional: false,
    completionCondition: "agent_reports",
    ...opts,
  };
}

function makeDef(id: string, nodes: WorkflowNodeDef[]): WorkflowDef {
  return { id, name: `wf-${id}`, nodes };
}

interface Ctx {
  db: SqliteDatabase;
  tasks: TaskRuntime;
  sched: WorkflowScheduler;
  taskId: string;
  adapter: FakeAdapter;
}

/** 用给定项目路径搭建一次性的调度上下文；非写入节点用虚拟路径即可。 */
function setup(projPath = "/tmp/proj"): Ctx {
  const db = makeDb();
  const adapters = new AdapterRegistry(db);
  const adapter = new FakeAdapter();
  adapters.register(adapter);
  const tasks = new TaskRuntime(db, adapters);
  const workspaces = new WorkspaceManager(db);
  const sched = new WorkflowScheduler(db, tasks, workspaces);
  seedProject(db, "p1", projPath);
  const task = tasks.createTask("p1", "task", "goal");
  return { db, tasks, sched, taskId: task.id, adapter };
}

/** 创建一个带初始提交的真实 git 仓库，供写入仓库的节点使用。 */
function gitProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-git-"));
  spawnSync("git", ["init"], { cwd: dir, stdio: "ignore" });
  spawnSync("git", ["config", "user.email", "t@example.com"], { cwd: dir, stdio: "ignore" });
  spawnSync("git", ["config", "user.name", "Tester"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "seed.txt"), "seed");
  spawnSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  spawnSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "ignore" });
  return dir;
}

/* ------------------------------------------------------------------ */
/* 测试                                                                */
/* ------------------------------------------------------------------ */

describe("validateWorkflow", () => {
  it("(a) 拒绝依赖环", () => {
    const def = makeDef("w", [
      makeNode("A", { dependsOn: ["B"] }),
      makeNode("B", { dependsOn: ["A"] }),
    ]);
    const r = validateWorkflow(def);
    expect(r.valid).toBe(false);
    expect(r.errors.some((e) => e.includes("cycle detected"))).toBe(true);
  });

  it("拒绝未知依赖与重复 id", () => {
    expect(
      validateWorkflow(makeDef("w", [makeNode("A", { dependsOn: ["X"] })])).errors,
    ).toContain("unknown dependency");
    expect(
      validateWorkflow(makeDef("w", [makeNode("A"), makeNode("A")])).errors.some((e) =>
        e.includes("duplicate node id"),
      ),
    ).toBe(true);
  });

  it("合法 DAG 通过", () => {
    const def = makeDef("w", [makeNode("A"), makeNode("B", { dependsOn: ["A"] })]);
    expect(validateWorkflow(def).valid).toBe(true);
  });
});

describe("WorkflowScheduler", () => {
  it("(b) 顺序依赖：A 完成后 B 才启动", async () => {
    const { sched, taskId } = setup();
    const def = makeDef("w", [makeNode("A"), makeNode("B", { dependsOn: ["A"] })]);

    const wf = await sched.startWorkflow(taskId, def);
    let st = await sched.advanceWorkflow(wf.id);

    const a = st.nodes.find((n) => n.id === "A")!;
    const b = st.nodes.find((n) => n.id === "B")!;
    expect(a.status).toBe("running");
    expect(b.status).toBe("pending");
    expect(a.runId).toBeTruthy();

    // 模拟 A 完成。
    (sched as unknown as { tasks: TaskRuntime }).tasks.setRunStatus(a.runId!, "succeeded");
    st = await sched.advanceWorkflow(wf.id);

    expect(st.nodes.find((n) => n.id === "A")!.status).toBe("succeeded");
    expect(st.nodes.find((n) => n.id === "B")!.status).toBe("running");
  });

  it("(c) 两个独立节点并行启动", async () => {
    const { sched, tasks, taskId } = setup();
    const def = makeDef("w", [makeNode("A"), makeNode("B")]);

    const wf = await sched.startWorkflow(taskId, def);
    const st = await sched.advanceWorkflow(wf.id);

    const running = st.nodes.filter((n) => n.status === "running");
    expect(running.length).toBe(2);
    // 应创建两个 run。
    expect(tasks.getTask(taskId)!.runs.length).toBe(2);
  });

  it("(d) 失败节点阻断后继", async () => {
    const { sched, taskId } = setup();
    const def = makeDef("w", [makeNode("A"), makeNode("B", { dependsOn: ["A"] })]);

    const wf = await sched.startWorkflow(taskId, def);
    let st = await sched.advanceWorkflow(wf.id);
    const aRun = st.nodes.find((n) => n.id === "A")!.runId!;
    (sched as unknown as { tasks: TaskRuntime }).tasks.setRunStatus(aRun, "failed");

    st = await sched.advanceWorkflow(wf.id);
    expect(st.nodes.find((n) => n.id === "A")!.status).toBe("failed");
    expect(st.nodes.find((n) => n.id === "B")!.status).not.toBe("running");
  });

  it("(e) 可选节点在依赖失败时跳过", async () => {
    const { sched, taskId } = setup();
    const def = makeDef("w", [
      makeNode("A"),
      makeNode("B", { dependsOn: ["A"], optional: true }),
    ]);

    const wf = await sched.startWorkflow(taskId, def);
    let st = await sched.advanceWorkflow(wf.id);
    const aRun = st.nodes.find((n) => n.id === "A")!.runId!;
    (sched as unknown as { tasks: TaskRuntime }).tasks.setRunStatus(aRun, "failed");

    st = await sched.advanceWorkflow(wf.id);
    expect(st.nodes.find((n) => n.id === "B")!.status).toBe("skipped");
  });

  it("(f) 复核门：依赖成功后阻塞，审批后才启动", async () => {
    const { sched, taskId } = setup();
    const def = makeDef("w", [
      makeNode("A"),
      makeNode("G", { dependsOn: ["A"], completionCondition: "user_review" }),
    ]);

    const wf = await sched.startWorkflow(taskId, def);
    let st = await sched.advanceWorkflow(wf.id);
    const aRun = st.nodes.find((n) => n.id === "A")!.runId!;
    (sched as unknown as { tasks: TaskRuntime }).tasks.setRunStatus(aRun, "succeeded");

    st = await sched.advanceWorkflow(wf.id);
    expect(st.nodes.find((n) => n.id === "G")!.status).toBe("blocked");

    st = await sched.approveNode(wf.id, "G");
    expect(st.nodes.find((n) => n.id === "G")!.status).toBe("ready");

    st = await sched.advanceWorkflow(wf.id);
    expect(st.nodes.find((n) => n.id === "G")!.status).toBe("running");
  });

  it("(g) 重试创建新的 run", async () => {
    const { sched, tasks, taskId } = setup();
    const def = makeDef("w", [makeNode("A")]);

    const wf = await sched.startWorkflow(taskId, def);
    let st = await sched.advanceWorkflow(wf.id);
    const firstRun = st.nodes.find((n) => n.id === "A")!.runId!;

    (sched as unknown as { tasks: TaskRuntime }).tasks.setRunStatus(firstRun, "failed");
    st = await sched.advanceWorkflow(wf.id);
    expect(st.nodes.find((n) => n.id === "A")!.status).toBe("failed");

    st = await sched.retryNode(wf.id, "A");
    const after = st.nodes.find((n) => n.id === "A")!;
    expect(after.status).toBe("running");
    expect(after.runId).toBeTruthy();
    expect(after.runId).not.toBe(firstRun);
    // 旧 run 仍为失败。
    expect(tasks.getRun(firstRun)!.status).toBe("failed");
  });

  it("(h) 写入仓库节点并发上限为 2", async () => {
    const projPath = gitProject();
    const { sched, taskId } = setup(projPath);
    const def = makeDef("w", [
      makeNode("A", { writesRepo: true }),
      makeNode("B", { writesRepo: true }),
      makeNode("C", { writesRepo: true }),
    ]);

    const wf = await sched.startWorkflow(taskId, def);
    const st = await sched.advanceWorkflow(wf.id);

    const runningWriters = st.nodes.filter((n) => n.status === "running");
    expect(runningWriters.length).toBeLessThanOrEqual(2);
    expect(runningWriters.length).toBe(2);
    // 未达上限的节点应保持 ready，等待下次推进。
    expect(st.nodes.find((n) => n.id === "C")!.status).toBe("ready");
  });

  it("写入节点在 Agent 启动前使用独立 worktree 和节点指令", async () => {
    const projPath = gitProject();
    const { sched, taskId, adapter, db } = setup(projPath);
    const wf = await sched.startWorkflow(taskId, makeDef("isolation", [
      makeNode("A", { writesRepo: true, input: "只修改独立分支中的 seed.txt" }),
    ]));
    const state = await sched.advanceWorkflow(wf.id);
    const runId = state.nodes[0].runId!;
    const workspace = db.getRow("SELECT path FROM workspaces WHERE run_id = ?", runId);
    expect(workspace).toBeTruthy();
    expect(adapter.inputs[0].projectPath).toBe(workspace!.path);
    expect(adapter.inputs[0].projectPath).not.toBe(projPath);
    expect(adapter.inputs[0].goal).toBe("只修改独立分支中的 seed.txt");
  });

  it("写入节点重试会创建新工作区而不复用失败分支", async () => {
    const projPath = gitProject();
    const { sched, taskId, tasks, db, adapter } = setup(projPath);
    const wf = await sched.startWorkflow(taskId, makeDef("retry-writer", [
      makeNode("A", { writesRepo: true }),
    ]));
    const started = await sched.advanceWorkflow(wf.id);
    const firstRun = started.nodes[0].runId!;
    tasks.setRunStatus(firstRun, "failed");
    await sched.advanceWorkflow(wf.id);
    const retried = await sched.retryNode(wf.id, "A");
    const secondRun = retried.nodes[0].runId!;
    expect(secondRun).not.toBe(firstRun);
    expect(db.getRows("SELECT id FROM workspaces WHERE run_id IN (?, ?)", firstRun, secondRun)).toHaveLength(2);
    expect(adapter.inputs[1].projectPath).not.toBe(adapter.inputs[0].projectPath);
  });

  it("暂停后 advance 不推进", async () => {
    const { sched, taskId } = setup();
    const def = makeDef("w", [makeNode("A"), makeNode("B")]);
    const wf = await sched.startWorkflow(taskId, def);
    sched.pauseScheduling(wf.id);
    const st = await sched.advanceWorkflow(wf.id);
    // 暂停时应为空推进：无节点 running。
    expect(st.nodes.every((n) => n.status === "pending")).toBe(true);
    expect(st.paused).toBe(true);
    sched.resumeScheduling(wf.id);
    const st2 = await sched.advanceWorkflow(wf.id);
    expect(st2.nodes.filter((n) => n.status === "running").length).toBe(2);
  });
});
