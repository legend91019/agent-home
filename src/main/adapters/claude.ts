/**
 * Claude Code 适配器。
 *
 * 设计原则：能力协商。任何本环境无法验证的能力一律标记为 unknown（或 unsupported），
 * 绝不谎报 supported。当程序化读取不可用时，提供「手工导出导入」回退
 * （parseClaudeSession / importSessionFromFile），而不是声称拥有实时访问。
 * 绝不读取隐藏推理、凭据或第三方私有数据库。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

/** 截断摘要，避免把大块输入/输出塞进事件列表。 */
function summarize(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    const s = JSON.stringify(value);
    return s.length > 500 ? `${s.slice(0, 500)}…` : s;
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
    const m = msg as { role?: unknown; content?: unknown; timestamp?: unknown; uuid?: unknown; id?: unknown };
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
      typeof m.timestamp === "string" ? m.timestamp : new Date().toISOString();
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
  return parseClaudeSession(parsed);
}

export class ClaudeAdapter extends BaseAdapter implements AgentAdapter {
  readonly id: AgentId = "claude-code";
  readonly displayName = "Claude Code";

  /** 运行 `claude --version`；未安装时返回 null。Windows 上的 npm shim 需要 shell。 */
  versionHint(): string | null {
    const attempt = (shell: boolean): string | null => {
      try {
        const res = spawnSync("claude", ["--version"], {
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
    return attempt(false) ?? attempt(true);
  }

  async probe(_projectPath: string): Promise<CapabilityReport> {
    const v = this.versionHint();
    if (v === null) return notInstalled(this.id, this.displayName);

    const version = `claude CLI ${v}`;
    const u = (_cap: string) =>
      `${version} 已安装；该能力在沙箱中未做真实验证`;
    const caps: CapabilityReportEntry[] = [
      this.entry("sessions.list", "unknown", u("sessions.list"), { version }),
      this.entry("sessions.readVisible", "unknown", u("sessions.readVisible"), { version }),
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
      this.entry("tasks.start", "unknown", u("tasks.start"), { version }),
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
      authenticated: null,
      version,
      capabilities: caps,
      checkedAt: new Date().toISOString(),
    };
  }

  /** 不伪造会话列表：本环境无法验证真实列表来源。 */
  async listSessions(_projectPath: string): Promise<SessionRef[]> {
    return [];
  }

  async *readVisibleSession(session: SessionRef): AsyncIterable<VisibleEvent> {
    // 实时会话读取在沙箱中未验证。若用户把导出文件路径作为 session.id 手工提供，
    // 则通过文件回退读取（不读取任何隐藏推理/凭据）。
    const candidate = session.id;
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
      "Claude 实时会话读取在沙箱中未验证；请使用手工导出导入（importSessionFromFile）。",
    );
  }

  async startTask(_input: StartTaskInput): Promise<RunHandle> {
    // 沙箱未验证 CLI 任务启动（需要鉴权且无法确认环境），绝不假装成功。
    throw new WorkbenchError(
      "not_authenticated",
      "Claude 任务启动在沙箱中未验证；未做真实 CLI 调用。",
    );
  }
}
