/** Official DeepSeek Harness adapter: ACP controls runs; exports provide history. */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { type AgentId, type CapabilityReport, type SessionRef, type VisibleEvent } from '../../shared/contracts';
import { WorkbenchError } from '../../shared/errors';
import { BaseAdapter, notInstalled, type AgentAdapter, type RunHandle, type StartTaskInput } from './types';
import { connectDeepSeek, type DeepSeekConnection } from './deepseek-acp';

type Completion = 'succeeded' | 'failed' | 'cancelled';
type Run = { connection: DeepSeekConnection; sessionId: string; completion: Promise<Completion>; cancelled: boolean };
type DeepSeekOptions = { version?: () => string | null; connect?: (cwd: string) => Promise<DeepSeekConnection> };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkbenchError('invalid_data', 'DeepSeek Harness ACP 返回格式不合法');
  return value as Record<string, unknown>;
}

export class DeepSeekAdapter extends BaseAdapter implements AgentAdapter {
  readonly id: AgentId = 'deepseek-harness';
  readonly displayName = 'DeepSeek Harness';
  private readonly connect: (cwd: string) => Promise<DeepSeekConnection>;
  private readonly runs = new Map<string, Run>();

  constructor(private readonly options: DeepSeekOptions = {}) {
    super();
    this.connect = options.connect ?? connectDeepSeek;
  }

  private version(): string | null {
    if (this.options.version) return this.options.version();
    try {
      const result = spawnSync(process.platform === 'win32' ? 'dsh.cmd' : 'dsh', ['--version'], {
        encoding: 'utf8', timeout: 5000, windowsHide: true, shell: process.platform === 'win32',
      });
      return !result.error && result.status === 0 ? (result.stdout.trim() || result.stderr.trim() || null) : null;
    } catch { return null; }
  }

  async probe(projectPath: string): Promise<CapabilityReport> {
    const version = this.version();
    if (!version) return notInstalled(this.id, this.displayName);
    const report: CapabilityReport = { agentId: this.id, agentName: this.displayName, installed: true, authenticated: null, version, checkedAt: new Date().toISOString(), capabilities: [] };
    let acp = false;
    let reason: string | undefined;
    let connection: DeepSeekConnection | undefined;
    try {
      connection = await this.connect(projectPath);
      const result = record(await connection.request('session/list', { cwd: projectPath }));
      if (!Array.isArray(result.sessions)) throw new WorkbenchError('invalid_data', 'dsh session/list 缺少 sessions');
      acp = true;
    } catch (error) { reason = error instanceof Error ? error.message : String(error); }
    finally { connection?.close(); }
    report.capabilities = [
      this.entry('sessions.list', acp ? 'supported' : 'unknown', 'dsh ACP v1 session/list', { version, reason }),
      this.entry('sessions.readVisible', 'degraded', '官方 dsh Web 会话导出；需用户显式导入', { version, reason: 'ACP 不提供历史回放；需要导入官方导出' }),
      this.entry('memory.readVisible', 'supported', '项目 AGENTS.md 与 CLAUDE.md 指令链', { version }),
      this.entry('memory.publishAsGuidance', 'supported', '用户确认的项目指导文件', { version }),
      this.entry('config.read', 'supported', 'AGENTS.md 与 .dsh/skills', { version }),
      this.entry('config.publish', 'supported', '预览、备份、冲突检查及回滚', { version }),
      this.entry('tasks.start', acp ? 'degraded' : 'unknown', 'dsh ACP v1 session/new + session/prompt', { version, reason: reason ?? '交互权限请求会明确拒绝，尚无审批 UI' }),
      this.entry('tasks.interrupt', acp ? 'degraded' : 'unknown', 'dsh ACP v1 session/cancel', { version, reason: reason ?? '仅支持本工作台启动的任务' }),
      this.entry('tasks.stream', 'unsupported', '工作台尚无 ACP 事件流展示', { version }),
      this.entry('usage.exact', 'unknown', '未接入可核实的 ACP 用量事件', { version }),
      this.entry('skills.invocationEvidence', 'unknown', '未接入可核实的 skill 调用事件', { version }),
    ];
    return report;
  }

  async listSessions(projectPath: string): Promise<SessionRef[]> {
    const connection = await this.connect(projectPath);
    const out: SessionRef[] = [];
    const seen = new Set<string>();
    try {
      let cursor: string | undefined;
      for (let page = 0; page < 100; page++) {
        const result = record(await connection.request('session/list', { cwd: projectPath, ...(cursor !== undefined ? { cursor } : {}) }));
        if (!Array.isArray(result.sessions)) throw new WorkbenchError('invalid_data', 'dsh session/list 缺少 sessions');
        for (const raw of result.sessions) {
          const item = record(raw);
          if (typeof item.sessionId !== 'string' || typeof item.cwd !== 'string') throw new WorkbenchError('invalid_data', 'dsh 会话条目不完整');
          if (seen.has(item.sessionId)) continue;
          seen.add(item.sessionId);
          out.push({ agentId: this.id, id: item.sessionId, messageCount: 0, nativeProjectPath: item.cwd });
        }
        if (result.nextCursor === undefined || result.nextCursor === null) return out;
        if (typeof result.nextCursor !== 'string' || result.nextCursor === cursor) throw new WorkbenchError('invalid_data', 'dsh 会话分页游标不合法');
        cursor = result.nextCursor;
      }
      throw new WorkbenchError('invalid_data', 'dsh 会话分页超过安全上限');
    } finally { connection.close(); }
  }

  async *readVisibleSession(_session: SessionRef): AsyncIterable<VisibleEvent> {
    throw new WorkbenchError('session_unavailable', 'dsh ACP 不回放历史；请先从 dsh Web 导出并导入会话');
  }

  async startTask(input: StartTaskInput): Promise<RunHandle> {
    const connection = await this.connect(input.projectPath);
    let sessionId: string;
    try {
      const result = record(await connection.request(input.sessionId ? 'session/resume' : 'session/new', {
        ...(input.sessionId ? { sessionId: input.sessionId } : {}), cwd: input.projectPath, mcpServers: [],
      }));
      sessionId = input.sessionId ?? String(result.sessionId ?? '');
      if (!sessionId) throw new WorkbenchError('invalid_data', 'dsh session/new 缺少 sessionId');
    } catch (error) { connection.close(); throw error; }
    const runId = randomUUID();
    const prompt = input.handoffPath
      ? `请先读取以下 UTF-8 文件，作为完整交接历史：${JSON.stringify(input.handoffPath)}\n然后继续执行目标：\n${input.goal}`
      : input.goal;
    const run: Run = { connection, sessionId, completion: Promise.resolve('failed'), cancelled: false };
    run.completion = (async (): Promise<Completion> => {
      try {
        const response = record(await connection.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] }, 24 * 60 * 60 * 1000));
        if (run.cancelled || response.stopReason === 'cancelled') return 'cancelled';
        return response.stopReason === 'end_turn' ? 'succeeded' : 'failed';
      } catch { return run.cancelled ? 'cancelled' : 'failed'; }
      finally {
        try { await connection.request('session/close', { sessionId }, 10000); } catch { /* close best effort */ }
        connection.close();
      }
    })();
    this.runs.set(runId, run);
    return { runId, nativeSessionId: sessionId, pid: connection.pid, startedAt: new Date().toISOString() };
  }

  async interrupt(handle: RunHandle): Promise<void> {
    const run = this.runs.get(handle.runId);
    if (!run) throw new WorkbenchError('session_unavailable', 'dsh 运行不属于当前工作台进程');
    run.cancelled = true;
    run.connection.notify('session/cancel', { sessionId: run.sessionId });
  }

  async waitForCompletion(handle: RunHandle): Promise<Completion> {
    const run = this.runs.get(handle.runId);
    if (!run) throw new WorkbenchError('session_unavailable', 'dsh 运行不属于当前工作台进程');
    const result = await run.completion;
    this.runs.delete(handle.runId);
    return result;
  }
}
