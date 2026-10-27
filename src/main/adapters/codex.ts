/**
 * Codex 适配器。
 *
 * 通过官方 app-server stdio 协议读取可见会话、启动并中断任务。
 * 手工导出导入保留为离线回退；不读取凭据和私有数据库。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { type AgentId, type CapabilityReport, type SessionRef, type ToolCall, type VisibleEvent, } from "../../shared/contracts";
import { WorkbenchError } from "../../shared/errors";
import { type AgentAdapter, BaseAdapter, notInstalled, type RunHandle, type StartTaskInput, } from "./types";
function summarize(value: unknown): string {
    if (value === undefined || value === null)
        return "";
    if (typeof value === "string")
        return value;
    try {
        const s = JSON.stringify(value);
        return s.length > 500 ? `${s.slice(0, 500)}…` : s;
    }
    catch {
        return String(value);
    }
}
function parseJsonl(text: string): unknown[] {
    const out: unknown[] = [];
    for (const line of text.split(/\r?\n/)) {
        const t = line.trim();
        if (!t)
            continue;
        try {
            out.push(JSON.parse(t));
        }
        catch {
            throw new WorkbenchError("invalid_data", "Codex 线程 JSONL 包含非法行");
        }
    }
    return out;
}
function extractTurns(json: unknown): unknown[] {
    if (Array.isArray(json))
        return json;
    if (json && typeof json === "object" && "turns" in json) {
        const t = (json as {
            turns?: unknown;
        }).turns;
        if (Array.isArray(t))
            return t;
    }
    throw new WorkbenchError("invalid_data", "Codex 线程必须是 turns 数组，或 { turns: [...] } 对象");
}
function extractTurnContent(content: unknown): {
    text: string | undefined;
    toolCalls: ToolCall[];
} {
    if (typeof content === "string")
        return { text: content, toolCalls: [] };
    if (Array.isArray(content)) {
        let text = "";
        const toolCalls: ToolCall[] = [];
        for (const block of content) {
            if (!block || typeof block !== "object") {
                throw new WorkbenchError("invalid_data", "Codex turn content 块格式非法");
            }
            const b = block as {
                type?: unknown;
                [k: string]: unknown;
            };
            const type = b.type;
            if (type === "text") {
                text += typeof b.text === "string" ? (text ? "\n" : "") + b.text : "";
            }
            else if (type === "tool_call") {
                if (typeof b.name !== "string") {
                    throw new WorkbenchError("invalid_data", "tool_call 块缺少 name");
                }
                toolCalls.push({
                    id: typeof b.id === "string" ? b.id : `tool_${toolCalls.length}`,
                    name: b.name,
                    inputSummary: summarize(b.args),
                    outputSummary: summarize(b.output),
                    status: "unknown",
                });
            }
        }
        return { text: text ? text : undefined, toolCalls };
    }
    throw new WorkbenchError("invalid_data", "Codex turn content 必须是字符串或块数组");
}
/**
 * 把一段 Codex 线程 JSON 解析为按源顺序的 VisibleEvent[]。纯函数、可单测。
 */
export function parseCodexThread(json: unknown): VisibleEvent[] {
    const turns = extractTurns(json);
    const events: VisibleEvent[] = [];
    let index = 0;
    for (const turn of turns) {
        if (!turn || typeof turn !== "object") {
            throw new WorkbenchError("invalid_data", `Codex turn #${index} 不是对象`);
        }
        const t = turn as {
            role?: unknown;
            content?: unknown;
            created_at?: unknown;
            id?: unknown;
        };
        const role = t.role;
        if (role !== "user" && role !== "assistant" && role !== "system") {
            throw new WorkbenchError("invalid_data", `Codex turn #${index} 含不支持的 role: ${String(role)}`);
        }
        if (t.content === undefined || t.content === null) {
            throw new WorkbenchError("invalid_data", `Codex turn #${index} 缺少 content`);
        }
        const timestamp = typeof t.created_at === "string" ? t.created_at : new Date().toISOString();
        const { text, toolCalls } = extractTurnContent(t.content);
        const nativeId = typeof t.id === "string" ? t.id : undefined;
        events.push({
            index: index++,
            role,
            timestamp,
            nativeId,
            text,
            toolCalls: toolCalls.length ? toolCalls : undefined,
        });
    }
    return events;
}
/** 手工导入回退：读取本地 JSON/JSONL 导出并解析为 VisibleEvent[]。 */
export function importThreadFromFile(filePath: string): VisibleEvent[] {
    let raw: string;
    try {
        raw = readFileSync(filePath, "utf8");
    }
    catch {
        throw new WorkbenchError("invalid_data", `无法读取 Codex 线程文件: ${filePath}`);
    }
    const trimmed = raw.trim();
    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    }
    catch {
        parsed = parseJsonl(trimmed);
    }
    return parseCodexThread(parsed);
}
import { randomUUID } from "node:crypto";
import { connectCodex, type CodexConnection } from "./codex-protocol";
interface CodexOptions {
    version?: () => string | null;
    connect?: (projectPath?: string) => Promise<CodexConnection>;
}
type RecordValue = Record<string, any>;
function object(value: unknown): RecordValue {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new WorkbenchError('invalid_data', 'Codex 返回的对象格式不合法');
    return value as RecordValue;
}
function iso(value: unknown): string | undefined {
    if (typeof value === 'number' && Number.isFinite(value))
        return new Date(value * 1000).toISOString();
    return typeof value === 'string' ? value : undefined;
}
/** 仅映射官方可见 item，reasoning 不进入交接历史。未知 item 拒绝而非静默丢失。 */
function visibleItems(turns: unknown[], fallbackTime: string): VisibleEvent[] {
    const events: VisibleEvent[] = [];
    for (const raw of turns) {
        const turn = object(raw);
        if (!Array.isArray(turn.items))
            throw new WorkbenchError('invalid_data', 'Codex turn 未提供 full items');
        for (const rawItem of turn.items) {
            const item = object(rawItem);
            if (item.type === 'reasoning')
                continue;
            const base = { index: events.length, nativeId: typeof item.id === 'string' ? item.id : undefined, timestamp: iso(item.createdAt) ?? iso(turn.startedAt) ?? fallbackTime };
            if (item.type === 'userMessage') {
                if (!Array.isArray(item.content))
                    throw new WorkbenchError('invalid_data', 'Codex userMessage 缺少 content');
                const texts: string[] = [];
                const attachments: NonNullable<VisibleEvent['attachments']> = [];
                for (const block of item.content) {
                    if (block.type === 'text')
                        texts.push(block.text);
                    else if (block.type === 'image' || block.type === 'localImage') {
                        const ref = block.url ?? block.path;
                        attachments.push({ name: typeof ref === 'string' ? ref : block.type, sizeBytes: null, kind: 'image', externalRef: ref, available: false });
                    }
                    else if (block.type === 'skill' || block.type === 'mention')
                        texts.push(JSON.stringify(block));
                    else
                        throw new WorkbenchError('unsupported_version', `Codex 未支持的用户内容: ${String(block.type)}`);
                }
                events.push({ ...base, role: 'user', text: texts.join('\n'), attachments: attachments.length ? attachments : undefined });
            }
            else if (item.type === 'agentMessage' || item.type === 'plan') {
                events.push({ ...base, role: 'assistant', text: item.text });
            }
            else if (['commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'imageView', 'imageGeneration', 'functionCallOutput', 'collabToolCall', 'collabAgentToolCall'].includes(item.type)) {
                events.push({ ...base, role: 'tool', toolCalls: [{ id: item.id ?? `item_${events.length}`, name: item.type, inputSummary: JSON.stringify(item), outputSummary: typeof item.aggregatedOutput === 'string' ? item.aggregatedOutput : JSON.stringify(item.result ?? item.contentItems ?? item.content ?? item.output ?? item.error ?? item.changes ?? null), exitCode: typeof item.exitCode === 'number' ? item.exitCode : undefined, status: item.status === 'failed' || (typeof item.exitCode === 'number' && item.exitCode !== 0) ? 'error' : item.status === 'completed' ? 'ok' : 'unknown' }] });
            }
            else if (['enteredReviewMode', 'exitedReviewMode', 'contextCompaction', 'sleep', 'hookPrompt', 'subAgentActivity'].includes(item.type)) {
                events.push({ ...base, role: 'system', text: JSON.stringify(item) });
            }
            else
                throw new WorkbenchError('unsupported_version', `Codex 未支持的可见 item: ${String(item.type)}`);
        }
    }
    return events;
}
export class CodexAdapter extends BaseAdapter implements AgentAdapter {
    readonly id: AgentId = 'codex';
    readonly displayName = 'Codex';
    private readonly connect: (projectPath?: string) => Promise<CodexConnection>;
    private readonly runs = new Map<string, {
        connection: CodexConnection;
        threadId: string;
        turnId: string;
        completion: Promise<'succeeded' | 'failed' | 'cancelled'>;
    }>();
    constructor(private readonly options: CodexOptions = {}) {
        super();
        this.connect = options.connect ?? (path => connectCodex(process.platform === 'win32' ? 'codex.exe' : 'codex', path));
    }
    versionHint(): string | null {
        if (this.options.version)
            return this.options.version();
        try {
            const res = spawnSync(process.platform === 'win32' ? 'codex.exe' : 'codex', ['--version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
            return !res.error && res.status === 0 ? res.stdout.trim() || null : null;
        }
        catch {
            return null;
        }
    }
    async probe(projectPath: string): Promise<CapabilityReport> {
        const version = this.versionHint();
        if (version === null)
            return notInstalled(this.id, this.displayName);
        const report: CapabilityReport = { agentId: this.id, agentName: this.displayName, installed: true, authenticated: null, version, checkedAt: new Date().toISOString(), capabilities: [] };
        let connection: CodexConnection | undefined;
        let listing = false;
        let failure: string | undefined;
        try {
            connection = await this.connect(projectPath);
            const auth = object(await connection.request('account/read', { refreshToken: false }));
            report.authenticated = auth.account ? true : auth.requiresOpenaiAuth === true ? false : null;
            const result = object(await connection.request('thread/list', { cwd: projectPath, limit: 1, sourceKinds: ['cli', 'vscode', 'exec', 'appServer'] }));
            if (!Array.isArray(result.data))
                throw new WorkbenchError('invalid_data', 'Codex thread/list 缺少 data');
            listing = true;
        }
        catch (error) {
            failure = error instanceof Error ? error.message : String(error);
        }
        finally {
            connection?.close();
        }
        report.capabilities = [
            this.entry('sessions.list', listing ? 'supported' : 'unknown', 'Codex app-server thread/list', { version, reason: failure }),
            this.entry('sessions.readVisible', listing ? 'degraded' : 'unknown', 'Codex app-server thread/read + thread/turns/list', { version, reason: failure ?? '按实际可访问线程读取；未知 item 会报错，附件保留引用，未验证全部桌面历史覆盖' }),
            this.entry('tasks.start', listing && report.authenticated !== false ? 'degraded' : 'unknown', 'Codex app-server thread/start + turn/start', { version, reason: failure ?? '协议实现已通过伪服务测试；未执行真实付费 turn，交互审批请求明确拒绝' }),
            this.entry('tasks.interrupt', listing ? 'degraded' : 'unknown', 'Codex app-server turn/interrupt', { version, reason: failure ?? '仅支持本工作台当前进程启动且仍在运行的 turn' }),
            this.entry('tasks.stream', 'unsupported', 'AgentAdapter 无公开事件流订阅接口'),
            this.entry('usage.exact', 'unknown', '尚未接入用量事件'),
        ];
        return report;
    }
    private async pages(connection: CodexConnection, method: string, params: RecordValue): Promise<unknown[]> {
        const all: unknown[] = [];
        let cursor: string | undefined;
        const seen = new Set<string>();
        do {
            const page = object(await connection.request(method, { ...params, ...(cursor ? { cursor } : {}) }));
            if (!Array.isArray(page.data))
                throw new WorkbenchError('invalid_data', `Codex ${method} 缺少 data`);
            all.push(...page.data);
            if (page.nextCursor != null && typeof page.nextCursor !== 'string')
                throw new WorkbenchError('invalid_data', 'Codex nextCursor 格式错误');
            cursor = page.nextCursor || undefined;
            if (cursor && seen.has(cursor))
                throw new WorkbenchError('invalid_data', 'Codex 分页游标重复');
            if (cursor)
                seen.add(cursor);
        } while (cursor);
        return all;
    }
    async listSessions(projectPath: string): Promise<SessionRef[]> {
        const connection = await this.connect(projectPath);
        try {
            const threads = await this.pages(connection, 'thread/list', { cwd: projectPath, limit: 100, sourceKinds: ['cli', 'vscode', 'exec', 'appServer'], sortKey: 'updated_at' });
            return threads.map(raw => {
                const t = object(raw);
                if (typeof t.id !== 'string')
                    throw new WorkbenchError('invalid_data', 'Codex thread 缺少 id');
                return { agentId: this.id, id: t.id, title: t.name ?? t.preview, messageCount: 0, startedAt: iso(t.createdAt), updatedAt: iso(t.updatedAt), nativeProjectPath: t.cwd };
            });
        }
        finally {
            connection.close();
        }
    }
    async *readVisibleSession(session: SessionRef): AsyncIterable<VisibleEvent> {
        if (session.agentId !== this.id)
            throw new WorkbenchError('invalid_data', '会话不属于 Codex');
        if ((session.id.endsWith('.json') || session.id.endsWith('.jsonl')) && existsSync(session.id)) {
            yield* importThreadFromFile(session.id);
            return;
        }
        const connection = await this.connect(session.nativeProjectPath);
        try {
            const thread = object(object(await connection.request('thread/read', { threadId: session.id })).thread);
            const turns = await this.pages(connection, 'thread/turns/list', { threadId: session.id, limit: 100, sortDirection: 'asc', itemsView: 'full' });
            yield* visibleItems(turns, iso(thread.createdAt) ?? session.startedAt ?? new Date(0).toISOString());
        }
        finally {
            connection.close();
        }
    }
    async startTask(input: StartTaskInput): Promise<RunHandle> {
        const connection = await this.connect(input.projectPath);
        let resolveCompletion!: (status: 'succeeded' | 'failed' | 'cancelled') => void;
        const completion = new Promise<'succeeded' | 'failed' | 'cancelled'>(resolve => { resolveCompletion = resolve; });
        const runId = randomUUID();
        let threadId: string | undefined;
        let turnId: string | undefined;
        let terminal: {
            threadId?: string;
            turn?: RecordValue;
        } | undefined;
        const finish = (status: 'succeeded' | 'failed' | 'cancelled') => { resolveCompletion(status); connection.close(); };
        const completed = (params: RecordValue) => {
            if (params.threadId !== threadId || params.turn?.id !== turnId)
                return;
            const status = params.turn.status;
            finish(status === 'completed' ? 'succeeded' : status === 'interrupted' ? 'cancelled' : 'failed');
        };
        connection.onNotification(n => {
            if (n.method === 'workbench/processExited') {
                resolveCompletion('failed');
                return;
            }
            if (n.method === 'turn/completed') {
                const params = object(n.params);
                terminal = params;
                if (turnId)
                    completed(params);
            }
        });
        try {
            const result = object(await connection.request(input.sessionId ? 'thread/resume' : 'thread/start', { ...(input.sessionId ? { threadId: input.sessionId } : {}), cwd: input.projectPath, approvalPolicy: 'never', sandbox: 'workspace-write' }));
            threadId = object(result.thread).id;
            if (typeof threadId !== 'string')
                throw new WorkbenchError('invalid_data', 'Codex thread/start 缺少 id');
            const handoffPath = input.handoffPath;
            const prompt = handoffPath ? `请先读取 UTF-8 文件 ${JSON.stringify(handoffPath)}，该文件包含完整交接历史。然后继续以下任务：\n${input.goal}` : input.goal;
            const turn = object(object(await connection.request('turn/start', { threadId, input: [{ type: 'text', text: prompt }], cwd: input.projectPath, approvalPolicy: 'never' })).turn);
            turnId = turn.id;
            if (typeof turnId !== 'string')
                throw new WorkbenchError('invalid_data', 'Codex turn/start 缺少 id');
            this.runs.set(runId, { connection, threadId, turnId, completion });
            if (terminal)
                completed(terminal);
            else if (turn.status !== 'inProgress' && turn.status !== 'running')
                completed({ threadId, turn });
            return { runId, nativeSessionId: threadId, pid: connection.pid, startedAt: new Date().toISOString() };
        }
        catch (error) {
            finish('failed');
            throw error;
        }
    }
    async waitForCompletion(handle: RunHandle): Promise<'succeeded' | 'failed' | 'cancelled'> {
        const run = this.runs.get(handle.runId);
        if (!run)
            throw new WorkbenchError('session_unavailable', 'Codex 运行不属于当前工作台进程');
        const result = await run.completion;
        this.runs.delete(handle.runId);
        return result;
    }
    async interrupt(handle: RunHandle): Promise<void> {
        const run = this.runs.get(handle.runId);
        if (!run)
            throw new WorkbenchError('session_unavailable', 'Codex 运行不属于当前工作台进程');
        await run.connection.request('turn/interrupt', { threadId: run.threadId, turnId: run.turnId });
    }
}
