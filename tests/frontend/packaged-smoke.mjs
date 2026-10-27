import { _electron as electron } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const executablePath = resolve("out", "Agent Workbench-win32-x64", "agent-workbench.exe");
const dataDir = mkdtempSync(join(tmpdir(), "agent-workbench-smoke-"));
let app;
try {
  app = await electron.launch({
    executablePath,
    env: { ...process.env, AGENT_WORKBENCH_DATA_DIR: dataDir },
    timeout: 30_000,
  });
  const window = await app.firstWindow({ timeout: 30_000 });
  await window.getByText("Agent Workbench", { exact: true }).waitFor({ timeout: 15_000 });
  await window.getByRole("button", { name: "项目", exact: true }).click();
  await window.getByRole("heading", { name: "项目" }).waitFor();
  const project = await window.evaluate(
    (projectPath) => window.api["projects.register"]({ path: projectPath }),
    dataDir,
  );
  const projects = await window.evaluate(() => window.api["projects.list"]());
  if (!projects.some((entry) => entry.id === project.id)) {
    throw new Error("Packaged IPC/database smoke failed");
  }
  console.log("Packaged Electron smoke passed");
} finally {
  await app?.close();
  const resolvedTemp = resolve(tmpdir());
  const resolvedData = resolve(dataDir);
  if (!resolvedData.startsWith(resolvedTemp + "\\") || !resolvedData.includes("agent-workbench-smoke-")) {
    throw new Error("Smoke test temporary directory is outside the expected root");
  }
  rmSync(resolvedData, { recursive: true, force: true });
}
