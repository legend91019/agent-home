import { describe, it, expect } from "vitest";
import { makeDb, seedProject } from "../helpers/db";
import { TaskRuntime } from "../../src/main/tasks/runtime";
import { AdapterRegistry } from "../../src/main/adapters/registry";
import { getRunEvents } from "../../src/main/tasks/events";

describe("TaskRuntime 状态机与持久化", () => {
  it("(a) 非法任务状态转换被拒绝（draft -> completed 直接抛错）", () => {
    const db = makeDb();
    seedProject(db);
    const adapters = new AdapterRegistry(db);
    const rt = new TaskRuntime(db, adapters);

    const task = rt.createTask("p1", "标题", "目标");
    expect(task.status).toBe("draft");

    expect(() => rt.setTaskStatus(task.id, "completed")).toThrowError(
      /非法任务状态转换/,
    );
  });

  it("(b) 相同 eventId 的重复 Run 事件只落库一次", () => {
    const db = makeDb();
    seedProject(db);
    const rt = new TaskRuntime(db, new AdapterRegistry(db));

    const task = rt.createTask("p1", "t", "g");
    // 直接插入一条 run 以便挂事件
    const runId = "run-dup";
    db.run(
      `INSERT INTO runs (id, task_id, agent_id, status, created_at, updated_at, controllable)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
      runId,
      task.id,
      "claude-code",
      "running",
      new Date().toISOString(),
      new Date().toISOString(),
    );

    rt.appendRunEvent(runId, "tick", { n: 1 }, "evt-1");
    rt.appendRunEvent(runId, "tick", { n: 1 }, "evt-1"); // 重复

    const rows = db.getRows("SELECT * FROM run_events WHERE run_id = ?", runId);
    expect(rows).toHaveLength(1);

    const events = getRunEvents(db, runId);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("tick");
    expect(events[0].payload).toEqual({ n: 1 });
  });

  it("(c) waiting_for_user 状态的 Run 可被恢复读取（持久化）", () => {
    const db = makeDb();
    seedProject(db);
    const rt = new TaskRuntime(db, new AdapterRegistry(db));

    const task = rt.createTask("p1", "t", "g");
    const runId = "run-wait";
    db.run(
      `INSERT INTO runs (id, task_id, agent_id, status, created_at, updated_at, controllable)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      runId,
      task.id,
      "claude-code",
      "running",
      new Date().toISOString(),
      new Date().toISOString(),
    );
    rt.setRunStatus(runId, "waiting_for_user");

    const read = rt.getRun(runId);
    expect(read).not.toBeNull();
    expect(read!.status).toBe("waiting_for_user");
  });

  it("(d) 外部导入（controllable=0）的 Run 不可由工作台中断", async () => {
    const db = makeDb();
    seedProject(db);
    const rt = new TaskRuntime(db, new AdapterRegistry(db));

    const task = rt.createTask("p1", "t", "g");
    const runId = "run-ext";
    // 模拟外部导入会话：controllable=0
    db.run(
      `INSERT INTO runs (id, task_id, agent_id, status, created_at, updated_at, controllable)
       VALUES (?, ?, ?, ?, ?, ?, 0)`,
      runId,
      task.id,
      "claude-code",
      "running",
      new Date().toISOString(),
      new Date().toISOString(),
    );

    expect(rt.getRun(runId)!.controllable).toBe(false);
    await expect(rt.interruptRun(runId)).rejects.toMatchObject({
      code: "permission_denied",
    });
  });

  it("(e) 进程重启（同 db 新建 TaskRuntime）后 Run 状态保持一致", async () => {
    const db = makeDb();
    seedProject(db);
    const rt1 = new TaskRuntime(db, new AdapterRegistry(db));

    const task = rt1.createTask("p1", "t", "g");
    const runId = "run-restart";
    db.run(
      `INSERT INTO runs (id, task_id, agent_id, status, created_at, updated_at, controllable)
       VALUES (?, ?, ?, ?, ?, ?, 1)`,
      runId,
      task.id,
      "claude-code",
      "running",
      new Date().toISOString(),
      new Date().toISOString(),
    );
    rt1.setRunStatus(runId, "succeeded");

    // 模拟重启：用同一 db 新建实例
    const rt2 = new TaskRuntime(db, new AdapterRegistry(db));
    const read = rt2.getRun(runId);
    expect(read).not.toBeNull();
    expect(read!.status).toBe("succeeded");
    // 原生进程句柄不跨进程持久化，重启后不能误报“可中断”。
    expect(read!.controllable).toBe(false);
  });
});
