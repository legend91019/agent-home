import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CodexProtocol,
  classifyTurnStatus,
  paginateTurns,
} from "../../src/main/adapters/codex-protocol";
import {
  CodexAdapter,
  importThreadFromFile,
  parseCodexThread,
} from "../../src/main/adapters/codex";
import { WorkbenchError } from "../../src/shared/errors";
import type { StartTaskInput } from "../../src/main/adapters/types";

const fixtureDir = fileURLToPath(new URL("../fixtures", import.meta.url));
const codexFixture = join(fixtureDir, "codex-thread.json");

const startInput: StartTaskInput = {
  projectId: "p1",
  projectPath: "/tmp/proj",
  agentId: "codex",
  goal: "paginate",
};

function makeProtocol() {
  const sent: string[] = [];
  let n = 0;
  const proto = new CodexProtocol(
    (line) => sent.push(line),
    () => ++n,
  );
  return { proto, sent };
}

describe("CodexProtocol", () => {
  it("(a) 匹配 id 的响应结算对应待请求", async () => {
    const { proto, sent } = makeProtocol();
    const p = proto.request("foo", { a: 1 });
    expect(sent.length).toBe(1);
    const req = JSON.parse(sent[0]);
    expect(req.method).toBe("foo");
    expect(req.id).toBe(1);

    proto.handleLine(JSON.stringify({ id: 1, result: { ok: true } }));
    const res = await p;
    expect(res).toEqual({ ok: true });
  });

  it("(a) 通知（无 id）不会结算请求", async () => {
    const { proto } = makeProtocol();
    let notif: unknown = null;
    proto.onNotification((nf) => {
      notif = nf;
    });
    const p = proto.request("bar");
    proto.handleLine(JSON.stringify({ method: "progress", params: { p: 1 } }));

    expect(notif).not.toBeNull();
    let resolved = false;
    p.then(() => {
      resolved = true;
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);

    proto.onProcessExit();
    await p.catch(() => {});
  });

  it("(a) onProcessExit 以 process_failed 拒绝所有待请求", async () => {
    const { proto } = makeProtocol();
    const pA = proto.request("a");
    const pB = proto.request("b");
    proto.onProcessExit();

    let code = "";
    try {
      await Promise.all([pA, pB]);
    } catch (e) {
      expect(e).toBeInstanceOf(WorkbenchError);
    }
    try {
      await pA;
    } catch (e) {
      code = (e as WorkbenchError).code;
    }
    expect(code).toBe("process_failed");
  });

  it("(a) 超时的请求被拒绝", async () => {
    const { proto } = makeProtocol();
    proto.setTimeout(30);
    const p = proto.request("slow");

    let err: unknown;
    try {
      await p;
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WorkbenchError);
    expect((err as WorkbenchError).code).toBe("process_failed");
  });
});

describe("classifyTurnStatus", () => {
  it("(b) failed/interrupted 绝不归类为 success", () => {
    expect(classifyTurnStatus({ status: "completed" })).toBe("success");
    expect(classifyTurnStatus({ status: "ok" })).toBe("success");
    expect(classifyTurnStatus({ status: "success" })).toBe("success");
    expect(classifyTurnStatus({ status: "failed" })).toBe("failed");
    expect(classifyTurnStatus({ status: "error" })).toBe("failed");
    expect(classifyTurnStatus({ status: "interrupted" })).toBe("interrupted");
    expect(classifyTurnStatus({ status: "running" })).toBe("running");
    expect(classifyTurnStatus({ status: "in_progress" })).toBe("running");

    expect(classifyTurnStatus({ status: "failed" })).not.toBe("success");
    expect(classifyTurnStatus({ status: "interrupted" })).not.toBe("success");
  });
});

describe("paginateTurns", () => {
  it("(c) 跨页不丢项", () => {
    const all = Array.from({ length: 10 }, (_, i) => ({ i }));
    const pages = paginateTurns(all, 3);
    expect(pages.length).toBe(4);
    const flat = pages.flat();
    expect(flat.length).toBe(10);
    expect(flat).toEqual(all);
  });

  it("(c) 空输入返回空页集合", () => {
    expect(paginateTurns([], 5)).toEqual([]);
  });
});

describe("parseCodexThread", () => {
  it("(d) 解析 fixture 得到正确的 VisibleEvent[]", () => {
    const json = JSON.parse(readFileSync(codexFixture, "utf8"));
    const events = parseCodexThread(json);

    expect(events.length).toBe(3);
    expect(events.map((e) => e.role)).toEqual(["user", "assistant", "user"]);
    expect(events.map((e) => e.index)).toEqual([0, 1, 2]);

    const assistant = events[1];
    expect(assistant.toolCalls).toBeDefined();
    expect(assistant.toolCalls!.length).toBe(1);
    expect(assistant.toolCalls![0].name).toBe("Bash");
    expect(assistant.toolCalls![0].outputSummary).toContain("index.ts");
  });

  it("(d) 非法输入抛出 invalid_data", () => {
    expect(() => parseCodexThread(123)).toThrow(WorkbenchError);
    expect(() => parseCodexThread({ foo: 1 })).toThrow(WorkbenchError);
    try {
      parseCodexThread({ foo: 1 });
    } catch (e) {
      expect((e as WorkbenchError).code).toBe("invalid_data");
    }
  });

  it("importThreadFromFile 读取 fixture 文件", () => {
    const fromFile = importThreadFromFile(codexFixture);
    const fromJson = parseCodexThread(JSON.parse(readFileSync(codexFixture, "utf8")));
    expect(fromFile).toEqual(fromJson);
  });
});

describe("CodexAdapter", () => {
  it("probe 在 CLI 缺失时返回 installed:false", async () => {
    const adapter = new CodexAdapter({ version: () => null });
    const report = await adapter.probe("/tmp/proj");
    expect(report.installed).toBe(false);
  });

  it("startTask 保留结构化连接失败，不会假装成功", async () => {
    const adapter = new CodexAdapter({ connect: async () => { throw new WorkbenchError("not_installed", "missing CLI"); } });
    await expect(adapter.startTask(startInput)).rejects.toMatchObject({code:"not_installed"});
  });
});
