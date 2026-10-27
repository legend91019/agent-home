import { describe, expect, it } from "vitest";
import { AdapterRegistry } from "../../src/main/adapters/registry";
import { BaseAdapter, type RunHandle, type StartTaskInput } from "../../src/main/adapters/types";
import type { CapabilityReport, SessionRef, VisibleEvent } from "../../src/shared/contracts";
import { makeDb } from "../helpers/db";

class ChangingAdapter extends BaseAdapter {
  readonly id = "codex" as const;
  readonly displayName = "Changing";
  authenticated = true;
  probes = 0;

  versionHint(): string { return "1.0"; }
  async probe(): Promise<CapabilityReport> {
    this.probes++;
    return {
      agentId: this.id,
      agentName: this.displayName,
      installed: true,
      authenticated: this.authenticated,
      version: "Changing 1.0",
      checkedAt: new Date().toISOString(),
      capabilities: [],
    };
  }
  async listSessions(): Promise<SessionRef[]> { return []; }
  async *readVisibleSession(): AsyncIterable<VisibleEvent> { return; }
  async startTask(_input: StartTaskInput): Promise<RunHandle> { throw new Error("unused"); }
}

describe("AdapterRegistry capability cache", () => {
  it("短时缓存可复用，启动前强制探测能看到登录状态变化", async () => {
    const registry = new AdapterRegistry(makeDb());
    const adapter = new ChangingAdapter();
    registry.register(adapter);
    expect((await registry.getReport("codex", "p1", "/tmp/project")).authenticated).toBe(true);
    adapter.authenticated = false;
    expect((await registry.getReport("codex", "p1", "/tmp/project")).authenticated).toBe(true);
    expect(adapter.probes).toBe(1);
    expect((await registry.getReport("codex", "p1", "/tmp/project", { force: true })).authenticated).toBe(false);
    expect(adapter.probes).toBe(2);
  });
});
