/** Official DeepSeek Harness adapter: ACP controls runs; exports provide history. */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { extname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { type AgentId, type CapabilityReport, type RunDTO, type SessionRef, type VisibleEvent } from '../../shared/contracts';
import { WorkbenchError } from '../../shared/errors';
import { BaseAdapter, notInstalled, type AgentAdapter, type RunHandle, type StartTaskInput } from './types';
import { connectDeepSeek, type DeepSeekConnection } from './deepseek-acp';
import { parseDeepSeekMarkdown, parseDeepSeekZip, type ParsedDeepSeekExport } from './deepseek-export';
import type { BlobStore } from '../storage/blobs';

type Completion = 'succeeded' | 'failed' | 'cancelled';
type Permission = { request: NonNullable<RunDTO['permissionRequest']>; resolve(value: unknown): void };
type Run = { connection: DeepSeekConnection; sessionId: string; completion: Promise<Completion>; cancelled: boolean; permissions: Map<string, Permission> };
type DeepSeekOptions = { version?: () => string | null; connect?: (cwd: string) => Promise<DeepSeekConnection>; dataDir?: string; blobs?: BlobStore };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkbenchError('invalid_data', 'DeepSeek Harness ACP 返回格式不合法');
  return value as Record<string, unknown>;
}

export class DeepSeekAdapter extends BaseAdapter implements AgentAdapter {
  readonly id: AgentId = 'deepseek-harness';
  readonly displayName = 'DeepSeek Harness';
  private readonly connect: (cwd: string) => Promise<DeepSeekConnection>;
  private readonly runs = new Map<string, Run>();

  private importDirectory(projectPath: string): string {
    const root = this.options.dataDir;
    if (!root) throw new WorkbenchError('session_unavailable', 'dsh 导入目录未配置');
    const key = createHash('sha256').update(resolve(projectPath).toLowerCase()).digest('hex');
    return join(root, 'deepseek-imports', key);
  }

  private imported(projectPath: string): SessionRef[] {
    if (!this.options.dataDir) return [];
    const dir = this.importDirectory(projectPath);
    if (!existsSync(dir)) return [];
    const out: SessionRef[] = [];
    for (const id of readdirSync(dir)) {
      if (!/^[0-9a-f-]{36}$/.test(id)) continue;
      try {
        const manifest = record(JSON.parse(readFileSync(join(dir, id, 'manifest.json'), 'utf8')));
        if (manifest.projectPath !== projectPath || !Array.isArray(manifest.events)) continue;
        const events = manifest.events as VisibleEvent[];
        out.push(this.importRef(id, projectPath, events, manifest.completeness === 'text-only' ? 'text-only' : 'structured', typeof manifest.sourceSessionId === 'string' ? manifest.sourceSessionId : undefined));
      } catch { /* One damaged import must not hide other sessions. */ }
    }
    return out.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  }

  private importRef(id: string, projectPath: string, events: VisibleEvent[], fidelity: 'structured' | 'text-only', nativeSourceSessionId?: string): SessionRef {
    return {
      agentId: this.id, id, nativeProjectPath: projectPath, historyFidelity: fidelity,
      title: fidelity === 'text-only' ? `dsh 文本转录 ${id.slice(0, 8)}` : events.find(e => e.role === 'user')?.text?.slice(0, 100) || `dsh 导入 ${id.slice(0, 8)}`,
      messageCount: events.length, startedAt: events[0]?.timestamp, updatedAt: events.at(-1)?.timestamp,
      nativeSourceSessionId,
    };
  }

  importSession(projectPath: string, filePath: string): SessionRef {
    const extension = extname(filePath).toLowerCase();
    if (extension !== '.zip' && extension !== '.md') throw new WorkbenchError('invalid_data', 'dsh 导出须为官方 ZIP 或复制的 Markdown');
    let stat;
    try { stat = lstatSync(filePath); }
    catch { throw new WorkbenchError('invalid_data', 'dsh 导出文件不存在或不可读取'); }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 20 * 1024 * 1024) throw new WorkbenchError('invalid_data', 'dsh 导出文件不是可接受的普通文件');
    const bytes = readFileSync(filePath);
    if (bytes.length > 20 * 1024 * 1024) throw new WorkbenchError('invalid_data', 'dsh 导出文件超过 20 MiB 上限');
    let parsed: ParsedDeepSeekExport;
    if (extension === '.zip') parsed = parseDeepSeekZip(bytes, projectPath);
    else {
      let markdown: string;
      try { markdown = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw new WorkbenchError('invalid_data', 'dsh Markdown 不是有效 UTF-8'); }
      parsed = parseDeepSeekMarkdown(markdown);
    }
    const id = randomUUID();
    const root = this.importDirectory(projectPath);
    const destination = join(root, id);
    mkdirSync(destination, { recursive: true });
    const storedHashes: string[] = [];
    try {
      writeFileSync(join(destination, `source${extension}`), bytes);
      for (const event of parsed.events) {
        for (const item of event.attachments ?? []) {
          if (!item.available || !item.externalRef) continue;
          const relative = item.externalRef;
          const attachmentBytes = parsed.attachments[relative];
          if (!attachmentBytes) throw new WorkbenchError('invalid_data', `dsh 附件缺失: ${relative}`);
          const target = join(destination, 'attachments', ...relative.split('/'));
          mkdirSync(resolve(target, '..'), { recursive: true });
          writeFileSync(target, attachmentBytes);
          item.externalRef = target;
          if (this.options.blobs) {
            item.blobHash = this.options.blobs.putBlob(Buffer.from(attachmentBytes));
            storedHashes.push(item.blobHash);
          }
        }
      }
      writeFileSync(join(destination, 'manifest.json'), JSON.stringify({
        projectPath, sourceHash: createHash('sha256').update(bytes).digest('hex'),
        sourceSessionId: parsed.sessionId, capturedAt: new Date().toISOString(),
        completeness: parsed.completeness, events: parsed.events,
        eventsHash: createHash('sha256').update(JSON.stringify(parsed.events)).digest('hex'),
      }), 'utf8');
      return this.importRef(id, projectPath, parsed.events, parsed.completeness, parsed.sessionId ?? undefined);
    } catch (error) {
      for (const hash of storedHashes) this.options.blobs?.release(hash);
      // Destination is generated from a UUID and remains below the known import root.
      const child = relative(resolve(root), resolve(destination));
      if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw error;
      rmSync(destination, { recursive: true, force: true });
      throw error;
    }
  }

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

  versionHint(): string | null { return this.version(); }

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
      this.entry('tasks.start', acp ? 'supported' : 'unknown', 'dsh ACP v1 session/new + session/prompt；权限在任务页逐项审查', { version, reason }),
      this.entry('tasks.interrupt', acp ? 'supported' : 'unknown', 'dsh ACP v1 session/cancel；仅限本工作台启动的任务', { version, reason }),
      this.entry('tasks.stream', 'unsupported', '工作台尚无 ACP 事件流展示', { version }),
      this.entry('usage.exact', 'unknown', '未接入可核实的 ACP 用量事件', { version }),
      this.entry('skills.invocationEvidence', 'unknown', '未接入可核实的 skill 调用事件', { version }),
    ];
    return report;
  }

  async listSessions(projectPath: string): Promise<SessionRef[]> {
    const imported = this.imported(projectPath);
    let connection: DeepSeekConnection;
    try { connection = await this.connect(projectPath); }
    catch { return imported; }
    const out: SessionRef[] = [...imported];
    const seen = new Set<string>();
    try {
      let cursor: string | undefined;
      for (let page = 0; page < 100; page++) {
        const result = record(await connection.request('session/list', { cwd: projectPath, ...(cursor !== undefined ? { cursor } : {}) }));
        if (!Array.isArray(result.sessions)) throw new WorkbenchError('invalid_data', 'dsh session/list 缺少 sessions');
        for (const raw of result.sessions) {
          const item = record(raw);
          if (typeof item.sessionId !== 'string' || typeof item.cwd !== 'string') throw new WorkbenchError('invalid_data', 'dsh 会话条目不完整');
          if (resolve(item.cwd).toLowerCase() !== resolve(projectPath).toLowerCase()) continue;
          if (seen.has(item.sessionId)) continue;
          seen.add(item.sessionId);
          out.push({ agentId: this.id, id: item.sessionId, title: `dsh 会话 ${item.sessionId.slice(0, 8)}（需导入历史）`, messageCount: 0, nativeProjectPath: item.cwd, historyFidelity: 'unavailable' });
        }
        if (result.nextCursor === undefined || result.nextCursor === null) return out;
        if (typeof result.nextCursor !== 'string' || result.nextCursor === cursor) throw new WorkbenchError('invalid_data', 'dsh 会话分页游标不合法');
        cursor = result.nextCursor;
      }
      throw new WorkbenchError('invalid_data', 'dsh 会话分页超过安全上限');
    } finally { connection.close(); }
  }

  async *readVisibleSession(session: SessionRef): AsyncIterable<VisibleEvent> {
    if (session.agentId !== this.id || !session.nativeProjectPath || !/^[0-9a-f-]{36}$/.test(session.id) || !this.options.dataDir)
      throw new WorkbenchError('session_unavailable', 'dsh ACP 不回放历史；请先从 dsh Web 导出并导入会话');
    const directory = join(this.importDirectory(session.nativeProjectPath), session.id);
    let manifest: Record<string, unknown>;
    try { manifest = record(JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'))); }
    catch { throw new WorkbenchError('session_unavailable', 'dsh 导入会话不可用'); }
    if (manifest.projectPath !== session.nativeProjectPath || !Array.isArray(manifest.events))
      throw new WorkbenchError('invalid_data', 'dsh 导入会话项目或事件无效');
    if (createHash('sha256').update(JSON.stringify(manifest.events)).digest('hex') !== manifest.eventsHash)
      throw new WorkbenchError('invalid_data', 'dsh 导入事件副本校验失败');
    const extension = manifest.completeness === 'text-only' ? '.md' : '.zip';
    const source = readFileSync(join(directory, `source${extension}`));
    if (createHash('sha256').update(source).digest('hex') !== manifest.sourceHash)
      throw new WorkbenchError('invalid_data', 'dsh 导入源副本校验失败');
    for (const event of manifest.events as VisibleEvent[]) {
      for (const item of event.attachments ?? []) {
        if (!item.available) continue;
        if (!item.externalRef) throw new WorkbenchError('invalid_data', `dsh 附件副本缺失: ${item.name}`);
        const child = relative(join(directory, 'attachments'), item.externalRef);
        if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child) || !existsSync(item.externalRef) || lstatSync(item.externalRef).isSymbolicLink())
          throw new WorkbenchError('invalid_data', `dsh 附件副本缺失或路径无效: ${item.name}`);
      }
      yield event;
    }
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
    const run: Run = { connection, sessionId, completion: Promise.resolve('failed'), cancelled: false, permissions: new Map() };
    connection.onRequest(async (method, raw) => {
      if (method !== 'session/request_permission') return { outcome: { outcome: 'cancelled' } };
      const params = record(raw);
      const toolCall = record(params.toolCall);
      if (params.sessionId !== sessionId || typeof toolCall.toolCallId !== 'string' || !Array.isArray(params.options))
        return { outcome: { outcome: 'cancelled' } };
      const options = params.options.map(rawOption => {
        const option = record(rawOption);
        if (typeof option.optionId !== 'string' || typeof option.name !== 'string' || typeof option.kind !== 'string')
          throw new WorkbenchError('invalid_data', 'dsh 权限选项格式不合法');
        return { optionId: option.optionId, name: option.name, kind: option.kind };
      });
      if (run.cancelled || run.permissions.has(toolCall.toolCallId)) return { outcome: { outcome: 'cancelled' } };
      const request: NonNullable<RunDTO['permissionRequest']> = {
        toolCallId: toolCall.toolCallId,
        title: typeof toolCall.title === 'string' ? toolCall.title.slice(0, 300) : undefined,
        inputSummary: toolCall.rawInput === undefined ? undefined : JSON.stringify(toolCall.rawInput).slice(0, 2000),
        options,
      };
      return new Promise(resolve => run.permissions.set(toolCall.toolCallId as string, { request, resolve }));
    });
    run.completion = (async (): Promise<Completion> => {
      try {
        const response = record(await connection.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] }, 24 * 60 * 60 * 1000));
        if (run.cancelled || response.stopReason === 'cancelled') return 'cancelled';
        return response.stopReason === 'end_turn' ? 'succeeded' : 'failed';
      } catch { return run.cancelled ? 'cancelled' : 'failed'; }
      finally {
        for (const permission of run.permissions.values()) permission.resolve({ outcome: { outcome: 'cancelled' } });
        run.permissions.clear();
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
    for (const permission of run.permissions.values()) permission.resolve({ outcome: { outcome: 'cancelled' } });
    run.permissions.clear();
    run.connection.notify('session/cancel', { sessionId: run.sessionId });
  }

  pendingPermission(handle: RunHandle): RunDTO['permissionRequest'] | null {
    return this.runs.get(handle.runId)?.permissions.values().next().value?.request ?? null;
  }

  respondPermission(handle: RunHandle, toolCallId: string, optionId: string | null): void {
    const run = this.runs.get(handle.runId);
    const pending = run?.permissions.get(toolCallId);
    if (!run || !pending) throw new WorkbenchError('session_unavailable', 'dsh 权限请求已结束');
    if (optionId !== null && !pending.request.options.some(option => option.optionId === optionId))
      throw new WorkbenchError('invalid_data', 'dsh 权限选项不属于当前请求');
    run.permissions.delete(toolCallId);
    pending.resolve({ outcome: optionId === null ? { outcome: 'cancelled' } : { outcome: 'selected', optionId } });
  }

  async waitForCompletion(handle: RunHandle): Promise<Completion> {
    const run = this.runs.get(handle.runId);
    if (!run) throw new WorkbenchError('session_unavailable', 'dsh 运行不属于当前工作台进程');
    const result = await run.completion;
    this.runs.delete(handle.runId);
    return result;
  }
}
