/**
 * ZCode 适配器。
 *
 * 能力协商：本环境未安装/未验证 ZCode，probe 返回 installed:false（notInstalled）。
 * 注意：ZCode 支持单向导入 Claude Code 历史，因此它的会话导入解析兼容 Claude Code
 * 的导出格式（消息数组或 { messages: [...] }，含 tool_use 块）。提供手工导入回退。
 * 实时列表/读取与任务启动在未验证前一律 honest 降级。
 */
import { existsSync, readFileSync } from "node:fs";
import {
  type AgentId,
  type CapabilityReport,
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

function parseJsonl(text: string): unknown[] {
  const out: unknown[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      throw new WorkbenchError("invalid_data", "ZCode 会话 JSONL 包含非法行");
    }
  }
  return out;
}

function extractMessages(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (json && typeof json === "object" && "messages" in json) {
    const m = (json as { messages?: unknown }).messages;
    if (Array.isArray(m)) return m;
  }
  throw new WorkbenchError("invalid_data", "ZCode 会话必须是消息数组或 { messages: [...] }");
}

function extractContent(content: unknown): { text: string | undefined; toolCalls: ToolCall[] } {
  if (typeof content === "string") return { text: content, toolCalls: [] };
  if (Array.isArray(content)) {
    let text = "";
    const toolCalls: ToolCall[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") {
        throw new WorkbenchError("invalid_data", "ZCode 消息 content 块非法");
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
        text += (text ? "\n" : "") + summarize(b.content);
      } else if (type === "thinking") {
        continue;
      }
    }
    return { text: text ? text : undefined, toolCalls };
  }
  throw new WorkbenchError("invalid_data", "ZCode 消息 content 必须是字符串或块数组");
}

/**
 * 解析 ZCode 会话 JSON 为 VisibleEvent[]。兼容 Claude Code 导出（单向导入）。
 * 纯函数、可单测；非法输入抛出 WorkbenchError('invalid_data')。
 */
export function parseZCodeSession(json: unknown): VisibleEvent[] {
  const messages = extractMessages(json);
  const events: VisibleEvent[] = [];
  let index = 0;
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      throw new WorkbenchError("invalid_data", `ZCode 消息 #${index} 不是对象`);
    }
    const m = msg as { role?: unknown; content?: unknown; timestamp?: unknown; id?: unknown };
    const role = m.role;
    if (role !== "user" && role !== "assistant" && role !== "system") {
      throw new WorkbenchError("invalid_data", `ZCode 消息 #${index} 含不支持的 role: ${String(role)}`);
    }
    if (m.content === undefined || m.content === null) {
      throw new WorkbenchError("invalid_data", `ZCode 消息 #${index} 缺少 content`);
    }
    const timestamp = typeof m.timestamp === "string" ? m.timestamp : new Date().toISOString();
    const { text, toolCalls } = extractContent(m.content);
    events.push({
      index: index++,
      role,
      timestamp,
      nativeId: typeof m.id === "string" ? m.id : undefined,
      text,
      toolCalls: toolCalls.length ? toolCalls : undefined,
    });
  }
  return events;
}

/** 手工导入回退：读取本地导出（含兼容的 Claude Code 历史）并解析。 */
export function importSessionFromFile(filePath: string): VisibleEvent[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    throw new WorkbenchError("invalid_data", `无法读取 ZCode 会话文件: ${filePath}`);
  }
  const trimmed = raw.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    parsed = parseJsonl(trimmed);
  }
  return parseZCodeSession(parsed);
}

export class ZCodeAdapter extends BaseAdapter implements AgentAdapter {
  readonly id: AgentId = "zcode";
  readonly displayName = "ZCode";

  versionHint(): string | null {
    return null;
  }

  async probe(_projectPath: string): Promise<CapabilityReport> {
    // 未验证：listSessions/readVisibleSession 标记为 unknown 直到验证；
    // 当前环境直接返回 notInstalled，绝不谎报。
    return notInstalled(this.id, this.displayName);
  }

  async listSessions(_projectPath: string): Promise<SessionRef[]> {
    return [];
  }

  async *readVisibleSession(session: SessionRef): AsyncIterable<VisibleEvent> {
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
      "ZCode 实时会话读取未验证；请使用手工导出导入（兼容 Claude Code 历史）。",
    );
  }

  async startTask(_input: StartTaskInput): Promise<RunHandle> {
    // 除非验证通过，否则不假装可启动任务。
    throw new WorkbenchError("unsupported_version", "ZCode 任务启动未验证；不可用。");
  }
}
