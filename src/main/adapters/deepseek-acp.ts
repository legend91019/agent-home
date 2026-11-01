/** ACP v1 stdio transport for the official `dsh --profile acp` server. */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { WorkbenchError } from '../../shared/errors';

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout };
export type AcpNotification = { method: string; params?: unknown };

export class DeepSeekAcpProtocol {
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  private exited = false;
  private notificationHandler: ((message: AcpNotification) => void) | undefined;
  private requestHandler: ((method: string, params?: unknown) => Promise<unknown>) | undefined;

  constructor(private readonly send: (line: string) => void, private readonly timeoutMs = 10000) {}

  onNotification(handler: (message: AcpNotification) => void): void { this.notificationHandler = handler; }
  onRequest(handler: (method: string, params?: unknown) => Promise<unknown>): void { this.requestHandler = handler; }

  request(method: string, params?: unknown, timeoutMs = this.timeoutMs): Promise<unknown> {
    if (this.exited) return Promise.reject(new WorkbenchError('process_failed', 'DeepSeek Harness ACP 进程已退出'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new WorkbenchError('process_failed', `DeepSeek Harness ACP ${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send(JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} })); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new WorkbenchError('process_failed', `DeepSeek Harness ACP 写入失败: ${String(error)}`));
      }
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.exited) throw new WorkbenchError('process_failed', 'DeepSeek Harness ACP 进程已退出');
    this.send(JSON.stringify({ jsonrpc: '2.0', method, params: params ?? {} }));
  }

  handleLine(line: string): void {
    let frame: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      frame = parsed as Record<string, unknown>;
    } catch { return; } // Some dsh releases print a non-protocol account log to stdout.
    if (frame.jsonrpc !== '2.0') return;
    if (typeof frame.method === 'string' && frame.id !== undefined) {
      const cancelled = { outcome: { outcome: 'cancelled' } };
      const reply = (result: unknown) => {
        try { this.send(JSON.stringify({ jsonrpc: '2.0', id: frame.id, result })); }
        catch { /* The ACP process may have exited while the user decided. */ }
      };
      if (!this.requestHandler) {
        reply(cancelled);
      } else {
        void this.requestHandler(frame.method, frame.params)
          .then(reply)
          .catch(() => reply(cancelled));
      }
      return;
    }
    if (typeof frame.id === 'number') {
      const waiting = this.pending.get(frame.id);
      if (!waiting) return;
      clearTimeout(waiting.timer);
      this.pending.delete(frame.id);
      if (frame.error !== undefined) waiting.reject(new WorkbenchError('process_failed', `DeepSeek Harness ACP 错误: ${JSON.stringify(frame.error)}`));
      else waiting.resolve(frame.result);
      return;
    }
    if (typeof frame.method === 'string') this.notificationHandler?.({ method: frame.method, params: frame.params });
  }

  onProcessExit(): void {
    if (this.exited) return;
    this.exited = true;
    const error = new WorkbenchError('process_failed', 'DeepSeek Harness ACP 进程已退出');
    for (const waiting of this.pending.values()) { clearTimeout(waiting.timer); waiting.reject(error); }
    this.pending.clear();
  }
}

export interface DeepSeekConnection {
  readonly pid?: number;
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  onNotification(handler: (message: AcpNotification) => void): void;
  onRequest(handler: (method: string, params?: unknown) => Promise<unknown>): void;
  close(): void;
}

export async function connectDeepSeek(cwd: string): Promise<DeepSeekConnection> {
  const child = spawn(process.platform === 'win32' ? 'dsh.cmd' : 'dsh', ['--profile', 'acp'], {
    cwd, windowsHide: true, shell: process.platform === 'win32', stdio: ['pipe', 'pipe', 'pipe'],
  });
  const protocol = new DeepSeekAcpProtocol(line => child.stdin.write(`${line}\n`));
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => protocol.handleLine(line));
  child.stderr.resume(); // Output can contain user material; do not retain or log it.
  child.on('exit', () => protocol.onProcessExit());
  child.on('error', () => protocol.onProcessExit());
  child.stdin.on('error', () => protocol.onProcessExit());
  const close = () => { lines.close(); child.kill(); protocol.onProcessExit(); };
  try {
    const init = protocol.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: { name: 'agent-home', version: '0.1.0' },
    }) as Promise<{ protocolVersion?: number }>;
    const response = await init;
    if (response?.protocolVersion !== 1) throw new WorkbenchError('unsupported_version', 'DeepSeek Harness ACP 协议版本不兼容');
    protocol.notify('initialized', {});
    return {
      pid: child.pid,
      request: (method, params, timeoutMs) => protocol.request(method, params, timeoutMs),
      notify: (method, params) => protocol.notify(method, params),
      onNotification: handler => protocol.onNotification(handler),
      onRequest: handler => protocol.onRequest(handler),
      close,
    };
  } catch (error) { close(); throw error; }
}
