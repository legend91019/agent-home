/**
 * Tencent WorkBuddy 适配器。
 *
 * 探测桌面应用安装；项目级配置发布使用 CodeBuddy 公开文档中的路径。
 * 会话仅从用户明确选择的 JSON/JSONL 文件导入到应用私有数据目录。
 * 桌面版实时会话与任务控制尚无经验证的公开接口。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
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
    return JSON.stringify(value);
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
      throw new WorkbenchError("invalid_data", "WorkBuddy 导出 JSONL 包含非法行");
    }
  }
  return out;
}

function extractMessages(json: unknown): unknown[] {
  if (Array.isArray(json)) return json;
  if (json && typeof json === "object") {
    const obj = json as { messages?: unknown; turns?: unknown };
    const m = obj.messages ?? obj.turns;
    if (Array.isArray(m)) return m;
  }
  throw new WorkbenchError("invalid_data", "WorkBuddy 会话必须是消息数组或 { messages|turns: [...] }");
}

function extractContent(content: unknown): { text: string | undefined; toolCalls: ToolCall[] } {
  if (typeof content === "string") return { text: content, toolCalls: [] };
  if (Array.isArray(content)) {
    let text = "";
    const toolCalls: ToolCall[] = [];
    for (const block of content) {
      if (!block || typeof block !== "object") {
        throw new WorkbenchError("invalid_data", "WorkBuddy 消息 content 块非法");
      }
      const b = block as { type?: unknown; [k: string]: unknown };
      const type = b.type;
      if (type === "text") {
        if (typeof b.text !== "string") throw new WorkbenchError("invalid_data", "WorkBuddy 文本块缺少 text");
        text += (text ? "\n" : "") + b.text;
      } else if (type === "tool_use" || type === "tool_call") {
        if (typeof b.name !== "string") {
          throw new WorkbenchError("invalid_data", "tool 块缺少 name");
        }
        toolCalls.push({
          id: typeof b.id === "string" ? b.id : `tool_${toolCalls.length}`,
          name: b.name,
          inputSummary: summarize(b.input ?? b.args),
          outputSummary: summarize(b.output),
          status: "unknown",
        });
      } else if (type === "thinking") {
        continue;
      } else if (type === "tool_result") {
        text += (text ? "\n" : "") + summarize(b.content);
      } else {
        throw new WorkbenchError("invalid_data", `WorkBuddy 消息包含不支持的内容块: ${String(type)}`);
      }
    }
    return { text: text ? text : undefined, toolCalls };
  }
  throw new WorkbenchError("invalid_data", "WorkBuddy 消息 content 必须是字符串或块数组");
}

/** 解析 WorkBuddy 会话 JSON 为 VisibleEvent[]（纯函数、可单测）。 */
export function parseWorkBuddySession(json: unknown): VisibleEvent[] {
  const messages = extractMessages(json);
  const events: VisibleEvent[] = [];
  let index = 0;
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      throw new WorkbenchError("invalid_data", `WorkBuddy 消息 #${index} 不是对象`);
    }
    const m = msg as { role?: unknown; content?: unknown; timestamp?: unknown; id?: unknown };
    const role = m.role;
    if (role !== "user" && role !== "assistant" && role !== "system") {
      throw new WorkbenchError("invalid_data", `WorkBuddy 消息 #${index} 含不支持的 role: ${String(role)}`);
    }
    if (m.content === undefined || m.content === null) {
      throw new WorkbenchError("invalid_data", `WorkBuddy 消息 #${index} 缺少 content`);
    }
    const timestamp = typeof m.timestamp === "string" ? m.timestamp : "1970-01-01T00:00:00.000Z";
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

/** 手工导入回退（会话）：读取本地导出并解析为 VisibleEvent[]。 */
export function importSessionFromFile(filePath: string): VisibleEvent[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    throw new WorkbenchError("invalid_data", `无法读取 WorkBuddy 会话文件: ${filePath}`);
  }
  const trimmed = raw.trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    parsed = parseJsonl(trimmed);
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && "role" in parsed) parsed = [parsed];
  return parseWorkBuddySession(parsed);
}

/**
 * 手工记忆导入回退：用户粘贴的记忆摘要（数组或 { entries:[{ originalText, source }] }）
 * 映射为 system 角色可见事件，供后续人工审阅后写入记忆。
 */
export function parseWorkBuddyMemory(json: unknown): VisibleEvent[] {
  let entries: unknown[];
  if (Array.isArray(json)) entries = json;
  else if (json && typeof json === "object" && "entries" in json) {
    const e = (json as { entries?: unknown }).entries;
    if (Array.isArray(e)) entries = e;
    else throw new WorkbenchError("invalid_data", "WorkBuddy 记忆必须是数组或 { entries: [...] }");
  } else {
    throw new WorkbenchError("invalid_data", "WorkBuddy 记忆必须是数组或 { entries: [...] }");
  }
  const events: VisibleEvent[] = [];
  entries.forEach((entry, i) => {
    if (!entry || typeof entry !== "object") {
      throw new WorkbenchError("invalid_data", `WorkBuddy 记忆条目 #${i} 不是对象`);
    }
    const e = entry as { originalText?: unknown; source?: unknown };
    const text = typeof e.originalText === "string" ? e.originalText : summarize(e.originalText);
    events.push({
      index: i,
      role: "system",
      timestamp: new Date().toISOString(),
      text,
    });
  });
  return events;
}

/** 手工记忆导入回退（文件）。 */
export function importMemoryFromFile(filePath: string): VisibleEvent[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    throw new WorkbenchError("invalid_data", `无法读取 WorkBuddy 记忆文件: ${filePath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = parseJsonl(raw);
  }
  return parseWorkBuddyMemory(parsed);
}

export class WorkBuddyAdapter extends BaseAdapter implements AgentAdapter {
  readonly id: AgentId = "workbuddy";
  readonly displayName = "Tencent WorkBuddy";
  private readonly dataDir: string;
  private readonly installation: { executablePath: string; version: string | null } | null;

  constructor(options: { dataDir?: string; installation?: { executablePath: string; version: string | null } | null } = {}) {
    super();
    this.dataDir = options.dataDir ?? join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "AgentWorkbench");
    this.installation = options.installation === undefined ? discoverInstallation() : options.installation;
  }

  versionHint(): string | null {
    return this.installation && existsSync(this.installation.executablePath) ? this.installation.version ?? "installed" : null;
  }

  async probe(_projectPath: string): Promise<CapabilityReport> {
    const versionHint = this.versionHint();
    if (versionHint === null) return notInstalled(this.id, this.displayName);
    const version = `WorkBuddy ${versionHint}`;
    return {
      agentId: this.id,
      agentName: this.displayName,
      installed: true,
      authenticated: null,
      version,
      checkedAt: new Date().toISOString(),
      capabilities: [
        this.entry("config.read", "supported", "读取项目 CODEBUDDY.md 和 .codebuddy/skills", { version }),
        this.entry("config.publish", "supported", "经用户预览确认后发布到 CODEBUDDY.md 和 .codebuddy/skills，可回滚", { version }),
        this.entry("memory.readVisible", "degraded", "可读取项目 CODEBUDDY.md；桌面版原生记忆无已验证读取接口", { version }),
        this.entry("sessions.list", "degraded", "仅列出用户主动导入的 JSON/JSONL 会话文件，不读取桌面实时会话", { version }),
        this.entry("sessions.readVisible", "degraded", "仅解析已导入文件中的可见消息和工具内容", { version }),
        this.entry("tasks.start", "unsupported", "桌面版任务启动接口未验证；捆绑的 CodeBuddy CLI 不等同于桌面会话", { version }),
        this.entry("tasks.interrupt", "unsupported", "桌面版任务中断接口未验证", { version }),
        this.entry("usage.exact", "unknown", "未接入 WorkBuddy 用量来源", { version }),
        this.entry("skills.invocationEvidence", "unknown", "未接入 WorkBuddy skill 调用事件", { version }),
      ],
    };
  }

  private importDirectory(projectPath: string): string {
    const projectKey = createHash("sha256").update(resolve(projectPath).toLowerCase()).digest("hex");
    return join(this.dataDir, "workbuddy-imports", projectKey);
  }

  importSession(projectPath: string, filePath: string): SessionRef {
    if (![".json", ".jsonl"].includes(extname(filePath).toLowerCase()))
      throw new WorkbenchError("invalid_data", "WorkBuddy 会话文件须为 JSON 或 JSONL");
    const directory = this.importDirectory(projectPath);
    mkdirSync(directory, { recursive: true });
    const id = randomUUID();
    const pending = join(directory, `${id}.pending`);
    try {
      copyFileSync(filePath, pending);
      const events = importSessionFromFile(pending);
      if (!events.length) throw new WorkbenchError("invalid_data", "WorkBuddy 会话没有可见消息");
      renameSync(pending, join(directory, `${id}${extname(filePath).toLowerCase()}`));
      return this.sessionRef(id, projectPath, events);
    } catch (error) {
      rmSync(pending, { force: true });
      throw error;
    }
  }

  private sessionRef(id: string, projectPath: string, events: VisibleEvent[]): SessionRef {
    return {
      agentId: this.id,
      id,
      title: events.find((event) => event.role === "user")?.text?.slice(0, 120) ?? `WorkBuddy 导入 ${id.slice(0, 8)}`,
      messageCount: events.length,
      startedAt: events[0]?.timestamp,
      updatedAt: events.at(-1)?.timestamp,
      nativeProjectPath: projectPath,
    };
  }

  async listSessions(projectPath: string): Promise<SessionRef[]> {
    const directory = this.importDirectory(projectPath);
    if (!existsSync(directory)) return [];
    const sessions: SessionRef[] = [];
    for (const name of readdirSync(directory)) {
      if (!/^[0-9a-f-]{36}\.jsonl?$/.test(name)) continue;
      const file = join(directory, name);
      try {
        if (!statSync(file).isFile()) continue;
        const events = importSessionFromFile(file);
        if (events.length) sessions.push(this.sessionRef(name.replace(/\.jsonl?$/, ""), projectPath, events));
      } catch { /* 单个损坏的导入文件不影响其他会话。 */ }
    }
    return sessions.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  }

  async *readVisibleSession(session: SessionRef): AsyncIterable<VisibleEvent> {
    if (session.agentId !== this.id || !session.nativeProjectPath || !/^[0-9a-f-]{36}$/.test(session.id))
      throw new WorkbenchError("session_unavailable", "WorkBuddy 会话引用无效");
    const directory = this.importDirectory(session.nativeProjectPath);
    const candidate = [".json", ".jsonl"].map((extension) => join(directory, `${session.id}${extension}`)).find(existsSync);
    if (!candidate) throw new WorkbenchError("session_unavailable", "WorkBuddy 导入会话文件不可用");
    for (const event of importSessionFromFile(candidate)) yield event;
  }

  async startTask(_input: StartTaskInput): Promise<RunHandle> {
    throw new WorkbenchError("unsupported_version", "WorkBuddy 桌面版任务启动接口未验证；请在 WorkBuddy 中手动打开交接内容。");
  }
}

function discoverInstallation(): { executablePath: string; version: string | null } | null {
  if (process.platform !== "win32") return null;
  const roots = [
    "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
    "HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall",
  ];
  for (const root of roots) {
    const found = spawnSync("reg.exe", ["query", root, "/s", "/f", "WorkBuddy", "/d"], { encoding: "utf8", timeout: 5000, windowsHide: true });
    if (found.status !== 0) continue;
    const sections = found.stdout.split(/(?=^HKEY_)/m);
    for (const section of sections) {
      if (!/^\s*DisplayName\s+REG_\w+\s+WorkBuddy(?:\s|$)/mi.test(section)) continue;
      const key = section.match(/^HKEY_[^\r\n]+/m)?.[0];
      if (!key) continue;
      const details = spawnSync("reg.exe", ["query", key], { encoding: "utf8", timeout: 5000, windowsHide: true });
      if (details.status !== 0) continue;
      const icon = details.stdout.match(/^\s*DisplayIcon\s+REG_\w+\s+(.+)$/mi)?.[1]?.trim();
      const executablePath = icon?.replace(/,\d+$/, "").replace(/^"|"$/g, "");
      if (!executablePath || basename(executablePath).toLowerCase() !== "workbuddy.exe" || !existsSync(executablePath)) continue;
      const version = details.stdout.match(/^\s*DisplayVersion\s+REG_\w+\s+(.+)$/mi)?.[1]?.trim() ?? null;
      return { executablePath, version };
    }
  }
  return null;
}
