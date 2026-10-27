/**
 * Claude Code 适配器。
 *
 * 读取官方文档化的本地 transcript，通过现有登录的 CLI print 模式启动任务。
 * 保留手工 JSON/JSONL 导入回退；进程完成不等于模型目标已被验收。
 * 绝不读取隐藏推理、凭据或第三方私有数据库。
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, delimiter } from "node:path";
import { randomUUID } from "node:crypto";
import {
  type AgentId,
  type CapabilityReport,
  type CapabilityReportEntry,
  type SessionRef,
  type ToolCall,
  type VisibleEvent,
} from "../../shared/contracts";
import { WorkbenchError } from "../../shared/errors";
import {
  type AgentAdapter,
  BaseAdapter,
  notInstalled,
  type RunHandle,
  type StartTaskInput,
} from "./types";

/** 契约字段虽名为 Summary，交接必须保留完整工具原文。 */
function summarize(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    const s = JSON.stringify(value);
    return s;
  } catch {
    return String(value);
  }
}

/** 将一行 JSONL 解析为对象数组（每行一个 JSON 对象）。 */
function parseJsonl(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      throw new WorkbenchError("invalid_data", "Claude 会话 JSONL 包含非法行");
    }
  }
  return out;
}

/** 从会话 JSON（数组或 {messages:[...]}）中提取消息数组。 */
function extractMessages(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (json && typeof json === "object" && "messages" in json) {
    const m = (json as { messages?: unknown }).messages;
    if (Array.isArray(m)) return m;
  }
  throw new WorkbenchError(
    "invalid_data",
    "Claude 会话必须是消息数组，或 { messages: [...] } 对象",
  );
}

/** 把一条消息的 content（字符串或块数组）拆成可见文本与 tool_use 调用。 */
function extractContent(content: unknown): { text: string | undefined; toolCalls: ToolCall[] } {
  if (typeof content === "string") {
    return { text: content, toolCalls: [] };
  }
  if (Array.isArray(content)) {
    let text = "";
    const toolCalls: ToolCall[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") {
        throw new WorkbenchError("invalid_data", "Claude 消息 content 块格式非法");
      }
      const b = block as { type?: unknown; [k: string]: unknown };
      const type = b.type;
      if (type === "text") {
        text += typeof b.text === "string" ? (text ? "\n" : "") + b.text : "";
      } else if (type === "tool_use") {
        if (typeof b.name !== "string") {
          throw new WorkbenchError("invalid_data", "tool_use 块缺少 name");
        }
        toolCalls.push({
          id: typeof b.id === "string" ? b.id : `tool_${toolCalls.length}`,
          name: b.name,
          inputSummary: summarize(b.input),
          outputSummary: "",
          status: "unknown",
        });
      } else if (type === "tool_result") {
        // 可见的工具输出：折叠进文本，保持会话可读性。
        text += (text ? "\n" : "") + summarize(b.content);
      } else if (type === "thinking") {
        // 隐藏推理：绝不外显。
        continue;
      }
      // 其它块类型（如 image）忽略。
    }
    return { text: text ? text : undefined, toolCalls };
  }
  throw new WorkbenchError("invalid_data", "Claude 消息 content 必须是字符串或块数组");
}

/**
 * 把一段 Claude 会话 JSON 解析为按源顺序的 VisibleEvent[]。
 * 纯函数、可单测；输入非法时抛出 WorkbenchError('invalid_data')。
 */
export function parseClaudeSession(json: unknown): VisibleEvent[] {
  const messages = extractMessages(json);
  const events: VisibleEvent[] = [];
  let index = 0;
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      throw new WorkbenchError("invalid_data", `Claude 消息 #${index} 不是对象`);
    }
    const record = msg as Record<string, unknown>;
    // Native JSONL includes bookkeeping records; only message envelopes are visible.
    if (typeof record.type === "string" && !["user", "assistant", "system"].includes(record.type)) continue;
    const m = (record.message && typeof record.message === "object" ? { ...record, ...record.message } : record) as { role?: unknown; content?: unknown; timestamp?: unknown; uuid?: unknown; id?: unknown };
    const role = m.role;
    if (role !== "user" && role !== "assistant" && role !== "system") {
      throw new WorkbenchError(
        "invalid_data",
        `Claude 消息 #${index} 含不支持的 role: ${String(role)}`,
      );
    }
    if (m.content === undefined || m.content === null) {
      throw new WorkbenchError("invalid_data", `Claude 消息 #${index} 缺少 content`);
    }
    const timestamp =
      typeof m.timestamp === "string" ? m.timestamp : "1970-01-01T00:00:00.000Z";
    const { text, toolCalls } = extractContent(m.content);
    const nativeId =
      typeof m.uuid === "string"
        ? m.uuid
        : typeof m.id === "string"
          ? m.id
          : undefined;
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
export function importSessionFromFile(filePath: string): VisibleEvent[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    throw new WorkbenchError("invalid_data", `无法读取 Claude 会话文件: ${filePath}`);
  }
  const trimmed = raw.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    parsed = parseJsonl(trimmed);
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "type" in parsed) parsed = [parsed];
  return parseClaudeSession(parsed);
}

export class ClaudeAdapter extends BaseAdapter implements AgentAdapter {
  readonly id: AgentId = "claude-code";
  readonly displayName = "Claude Code";
  private readonly configDirectory: string;
  private readonly command: { file: string; args: string[] };
  private readonly sessionFiles = new Map<string, string>();
  private readonly completions = new Map<string, Promise<"succeeded" | "failed" | "cancelled">>();

  constructor(options: { configDirectory?: string; command?: { file: string; args: string[] } } = {}) {
    super();
    this.configDirectory = options.configDirectory ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
    this.command = options.command ?? this.resolveCommand();
  }

  private resolveCommand(): { file: string; args: string[] } {
    if (process.platform === "win32") {
      for (const dir of (process.env.PATH ?? "").split(delimiter)) {
        if (existsSync(join(dir, "claude.exe"))) return { file: join(dir, "claude.exe"), args: [] };
        const native = join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe");
        if (existsSync(native)) return { file: native, args: [] };
        const cli = join(dir, "node_modules", "@anthropic-ai", "claude-code", "cli.js");
        if (existsSync(cli)) return { file: process.execPath, args: [cli] };
      }
    }
    return { file: "claude", args: [] };
  }

  authenticated(): boolean | null {
    const result = spawnSync(this.command.file, [...this.command.args, "auth", "status"], { encoding: "utf8", timeout: 5000, windowsHide: true, env: { ...process.env, CLAUDE_CONFIG_DIR: this.configDirectory } });
    try { return JSON.parse(result.stdout).loggedIn === true; } catch { return null; }
  }

  /** 运行 `claude --version`；未安装时返回 null。Windows 上的 npm shim 需要 shell。 */
  versionHint(): string | null {
    const attempt = (shell: boolean): string | null => {
      try {
        const res = spawnSync(this.command.file, [...this.command.args, "--version"], {
          encoding: "utf8",
          timeout: 5000,
          shell,
        });
        if (res.error || res.status !== 0) return null;
        const out = (res.stdout ?? "").trim();
        return out ? out : null;
      } catch {
        return null;
      }
    };
    return attempt(false);
  }

  async probe(_projectPath: string): Promise<CapabilityReport> {
    const v = this.versionHint();
    if (v === null) return notInstalled(this.id, this.displayName);

    const version = `claude CLI ${v}`;
    const u = (_cap: string) =>
      `${version} 已安装；该能力在沙箱中未做真实验证`;
    const caps: CapabilityReportEntry[] = [
      this.entry("sessions.list", "supported", "读取官方文档化 projects JSONL transcript", { version }),
      this.entry("sessions.readVisible", "supported", "保留本地 transcript 可见消息与完整工具内容", { version }),
      this.entry("memory.readVisible", "unknown", u("memory.readVisible"), { version }),
      this.entry(
        "config.read",
        "supported",
        "CLAUDE.md 是可读的项目文件，可通过文件系统读取",
        { version },
      ),
      this.entry(
        "config.publish",
        "supported",
        "CLAUDE.md 是可写的项目文件，可通过文件系统发布",
        { version },
      ),
      this.entry("tasks.start", this.authenticated() === true ? "supported" : "unknown", "使用现有 CLI 登录启动 print 模式；不绕过权限", { version }),
      typeof (this as unknown as { interrupt?: unknown }).interrupt === "function"
        ? this.entry("tasks.interrupt", "unknown", u("tasks.interrupt"), { version })
        : this.entry(
            "tasks.interrupt",
            "unsupported",
            "适配器未实现 interrupt（本环境也未验证实时进程控制）",
            { version },
          ),
      this.entry("usage.exact", "unknown", u("usage.exact"), { version }),
      this.entry(
        "skills.invocationEvidence",
        "unknown",
        u("skills.invocationEvidence"),
        { version },
      ),
    ];

    return {
      agentId: this.id,
      agentName: this.displayName,
      installed: true,
      authenticated: this.authenticated(),
      version,
      capabilities: caps,
      checkedAt: new Date().toISOString(),
    };
  }

  /** 只读取指定项目的 transcript，不扫描凭据、数据库或其他项目。 */
  async listSessions(projectPath: string): Promise<SessionRef[]> {
    const dir = join(this.configDirectory, "projects", projectPath.replace(/[^a-zA-Z0-9]/g, "-"));
    if (!existsSync(dir)) return [];
    const sessions: SessionRef[] = [];
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".jsonl"))) {
      const path = join(dir, file);
      const events = importSessionFromFile(path);
      if (!events.length) continue;
      const id = file.slice(0, -6);
      this.sessionFiles.set(id, path);
      sessions.push({ agentId: this.id, id, title: events.find((e) => e.role === "user")?.text?.slice(0, 120), messageCount: events.length, startedAt: events[0].timestamp, updatedAt: events.at(-1)?.timestamp, nativeProjectPath: projectPath });
    }
    return sessions.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }

  async *readVisibleSession(session: SessionRef): AsyncIterable<VisibleEvent> {
    if (session.agentId !== this.id) throw new WorkbenchError("session_unavailable", "会话不属于 Claude Code");
    const candidate = this.sessionFiles.get(session.id) ?? (session.nativeProjectPath && /^[a-zA-Z0-9_-]+$/.test(session.id) ? join(this.configDirectory, "projects", session.nativeProjectPath.replace(/[^a-zA-Z0-9]/g, "-"), `${session.id}.jsonl`) : session.id);
    if (
      candidate &&
      (candidate.endsWith(".json") || candidate.endsWith(".jsonl")) &&
      existsSync(candidate)
    ) {
      const events = importSessionFromFile(candidate);
      for (const e of events) yield e;
      return;
    }
    throw new WorkbenchError(
      "session_unavailable",
      "Claude 本地会话文件不可用；可导入用户导出的 JSON/JSONL 文件。",
    );
  }

  async startTask(input: StartTaskInput): Promise<RunHandle> {
    if (this.authenticated() !== true) throw new WorkbenchError("not_authenticated", "请先通过 Claude Code CLI 登录");
    const nativeSessionId = input.sessionId ?? randomUUID();
    if (!/^[a-zA-Z0-9_-]+$/.test(nativeSessionId)) throw new WorkbenchError("invalid_data", "Claude 会话 ID 非法");
    const child = spawn(this.command.file, [...this.command.args, "-p", "--output-format", "stream-json", "--verbose", input.sessionId ? "--resume" : "--session-id", nativeSessionId], { cwd: input.projectPath, windowsHide: true, stdio: ["pipe", "pipe", "ignore"], env: { ...process.env, CLAUDE_CONFIG_DIR: this.configDirectory } });
    const runId = randomUUID();
    let finish!: (state: "succeeded" | "failed" | "cancelled") => void;
    this.completions.set(runId, new Promise((resolve) => { finish = resolve; }));
    return new Promise((resolve, reject) => {
      let initialized = false;
      let resultFailed = false;
      let buffer = "";
      const fail = () => reject(new WorkbenchError("process_failed", "Claude CLI 在建立会话前退出"));
      child.on("error", () => { finish("failed"); fail(); });
      child.on("close", (code) => { finish(code === 0 && !resultFailed ? "succeeded" : "failed"); if (!initialized) fail(); });
      child.stdin.on("error", () => { /* close/error handlers report process failure */ });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buffer += chunk;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
          try {
            const event = JSON.parse(line);
            if (event.type === "result" && event.is_error === true) resultFailed = true;
            if (!initialized && event.type === "system" && event.subtype === "init" && event.session_id === nativeSessionId) {
              initialized = true;
              resolve({ runId, nativeSessionId, pid: child.pid, startedAt: new Date().toISOString() });
            }
          } catch { /* ignore non-protocol diagnostics */ }
        }
      });
      child.stdin.end(input.handoffPath ? `请先读取以下 UTF-8 文件，作为完整交接历史：${JSON.stringify(input.handoffPath)}\n然后继续执行目标：\n${input.goal}` : input.goal);
    });
  }

  async waitForCompletion(handle: RunHandle): Promise<"succeeded" | "failed" | "cancelled"> {
    const completion = this.completions.get(handle.runId);
    if (!completion) throw new WorkbenchError("session_unavailable", "Claude 运行句柄不在当前进程中");
    return completion;
  }
}
