import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { zipSync, strToU8 } from 'fflate';
import { DeepSeekAdapter } from '../../src/main/adapters/deepseek';

describe('DeepSeek import', () => {
  it('keeps a private source copy and makes imported history handoff-readable without dsh installed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-import-'));
    try {
      const project = join(dir, 'project');
      const source = join(dir, 'export.zip');
      const log = [
        { type: 'session', version: 4, id: 'native', createdAt: 1, cwd: project, isSeeded: false, delegationDepth: 0 },
        { type: 'user/message', seq: 0, time: 1000, surfaceOp: 'append', data: { id: 'u', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'full prompt' }] } },
      ].map(value => JSON.stringify(value)).join('\n') + '\n';
      writeFileSync(source, Buffer.from(zipSync({ 'session.v4.jsonl': strToU8(log) })));
      const adapter = new DeepSeekAdapter({ dataDir: join(dir, 'private'), version: () => null, connect: async () => { throw new Error('dsh absent'); } });
      const imported = adapter.importSession(project, source);
      const listed = await adapter.listSessions(project);
      expect(listed).toContainEqual(imported);
      const events = [];
      for await (const event of adapter.readVisibleSession(imported)) events.push(event);
      expect(events.map(event => event.text)).toEqual(['full prompt']);
      writeFileSync(source, 'overwritten after import');
      const again = [];
      for await (const event of adapter.readVisibleSession(imported)) again.push(event);
      expect(again).toEqual(events);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('imports Markdown as one exact text transcript', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-import-'));
    try {
      const source = join(dir, 'conversation.md');
      writeFileSync(source, '# Session\n\n> Hello\n\nReply\n');
      const adapter = new DeepSeekAdapter({ dataDir: join(dir, 'private'), connect: async () => { throw new Error('dsh absent'); } });
      const imported = adapter.importSession(join(dir, 'project'), source);
      const events = [];
      for await (const event of adapter.readVisibleSession(imported)) events.push(event);
      expect(events[0].text).toBe(readFileSync(source, 'utf8'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
