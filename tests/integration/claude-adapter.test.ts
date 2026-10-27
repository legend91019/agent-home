import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ClaudeAdapter,
  importSessionFromFile,
  parseClaudeSession,
} from "../../src/main/adapters/claude";
import { WorkbenchError } from "../../src/shared/errors";
import type { StartTaskInput } from "../../src/main/adapters/types";

const fixtureDir = fileURLToPath(new URL("../fixtures", import.meta.url));
const claudeFixture = join(fixtureDir, "claude-session.json");

const startInput: StartTaskInput = {
  projectId: "p1",
  projectPath: "/tmp/proj",
  agentId: "claude-code",
  goal: "refactor",
};

describe("parseClaudeSession", () => {
  it("(a) 解析 fixture 得到有序、角色正确、tool_use 映射为 ToolCall 的 VisibleEvent[]", () => {
    const json = JSON.parse(readFileSync(claudeFixture, "utf8"));
    const events = parseClaudeSession(json);

    expect(events.length).toBe(4);
    expect(events.map((e) => e.role)).toEqual(["user", "assistant", "user", "system"]);
    // 顺序稳定
    expect(events.map((e) => e.index)).toEqual([0, 1, 2, 3]);

    // assistant 消息包含 1 个 tool_use
    const assistant = events[1];
    expect(assistant.toolCalls).toBeDefined();
    expect(assistant.toolCalls!.length).toBe(1);
    expect(assistant.toolCalls![0].name).toBe("Read");
    expect(assistant.toolCalls![0].status).toBe("unknown");

    // 隐藏推理（thinking）未被外显：assistant 文本不含 thinking 内容
    expect(assistant.text).not.toContain("先看看现有结构");
    // tool_result 折叠进了后续 user 消息文本
    expect(events[2].text).toContain("export function parse()");
    // nativeId 保留
    expect(events[0].nativeId).toBe("msg_1");
  });

  it("(b) 输入非法时抛出 WorkbenchError('invalid_data')", () => {
    expect(() => parseClaudeSession(123)).toThrow(WorkbenchError);
    expect(() => parseClaudeSession({ notMessages: true })).toThrow(WorkbenchError);
    expect(() => parseClaudeSession([{ role: "bogus" }])).toThrow(WorkbenchError);

    try {
      parseClaudeSession({ foo: 1 });
    } catch (e) {
      expect(e).toBeInstanceOf(WorkbenchError);
      expect((e as WorkbenchError).code).toBe("invalid_data");
    }
  });

  it("importSessionFromFile 能读取 fixture 文件", () => {
    const fromFile = importSessionFromFile(claudeFixture);
    const fromJson = parseClaudeSession(JSON.parse(readFileSync(claudeFixture, "utf8")));
    expect(fromFile).toEqual(fromJson);
  });
});

describe("ClaudeAdapter.probe", () => {
  it("(c) claude 缺失时返回 installed:false；存在时如实上报 unknown/supported", async () => {
    class AbsentClaude extends ClaudeAdapter {
      override versionHint(): string | null {
        return null;
      }
    }
    const absent = new AbsentClaude();
    const absentReport = await absent.probe("/tmp/proj");
    expect(absentReport.installed).toBe(false);

    const real = new ClaudeAdapter();
    const report = await real.probe("/tmp/proj");
    if (real.versionHint() === null) {
      expect(report.installed).toBe(false);
    } else {
      expect(report.installed).toBe(true);
      const caps = Object.fromEntries(
        report.capabilities.map((c) => [c.capability, c.status]),
      );
      expect(caps["config.read"]).toBe("supported");
      expect(caps["config.publish"]).toBe("supported");
      expect(caps["sessions.list"]).toBe("supported");
      expect(caps["sessions.readVisible"]).toBe("supported");
      // interrupt 未实现 -> unsupported
      expect(caps["tasks.interrupt"]).toBe("unsupported");
      // 每条能力都带证据与探测时间
      for (const c of report.capabilities) {
        expect(c.evidence).toBeTruthy();
        expect(c.checkedAt).toBeTruthy();
      }
    }
  });
});

describe("ClaudeAdapter.startTask", () => {
  it("用 stdin 传递特殊字符提示，等到真实 init 后返回，并观察完成状态", async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-cli-"));
    try {
      const script = join(root, "fake.cjs");
      writeFileSync(script, `const fs=require('node:fs'); const args=process.argv.slice(2);
if(args[0]==='auth'){console.log(JSON.stringify({loggedIn:true}));process.exit(0)}
let text='';process.stdin.on('data',c=>text+=c);process.stdin.on('end',()=>{fs.writeFileSync(${JSON.stringify(join(root, "input.txt"))},text); console.log(JSON.stringify({type:'system',subtype:'init',session_id:args[args.length-1]}));setTimeout(()=>process.exit(0),25)});`);
      const adapter = new ClaudeAdapter({ configDirectory: root, command: { file: process.execPath, args: [script] } });
      const goal = '保留 "引用" & $(echo unsafe)\n下一行';
      const handoffPath = join(root, "完整交接.json");
      const handle = await adapter.startTask({ ...startInput, projectPath: root, goal, handoffPath });
      expect(handle.nativeSessionId).toMatch(/^[a-f0-9-]{36}$/);
      expect(await adapter.waitForCompletion(handle)).toBe("succeeded");
      const prompt = readFileSync(join(root, "input.txt"), "utf8");
      expect(prompt).toContain(JSON.stringify(handoffPath));
      expect(prompt).toContain("UTF-8");
      expect(prompt.endsWith(goal)).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("CLI 在会话建立前退出时拒绝返回成功句柄", async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-cli-"));
    try {
      const script = join(root, "fail.cjs");
      writeFileSync(script, `if(process.argv[2]==='auth'){console.log('{"loggedIn":true}')}else{process.exit(1)}`);
      const adapter = new ClaudeAdapter({ configDirectory: root, command: { file: process.execPath, args: [script] } });
      await expect(adapter.startTask({ ...startInput, projectPath: root })).rejects.toMatchObject({ code: "process_failed" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("(d) 未登录时抛出结构化 WorkbenchError", async () => {
    class LoggedOut extends ClaudeAdapter { override authenticated(): boolean { return false; } }
    const adapter = new LoggedOut();
    let err: unknown;
    try {
      await adapter.startTask(startInput);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WorkbenchError);
    const code = (err as WorkbenchError).code;
    expect(["not_authenticated", "unsupported", "unknown", "unsupported_version"]).toContain(code);
  });
});

describe("Claude 本地会话", () => {
  it("发现真实 transcript 信封并保留完整工具输入输出，排除隐藏推理与元数据", async () => {
    const root = mkdtempSync(join(tmpdir(), "claude-adapter-"));
    try {
      const dir = join(root, "projects", startInput.projectPath.replace(/[^a-zA-Z0-9]/g, "-"));
      mkdirSync(dir, { recursive: true });
      const long = "完整原文".repeat(300);
      writeFileSync(join(dir, "native-session.jsonl"), [
        { type: "file-history-snapshot", snapshot: {} },
        { type: "user", sessionId: "native-session", cwd: startInput.projectPath, uuid: "u", timestamp: "2026-01-01T00:00:00Z", message: { role: "user", content: "目标" } },
        { type: "assistant", uuid: "a", timestamp: "2026-01-01T00:00:01Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "隐藏" }, { type: "tool_use", id: "t", name: "Read", input: { value: long } }] } },
        { type: "user", uuid: "r", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t", content: long }] } },
      ].map((entry) => JSON.stringify(entry)).join("\n"));
      const adapter = new ClaudeAdapter({ configDirectory: root });
      const sessions = await adapter.listSessions(startInput.projectPath);
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({ id: "native-session", messageCount: 3, title: "目标" });
      const events = [];
      for await (const event of adapter.readVisibleSession(sessions[0])) events.push(event);
      expect(events[1].toolCalls?.[0].inputSummary).toBe(JSON.stringify({ value: long }));
      expect(events[2].text).toBe(long);
      expect(JSON.stringify(events)).not.toContain("隐藏");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe("ClaudeAdapter.readVisibleSession", () => {
  it("无可用实时来源时抛出 session_unavailable（不伪造）", async () => {
    const adapter = new ClaudeAdapter();
    const gen = adapter.readVisibleSession({
      agentId: "claude-code",
      id: "no-such-session",
      messageCount: 0,
    });
    let err: unknown;
    try {
      for await (const e of gen) {
        void e;
      }
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WorkbenchError);
    expect((err as WorkbenchError).code).toBe("session_unavailable");
  });

  it("当 session.id 指向可读导出文件时通过手工回退产出事件", async () => {
    const adapter = new ClaudeAdapter();
    const gen = adapter.readVisibleSession({
      agentId: "claude-code",
      id: claudeFixture,
      messageCount: 4,
    });
    const events: unknown[] = [];
    for await (const e of gen) events.push(e);
    expect(events.length).toBe(4);
  });
});
