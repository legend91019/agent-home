/**
 * 共享配置发布：预览快照按 artifactId 选择；源/目标再次校验后暂存、替换、记账。
 * 每次发布保存准确目标与原字节证据，回滚不依赖内存，也不猜测旧记录的目标。
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SqliteDatabase } from '../db/database';
import { ProjectRegistry } from '../projects/registry';
import { WorkbenchError } from '../../shared/errors';
import type { AgentId, DiffChoice, PublishDiff, PublishDiffEntry, PublishReceipt, SharedArtifactDTO } from '../../shared/contracts';
import { ConfigInventory } from './inventory';
type Kind = SharedArtifactDTO['kind'];
interface StoredDiff {
  projectId: string;
  projectPath: string;
  targetAgentId: AgentId;
  entries: PublishDiffEntry[];
}
interface Change {
  artifactId: string;
  kind: Kind;
  target: string;
  source: string | null;
  beforeHash: string | null;
  afterHash: string | null;
  backup: string | null;
  stage: string | null;
  previousPublishedAt: string | null;
}
function key(file: string): string {
  const resolved = path.resolve(file);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
function within(root: string, file: string): boolean {
  const relative = path.relative(key(root), key(file));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}
function stat(file: string): fs.Stats | null {
  try {
    return fs.lstatSync(file);
  }
  catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? ''))
      return null;
    throw error;
  }
}
/** 拒绝路径逃逸及符号链接/junction，避免复制、备份或删除进入项目之外。 */
function safePath(root: string, file: string): void {
  if (key(root) === key(file) || !within(root, file))
    throw new WorkbenchError('invalid_data', '发布路径必须位于项目内部');
  let current = path.resolve(root);
  if (stat(current)?.isSymbolicLink())
    throw new WorkbenchError('invalid_data', '项目根目录不能是符号链接');
  for (const segment of path.relative(root, file).split(path.sep)) {
    current = path.join(current, segment);
    const info = stat(current);
    if (info?.isSymbolicLink())
      throw new WorkbenchError('invalid_data', '发布路径包含符号链接或 junction');
    if (info && key(current) !== key(file) && !info.isDirectory())
      throw new WorkbenchError('invalid_data', '发布路径的父级不是目录');
  }
}
function hashPath(file: string, kind: Kind): string | null {
  const info = stat(file);
  if (!info)
    return null;
  if (info.isSymbolicLink())
    throw new WorkbenchError('invalid_data', '发布内容包含符号链接');
  const hash = crypto.createHash('sha256');
  if (kind !== 'skill') {
    if (!info.isFile())
      throw new WorkbenchError('invalid_data', '规则或知识目标必须为文件');
    return hash.update(fs.readFileSync(file)).digest('hex');
  }
  if (!info.isDirectory())
    throw new WorkbenchError('invalid_data', 'skill 目标必须为目录');
  const visit = (directory: string) => {
    for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(directory, item.name);
      const relative = path.relative(file, full).split(path.sep).join('/');
      if (item.isSymbolicLink())
        throw new WorkbenchError('invalid_data', 'skill 内不能包含符号链接');
      if (item.isDirectory()) {
        hash.update(`directory\0${relative}\0`);
        visit(full);
      }
      else if (item.isFile()) {
        hash.update(`file\0${relative}\0`);
        hash.update(crypto.createHash('sha256').update(fs.readFileSync(full)).digest());
      }
      else
        throw new WorkbenchError('invalid_data', 'skill 内包含不支持的文件类型');
    }
  };
  visit(file);
  return hash.digest('hex');
}
function copyPath(source: string, target: string): void {
  const info = fs.lstatSync(source);
  if (info.isSymbolicLink())
    throw new WorkbenchError('invalid_data', '不能复制符号链接');
  if (info.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const item of fs.readdirSync(source))
      copyPath(path.join(source, item), path.join(target, item));
  }
  else if (info.isFile()) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(source, target);
  }
  else
    throw new WorkbenchError('invalid_data', '不支持的发布文件类型');
}
function removePath(root: string, file: string): void {
  safePath(root, file);
  fs.rmSync(file, { recursive: true, force: true });
}
/** 目录先移动原目录，再把已完整暂存的副本移入，失败立即把原目录移回。 */
function replacePath(root: string, stage: string, target: string): void {
  safePath(root, stage);
  safePath(root, target);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (!stat(target)) {
    fs.renameSync(stage, target);
    return;
  }
  if (fs.lstatSync(stage).isFile() && fs.lstatSync(target).isFile()) {
    fs.renameSync(stage, target);
    return;
  }
  const displaced = `${target}.awb-old-${crypto.randomUUID()}`;
  safePath(root, displaced);
  fs.renameSync(target, displaced);
  try {
    fs.renameSync(stage, target);
  }
  catch (error) {
    fs.renameSync(displaced, target);
    throw error;
  }
  // 目标已完整替换；旧副本清理失败时保留它，恢复证据仍在独立 backup 中。
  try {
    removePath(root, displaced);
  }
  catch { /* 可人工清理，不破坏已发布目标。 */ }
}
export class ConfigPublisher {
  private readonly registry: ProjectRegistry;
  private readonly diffs = new Map<string, StoredDiff>();
  constructor(private readonly db: SqliteDatabase) { this.registry = new ProjectRegistry(db); }
  private projectPath(projectId: string): string {
    const project = this.registry.getProject(projectId);
    if (!project)
      throw new WorkbenchError('invalid_data', `未知项目: ${projectId}`);
    return project.path;
  }
  private nativeTarget(artifact: SharedArtifactDTO, root: string, agent: AgentId): string | null {
    if (artifact.kind === 'skill') {
      if (!artifact.name || path.basename(artifact.name) !== artifact.name || ['.', '..'].includes(artifact.name))
        return null;
      if (agent === 'claude-code')
        return path.join(root, '.claude', 'skills', artifact.name);
      if (agent === 'codex')
        return path.join(root, '.agents', 'skills', artifact.name);
      if (agent === 'workbuddy')
        return path.join(root, '.codebuddy', 'skills', artifact.name);
      return null;
    }
    if (artifact.kind === 'workflow')
      return null;
    if (agent === 'claude-code')
      return path.join(root, 'CLAUDE.md');
    if (agent === 'codex')
      return path.join(root, 'AGENTS.md');
    if (agent === 'workbuddy')
      return path.join(root, 'CODEBUDDY.md');
    return null;
  }
  private baseline(agent: AgentId, target: string): string | null {
    const row = this.db.getRow('SELECT shared_hash FROM publications WHERE target_agent_id = ? AND target_path = ? ORDER BY rowid DESC LIMIT 1', agent, target);
    return typeof row?.shared_hash === 'string' ? row.shared_hash : null;
  }
  /** inventory 可能同时发现共享 skill 和其已发布副本；优先保留非原生共享来源。 */
  private sources(projectId: string, root: string): {
    artifact: SharedArtifactDTO;
    ambiguous: boolean;
  }[] {
    const groups = new Map<string, SharedArtifactDTO[]>();
    for (const artifact of new ConfigInventory(this.db).scanArtifacts(projectId)) {
      const source = artifact.sourcePath;
      if (!source || within(path.join(root, '.agent-workbench', 'backups'), source) || source.includes('.awb-old-'))
        continue;
      const group = groups.get(artifact.id) ?? [];
      if (!group.some(a => key(a.sourcePath!) === key(source)))
        group.push(artifact);
      groups.set(artifact.id, group);
    }
    return [...groups.values()].map(group => {
      const shared = group.filter(a => !within(path.join(root, '.claude', 'skills'), a.sourcePath!) && !within(path.join(root, '.agents', 'skills'), a.sourcePath!) && !within(path.join(root, '.codebuddy', 'skills'), a.sourcePath!));
      const candidates = shared.length ? shared : group;
      return { artifact: candidates[0], ambiguous: candidates.length > 1 };
    });
  }
  previewPublish(projectId: string, targetAgentId: AgentId): PublishDiff {
    const root = this.projectPath(projectId);
    const entries: PublishDiffEntry[] = this.sources(projectId, root).map(({ artifact, ambiguous }) => {
      const target = this.nativeTarget(artifact, root, targetAgentId);
      const entry: PublishDiffEntry = { artifactId: artifact.id, sourcePath: artifact.sourcePath!, kind: artifact.kind, path: target ?? '', status: 'changed', sharedHash: null, nativeHash: null, lastPublishedHash: null, publishable: true };
      try {
        if (!target)
          throw new WorkbenchError('invalid_data', '该 Agent 的此类配置原生路径尚未验证，不支持直接发布');
        if (ambiguous)
          throw new WorkbenchError('invalid_data', '多个同名来源无法稳定区分，请保留一个共享来源后重新预览');
        safePath(root, entry.sourcePath);
        safePath(root, target);
        if (key(entry.sourcePath) !== key(target) && (within(entry.sourcePath, target) || within(target, entry.sourcePath)))
          throw new WorkbenchError('invalid_data', 'skill 源目录与目标目录重叠');
        entry.sharedHash = hashPath(entry.sourcePath, entry.kind);
        entry.nativeHash = hashPath(target, entry.kind);
        entry.lastPublishedHash = this.baseline(targetAgentId, target);
        if (entry.sharedHash === null)
          throw new WorkbenchError('incomplete_source', '共享来源不存在，请重新扫描');
        if (entry.sharedHash === entry.nativeHash)
          entry.status = 'identical';
        else if (entry.nativeHash === null)
          entry.status = 'new';
        else if (entry.lastPublishedHash !== null && entry.nativeHash !== entry.lastPublishedHash)
          entry.status = 'conflict';
        else
          entry.status = 'changed';
      }
      catch (error) {
        entry.publishable = false;
        entry.reason = error instanceof Error ? error.message : String(error);
      }
      return entry;
    });
    for (const entry of entries) {
      if (!entry.path || !entry.publishable)
        continue;
      if (entries.some(other => other.artifactId !== entry.artifactId && key(other.path || root) === key(entry.path))) {
        entry.reason = '多个来源映射同一目标；一次只能选择一个来源，其余保留原生';
        if (entry.status !== 'identical')
          entry.status = 'conflict';
      }
    }
    const diff: PublishDiff = { id: crypto.randomUUID(), projectId, targetAgentId, entries, createdAt: new Date().toISOString() };
    this.diffs.set(diff.id, { projectId, projectPath: root, targetAgentId, entries: structuredClone(entries) });
    return diff;
  }
  private validate(stored: StoredDiff, entry: PublishDiffEntry): void {
    safePath(stored.projectPath, entry.sourcePath);
    safePath(stored.projectPath, entry.path);
    if (hashPath(entry.sourcePath, entry.kind) !== entry.sharedHash || hashPath(entry.path, entry.kind) !== entry.nativeHash || this.baseline(stored.targetAgentId, entry.path) !== entry.lastPublishedHash) {
      throw new WorkbenchError('conflict', '来源或目标在预览后已变化，请重新预览');
    }
  }
  private backupRoot(root: string, id: string): string {
    const target = path.join(root, '.agent-workbench', 'backups', id);
    safePath(root, target);
    fs.mkdirSync(target, { recursive: true });
    return target;
  }
  private prepare(root: string, backupRoot: string, change: Change, index: number): void {
    const folder = path.join(backupRoot, String(index));
    safePath(root, folder);
    fs.mkdirSync(folder, { recursive: true });
    if (change.beforeHash !== null) {
      change.backup = path.join(folder, 'before');
      copyPath(change.target, change.backup);
      if (hashPath(change.backup, change.kind) !== change.beforeHash)
        throw new WorkbenchError('conflict', '目标在备份时已变化，请重新预览');
    }
    if (change.source !== null) {
      change.stage = path.join(folder, 'stage');
      copyPath(change.source, change.stage);
      if (hashPath(change.stage, change.kind) !== change.afterHash)
        throw new WorkbenchError('conflict', '来源在暂存时已变化，请重新预览');
    }
  }
  private apply(root: string, change: Change): void {
    safePath(root, change.target);
    if (hashPath(change.target, change.kind) !== change.beforeHash)
      throw new WorkbenchError('conflict', '目标在应用前已变化，请重新预览');
    if (change.stage)
      replacePath(root, change.stage, change.target);
    else
      removePath(root, change.target);
  }
  private restore(root: string, change: Change): void {
    if (change.backup) {
      const recovery = `${change.backup}.restore-${crypto.randomUUID()}`;
      safePath(root, recovery);
      copyPath(change.backup, recovery);
      replacePath(root, recovery, change.target);
    }
    else
      removePath(root, change.target);
  }
  /** 任一文件或数据库失败，逆序恢复所有已替换目标；恢复失败时保留证据并明确报错。 */
  private execute(root: string, changes: Change[], commit: () => void): void {
    const written: Change[] = [];
    try {
      for (const change of changes) {
        this.apply(root, change);
        written.push(change);
      }
      commit();
    }
    catch (error) {
      const failures: unknown[] = [];
      for (const change of written.reverse())
        try {
          this.restore(root, change);
        }
        catch (restoreError) {
          failures.push(restoreError);
        }
      if (failures.length)
        throw new WorkbenchError('process_failed', '发布失败且部分自动恢复失败；请保留 backups 中的恢复证据', { original: error instanceof Error ? error.message : String(error), failures: failures.map(e => e instanceof Error ? e.message : String(e)) });
      throw error;
    }
  }
  publish(diffId: string, choices: Record<string, DiffChoice>): PublishReceipt {
    const stored = this.diffs.get(diffId);
    if (!stored)
      throw new WorkbenchError('invalid_data', `未知或已应用 diff: ${diffId}`);
    if (key(this.projectPath(stored.projectId)) !== key(stored.projectPath))
      throw new WorkbenchError('conflict', '项目路径已变化，请重新预览');
    for (const [id, choice] of Object.entries(choices)) {
      if (!stored.entries.some(e => e.artifactId === id))
        throw new WorkbenchError('invalid_data', '发布选择必须使用预览中的 artifactId');
      if (!['keep-native', 'overwrite-with-shared', 'manual-merge'].includes(choice))
        throw new WorkbenchError('invalid_data', '非法发布选择');
      if (choice === 'manual-merge')
        throw new WorkbenchError('invalid_data', '尚未提供人工合并结果；请在外部完成合并后重新预览，不会自动覆盖');
    }
    const selected = stored.entries.filter(e => choices[e.artifactId] === 'overwrite-with-shared');
    const targets = new Set<string>();
    for (const entry of selected) {
      if (entry.publishable === false)
        throw new WorkbenchError('invalid_data', entry.reason ?? '来源不可发布');
      if (targets.has(key(entry.path)))
        throw new WorkbenchError('conflict', '多个选中来源映射同一目标；请只选择一个来源');
      targets.add(key(entry.path));
      this.validate(stored, entry);
    }
    // 源==目标以及字节相同的发布是 no-op，不备份、不删除、不增加发布记录。
    const plan = selected.filter(e => e.sharedHash !== e.nativeHash);
    const now = new Date().toISOString();
    const appliedChoices: Record<string, DiffChoice> = {};
    if (!plan.length) {
      this.diffs.delete(diffId);
      return { id: diffId, diffId, appliedChoices, appliedAt: now };
    }
    const root = stored.projectPath;
    const backupRoot = this.backupRoot(root, diffId);
    const changes: Change[] = plan.map(entry => ({ artifactId: entry.artifactId, kind: entry.kind, target: entry.path, source: entry.sourcePath, beforeHash: entry.nativeHash, afterHash: entry.sharedHash, backup: null, stage: null, previousPublishedAt: (this.db.getRow('SELECT published_at FROM shared_artifacts WHERE id = ?', entry.artifactId)?.published_at as string | null) ?? null }));
    changes.forEach((change, index) => this.prepare(root, backupRoot, change, index));
    // 暂存/备份之后再次校验整个选中计划，避免前一个目标先写后才发现后续来源漂移。
    selected.forEach(entry => this.validate(stored, entry));
    fs.writeFileSync(path.join(backupRoot, 'recovery.json'), JSON.stringify({ diffId, projectId: stored.projectId, targetAgentId: stored.targetAgentId, changes }, null, 2));
    this.execute(root, changes, () => this.db.transaction(tx => {
      for (const change of changes) {
        tx.run(`INSERT INTO publications (id,artifact_id,diff_id,applied_at,backup_path,target_agent_id,target_path,artifact_kind,shared_hash,native_before_hash,published_at_before) VALUES (?,?,?,?,?,?,?,?,?,?,?)`, crypto.randomUUID(), change.artifactId, diffId, now, change.backup, stored.targetAgentId, change.target, change.kind, change.afterHash, change.beforeHash, change.previousPublishedAt);
        tx.run('UPDATE shared_artifacts SET published_at = ? WHERE id = ?', now, change.artifactId);
        appliedChoices[change.artifactId] = 'overwrite-with-shared';
      }
    }));
    this.diffs.delete(diffId);
    return { id: diffId, diffId, appliedChoices, backupPath: backupRoot, appliedAt: now };
  }
  rollback(receiptId: string): void {
    const pubs = this.db.getRows('SELECT p.*, a.project_id FROM publications p JOIN shared_artifacts a ON a.id = p.artifact_id WHERE p.diff_id = ? ORDER BY p.rowid DESC', receiptId);
    if (!pubs.length)
      return;
    let root: string | undefined;
    const changes: Change[] = pubs.map(pub => {
      if (typeof pub.target_path !== 'string' || typeof pub.target_agent_id !== 'string' || typeof pub.artifact_kind !== 'string' || typeof pub.shared_hash !== 'string')
        throw new WorkbenchError('unsupported_version', '旧发布记录缺少准确目标和哈希证据，不能安全自动回滚');
      const projectRoot = this.projectPath(String(pub.project_id));
      if (root && key(root) !== key(projectRoot))
        throw new WorkbenchError('invalid_data', '同一次发布跨越多个项目');
      root = projectRoot;
      safePath(root, pub.target_path);
      const kind = pub.artifact_kind as Kind;
      if (!['rule', 'skill', 'knowledge', 'workflow'].includes(kind))
        throw new WorkbenchError('invalid_data', '发布记录的产物类型不合法');
      if (hashPath(pub.target_path, kind) !== pub.shared_hash)
        throw new WorkbenchError('conflict', '目标在发布后已变化，回滚会覆盖新内容，已拒绝');
      const before = typeof pub.native_before_hash === 'string' ? pub.native_before_hash : null;
      const source = typeof pub.backup_path === 'string' ? pub.backup_path : null;
      if (before !== null) {
        if (!source || !within(path.join(root, '.agent-workbench', 'backups'), source))
          throw new WorkbenchError('incomplete_source', '原始备份路径不可用');
        safePath(root, source);
        if (hashPath(source, kind) !== before)
          throw new WorkbenchError('incomplete_source', '原始备份缺失或已变化，拒绝回滚');
      }
      else if (source !== null)
        throw new WorkbenchError('invalid_data', '回滚备份元数据不一致');
      return { artifactId: String(pub.artifact_id), kind, target: pub.target_path, source, beforeHash: pub.shared_hash, afterHash: before, backup: null, stage: null, previousPublishedAt: typeof pub.published_at_before === 'string' ? pub.published_at_before : null };
    });
    const backupRoot = this.backupRoot(root!, `rollback-${crypto.randomUUID()}`);
    changes.forEach((change, index) => this.prepare(root!, backupRoot, change, index));
    this.execute(root!, changes, () => this.db.transaction(tx => {
      for (let index = 0; index < pubs.length; index++) {
        const pub = pubs[index];
        tx.run('DELETE FROM publications WHERE id = ?', pub.id);
        const latest = tx.getRow('SELECT applied_at FROM publications WHERE artifact_id = ? ORDER BY rowid DESC LIMIT 1', pub.artifact_id);
        tx.run('UPDATE shared_artifacts SET published_at = ? WHERE id = ?', latest?.applied_at ?? changes[index].previousPublishedAt, pub.artifact_id);
      }
    }));
  }
}
