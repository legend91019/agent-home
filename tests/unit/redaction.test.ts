import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import { makeDb, seedProject } from "../helpers/db";
import { RedactionScanner } from "../../src/main/security/redaction";

function nowIso(): string {
  return new Date().toISOString();
}

function insertHandoff(db: ReturnType<typeof makeDb>, id: string, messageText: string): void {
  seedProject(db, "p1");
  db.run(
    "INSERT INTO handoffs (id, project_id, source_agent_id, source_session_id, source_snapshot_hash, manifest_path, created_at) VALUES (?,?,?,?,?,?,?)",
    id,
    "p1",
    "claude-code",
    "sess-" + id,
    "hash-" + id,
    "/tmp/manifest-" + id + ".json",
    nowIso(),
  );
  db.run(
    "INSERT INTO handoff_messages (handoff_id, idx, role, timestamp, text, redacted) VALUES (?,?,?,?,?,?)",
    id,
    0,
    "assistant",
    nowIso(),
    messageText,
    0,
  );
}

describe("RedactionScanner", () => {
  it("(a) flags an API-key string as 'secret' and leaves the source snapshot unchanged", () => {
    const db = makeDb();
    const pkg = "hpkg-secret";
    const secretText = "config: api_key=sk-ABCDEFGHIJKLMNOPQRSTUVWX please rotate";
    insertHandoff(db, pkg, secretText);

    const svc = new RedactionScanner(db);
    const findings = svc.scanHandoff(pkg);

    const secret = findings.find((f) => f.kind === "secret");
    expect(secret).toBeDefined();
    expect(secret!.packageId).toBe(pkg);
    expect(secret!.field).toBe("text");
    expect(secret!.eventIndex).toBe(0);

    // 源快照必须原样保留。
    const row = db.getRow(
      "SELECT text FROM handoff_messages WHERE handoff_id = ? AND idx = ?",
      pkg,
      0,
    );
    expect(String(row!.text)).toBe(secretText);
  });

  it("(b) exportDiagnostics omits the secret when includePrompts=false and includes it when true", () => {
    const db = makeDb();
    const pkg = "hpkg-diag";
    const secret = "sk-ABCDEFGHIJKLMNOPQRSTUVWX";
    const text = `auth token=${secret} expiry=never`;
    insertHandoff(db, pkg, text);

    const svc = new RedactionScanner(db);

    const falsePath = svc.exportDiagnostics({ handoffIds: [pkg], includePrompts: false });
    const falseContent = fs.readFileSync(falsePath, "utf8");
    expect(falseContent).not.toContain(secret);

    const truePath = svc.exportDiagnostics({ handoffIds: [pkg], includePrompts: true });
    const trueContent = fs.readFileSync(truePath, "utf8");
    expect(trueContent).toContain(secret);
  });
});
