/** Parse official dsh Web exports. Private ~/.dsh persistence files are never read. */
import { Unzip, UnzipInflate } from 'fflate';
import { type AttachmentRef, type ToolCall, type VisibleEvent } from '../../shared/contracts';
import { WorkbenchError } from '../../shared/errors';

export interface ParsedDeepSeekExport {
  sessionId: string | null;
  projectPath: string | null;
  events: VisibleEvent[];
  completeness: 'structured' | 'text-only';
  attachments: Record<string, Uint8Array>;
}

const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 48 * 1024 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
function obj(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new WorkbenchError('invalid_data', 'dsh 导出对象格式不合法');
  return value as Record<string, unknown>;
}
function safeName(name: string): boolean {
  return !!name && !name.includes('\\') && !name.startsWith('/') && !name.includes(':') && name.split('/').every(part => part !== '.' && part !== '..' && part !== '');
}
function samePath(a: string, b: string): boolean {
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
  return norm(a) === norm(b);
}
function decoded(bytes: Uint8Array): string {
  try { return decoder.decode(bytes); }
  catch { throw new WorkbenchError('invalid_data', 'dsh 导出不是有效 UTF-8'); }
}

/** Read ZIP central-directory metadata before asking fflate to inflate anything. */
function inspectZip(bytes: Buffer): void {
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new WorkbenchError('invalid_data', 'dsh ZIP 超过 20 MiB 上限');
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new WorkbenchError('invalid_data', 'dsh ZIP 缺少中央目录');
  const count = bytes.readUInt16LE(eocd + 10);
  const size = bytes.readUInt32LE(eocd + 12);
  let position = bytes.readUInt32LE(eocd + 16);
  if (count > 512 || count === 0 || position + size > eocd) throw new WorkbenchError('invalid_data', 'dsh ZIP 目录异常');
  const names = new Set<string>();
  let expanded = 0;
  for (let i = 0; i < count; i++) {
    if (position + 46 > bytes.length || bytes.readUInt32LE(position) !== 0x02014b50) throw new WorkbenchError('invalid_data', 'dsh ZIP 目录损坏');
    const flags = bytes.readUInt16LE(position + 8);
    const method = bytes.readUInt16LE(position + 10);
    const compressed = bytes.readUInt32LE(position + 20);
    const uncompressed = bytes.readUInt32LE(position + 24);
    const nameLength = bytes.readUInt16LE(position + 28);
    const extraLength = bytes.readUInt16LE(position + 30);
    const commentLength = bytes.readUInt16LE(position + 32);
    const external = bytes.readUInt32LE(position + 38);
    const end = position + 46 + nameLength + extraLength + commentLength;
    if (end > bytes.length) throw new WorkbenchError('invalid_data', 'dsh ZIP 目录越界');
    const name = decoded(bytes.subarray(position + 46, position + 46 + nameLength));
    const parts = name.endsWith('/') ? name.slice(0, -1) : name;
    if (!safeName(parts) || names.has(name)) throw new WorkbenchError('invalid_data', 'dsh ZIP 包含重复或越界路径');
    names.add(name);
    const fileMode = (external >>> 16) & 0xf000;
    if ((flags & 1) || ![0, 8].includes(method) || fileMode === 0xa000 || compressed === 0xffffffff || uncompressed === 0xffffffff)
      throw new WorkbenchError('invalid_data', 'dsh ZIP 包含不支持的加密、压缩或符号链接条目');
    expanded += uncompressed;
    if (expanded > MAX_EXPANDED_BYTES || (compressed > 0 && uncompressed / compressed > 200))
      throw new WorkbenchError('invalid_data', 'dsh ZIP 展开体积或压缩比超过上限');
    position = end;
  }
  if (position !== bytes.readUInt32LE(eocd + 16) + size) throw new WorkbenchError('invalid_data', 'dsh ZIP 目录长度不一致');
}

function attachment(block: Record<string, unknown>, archive: Record<string, Uint8Array>): AttachmentRef {
  const ref = obj(block.attachment);
  if (typeof ref.attachmentId !== 'string') throw new WorkbenchError('invalid_data', 'dsh 附件缺少 id');
  const id = ref.attachmentId;
  let path: string | undefined;
  if (block.type === 'image') path = Object.keys(archive).find(name => name.startsWith(`media/${id}.`));
  else {
    const digest = id.replace(/^sha256:/, '');
    path = Object.keys(archive).find(name => name.startsWith(`files/${digest.slice(0, 2)}/${digest}/`));
  }
  return {
    name: typeof ref.name === 'string' ? ref.name : id,
    kind: String(block.type),
    sizeBytes: path ? archive[path].length : null,
    externalRef: path,
    available: !!path,
  };
}
function content(value: unknown, archive: Record<string, Uint8Array>): { text: string; attachments: AttachmentRef[] } {
  if (!Array.isArray(value)) throw new WorkbenchError('invalid_data', 'dsh 消息缺少内容块');
  const texts: string[] = [];
  const attachments: AttachmentRef[] = [];
  for (const raw of value) {
    const block = obj(raw);
    if (block.type === 'text') {
      if (typeof block.text !== 'string') throw new WorkbenchError('invalid_data', 'dsh 文本块缺少 text');
      texts.push(block.text);
    } else if (block.type === 'image' || block.type === 'file') attachments.push(attachment(block, archive));
    else if (block.type === 'tool-result') {
      const nested = content(block.content, archive);
      texts.push(nested.text);
      attachments.push(...nested.attachments);
    } else if (block.type === 'reasoning' || block.type === 'tool-call' || block.type === 'tool-addition' || block.type === 'tool-removal') continue;
    else throw new WorkbenchError('unsupported_version', `dsh 未知内容块: ${String(block.type)}`);
  }
  return { text: texts.join('\n'), attachments };
}

function parseLog(text: string, projectPath: string, archive: Record<string, Uint8Array>): { sessionId: string; events: VisibleEvent[] } {
  const lines = text.trimEnd().split(/\r?\n/);
  if (!lines[0]) throw new WorkbenchError('invalid_data', 'dsh 会话日志没有会话头');
  let header: Record<string, unknown>;
  try { header = obj(JSON.parse(lines[0])); }
  catch { throw new WorkbenchError('invalid_data', 'dsh 会话头无效'); }
  if (header.type !== 'session' || header.version !== 4) throw new WorkbenchError('unsupported_version', `dsh 导出版本不支持: ${String(header.version)}`);
  if (typeof header.id !== 'string' || typeof header.cwd !== 'string') throw new WorkbenchError('invalid_data', 'dsh 会话头缺少 id 或项目路径');
  if (!samePath(header.cwd, projectPath)) throw new WorkbenchError('invalid_data', 'dsh 导出会话不属于当前项目');
  const events: VisibleEvent[] = [];
  const calls = new Map<string, ToolCall>();
  for (let i = 1; i < lines.length; i++) {
    let row: Record<string, unknown>;
    try { row = obj(JSON.parse(lines[i])); }
    catch { throw new WorkbenchError('invalid_data', `dsh 事件第 ${i} 行无效`); }
    if (row.seq !== i - 1 || typeof row.time !== 'number' || !Number.isFinite(row.time) || Math.abs(row.time) > 8.64e15 || typeof row.type !== 'string')
      throw new WorkbenchError('invalid_data', `dsh 事件第 ${i} 行序号或时间无效`);
    const timestamp = new Date(row.time).toISOString();
    const data = obj(row.data);
    const base = { index: events.length, timestamp, nativeId: `${header.id}:${row.seq}` };
    if (row.type === 'user/message') {
      const source = obj(data.source);
      if (source.kind !== 'user' || row.surfaceOp !== 'append') continue;
      const parsed = content(data.content, archive);
      events.push({ ...base, role: 'user', text: parsed.text, attachments: parsed.attachments.length ? parsed.attachments : undefined });
    } else if (row.type === 'assistant/message') {
      if (row.surfaceOp !== 'append') continue;
      const parsed = content(obj(data.message).content, archive);
      if (parsed.text || parsed.attachments.length) events.push({ ...base, role: 'assistant', text: parsed.text, attachments: parsed.attachments.length ? parsed.attachments : undefined });
    } else if (row.type === 'tool/call') {
      if (typeof data.callId !== 'string' || typeof data.name !== 'string' || typeof data.arguments !== 'string') throw new WorkbenchError('invalid_data', 'dsh 工具调用缺少字段');
      const call: ToolCall = { id: data.callId, name: data.name, inputSummary: data.arguments, outputSummary: '', status: 'unknown' };
      calls.set(call.id, call);
      events.push({ ...base, role: 'tool', toolCalls: [call] });
    } else if (row.type === 'tool/result') {
      const message = obj(data.message);
      const source = obj(message.source);
      const call = calls.get(String(source.callId));
      if (!call) throw new WorkbenchError('invalid_data', 'dsh 工具结果缺少对应调用');
      const parsed = content(message.content, archive);
      call.outputSummary = parsed.text;
      if (parsed.attachments.length) {
        const callEvent = events.find(event => event.toolCalls?.some(item => item.id === call.id));
        if (callEvent) callEvent.attachments = [...(callEvent.attachments ?? []), ...parsed.attachments];
      }
      const resultBlock = Array.isArray(message.content) ? message.content.find((block: unknown) => obj(block).type === 'tool-result') : undefined;
      call.status = resultBlock && obj(resultBlock).isError === true ? 'error' : 'ok';
    } else if (row.type === 'turn/end') {
      const reason = obj(data.reason);
      if (reason.kind !== 'completed') events.push({ ...base, role: 'system', text: `dsh 任务轮次结束：${String(reason.kind)}` });
    } else if (row.type === 'assistant/attempt' || row.type === 'system/message' || row.type === 'developer/message' || /^(turn|step|request|session|compaction|command)\//.test(row.type) || row.ignorable === true) {
      continue;
    } else throw new WorkbenchError('unsupported_version', `dsh 未知必要事件: ${row.type}`);
  }
  if (!events.length) throw new WorkbenchError('invalid_data', 'dsh 导出没有可见历史');
  return { sessionId: header.id, events };
}

export function parseDeepSeekZip(bytes: Buffer, projectPath: string): ParsedDeepSeekExport {
  inspectZip(bytes);
  const archive: Record<string, Uint8Array> = {};
  let expanded = 0;
  let failure: Error | null = null;
  const unzip = new Unzip(file => {
    const name = file.name;
    const normalized = name.endsWith('/') ? name.slice(0, -1) : name;
    if (!safeName(normalized) || archive[name] || file.compression !== 0 && file.compression !== 8) {
      failure = new WorkbenchError('invalid_data', 'dsh ZIP 包含非法或重复条目');
      return;
    }
    const chunks: Buffer[] = [];
    file.ondata = (error, chunk, final) => {
      if (error) { failure = new WorkbenchError('invalid_data', 'dsh ZIP 解压失败'); return; }
      expanded += chunk.length;
      if (expanded > MAX_EXPANDED_BYTES) { failure = new WorkbenchError('invalid_data', 'dsh ZIP 展开体积超过上限'); return; }
      chunks.push(Buffer.from(chunk));
      if (final && !name.endsWith('/')) archive[name] = Buffer.concat(chunks);
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try {
    for (let offset = 0; offset < bytes.length && !failure; offset += 64 * 1024)
      unzip.push(bytes.subarray(offset, offset + 64 * 1024), offset + 64 * 1024 >= bytes.length);
  } catch { throw new WorkbenchError('invalid_data', 'dsh ZIP 解压失败'); }
  if (failure) throw failure;
  const root = Object.keys(archive).find(name => /^session\.v\d+\.jsonl$/.test(name));
  if (!root) throw new WorkbenchError('unsupported_version', 'dsh ZIP 没有受支持的根会话日志版本');
  if (root !== 'session.v4.jsonl') throw new WorkbenchError('unsupported_version', `dsh 导出版本不支持: ${root}`);
  const parsed = parseLog(decoded(archive[root]), projectPath, archive);
  const events = parsed.events;
  for (const name of Object.keys(archive).filter(name => /^subagents\/[^/]+\/session\.v4\.jsonl$/.test(name)).sort()) {
    const child = parseLog(decoded(archive[name]), projectPath, archive);
    events.push({ index: events.length, role: 'system', timestamp: events.at(-1)!.timestamp, text: `子会话 ${child.sessionId} 的可见历史：` });
    for (const event of child.events) events.push({ ...event, index: events.length });
  }
  const attachments = Object.fromEntries(Object.entries(archive).filter(([name]) => name.startsWith('media/') || name.startsWith('files/')));
  return { sessionId: parsed.sessionId, projectPath, events, completeness: 'structured', attachments };
}

export function parseDeepSeekMarkdown(text: string): ParsedDeepSeekExport {
  if (!text.trim() || Buffer.byteLength(text, 'utf8') > MAX_EXPANDED_BYTES) throw new WorkbenchError('invalid_data', 'dsh Markdown 为空或过大');
  if (!/^# .+$/m.test(text) || !/^> /m.test(text)) throw new WorkbenchError('invalid_data', 'dsh Markdown 缺少官方会话标题或用户消息');
  return { sessionId: null, projectPath: null, events: [{ index: 0, role: 'system', timestamp: new Date().toISOString(), text }], completeness: 'text-only', attachments: {} };
}
