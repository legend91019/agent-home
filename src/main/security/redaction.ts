/**
 * 交接包敏感信息扫描器。
 *
 * 设计要点：
 *  - 扫描「只标记、不改动源快照」：handoff_messages 的内容绝不被本模块修改。
 *  - scanHandoff 逐条读取 handoff_messages，对文本跑秘钥/个人信息的正则，
 *    对附件按 sizeBytes 判定大文件，产出 RedactionFinding 列表。
 *  - exportDiagnostics 写出 JSON 诊断清单。默认 includePrompts=false：
 *    仅导出元数据与（已脱敏的）发现项，绝不导出完整提示词/凭据原文；
 *    仅当 includePrompts=true 时才在清单中附带消息原文。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteDatabase } from "../db/database";
import type { RedactionFinding } from "../../shared/contracts";
import { readCopy } from "../handoff/search";

const SECRET_REGEXES: RegExp[] = [
  /(?:api[_-]?key|token|secret|password|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,})/gi,
  /Bearer\s+[A-Za-z0-9._-]+/g,
];

const PERSONAL_REGEXES: RegExp[] = [
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  /\b(?:\+?\d{1,3}[\s-]?)?\d{3}[\s-]?\d{3,4}[\s-]?\d{4}\b/g,
];

const LARGE_FILE_BYTES = 5_000_000;
const SNIPPET_MAX = 40;

interface AttachmentLike {
  name?: string;
  sizeBytes?: number | null;
}

export interface DiagnosticSelection {
  handoffIds?: string[];
  includePrompts?: boolean;
}

export class RedactionScanner {
  constructor(private readonly db: SqliteDatabase) {}

  /** 扫描指定交接包的消息，返回敏感信息发现项。绝不修改源快照。 */
  scanHandoff(packageId: string): RedactionFinding[] {
    const rows = this.db.getRows(
      "SELECT idx, role, text, attachments FROM handoff_messages WHERE handoff_id = ? ORDER BY idx ASC",
      packageId,
    );
    return this.scanRows(packageId, rows);
  }

  /** 扫描即将交给目标 Agent 的副本，已删除的消息不再产生警告。 */
  scanCopy(packageId: string): RedactionFinding[] {
    return this.scanRows(packageId, readCopy(this.db, packageId).map((event) => ({
      idx: event.index,
      text: event.text ?? null,
      attachments: JSON.stringify(event.attachments ?? []),
    })));
  }

  private scanRows(packageId: string, rows: Record<string, unknown>[]): RedactionFinding[] {
    const findings: RedactionFinding[] = [];

    for (const row of rows) {
      const eventIndex = Number(row.idx);
      const text = row.text == null ? "" : String(row.text);

      for (const re of SECRET_REGEXES) {
        for (const m of text.matchAll(re)) {
          findings.push({
            packageId,
            eventIndex,
            field: "text",
            kind: "secret",
            snippet: m[0].slice(0, SNIPPET_MAX),
          });
        }
      }
      for (const re of PERSONAL_REGEXES) {
        for (const m of text.matchAll(re)) {
          findings.push({
            packageId,
            eventIndex,
            field: "text",
            kind: "personal",
            snippet: m[0].slice(0, SNIPPET_MAX),
          });
        }
      }

      const attJson = row.attachments == null ? "" : String(row.attachments);
      if (attJson) {
        try {
          const atts = JSON.parse(attJson) as unknown;
          if (Array.isArray(atts)) {
            for (const a of atts as AttachmentLike[]) {
              if (
                a &&
                typeof a.sizeBytes === "number" &&
                a.sizeBytes > LARGE_FILE_BYTES
              ) {
                findings.push({
                  packageId,
                  eventIndex,
                  field: "attachment",
                  kind: "large-file",
                  snippet: (a.name ?? "attachment").slice(0, SNIPPET_MAX),
                });
              }
            }
          }
        } catch {
          // 附件 JSON 损坏不影响扫描：源快照保持不变，仅跳过该附件。
        }
      }
    }
    return findings;
  }

  /**
   * 写出诊断清单 JSON 并返回其绝对路径。
   * 默认 includePrompts=false：清单只包含元数据与（已脱敏的）发现项，
   * 不写入完整提示词/凭据。仅当 includePrompts=true 才附带消息原文。
   */
  exportDiagnostics(selection: DiagnosticSelection): string {
    const includePrompts = selection.includePrompts === true;
    const handoffIds = selection.handoffIds ?? [];

    const handoffs = handoffIds.map((handoffId) => {
      const rows = this.db.getRows(
        "SELECT idx, role, text FROM handoff_messages WHERE handoff_id = ? ORDER BY idx ASC",
        handoffId,
      );
      const findings = this.scanHandoff(handoffId);
      const masked = findings.map((f) => ({
        ...f,
        snippet: includePrompts ? f.snippet : "[REDACTED]",
      }));
      const entry: Record<string, unknown> = {
        handoffId,
        messageCount: rows.length,
        findingCount: findings.length,
        findings: masked,
      };
      if (includePrompts) {
        entry.messages = rows.map((r) => ({
          idx: Number(r.idx),
          role: String(r.role),
          text: r.text == null ? null : String(r.text),
        }));
      }
      return entry;
    });

    const manifest = {
      generatedAt: new Date().toISOString(),
      includePrompts,
      selectedHandoffIds: handoffIds,
      handoffs,
    };

    const dataDir = this.resolveDataDir();
    const diagnosticsDir = path.join(dataDir, "diagnostics");
    fs.mkdirSync(diagnosticsDir, { recursive: true });
    const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
    const filePath = path.join(diagnosticsDir, fileName);
    fs.writeFileSync(filePath, JSON.stringify(manifest, null, 2), "utf8");
    return path.resolve(filePath);
  }

  /** 推导诊断输出根目录：优先取 DB 文件所在目录，内存库则回落到系统临时目录。 */
  private resolveDataDir(): string {
    const fp = this.db.filePath;
    if (fp && fp !== ":memory:") {
      return path.dirname(path.resolve(fp));
    }
    return os.tmpdir();
  }
}
