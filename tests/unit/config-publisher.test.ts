import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { makeDb, seedProject } from '../helpers/db';
import { SqliteDatabase } from '../../src/main/db/database';
import { ConfigPublisher } from '../../src/main/config/publisher';
import { applyMigrations, MIGRATIONS } from '../../src/main/db/migrations';
import type { AgentId, PublishDiff, PublishDiffEntry } from '../../src/shared/contracts';
function entry(diff: PublishDiff, name: string): PublishDiffEntry {
  const found = diff.entries.find(e => path.basename(e.sourcePath) === name);
  expect(found, `missing source ${name}`).toBeTruthy();
  return found!;
}
describe('ConfigPublisher safe publication', () => {
  let db: SqliteDatabase;
  let dir: string;
  const write = (name: string, body: string) => { const file = path.join(dir, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, body); return file; };
  const read = (name: string) => fs.readFileSync(path.join(dir, name), 'utf8');
  const skill = (location = 'shared/my-skill') => { write(`${location}/SKILL.md`, 'skill body'); write(`${location}/assets/icon.png`, 'resource bytes'); return path.join(dir, location); };
  beforeEach(() => { db = makeDb(); dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-safe-publish-')); seedProject(db, 'p1', dir); });
  afterEach(() => { vi.restoreAllMocks(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  it('publishes selected artifact with a stable source identity', () => {
    write('CLAUDE.md', 'shared');
    const p = new ConfigPublisher(db);
    const d = p.previewPublish('p1', 'codex');
    const e = entry(d, 'CLAUDE.md');
    expect(e).toMatchObject({ artifactId: expect.any(String), sourcePath: path.join(dir, 'CLAUDE.md'), kind: 'rule', path: path.join(dir, 'AGENTS.md'), status: 'new' });
    const receipt = p.publish(d.id, { [e.artifactId]: 'overwrite-with-shared' });
    expect(read('AGENTS.md')).toBe('shared');
    expect(receipt.appliedChoices[e.artifactId]).toBe('overwrite-with-shared');
    expect(db.getRows('SELECT * FROM publications WHERE diff_id = ?', d.id)).toHaveLength(1);
  });
  it('rejects multiple selected sources targeting one file before any write', () => {
    write('CLAUDE.md', 'claude');
    write('GEMINI.md', 'gemini');
    write('AGENTS.md', 'native');
    const p = new ConfigPublisher(db);
    const d = p.previewPublish('p1', 'codex');
    const a = entry(d, 'CLAUDE.md'), b = entry(d, 'GEMINI.md');
    expect(() => p.publish(d.id, { [a.artifactId]: 'overwrite-with-shared', [b.artifactId]: 'overwrite-with-shared' })).toThrow(/同一目标|冲突/);
    expect(read('AGENTS.md')).toBe('native');
    expect(db.getRows('SELECT * FROM publications')).toHaveLength(0);
  });
  it('allows explicitly choosing only one source among colliding rules', () => {
    write('CLAUDE.md', 'claude');
    write('GEMINI.md', 'gemini');
    write('AGENTS.md', 'native');
    const p = new ConfigPublisher(db);
    const d = p.previewPublish('p1', 'codex');
    const a = entry(d, 'CLAUDE.md');
    p.publish(d.id, { [a.artifactId]: 'overwrite-with-shared' });
    expect(read('AGENTS.md')).toBe('claude');
    expect(read('GEMINI.md')).toBe('gemini');
  });
  it.each(['source', 'target'] as const)('rejects %s drift after preview', side => {
    write('CLAUDE.md', 'shared');
    write('AGENTS.md', 'native');
    const p = new ConfigPublisher(db);
    const d = p.previewPublish('p1', 'codex');
    const e = entry(d, 'CLAUDE.md');
    write(side === 'source' ? 'CLAUDE.md' : 'AGENTS.md', 'changed since preview');
    expect(() => p.publish(d.id, { [e.artifactId]: 'overwrite-with-shared' })).toThrow(/变化|重新预览/);
    expect(read('AGENTS.md')).toBe(side === 'source' ? 'native' : 'changed since preview');
    expect(db.getRows('SELECT * FROM publications')).toHaveLength(0);
  });
  it('never treats manual-merge as overwrite', () => {
    write('CLAUDE.md', 'shared');
    write('AGENTS.md', 'native');
    const p = new ConfigPublisher(db);
    const d = p.previewPublish('p1', 'codex');
    const e = entry(d, 'CLAUDE.md');
    expect(() => p.publish(d.id, { [e.artifactId]: 'manual-merge' })).toThrow(/人工合并|合并结果/);
    expect(read('AGENTS.md')).toBe('native');
  });
  it.each([['claude-code', '.claude'], ['codex', '.agents'], ['workbuddy', '.codebuddy']] as const)('publishes %s skills into the documented project path', (agent, folder) => {
    skill();
    const p = new ConfigPublisher(db);
    const d = p.previewPublish('p1', agent);
    const e = entry(d, 'my-skill');
    expect(e.path).toBe(path.join(dir, folder, 'skills', 'my-skill'));
    p.publish(d.id, { [e.artifactId]: 'overwrite-with-shared' });
    expect(read(`${folder}/skills/my-skill/SKILL.md`)).toBe('skill body');
    expect(read(`${folder}/skills/my-skill/assets/icon.png`)).toBe('resource bytes');
  });
  it('same source and native skill is a harmless no-op', () => {
    skill('.agents/skills/my-skill');
    const p = new ConfigPublisher(db);
    const d = p.previewPublish('p1', 'codex');
    const e = entry(d, 'my-skill');
    p.publish(d.id, { [e.artifactId]: 'overwrite-with-shared' });
    expect(read('.agents/skills/my-skill/SKILL.md')).toBe('skill body');
    expect(db.getRows('SELECT * FROM publications')).toHaveLength(0);
  });
  it('publishes a selected rule to WorkBuddy project instructions and restores the previous bytes', () => {
    write('CLAUDE.md', 'shared guidance');
    write('CODEBUDDY.md', 'existing WorkBuddy guidance');
    const p = new ConfigPublisher(db);
    const d = p.previewPublish('p1', 'workbuddy');
    const e = entry(d, 'CLAUDE.md');
    expect(e.path).toBe(path.join(dir, 'CODEBUDDY.md'));
    const receipt = p.publish(d.id, { [e.artifactId]: 'overwrite-with-shared' });
    expect(read('CODEBUDDY.md')).toBe('shared guidance');
    new ConfigPublisher(db).rollback(receipt.id);
    expect(read('CODEBUDDY.md')).toBe('existing WorkBuddy guidance');
  });
  it.each(['antigravity', 'zcode'] as AgentId[])('does not claim an unverified %s skill path', agent => {
    skill();
    const p = new ConfigPublisher(db);
    const d = p.previewPublish('p1', agent);
    const e = entry(d, 'my-skill');
    expect(e.publishable).toBe(false);
    expect(e.reason).toMatch(/未验证|不支持/);
    expect(() => p.publish(d.id, { [e.artifactId]: 'overwrite-with-shared' })).toThrow();
    expect(read('shared/my-skill/SKILL.md')).toBe('skill body');
  });
  it('rollback after publisher restart restores the persisted target and original bytes', () => {
    write('CLAUDE.md', 'shared');
    write('AGENTS.md', 'native');
    const p = new ConfigPublisher(db);
    const d = p.previewPublish('p1', 'codex');
    const e = entry(d, 'CLAUDE.md');
    const r = p.publish(d.id, { [e.artifactId]: 'overwrite-with-shared' });
    new ConfigPublisher(db).rollback(r.id);
    expect(read('AGENTS.md')).toBe('native');
    expect(fs.existsSync(path.join(dir, '.workbuddy.md'))).toBe(false);
    expect(db.getRows('SELECT * FROM publications')).toHaveLength(0);
  });
  it('rollback of a first publication removes only its new target', () => {
    write('CLAUDE.md', 'shared');
    const p = new ConfigPublisher(db);
    const d = p.previewPublish('p1', 'codex');
    const e = entry(d, 'CLAUDE.md');
    const r = p.publish(d.id, { [e.artifactId]: 'overwrite-with-shared' });
    new ConfigPublisher(db).rollback(r.id);
    expect(fs.existsSync(path.join(dir, 'AGENTS.md'))).toBe(false);
    expect(read('CLAUDE.md')).toBe('shared');
  });
  it('rollback rejects native edits after publication', () => {
    write('CLAUDE.md', 'shared');
    write('AGENTS.md', 'native');
    const p = new ConfigPublisher(db);
    const d = p.previewPublish('p1', 'codex');
    const e = entry(d, 'CLAUDE.md');
    const r = p.publish(d.id, { [e.artifactId]: 'overwrite-with-shared' });
    write('AGENTS.md', 'new user edit');
    expect(() => new ConfigPublisher(db).rollback(r.id)).toThrow(/变化|冲突/);
    expect(read('AGENTS.md')).toBe('new user edit');
  });
  it('database failure restores all files and publication baselines', () => {
    write('CLAUDE.md', 'shared');
    write('AGENTS.md', 'native');
    skill();
    const p = new ConfigPublisher(db);
    const d = p.previewPublish('p1', 'codex');
    const rule = entry(d, 'CLAUDE.md'), s = entry(d, 'my-skill');
    vi.spyOn(db, 'transaction').mockImplementationOnce(() => { throw Error('injected database failure'); });
    expect(() => p.publish(d.id, { [rule.artifactId]: 'overwrite-with-shared', [s.artifactId]: 'overwrite-with-shared' })).toThrow('injected database failure');
    expect(read('AGENTS.md')).toBe('native');
    expect(fs.existsSync(path.join(dir, '.agents/skills/my-skill'))).toBe(false);
    expect(db.getRows('SELECT * FROM publications')).toHaveLength(0);
    expect(new ConfigPublisher(db).previewPublish('p1', 'codex').entries.find(x => x.artifactId === rule.artifactId)?.lastPublishedHash).toBeNull();
  });
  it('three-way baseline belongs to the destination agent', () => {
    write('CLAUDE.md', 'a');
    skill();
    const p = new ConfigPublisher(db);
    let d = p.previewPublish('p1', 'codex');
    let e = entry(d, 'my-skill');
    p.publish(d.id, { [e.artifactId]: 'overwrite-with-shared' });
    d = p.previewPublish('p1', 'claude-code');
    e = entry(d, 'my-skill');
    expect(e.lastPublishedHash).toBeNull();
  });
  it('preview omits skill backups and keeps the shared source stable after publication', () => {
    skill();
    const p = new ConfigPublisher(db);
    let d = p.previewPublish('p1', 'codex');
    let e = entry(d, 'my-skill');
    p.publish(d.id, { [e.artifactId]: 'overwrite-with-shared' });
    write('shared/my-skill/SKILL.md', 'next shared');
    d = p.previewPublish('p1', 'codex');
    const skills = d.entries.filter(e => e.kind === 'skill');
    expect(skills).toHaveLength(1);
    expect(skills[0].sourcePath).toBe(path.join(dir, 'shared/my-skill'));
  });
  it('legacy publications without a persisted target cannot guess a rollback path', () => {
    write('CLAUDE.md', 'shared');
    const p = new ConfigPublisher(db);
    const d = p.previewPublish('p1', 'codex');
    const e = entry(d, 'CLAUDE.md');
    db.run('INSERT INTO publications (id, artifact_id, diff_id, applied_at, backup_path) VALUES (?,?,?,?,?)', 'legacy', e.artifactId, 'legacy-diff', new Date().toISOString(), null);
    expect(() => p.rollback('legacy-diff')).toThrow(/旧|目标/);
    expect(read('CLAUDE.md')).toBe('shared');
  });
  it('v2 databases migrate without inventing rollback metadata for legacy rows', () => {
    db.close();
    db = new SqliteDatabase(path.join(dir, 'legacy.db'));
    for (const migration of MIGRATIONS.filter(m => m.version <= 2)) {
      db.exec(migration.up);
      db.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?,?)', migration.version, new Date().toISOString());
    }
    seedProject(db, 'p1', dir);
    db.run(`INSERT INTO shared_artifacts (id,project_id,kind,name,scope,created_at) VALUES (?,?,?,?,?,?)`, 'old-artifact', 'p1', 'rule', 'CLAUDE.md', 'project', new Date().toISOString());
    db.run('INSERT INTO publications (id,artifact_id,diff_id,applied_at) VALUES (?,?,?,?)', 'old-pub', 'old-artifact', 'old-diff', new Date().toISOString());
    applyMigrations(db);
    applyMigrations(db);
    expect(db.getRow('SELECT target_path,target_agent_id,shared_hash FROM publications WHERE id = ?', 'old-pub')).toMatchObject({ target_path: null, target_agent_id: null, shared_hash: null });
    expect(() => new ConfigPublisher(db).rollback('old-diff')).toThrow(/旧发布/);
  });
  it('directory replacement restores every original resource if database commit fails', () => {
    skill();
    write('.agents/skills/my-skill/SKILL.md', 'original skill');
    write('.agents/skills/my-skill/old.txt', 'original resource');
    const p = new ConfigPublisher(db);
    const d = p.previewPublish('p1', 'codex');
    const e = entry(d, 'my-skill');
    vi.spyOn(db, 'transaction').mockImplementationOnce(() => { throw Error('commit failed'); });
    expect(() => p.publish(d.id, { [e.artifactId]: 'overwrite-with-shared' })).toThrow('commit failed');
    expect(read('.agents/skills/my-skill/SKILL.md')).toBe('original skill');
    expect(read('.agents/skills/my-skill/old.txt')).toBe('original resource');
    expect(fs.existsSync(path.join(dir, '.agents/skills/my-skill/assets/icon.png'))).toBe(false);
    expect(read('shared/my-skill/SKILL.md')).toBe('skill body');
  });
  it('rejects a junction or symlink in a native destination', () => {
    skill();
    fs.mkdirSync(path.join(dir, 'do-not-touch'));
    write('do-not-touch/marker', 'keep');
    fs.symlinkSync(path.join(dir, 'do-not-touch'), path.join(dir, '.agents'), process.platform === 'win32' ? 'junction' : 'dir');
    const p = new ConfigPublisher(db);
    const d = p.previewPublish('p1', 'codex');
    const e = entry(d, 'my-skill');
    expect(e.publishable).toBe(false);
    expect(() => p.publish(d.id, { [e.artifactId]: 'overwrite-with-shared' })).toThrow(/链接|junction/);
    expect(read('do-not-touch/marker')).toBe('keep');
  });
  it('does not overwrite an unselected target when its native parent is invalid', () => {
    write('CLAUDE.md', 'shared');
    write('AGENTS.md', 'native');
    skill();
    write('.agents', 'not a directory');
    const p = new ConfigPublisher(db);
    const d = p.previewPublish('p1', 'codex');
    const rule = entry(d, 'CLAUDE.md'), s = entry(d, 'my-skill');
    expect(() => p.publish(d.id, { [rule.artifactId]: 'overwrite-with-shared', [s.artifactId]: 'overwrite-with-shared' })).toThrow();
    expect(read('AGENTS.md')).toBe('native');
    expect(db.getRows('SELECT * FROM publications')).toHaveLength(0);
  });
  it('a consumed preview cannot be replayed', () => {
    write('CLAUDE.md', 'shared');
    const p = new ConfigPublisher(db);
    const d = p.previewPublish('p1', 'codex');
    const e = entry(d, 'CLAUDE.md');
    p.publish(d.id, { [e.artifactId]: 'overwrite-with-shared' });
    expect(() => p.publish(d.id, { [e.artifactId]: 'overwrite-with-shared' })).toThrow(/已应用|未知/);
  });
});
