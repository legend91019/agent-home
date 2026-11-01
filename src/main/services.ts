/**
 * 应用装配：把数据库、内容存储、项目登记、五个适配器与所有核心服务
 * 组合成单一 AppContext。主进程与 IPC 处理器共享这一上下文。
 */
import { SqliteDatabase } from "./db/database";
import { openDatabase, defaultDataDir } from "./db/migrations";
import { BlobStore } from "./storage/blobs";
import { ProjectRegistry } from "./projects/registry";
import { AdapterRegistry } from "./adapters/registry";
import { ClaudeAdapter } from "./adapters/claude";
import { CodexAdapter } from "./adapters/codex";
import { AntigravityAdapter } from "./adapters/antigravity";
import { ZCodeAdapter } from "./adapters/zcode";
import { WorkBuddyAdapter } from "./adapters/workbuddy";
import { DeepSeekAdapter } from "./adapters/deepseek";
import { ConfigInventory } from "./config/inventory";
import { ConfigPublisher } from "./config/publisher";
import { MemoryInventory } from "./memory/inventory";
import { MemoryTransfer } from "./memory/transfer";
import { TaskRuntime } from "./tasks/runtime";
import { WorkspaceManager } from "./workspaces/git";
import { WorkflowScheduler } from "./workflows/scheduler";
import { MergeService } from "./merge/proposals";
import { UsageAggregator } from "./usage/aggregate";
import { RecoveryService } from "./recovery/reconcile";
import { RedactionScanner } from "./security/redaction";
import * as path from "node:path";
import { createHash } from "node:crypto";

export interface AppContext {
  dataDir: string;
  db: SqliteDatabase;
  blobs: BlobStore;
  projects: ProjectRegistry;
  adapters: AdapterRegistry;
  config: ConfigInventory;
  publisher: ConfigPublisher;
  memory: MemoryInventory;
  memoryTransfer: MemoryTransfer;
  tasks: TaskRuntime;
  workspaces: WorkspaceManager;
  workflows: WorkflowScheduler;
  merge: MergeService;
  usage: UsageAggregator;
  recovery: RecoveryService;
  redaction: RedactionScanner;
}

export function createContext(
  dataDir: string = defaultDataDir(),
  adapterRegistry?: AdapterRegistry,
): AppContext {
  const db = openDatabase(dataDir);
  const blobs = new BlobStore(db, path.join(dataDir, "blobs"));
  const projects = new ProjectRegistry(db);
  const adapters = adapterRegistry ?? new AdapterRegistry(db);

  // 深度适配 Claude Code 与 Codex；后续三种按实测能力接入。
  if (!adapterRegistry) {
    adapters.register(new ClaudeAdapter());
    adapters.register(new CodexAdapter());
    adapters.register(new AntigravityAdapter());
    adapters.register(new ZCodeAdapter());
    adapters.register(new WorkBuddyAdapter({ dataDir }));
    adapters.register(new DeepSeekAdapter());
  }

  const config = new ConfigInventory(db);
  const publisher = new ConfigPublisher(db);
  const memory = new MemoryInventory(db);
  const memoryTransfer = new MemoryTransfer(db, publisher);
  const tasks = new TaskRuntime(db, adapters);
  const workspaces = new WorkspaceManager(db, (projectPath) =>
    path.join(dataDir, "worktrees", createHash("sha256").update(projectPath).digest("hex")),
  );
  const workflows = new WorkflowScheduler(db, tasks, workspaces);
  const merge = new MergeService(db, workspaces);
  const usage = new UsageAggregator(db);
  const recovery = new RecoveryService(db, dataDir);
  const redaction = new RedactionScanner(db);

  return {
    dataDir,
    db,
    blobs,
    projects,
    adapters,
    config,
    publisher,
    memory,
    memoryTransfer,
    tasks,
    workspaces,
    workflows,
    merge,
    usage,
    recovery,
    redaction,
  };
}
