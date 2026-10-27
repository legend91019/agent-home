import { readFileSync } from "node:fs";
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
      expect(caps["sessions.list"]).toBe("unknown");
      expect(caps["sessions.readVisible"]).toBe("unknown");
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
  it("(d) 从不假装成功，抛出结构化 WorkbenchError", async () => {
    const adapter = new ClaudeAdapter();
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
