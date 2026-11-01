import { describe, expect, it, vi } from 'vitest';
import { DeepSeekAdapter } from '../../src/main/adapters/deepseek';
import type { DeepSeekConnection } from '../../src/main/adapters/deepseek-acp';
import { makeDb, seedProject } from '../helpers/db';
import { AdapterRegistry } from '../../src/main/adapters/registry';
import { TaskRuntime } from '../../src/main/tasks/runtime';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function fakeConnection(handler: (method: string, params?: unknown) => Promise<unknown>) {
  const close = vi.fn();
  const notify = vi.fn();
  let requestHandler: ((method: string, params?: unknown) => Promise<unknown>) | undefined;
  const connection: DeepSeekConnection = { pid: 42, request: handler, notify, close, onNotification: () => {}, onRequest: fn => { requestHandler = fn; } };
  return { connection, close, notify, serverRequest: (method: string, params?: unknown) => requestHandler!(method, params) };
}

describe('DeepSeek adapter', () => {
  it('lists all pages of project sessions without guessing message counts', async () => {
    const calls: string[] = [];
    const fake = fakeConnection(async (method, params) => {
      calls.push(method);
      if (method !== 'session/list') throw new Error(method);
      return 'cursor' in (params as object) ? { sessions: [{ sessionId: 'b', cwd: 'C:/project' }] } : { sessions: [{ sessionId: 'a', cwd: 'C:/project' }, { sessionId: 'other-project', cwd: 'C:/other' }], nextCursor: 'next' };
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

  it('exposes permission options and waits for user choice', async () => {
    let finishPrompt!: (value: unknown) => void;
    const prompt = new Promise(resolve => { finishPrompt = resolve; });
    const fake = fakeConnection(async method => method === 'session/new' ? { sessionId: 'owned' } : method === 'session/prompt' ? prompt : {});
    const adapter = new DeepSeekAdapter({ connect: async () => fake.connection });
    const handle = await adapter.startTask({ projectId: 'p', projectPath: 'C:/project', agentId: 'deepseek-harness', goal: 'go' });
    const permission = fake.serverRequest('session/request_permission', { sessionId: 'owned', toolCall: { toolCallId: 'call' }, options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }] });
    expect(adapter.pendingPermission(handle)?.toolCallId).toBe('call');
    adapter.respondPermission(handle, 'call', 'allow-once');
    await expect(permission).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
    finishPrompt({ stopReason: 'end_turn' });
    await adapter.waitForCompletion(handle);
  });

  it('shows a pending dsh permission in the project task panel model', async () => {
    const db = makeDb();
    const path = mkdtempSync(join(tmpdir(), 'dsh-run-'));
    try {
      seedProject(db, 'p', path);
      let finishPrompt!: (value: unknown) => void;
      const prompt = new Promise(resolve => { finishPrompt = resolve; });
      const fake = fakeConnection(async method => method === 'session/list' ? { sessions: [] } : method === 'session/new' ? { sessionId: 'owned' } : method === 'session/prompt' ? prompt : {});
      const adapter = new DeepSeekAdapter({ version: () => 'dsh 0.2', connect: async () => fake.connection });
      const registry = new AdapterRegistry(db);
      registry.register(adapter);
      const tasks = new TaskRuntime(db, registry);
      const task = tasks.createTask('p', 'title', 'goal');
      const run = await tasks.startRun(task.id, 'deepseek-harness');
      const decision = fake.serverRequest('session/request_permission', { sessionId: 'owned', toolCall: { toolCallId: 'edit', title: 'Edit file', rawInput: { path: 'a.ts' } }, options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }] });
      expect(tasks.getRun(run.id)).toMatchObject({ status: 'waiting_for_user', permissionRequest: { toolCallId: 'edit', title: 'Edit file' } });
      tasks.respondPermission(run.id, 'edit', 'allow-once');
      await expect(decision).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'allow-once' } });
      finishPrompt({ stopReason: 'end_turn' });
      await vi.waitFor(() => expect(tasks.getRun(run.id)?.status).toBe('succeeded'));
    } finally { db.close(); rmSync(path, { recursive: true, force: true }); }
  });
});
