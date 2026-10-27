// 最小化的 node:sqlite 类型声明，避免依赖 @types/node 是否已收录该模块。
declare module "node:sqlite" {
  export interface SQLiteRunResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }
  export interface StatementSync {
    run(...params: unknown[]): SQLiteRunResult;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
    iterate(...params: unknown[]): IterableIterator<unknown>;
    columns(): { name: string }[];
  }
  export class DatabaseSync {
    constructor(location: string, options?: { readOnly?: boolean; [k: string]: unknown });
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
}
