/**
 * SQLite 连接封装。生产使用 better-sqlite3；本环境使用 Node 内置 node:sqlite
 * （零原生编译，支持 WAL、预编译语句与事务，满足设计的数据完整性要求）。
 * 业务模块只依赖这里暴露的窄接口，不直接接触底层驱动。
 */
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";

const require = createRequire(import.meta.url);
// 通过 createRequire 加载 node:sqlite，避免打包器静态解析该较新内置模块。
const { DatabaseSync } = require("node:sqlite") as {
  DatabaseSync: new (location: string, options?: Record<string, unknown>) => NodeSqliteDb;
};

interface StatementSync {
  run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  iterate(...params: unknown[]): IterableIterator<unknown>;
}
interface NodeSqliteDb {
  exec(sql: string): void;
  prepare(sql: string): StatementSync;
  close(): void;
}

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

/** 预编译语句的窄封装，与 better-sqlite3 的使用方式一致。 */
export class Statement {
  constructor(private readonly stmt: StatementSync) {}

  run(...params: unknown[]): RunResult {
    const r = this.stmt.run(...params);
    return { changes: r.changes, lastInsertRowid: r.lastInsertRowid };
  }

  get(...params: unknown[]): Record<string, unknown> | undefined {
    return this.stmt.get(...params) as Record<string, unknown> | undefined;
  }

  all(...params: unknown[]): Record<string, unknown>[] {
    return this.stmt.all(...params) as Record<string, unknown>[] | Record<string, unknown>[];
  }

  iterate(...params: unknown[]): IterableIterator<unknown> {
    return this.stmt.iterate(...params);
  }
}

export class SqliteDatabase {
  private readonly db: NodeSqliteDb;
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    this.db = new DatabaseSync(filePath);
    // WAL 提升并发与崩溃安全；foreign_keys 保证引用完整性。
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000;");
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  prepare(sql: string): Statement {
    return new Statement(this.db.prepare(sql));
  }

  /** 同步事务：回调内任一异常都会回滚，绝不部分提交。 */
  transaction<T>(fn: (db: SqliteDatabase) => T): T {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = fn(this);
      this.db.exec("COMMIT;");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK;");
      throw err;
    }
  }

  /** 读取一行，未命中返回 undefined。 */
  getRow(sql: string, ...params: unknown[]): Record<string, unknown> | undefined {
    return this.prepare(sql).get(...params);
  }

  /** 读取多行。 */
  getRows(sql: string, ...params: unknown[]): Record<string, unknown>[] {
    return this.prepare(sql).all(...params);
  }

  /** 执行写操作并返回变更信息。 */
  run(sql: string, ...params: unknown[]): RunResult {
    return this.prepare(sql).run(...params);
  }

  close(): void {
    this.db.close();
  }
}
