/**
 * 版本化数据库迁移。首版为单一初始化迁移，建立设计文档 4.4 的全部主表。
 * 后续能力变更以新的递增迁移追加，绝不手工 ALTER 线上库而不留版本记录。
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { SqliteDatabase } from "./database";

export interface Migration {
  version: number;
  up: string;
}

const V1 = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  path TEXT NOT NULL UNIQUE,
  git_root TEXT,
  git_remote TEXT,
  created_at TEXT NOT NULL,
  registered_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_installations (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  version TEXT,
  executable_path TEXT,
  auth_status TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS native_sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  native_session_id TEXT NOT NULL,
  project_id TEXT,
  title TEXT,
  message_count INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  native_session_id TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  workspace_id TEXT,
  controllable INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS run_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES runs(id)
);

CREATE TABLE IF NOT EXISTS handoffs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  source_agent_id TEXT NOT NULL,
  target_agent_id TEXT,
  source_session_id TEXT NOT NULL,
  source_message_count INTEGER,
  source_snapshot_hash TEXT NOT NULL,
  manifest_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS handoff_messages (
  handoff_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  role TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  native_id TEXT,
  text TEXT,
  tool_calls TEXT,
  attachments TEXT,
  redacted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (handoff_id, idx),
  FOREIGN KEY (handoff_id) REFERENCES handoffs(id)
);

CREATE TABLE IF NOT EXISTS handoff_edits (
  handoff_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  text TEXT,
  removed_attachments TEXT,
  PRIMARY KEY (handoff_id, idx),
  FOREIGN KEY (handoff_id) REFERENCES handoffs(id)
);

CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  project_id TEXT,
  source TEXT NOT NULL,
  original_text TEXT NOT NULL,
  scope TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  published INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS shared_artifacts (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  scope TEXT NOT NULL,
  target_agents TEXT NOT NULL DEFAULT '[]',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  published_at TEXT,
  source_path TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS publications (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  diff_id TEXT,
  applied_at TEXT NOT NULL,
  backup_path TEXT,
  FOREIGN KEY (artifact_id) REFERENCES shared_artifacts(id)
);

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  name TEXT NOT NULL,
  definition TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  paused INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (project_id) REFERENCES projects(id),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS workflow_nodes (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  node_id TEXT NOT NULL,
  status TEXT NOT NULL,
  run_id TEXT,
  FOREIGN KEY (workflow_id) REFERENCES workflows(id)
);

CREATE TABLE IF NOT EXISTS merge_proposals (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL,
  target_branch TEXT NOT NULL,
  baseline_commit TEXT NOT NULL,
  branches TEXT NOT NULL DEFAULT '[]',
  conflicts TEXT NOT NULL DEFAULT '[]',
  baseline_valid INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS usage_records (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  project_id TEXT,
  task_id TEXT,
  run_id TEXT,
  model TEXT,
  source_type TEXT NOT NULL,
  quality TEXT NOT NULL,
  native_session_id TEXT,
  native_event_id TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_tokens INTEGER,
  reasoning_tokens INTEGER,
  recorded_at TEXT NOT NULL,
  dedup_key TEXT,
  raw_fields TEXT
);

CREATE TABLE IF NOT EXISTS blobs (
  hash TEXT PRIMARY KEY,
  bytes INTEGER NOT NULL,
  stored_at TEXT NOT NULL,
  ref_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  run_id TEXT,
  base_commit TEXT NOT NULL,
  branch TEXT NOT NULL,
  path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  retained INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY (project_id) REFERENCES projects(id)
);

CREATE TABLE IF NOT EXISTS capability_cache (
  agent_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  report TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, project_id)
);
`;

const V2 = `
ALTER TABLE runs ADD COLUMN handoff_id TEXT;
`;

// 旧记录保留 NULL，回滚时拒绝猜测原生目标；新发布完整保存目标及恢复证据。
const V3 = `
ALTER TABLE publications ADD COLUMN target_agent_id TEXT;
ALTER TABLE publications ADD COLUMN target_path TEXT;
ALTER TABLE publications ADD COLUMN artifact_kind TEXT;
ALTER TABLE publications ADD COLUMN shared_hash TEXT;
ALTER TABLE publications ADD COLUMN native_before_hash TEXT;
ALTER TABLE publications ADD COLUMN published_at_before TEXT;
`;

export const MIGRATIONS: Migration[] = [
  { version: 1, up: V1 },
  { version: 2, up: V2 },
  { version: 3, up: V3 },
];

export function applyMigrations(db: SqliteDatabase): number {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);",
  );
  const applied = db.getRows("SELECT version FROM schema_migrations");
  const appliedVersions = new Set(applied.map((r) => Number(r.version)));
  for (const m of MIGRATIONS) {
    if (appliedVersions.has(m.version)) continue;
    db.transaction((tx) => {
      tx.exec(m.up);
      tx.run(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
        m.version,
        new Date().toISOString(),
      );
    });
  }
  return MIGRATIONS.length;
}

const DEFAULT_DIR =
  process.env.AGENT_WORKBENCH_DATA_DIR ||
  path.join(process.env.LOCALAPPDATA || process.env.APPDATA || ".", "AgentWorkbench");

export function defaultDataDir(): string {
  return DEFAULT_DIR;
}

export function openDatabase(dataDir: string = DEFAULT_DIR): SqliteDatabase {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new SqliteDatabase(path.join(dataDir, "agent-workbench.db"));
  applyMigrations(db);
  return db;
}
