/**
 * Codex JSON-RPC 协议客户端（在子进程上运行 Codex app-server 时使用）。
 *
 * 设计要点：
 * - 出站请求入队，按 id 匹配响应；通知（无 id）单独派发。
 * - 支持超时：超过阈值未响应的待请求以 process_failed 拒绝。
 * - 进程退出：所有待请求以 process_failed 拒绝，绝不悬挂。
 * 纯逻辑、可单测，不涉及任何文件系统或 CLI 调用。
 */
import { WorkbenchError } from "../../shared/errors";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
export interface JsonRpcRequest {
    id: number;
    method: string;
    params?: unknown;
}
export interface JsonRpcResponse {
    id: number;
    result?: unknown;
    error?: unknown;
}
export type NotificationHandler = (notif: {
    method: string;
    params?: unknown;
}) => void;
interface Pending {
    resolve: (value: unknown) => void;
    reject: (err: WorkbenchError) => void;
    timer: NodeJS.Timeout;
}
export class CodexProtocol {
    private readonly pending = new Map<number, Pending>();
    private notificationHandler: NotificationHandler | null = null;
    private timeoutMs = 5000;
    private exited = false;
    constructor(private readonly send: (line: string) => void, private readonly nextId: () => number) { }
    onNotification(handler: NotificationHandler): void {
        this.notificationHandler = handler;
    }
    setTimeout(ms: number): void {
        this.timeoutMs = ms;
    }
    request(method: string, params?: unknown): Promise<unknown> {
        if (this.exited)
            return Promise.reject(new WorkbenchError("process_failed", "Codex 进程已退出"));
        const id = this.nextId();
        const req: JsonRpcRequest = { id, method, params };
        return new Promise<unknown>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new WorkbenchError("process_failed", `Codex JSON-RPC 请求 ${method} (#${id}) 在 ${this.timeoutMs}ms 后超时`));
            }, this.timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            try {
                this.send(JSON.stringify(req));
            }
            catch {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(new WorkbenchError("process_failed", "Codex 请求写入失败"));
            }
        });
    }
    /** 解析一行 JSON；若带 id 则匹配并结算对应待请求；否则视为通知派发。 */
    handleLine(line: string): void {
        let parsed: {
            id?: unknown;
            result?: unknown;
            error?: unknown;
            method?: unknown;
            params?: unknown;
        };
        try {
            parsed = JSON.parse(line) as typeof parsed;
        }
        catch {
            return; // 忽略非法行，绝不抛出到调用方
        }
        if (parsed && typeof parsed === "object" && typeof parsed.method === "string" && parsed.id != null) {
            // 当前客户端没有交互审批 UI，明确拒绝，绝不自动授权或悬挂请求。
            this.send(JSON.stringify({ id: parsed.id, error: { code: -32601, message: "Workbench does not support this server request" } }));
            return;
        }
        if (parsed &&
            typeof parsed === "object" &&
            "id" in parsed &&
            parsed.id !== null &&
            parsed.id !== undefined) {
            const id = parsed.id as number;
            const p = this.pending.get(id);
            if (!p)
                return;
            clearTimeout(p.timer);
            this.pending.delete(id);
            if ("error" in parsed && parsed.error !== undefined) {
                p.reject(new WorkbenchError("process_failed", `Codex JSON-RPC 错误: ${JSON.stringify(parsed.error)}`));
            }
            else {
                p.resolve(parsed.result);
            }
        }
        else if (this.notificationHandler && parsed && typeof parsed === "object") {
            this.notificationHandler({
                method: typeof parsed.method === "string" ? parsed.method : "",
                params: parsed.params,
            });
        }
    }
    /** 进程退出：所有待请求以 process_failed 拒绝。 */
    onProcessExit(): void {
        this.exited = true;
        const err = new WorkbenchError("process_failed", "Codex 进程已退出；所有待请求失败");
        for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(err);
        }
        this.pending.clear();
    }
}
export interface CodexConnection {
    readonly pid?: number;
    request(method: string, params?: unknown): Promise<unknown>;
    onNotification(handler: NotificationHandler): void;
    close(): void;
}
/** 官方 stdio transport：每行一个 JSON-RPC 消息；不读取凭据或私有存储。 */
export async function connectCodex(command = "codex", cwd?: string, args = ["app-server"]): Promise<CodexConnection> {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let id = 0;
    const protocol = new CodexProtocol(line => { child.stdin.write(`${line}\n`); }, () => ++id);
    const lines = createInterface({ input: child.stdout });
    lines.on("line", line => protocol.handleLine(line));
    // stderr may contain user content: drain without logging or retaining it.
    child.stderr.resume();
    const exit = () => { protocol.onProcessExit(); protocol.handleLine(JSON.stringify({ method: "workbench/processExited" })); };
    child.on("error", exit);
    child.on("exit", exit);
    child.stdin.on("error", exit);
    const close = () => { lines.close(); child.kill(); protocol.onProcessExit(); };
    try {
        await protocol.request("initialize", { clientInfo: { name: "agent_workbench", title: "Agent Workbench", version: "0.1.0" } });
        child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
        return { pid: child.pid, request: (method, params) => protocol.request(method, params), onNotification: fn => protocol.onNotification(fn), close };
    }
    catch (error) {
        close();
        throw error;
    }
}
/**
 * 把一次 turn 的状态分类。关键不变量：failed 与 interrupted 绝不归类为 success。
 */
export function classifyTurnStatus(turn: {
    status: string;
}): "success" | "failed" | "interrupted" | "running" {
    const s = turn.status;
    if (s === "failed" || s === "error")
        return "failed";
    if (s === "interrupted")
        return "interrupted";
    if (s === "completed" || s === "ok" || s === "success")
        return "success";
    return "running";
}
/** 把全部 turns 分页，保证不丢项（用于验证无 turn 被遗漏）。 */
export function paginateTurns(all: unknown[], pageSize: number): unknown[][] {
    if (pageSize <= 0) {
        throw new WorkbenchError("invalid_data", "pageSize 必须为正整数");
    }
    const pages: unknown[][] = [];
    for (let i = 0; i < all.length; i += pageSize) {
        pages.push(all.slice(i, i + pageSize));
    }
    return pages;
}
