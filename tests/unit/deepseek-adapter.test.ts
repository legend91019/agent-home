import { describe, expect, it, vi } from 'vitest';
import { DeepSeekAdapter } from '../../src/main/adapters/deepseek';
import type { DeepSeekConnection } from '../../src/main/adapters/deepseek-acp';

function fakeConnection(handler: (method: string, params?: unknown) => Promise<unknown>) {
  const close = vi.fn();
  const notify = vi.fn();
  const connection: DeepSeekConnection = { pid: 42, request: handler, notify, close, onNotification: () => {} };
  return { connection, close, notify };
}

describe('DeepSeek adapter', () => {
  it('lists all pages of project sessions without guessing message counts', async () => {
    const calls: string[] = [];
    const fake = fakeConnection(async (method, params) => {
      calls.push(method);
      if (method !== 'session/list') throw new Error(method);
      return 'cursor' in (params as object) ? { sessions: [{ sessionId: 'b', cwd: 'C:/project' }] } : { sessions: [{ sessionId: 'a', cwd: 'C:/project' }], nextCursor: 'next' };
    });
    const adapter = new DeepSeekAdapter({ version: () => 'dsh 0.2', connect: async () => fake.connection });
    expect((await adapter.listSessions('C:/project')).map(s => s.id)).toEqual(['a', 'b']);
    expect(calls).toEqual(['session/list', 'session/list']);
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it('starts an owned task, passes handoff path, and classifies completion', async () => {
    let finishPrompt!: (value: unknown) => void;
    const prompt = new Promise(resolve => { finishPrompt = resolve; });
    const fake = fakeConnection(async method => method === 'session/new' ? { sessionId: 'dsh-session' } : method === 'session/prompt' ? prompt : {});
    const adapter = new DeepSeekAdapter({ version: () => 'dsh 0.2', connect: async () => fake.connection });
    const handle = await adapter.startTask({ projectId: 'p', projectPath: 'C:/project', agentId: 'deepseek-harness', goal: 'continue', handoffPath: 'C:/handoff.md' });
    expect(handle.nativeSessionId).toBe('dsh-session');
    const completed = adapter.waitForCompletion(handle);
    finishPrompt({ stopReason: 'end_turn' });
    await expect(completed).resolves.toBe('succeeded');
    expect(fake.close).toHaveBeenCalledOnce();
  });

  it('cancels only an owned task', async () => {
    let finishPrompt!: (value: unknown) => void;
    const prompt = new Promise(resolve => { finishPrompt = resolve; });
    const fake = fakeConnection(async method => method === 'session/new' ? { sessionId: 'owned' } : method === 'session/prompt' ? prompt : {});
    const adapter = new DeepSeekAdapter({ version: () => 'dsh 0.2', connect: async () => fake.connection });
    const handle = await adapter.startTask({ projectId: 'p', projectPath: 'C:/project', agentId: 'deepseek-harness', goal: 'go' });
    await adapter.interrupt!(handle);
    expect(fake.notify).toHaveBeenCalledWith('session/cancel', { sessionId: 'owned' });
    finishPrompt({ stopReason: 'cancelled' });
    await expect(adapter.waitForCompletion(handle)).resolves.toBe('cancelled');
  });
});
