import { SqliteDatabase } from "../../src/main/db/database";
import { applyMigrations } from "../../src/main/db/migrations";

/** 测试用内存数据库，迁移后立即可用，无磁盘副作用。 */
export function makeDb(): SqliteDatabase {
  const db = new SqliteDatabase(":memory:");
  applyMigrations(db);
  return db;
}

/** 插入一个最小项目行，满足外键约束。 */
export function seedProject(db: SqliteDatabase, id = "p1", projPath = "/tmp/proj"): void {
  db.run(
    "INSERT INTO projects (id, name, path, created_at, registered_at) VALUES (?, ?, ?, ?, ?)",
    id,
    "proj",
    projPath,
    new Date().toISOString(),
    new Date().toISOString(),
  );
}
