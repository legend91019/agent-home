/**
 * Codex 适配器。
 *
 * 能力协商：Codex 在本环境未安装，probe 返回 installed:false（notInstalled）。
 * 提供 parseCodexThread / importThreadFromFile 作为「手工导出导入」回退。
 * 绝不伪造会话读取或任务启动。
 */
import { spawnSync } from "node:child_process";
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
      throw new WorkbenchError("invalid_data", "Codex 线程 JSONL 包含非法行");
    }
  }
  return out;
}

function extractTurns(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (json && typeof json === "object" && "turns" in json) {
    const t = (json as { turns?: unknown }).turns;
    if (Array.isArray(t)) return t;
  }
  throw new WorkbenchError(
    "invalid_data",
    "Codex 线程必须是 turns 数组，或 { turns: [...] } 对象",
  );
}

function extractTurnContent(content: unknown): { text: string | undefined; toolCalls: ToolCall[] } {
  if (typeof content === "string") return { text: content, toolCalls: [] };
  if (Array.isArray(content)) {
    let text = "";
    const toolCalls: ToolCall[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") {
        throw new WorkbenchError("invalid_data", "Codex turn content 块格式非法");
      }
      const b = block as { type?: unknown; [k: string]: unknown };
      const type = b.type;
      if (type === "text") {
        text += typeof b.text === "string" ? (text ? "\n" : "") + b.text : "";
      } else if (type === "tool_call") {
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
    const t = turn as { role?: unknown; content?: unknown; created_at?: unknown; id?: unknown };
    const role = t.role;
    if (role !== "user" && role !== "assistant" && role !== "system") {
      throw new WorkbenchError(
        "invalid_data",
        `Codex turn #${index} 含不支持的 role: ${String(role)}`,
      );
    }
    if (t.content === undefined || t.content === null) {
      throw new WorkbenchError("invalid_data", `Codex turn #${index} 缺少 content`);
    }
    const timestamp =
      typeof t.created_at === "string" ? t.created_at : new Date().toISOString();
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
  } catch {
    throw new WorkbenchError("invalid_data", `无法读取 Codex 线程文件: ${filePath}`);
  }
  const trimmed = raw.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    parsed = parseJsonl(trimmed);
  }
  return parseCodexThread(parsed);
}

export class CodexAdapter extends BaseAdapter implements AgentAdapter {
  readonly id: AgentId = "codex";
  readonly displayName = "Codex";

  versionHint(): string | null {
    const attempt = (shell: boolean): string | null => {
      try {
        const res = spawnSync("codex", ["--version"], {
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
    if (this.versionHint() === null) {
      return notInstalled(this.id, this.displayName);
    }
    // 若未来在本环境验证安装，则如实上报 unknown 能力；此处保持保守。
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
      const events = importThreadFromFile(candidate);
      for (const e of events) yield e;
      return;
    }
    throw new WorkbenchError(
      "session_unavailable",
      "Codex 实时会话读取未验证；请使用手工导出导入（importThreadFromFile）。",
    );
  }

  async startTask(_input: StartTaskInput): Promise<RunHandle> {
    throw new WorkbenchError("not_installed", "Codex 未安装/未验证；任务启动不可用。");
  }
}
