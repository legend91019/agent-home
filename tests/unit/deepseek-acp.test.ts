import { describe, expect, it, vi } from 'vitest';
import { DeepSeekAcpProtocol } from '../../src/main/adapters/deepseek-acp';

describe('DeepSeek ACP protocol', () => {
  it('pairs responses, ignores stray stdout text, and rejects permissions explicitly', async () => {
    const frames: string[] = [];
    const protocol = new DeepSeekAcpProtocol(line => frames.push(line), 1000);
    const first = protocol.request('session/list', { cwd: 'C:/project' });
    const second = protocol.request('session/new', { cwd: 'C:/project', mcpServers: [] });
    protocol.handleLine('[llm-deepseek-account] model listing');
    protocol.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 2, result: { sessionId: 's2' } }));
    protocol.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { sessions: [] } }));
    expect(await first).toEqual({ sessions: [] });
    expect(await second).toEqual({ sessionId: 's2' });
    protocol.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'session/request_permission', params: { sessionId: 's2', options: [] } }));
    expect(JSON.parse(frames.at(-1)!)).toEqual({ jsonrpc: '2.0', id: 7, result: { outcome: { outcome: 'cancelled' } } });
  });

  it('settles pending requests when the process exits', async () => {
    const protocol = new DeepSeekAcpProtocol(() => {}, 1000);
    const pending = protocol.request('session/list', {});
    protocol.onProcessExit();
    await expect(pending).rejects.toThrow(/退出/);
    await expect(protocol.request('session/list', {})).rejects.toThrow(/退出/);
  });

  it('waits for a reviewed permission decision and returns only the selected option', async () => {
    const frames: string[] = [];
    const protocol = new DeepSeekAcpProtocol(line => frames.push(line));
    let decide!: (value: unknown) => void;
    protocol.onRequest(() => new Promise(resolve => { decide = resolve; }));
    protocol.handleLine(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'session/request_permission', params: { sessionId: 's' } }));
    expect(frames).toHaveLength(0);
    decide({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
    await Promise.resolve();
    expect(JSON.parse(frames[0])).toEqual({ jsonrpc: '2.0', id: 9, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } });
  });

  it('times out missing responses', async () => {
    vi.useFakeTimers();
    try {
      const protocol = new DeepSeekAcpProtocol(() => {}, 10);
      const pending = protocol.request('session/list', {});
      const rejected = expect(pending).rejects.toThrow(/超时/);
      await vi.advanceTimersByTimeAsync(11);
      await rejected;
    } finally { vi.useRealTimers(); }
  });
});
