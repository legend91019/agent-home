/**
 * 适配器注册表：持有所有适配器实例，集中管理能力探测、缓存失效、异常隔离。
 * - 探测失败只影响该适配器，绝不拖垮其他适配器或整个应用。
 * - 适配器版本变化时旧的探测结果失效，强制重新探测。
 * - 可选方法（如 interrupt）未实现时，对应能力报告 unsupported。
 */
import { SqliteDatabase } from "../db/database";
import { AgentId, Capability, CapabilityReport } from "../../shared/contracts";
import { AgentAdapter, reportFromError } from "./types";
import { WorkbenchError } from "../../shared/errors";

export class AdapterRegistry {
  private readonly adapters = new Map<AgentId, AgentAdapter>();
  private readonly cacheTtlMs = 30_000;

  constructor(private readonly db: SqliteDatabase) {}

  register(adapter: AgentAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: AgentId): AgentAdapter {
    const a = this.adapters.get(id);
    if (!a) throw new WorkbenchError("unsupported_version", `未注册的适配器: ${id}`);
    return a;
  }

  list(): AgentAdapter[] {
    return [...this.adapters.values()];
  }

  getIds(): AgentId[] {
    return [...this.adapters.keys()];
  }

  /** 能力是否明确支持；unknown/degraded/unsupported 都不启用对应控制按钮。 */
  isCapability(report: CapabilityReport, cap: Capability): boolean {
    return report.capabilities.find((c) => c.capability === cap)?.status === "supported";
  }

  private readCache(agentId: AgentId, projectId: string): CapabilityReport | null {
    const row = this.db.getRow(
      "SELECT report FROM capability_cache WHERE agent_id = ? AND project_id = ?",
      agentId,
      projectId,
    );
    if (!row) return null;
    try {
      return JSON.parse(String(row.report)) as CapabilityReport;
    } catch {
      return null;
    }
  }

  private writeCache(agentId: AgentId, projectId: string, report: CapabilityReport): void {
    this.db.run(
      "INSERT OR REPLACE INTO capability_cache (agent_id, project_id, report, checked_at) VALUES (?, ?, ?, ?)",
      agentId,
      projectId,
      JSON.stringify(report),
      report.checkedAt,
    );
  }

  /** 探测单个适配器；带版本失效判断与异常隔离。 */
  async getReport(
    agentId: AgentId,
    projectId: string,
    projectPath: string,
    opts?: { force?: boolean },
  ): Promise<CapabilityReport> {
    const adapter = this.get(agentId);
    const currentVersion = this.safeVersion(adapter);
    const cached = this.readCache(agentId, projectId);
    const fresh = cached && Number.isFinite(Date.parse(cached.checkedAt)) &&
      Date.now() - Date.parse(cached.checkedAt) < this.cacheTtlMs;
    const sameVersion = currentVersion !== null && cached?.version != null &&
      (cached.version === currentVersion || cached.version.endsWith(` ${currentVersion}`));
    if (!opts?.force && fresh && sameVersion) {
      return cached;
    }
    let report: CapabilityReport;
    try {
      report = await adapter.probe(projectPath);
    } catch (err) {
      report = reportFromError(agentId, adapter.displayName, err);
    }
    this.writeCache(agentId, projectId, report);
    return report;
  }

  /** 探测项目下的全部适配器；任一异常都隔离在该适配器内。 */
  async probeAll(projectId: string, projectPath: string): Promise<CapabilityReport[]> {
    return Promise.all(
      this.list().map((a) => this.getReport(a.id, projectId, projectPath)),
    );
  }

  private safeVersion(adapter: AgentAdapter): string | null {
    try {
      const v = (adapter as unknown as { versionHint?: () => string | null }).versionHint?.();
      return v ?? null;
    } catch {
      return null;
    }
  }
}
