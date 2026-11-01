import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { parseDeepSeekMarkdown, parseDeepSeekZip } from '../../src/main/adapters/deepseek-export';

const now = Date.UTC(2026, 10, 1);
function archive(events: object[], extra: Record<string, Uint8Array> = {}) {
  const lines = [
    { type: 'session', version: 4, id: 'source-id', createdAt: now, cwd: 'C:/project', isSeeded: false, delegationDepth: 0 },
    ...events,
  ].map(value => JSON.stringify(value)).join('\n') + '\n';
  return Buffer.from(zipSync({ 'session.v4.jsonl': strToU8(lines), ...extra }));
}
const event = (seq: number, type: string, data: object) => ({ seq, time: now + seq, type, data, ...(type.endsWith('/message') || type === 'tool/result' ? { surfaceOp: 'append' } : {}) });

describe('official dsh export', () => {
  it('keeps the visible sequence and excludes reasoning and injected context', () => {
    const bytes = archive([
      event(0, 'user/message', { id: 'u1', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Hi' }] }),
      event(1, 'user/message', { id: 'hidden', role: 'user', source: { kind: 'plugin' }, content: [{ type: 'text', text: 'internal' }] }),
      event(2, 'assistant/message', { message: { id: 'a1', role: 'assistant', content: [{ type: 'reasoning', text: 'secret' }, { type: 'text', text: 'Hello' }] }, stream: [] }),
      event(3, 'tool/call', { callId: 'call1', name: 'read_file', arguments: '{"path":"x"}' }),
      event(4, 'tool/result', { message: { id: 't1', source: { kind: 'tool', callId: 'call1' }, content: [{ type: 'tool-result', toolCallId: 'call1', content: [{ type: 'text', text: 'file body' }, { type: 'file', attachment: { attachmentId: 'sha256:abc', name: 'note.txt' } }], isError: false }] } }),
    ], { 'files/ab/abc/note.txt': strToU8('attachment body') });
    const parsed = parseDeepSeekZip(bytes, 'C:/project');
    expect(parsed.sessionId).toBe('source-id');
    expect(parsed.events.map(e => e.role)).toEqual(['user', 'assistant', 'tool']);
    expect(JSON.stringify(parsed.events)).not.toContain('secret');
    expect(JSON.stringify(parsed.events)).not.toContain('internal');
    expect(parsed.events[2].toolCalls?.[0]).toMatchObject({ name: 'read_file', outputSummary: 'file body', status: 'ok' });
    expect(parsed.events[2].attachments?.[0]).toMatchObject({ name: 'note.txt', available: true, externalRef: 'files/ab/abc/note.txt' });
  });

  it('rejects mismatched projects and path traversal', () => {
    expect(() => parseDeepSeekZip(archive([]), 'D:/other')).toThrow(/项目/);
    expect(() => parseDeepSeekZip(archive([], { '../escape': strToU8('bad') }), 'C:/project')).toThrow(/路径/);
  });

  it('refuses unsupported log formats instead of inventing history', () => {
    const bytes = Buffer.from(zipSync({ 'session.v5.jsonl': strToU8('{"type":"session","version":5}\n') }));
    expect(() => parseDeepSeekZip(bytes, 'C:/project')).toThrow(/版本/);
  });

  it('preserves the official Markdown transcript without truncation', () => {
    const transcript = '# Session\n\n> User prompt\n\nAssistant reply\n';
    const parsed = parseDeepSeekMarkdown(transcript);
    expect(parsed.events).toHaveLength(1);
    expect(parsed.events[0].text).toBe(transcript);
    expect(parsed.completeness).toBe('text-only');
  });
});
