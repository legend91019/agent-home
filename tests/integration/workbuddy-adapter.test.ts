import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkBuddyAdapter, importSessionFromFile, parseWorkBuddySession } from "../../src/main/adapters/workbuddy";
import { createContext } from "../../src/main/services";
import { createHandoff, searchHandoff } from "../../src/main/ipc/handoff";
import { importWorkBuddySession } from "../../src/main/ipc/projects";

const roots: string[] = [];
function root(): string {
  const value = mkdtempSync(join(tmpdir(), "workbuddy-adapter-"));
  roots.push(value);
  return value;
}
afterEach(() => {
  for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true });
});

describe("WorkBuddyAdapter", () => {
  it("reports an installed desktop without claiming unverified live sessions or task control", async () => {
    const executablePath = join(root(), "WorkBuddy.exe");
    writeFileSync(executablePath, "fixture");
    const adapter = new WorkBuddyAdapter({ installation: { executablePath, version: "5.9.2" } });
    const report = await adapter.probe(root());
    expect(report).toMatchObject({ installed: true, version: "WorkBuddy 5.9.2", authenticated: null });
    const caps = Object.fromEntries(report.capabilities.map((entry) => [entry.capability, entry.status]));
    expect(caps["config.publish"]).toBe("supported");
    expect(caps["sessions.list"]).toBe("degraded");
    expect(caps["tasks.start"]).toBe("unsupported");
  });

  it("imports a user-selected full visible transcript into a project-scoped private copy", async () => {
    const dataDir = root();
    const project = root();
    const otherProject = root();
    const source = join(root(), "conversation.json");
    const longOutput = "tool output ".repeat(100);
    writeFileSync(source, JSON.stringify({ messages: [
      { role: "user", content: "请接续这个任务", timestamp: "2026-10-27T00:00:00Z" },
      { role: "assistant", content: [{ type: "text", text: "已读取" }, { type: "tool_call", id: "t1", name: "Read", input: { file: "a.ts" }, output: longOutput }], timestamp: "2026-10-27T00:01:00Z" },
    ] }));
    const adapter = new WorkBuddyAdapter({ dataDir, installation: null });
    const imported = adapter.importSession(project, source);
    rmSync(source);
    expect(await adapter.listSessions(otherProject)).toEqual([]);
    expect((await adapter.listSessions(project))[0]).toMatchObject({ id: imported.id, messageCount: 2 });
    const events = [];
    for await (const event of adapter.readVisibleSession(imported)) events.push(event);
    expect(events[1].toolCalls?.[0].outputSummary).toBe(longOutput);
  });

  it("rejects unknown blocks rather than silently shortening a handoff", () => {
    expect(() => parseWorkBuddySession([{ role: "assistant", content: [{ type: "unrecognized", payload: "important" }] }])).toThrow(/不支持|未知/);
  });

  it("accepts a one-message JSONL transcript", () => {
    const source = join(root(), "single.jsonl");
    writeFileSync(source, JSON.stringify({ role: "user", content: "唯一的一条消息" }) + "\n");
    expect(importSessionFromFile(source)).toMatchObject([{ role: "user", text: "唯一的一条消息" }]);
  });

  it("routes an imported WorkBuddy session into the existing project handoff archive", async () => {
    const projectPath = root();
    const source = join(root(), "conversation.json");
    writeFileSync(source, JSON.stringify([{ role: "user", content: "保留这段完整交接历史" }]));
    const context = createContext(root());
    try {
      const project = context.projects.registerProject(projectPath);
      const session = await importWorkBuddySession(context, { projectId: project.id, filePath: source });
      const handoff = await createHandoff(context, { projectId: project.id, session });
      const events = await searchHandoff(context, { handoffId: handoff.id, query: "" });
      expect(events).toMatchObject([{ role: "user", text: "保留这段完整交接历史" }]);
    } finally {
      context.db.close();
    }
  });
});
