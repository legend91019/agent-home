/**
 * 内容寻址 blob 存储。大文本与附件不进关系表，只以哈希索引 + 文件落盘，
 * 避免数据库膨胀（设计 4.1）。同一内容只存一份（去重 + 引用计数）。
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { SqliteDatabase } from "../db/database";
import { WorkbenchError } from "../../shared/errors";

export class BlobStore {
  constructor(
    private readonly db: SqliteDatabase,
    private readonly baseDir: string,
  ) {
    fs.mkdirSync(baseDir, { recursive: true });
  }

  private filePath(hash: string): string {
    return path.join(this.baseDir, hash);
  }

  /** 写入内容并返回内容哈希；相同内容复用已存文件并增加引用计数。 */
  putBlob(bytes: Buffer): string {
    const hash = "sha256-" + crypto.createHash("sha256").update(bytes).digest("hex");
    const existing = this.db.getRow("SELECT hash FROM blobs WHERE hash = ?", hash);
    if (existing) {
      this.db.run("UPDATE blobs SET ref_count = ref_count + 1 WHERE hash = ?", hash);
      return hash;
    }
    const tmp = path.join(this.baseDir, `.tmp-${hash}-${process.pid}`);
    fs.writeFileSync(tmp, bytes);
    fs.renameSync(tmp, this.filePath(hash)); // 原子替换，避免半写入
    this.db.run(
      "INSERT INTO blobs (hash, bytes, stored_at, ref_count) VALUES (?, ?, ?, 1)",
      hash,
      bytes.length,
      new Date().toISOString(),
    );
    return hash;
  }

  /** 按哈希读取内容；哈希不在索引中或文件缺失视为数据损坏，拒绝读取。 */
  getBlob(hash: string): Buffer {
    const row = this.db.getRow("SELECT hash FROM blobs WHERE hash = ?", hash);
    if (!row) throw new WorkbenchError("invalid_data", `blob 不在索引中: ${hash}`);
    const fp = this.filePath(hash);
    if (!fs.existsSync(fp)) {
      throw new WorkbenchError("invalid_data", `blob 文件缺失: ${hash}`);
    }
    return fs.readFileSync(fp);
  }

  /** 释放一次引用；引用归零时删除文件与索引。 */
  release(hash: string): void {
    const row = this.db.getRow("SELECT ref_count FROM blobs WHERE hash = ?", hash);
    if (!row) return;
    const rc = Number(row.ref_count);
    if (rc <= 1) {
      this.db.run("DELETE FROM blobs WHERE hash = ?", hash);
      try {
        fs.rmSync(this.filePath(hash));
      } catch {
        /* 文件已不存在时忽略 */
      }
    } else {
      this.db.run("UPDATE blobs SET ref_count = ref_count - 1 WHERE hash = ?", hash);
    }
  }
}
