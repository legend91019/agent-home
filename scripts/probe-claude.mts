/**
 * 探测 Claude Code 的能力并输出结构化 JSON 报告。
 * 不打印任何凭据；若 CLI/模块缺失则输出优雅的报告。
 */
import { ClaudeAdapter } from "../src/main/adapters/claude";

async function main(): Promise<void> {
  try {
    const adapter = new ClaudeAdapter();
    const projectPath = process.argv[2] ?? process.cwd();
    const report = await adapter.probe(projectPath);
    const version = adapter.versionHint();
    process.stdout.write(
      JSON.stringify(
        {
          adapter: adapter.id,
          versionHint: version,
          report,
        },
        null,
        2,
      ) + "\n",
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    process.stdout.write(
      JSON.stringify({ adapter: "claude-code", error: "探测失败", detail: msg }, null, 2) + "\n",
    );
  }
}

main();
