import { describe, it, expect, vi } from 'vitest';
import { CodexAdapter } from '../../src/main/adapters/codex';
import { connectCodex, CodexProtocol, type CodexConnection } from '../../src/main/adapters/codex-protocol';
function fixture() {
    const calls: {
        method: string;
        params: any;
    }[] = [];
    let notify: (n: {
        method: string;
        params?: any;
    }) => void = () => { };
    const connection: CodexConnection = {
        pid: 123, close: vi.fn(), onNotification: fn => { notify = fn; },
        request: async (method, params) => {
            calls.push({ method, params });
            const p = params as any;
            if (method === 'account/read')
                return { account: { type: 'chatgpt' }, requiresOpenaiAuth: true };
            if (method === 'thread/list')
                return p.cursor ? { data: [{ id: 't2', cwd: 'C:/repo' }], nextCursor: null } : { data: [{ id: 't1', cwd: 'C:/repo', preview: 'Hello' }], nextCursor: 'next' };
            if (method === 'thread/read')
                return { thread: { id: 't1', createdAt: 1 } };
            if (method === 'thread/turns/list')
                return p.cursor ? { data: [{ id: 'b', items: [{ id: 'a', type: 'agentMessage', text: 'done' }] }], nextCursor: null } : { data: [{ id: 'a', items: [{ id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'hello' }] }, { type: 'reasoning', summary: ['secret'] }, { id: 'c', type: 'commandExecution', command: 'ls', aggregatedOutput: 'all output', exitCode: 0, status: 'completed' }] }], nextCursor: 'next' };
            if (method === 'thread/start' || method === 'thread/resume')
                return { thread: { id: 'new-thread' } };
            if (method === 'turn/start')
                return { turn: { id: 'turn1', status: 'inProgress' } };
            return {};
        },
    };
    return { connection, calls, notify: (method: string, params: any) => notify({ method, params }), adapter: new CodexAdapter({ version: () => 'codex-cli test', connect: async () => connection }) };
}
describe('Codex app-server adapter', () => {
    it('reports installed CLI and read-only capability probe without a model turn', async () => {
        const f = fixture();
        const r = await f.adapter.probe('C:/repo');
        expect(r.installed).toBe(true);
        expect(r.authenticated).toBe(true);
        expect(r.capabilities.find(c => c.capability === 'sessions.list')?.status).toBe('supported');
        expect(f.calls.some(c => c.method === 'turn/start')).toBe(false);
        expect(f.connection.close).toHaveBeenCalled();
    });
    it('lists all cursor pages including appServer sources', async () => {
        const f = fixture();
        const sessions = await f.adapter.listSessions('C:/repo');
        expect(sessions.map(s => s.id)).toEqual(['t1', 't2']);
        expect(f.calls[0].params).toMatchObject({ cwd: 'C:/repo', sourceKinds: expect.arrayContaining(['appServer']) });
    });
    it('reads full ascending turns and excludes reasoning', async () => {
        const f = fixture();
        const events = [];
        for await (const event of f.adapter.readVisibleSession({ agentId: 'codex', id: 't1', messageCount: 0 }))
            events.push(event);
        expect(events.map(e => e.role)).toEqual(['user', 'tool', 'assistant']);
        expect(events.map(e => e.index)).toEqual([0, 1, 2]);
        expect(events[1].toolCalls?.[0].outputSummary).toBe('all output');
        expect(JSON.stringify(events)).not.toContain('secret');
        expect(f.calls.find(c => c.method === 'thread/turns/list')?.params).toMatchObject({ itemsView: 'full', sortDirection: 'asc' });
    });
    it('starts a task and interrupts its exact turn', async () => {
        const f = fixture();
        const h = await f.adapter.startTask({ projectId: 'p', projectPath: 'C:/repo', agentId: 'codex', goal: 'hello' });
        expect(h.nativeSessionId).toBe('new-thread');
        expect(h.pid).toBe(123);
        expect(f.calls.find(c => c.method === 'turn/start')?.params).toMatchObject({ threadId: 'new-thread', input: [{ type: 'text', text: 'hello' }] });
        await f.adapter.interrupt(h);
        expect(f.calls.at(-1)).toEqual({ method: 'turn/interrupt', params: { threadId: 'new-thread', turnId: 'turn1' } });
        f.notify('turn/completed', { threadId: 'new-thread', turn: { id: 'turn1', status: 'interrupted' } });
        expect(f.connection.close).toHaveBeenCalled();
    });
    it.each([['completed', 'succeeded'], ['failed', 'failed'], ['interrupted', 'cancelled']])('maps terminal %s to %s', async (status, expected) => {
        const f = fixture();
        const h = await f.adapter.startTask({ projectId: 'p', projectPath: 'C:/repo', agentId: 'codex', goal: 'hello' });
        const done = f.adapter.waitForCompletion(h);
        f.notify('turn/completed', { threadId: 'new-thread', turn: { id: 'turn1', status } });
        expect(await done).toBe(expected);
    });
    it('passes the durable handoff file in the initial prompt', async () => {
        const f = fixture();
        const h = await f.adapter.startTask({ projectId: 'p', projectPath: 'C:/repo', agentId: 'codex', goal: 'continue', handoffPath: 'C:/repo/history.txt' });
        expect(f.calls.find(c => c.method === 'turn/start')?.params.input[0].text).toContain('C:/repo/history.txt');
        f.notify('turn/completed', { threadId: 'new-thread', turn: { id: 'turn1', status: 'completed' } });
        await f.adapter.waitForCompletion(h);
    });
    it('reads current CLI visible control and tool items without losing output', async () => {
        const f = fixture();
        const original = f.connection.request;
        f.connection.request = async (method, params) => method === 'thread/turns/list' ? { data: [{ items: [
                        { id: 'sleep', type: 'sleep', durationMs: 100 },
                        { id: 'output', type: 'functionCallOutput', name: 'lookup', output: 'full output' },
                        { id: 'hook', type: 'hookPrompt', fragments: [{ text: 'visible instruction' }] },
                        { id: 'compact', type: 'contextCompaction' },
                    ] }], nextCursor: null } : original(method, params);
        const events = [];
        for await (const e of f.adapter.readVisibleSession({ agentId: 'codex', id: 't1', messageCount: 0 }))
            events.push(e);
        expect(events).toHaveLength(4);
        expect(JSON.stringify(events)).toContain('full output');
        expect(JSON.stringify(events)).toContain('visible instruction');
    });
    it('retains installed status if app-server handshake fails', async () => {
        const adapter = new CodexAdapter({ version: () => 'test', connect: async () => { throw Error('unsupported protocol'); } });
        const r = await adapter.probe('C:/repo');
        expect(r.installed).toBe(true);
        expect(r.capabilities.find(c => c.capability === 'tasks.start')?.status).toBe('unknown');
    });
});
describe('Codex protocol lifecycle', () => {
    it('handshakes with a real stdio fake server and reassembles split response lines', async () => {
        const source = `
      const rl=require('node:readline').createInterface({input:process.stdin});
      let initialized=false;
      rl.on('line',line=>{
        const msg=JSON.parse(line);
        if(msg.method==='initialized'){initialized=true;return;}
        const result=msg.method==='initialize'?{userAgent:'fixture'}:{initialized,method:msg.method};
        const response=JSON.stringify({id:msg.id,result})+'\\n';
        process.stdout.write(response.slice(0,5));
        setTimeout(()=>process.stdout.write(response.slice(5)),2);
      });
    `;
        const connection = await connectCodex(process.execPath, undefined, ['-e', source]);
        try {
            await expect(connection.request('thread/list', {})).resolves.toEqual({ initialized: true, method: 'thread/list' });
        }
        finally {
            connection.close();
        }
        await expect(connection.request('after-close')).rejects.toMatchObject({ code: 'process_failed' });
    });
    it('turn process exit settles completion as failed', async () => {
        const f = fixture();
        const h = await f.adapter.startTask({ projectId: 'p', projectPath: 'C:/repo', agentId: 'codex', goal: 'hello' });
        const done = f.adapter.waitForCompletion(h);
        f.notify('workbench/processExited', {});
        await expect(done).resolves.toBe('failed');
    });
    it('rejects immediately after exit', async () => {
        const p = new CodexProtocol(() => { }, () => 1);
        p.onProcessExit();
        p.setTimeout(10000);
        await expect(p.request('foo')).rejects.toThrow('退出');
    });
    it('rejects unsupported server requests instead of hanging approval', () => {
        const sent: string[] = [];
        const p = new CodexProtocol(s => { sent.push(s); }, () => 1);
        p.handleLine(JSON.stringify({ id: 'approval1', method: 'item/commandExecution/requestApproval', params: {} }));
        expect(JSON.parse(sent[0])).toMatchObject({ id: 'approval1', error: { code: -32601 } });
    });
});
