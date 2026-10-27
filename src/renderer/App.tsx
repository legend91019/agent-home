import { useEffect, useMemo, useState } from "react";
import { call } from "./api";
import type {
  AgentId,
  ProjectDTO,
  TaskDTO,
  IntegrityReport,
  UsageSummary,
  SkillUsageSummary,
  MemoryEntryDTO,
  CapabilityReport,
  RecoveryReport,
  PublishDiff,
  PublishDiffEntry,
  WorkflowDef,
  MemoryTransferDiff,
} from "../shared/contracts";

type ViewKey =
  | "projects"
  | "tasks"
  | "handoffs"
  | "config"
  | "memory"
  | "usage"
  | "workflows"
  | "recovery";

const NAV: { key: ViewKey; label: string }[] = [
  { key: "projects", label: "项目" },
  { key: "tasks", label: "任务" },
  { key: "handoffs", label: "对话交接" },
  { key: "config", label: "共享配置" },
  { key: "memory", label: "记忆互转" },
  { key: "usage", label: "用量统计" },
  { key: "workflows", label: "工作流" },
  { key: "recovery", label: "恢复与诊断" },
];

const AGENTS: AgentId[] = [
  "claude-code",
  "codex",
  "antigravity",
  "zcode",
  "workbuddy",
];

const panel: React.CSSProperties = {
  flex: 1,
  padding: 20,
  overflow: "auto",
  color: "#cdd6f4",
};
const card: React.CSSProperties = {
  background: "#313244",
  borderRadius: 8,
  padding: 14,
  marginBottom: 12,
};
const btn: React.CSSProperties = {
  background: "#89b4fa",
  color: "#11111b",
  border: "none",
  borderRadius: 6,
  padding: "6px 12px",
  cursor: "pointer",
  marginRight: 8,
};
const inputStyle: React.CSSProperties = {
  background: "#1e1e2e",
  color: "#cdd6f4",
  border: "1px solid #45475a",
  borderRadius: 6,
  padding: "6px 8px",
  marginRight: 8,
};

export function App(): JSX.Element {
  const [active, setActive] = useState<ViewKey>("projects");
  const [projectId, setProjectId] = useState<string>("");
  const [projects, setProjects] = useState<ProjectDTO[]>([]);

  const refreshProjects = async () => {
    try {
      setProjects(await call("projects.list", undefined));
    } catch {
      setProjects([]);
    }
  };

  useEffect(() => {
    void refreshProjects();
  }, []);

  const selected = useMemo(
    () => projects.find((p) => p.id === projectId) ?? null,
    [projects, projectId],
  );

  return (
    <div style={{ display: "flex", height: "100vh", background: "#1e1e2e" }}>
      <nav
        style={{
          width: 180,
          background: "#181825",
          padding: 12,
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        <div style={{ color: "#f5c2e7", fontWeight: 700, marginBottom: 12 }}>
          Agent Workbench
        </div>
        {NAV.map((n) => (
          <button
            key={n.key}
            onClick={() => setActive(n.key)}
            style={{
              textAlign: "left",
              background: active === n.key ? "#313244" : "transparent",
              color: "#cdd6f4",
              border: "none",
              borderRadius: 6,
              padding: "8px 10px",
              cursor: "pointer",
            }}
          >
            {n.label}
          </button>
        ))}
        <div style={{ marginTop: "auto", color: "#6c7086", fontSize: 12 }}>
          {selected ? `项目: ${selected.name}` : "未选择项目"}
        </div>
      </nav>
      <main style={panel}>
        {active === "projects" && (
          <ProjectsView
            projects={projects}
            selectedId={projectId}
            onSelect={setProjectId}
            onChanged={refreshProjects}
          />
        )}
        {active === "tasks" && (
          <TasksView projectId={projectId} disabled={!projectId} />
        )}
        {active === "handoffs" && (
          <HandoffsView projectId={projectId} disabled={!projectId} />
        )}
        {active === "config" && (
          <ConfigView projectId={projectId} disabled={!projectId} />
        )}
        {active === "memory" && (
          <MemoryView projectId={projectId} disabled={!projectId} />
        )}
        {active === "usage" && (
          <UsageView projectId={projectId} disabled={!projectId} />
        )}
        {active === "workflows" && (
          <WorkflowsView projectId={projectId} disabled={!projectId} />
        )}
        {active === "recovery" && <RecoveryView />}
      </main>
    </div>
  );
}

/* ----------------------------- 项目 ----------------------------- */

function ProjectsView(props: {
  projects: ProjectDTO[];
  selectedId: string;
  onSelect: (id: string) => void;
  onChanged: () => void;
}): JSX.Element {
  const [path, setPath] = useState("");
  const [caps, setCaps] = useState<CapabilityReport[]>([]);
  const [busy, setBusy] = useState(false);

  const register = async () => {
    if (!path) return;
    setBusy(true);
    try {
      await call("projects.register", { path });
      setPath("");
      props.onChanged();
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    if (!props.selectedId) {
      setCaps([]);
      return;
    }
    call("projects.capabilities", { projectId: props.selectedId })
      .then(setCaps)
      .catch(() => setCaps([]));
  }, [props.selectedId]);

  return (
    <div>
      <h2>项目</h2>
      <div style={{ marginBottom: 12 }}>
        <input
          style={inputStyle}
          placeholder="项目路径，例如 D:/repo"
          value={path}
          onChange={(e) => setPath(e.target.value)}
        />
        <button style={btn} disabled={busy} onClick={register}>
          登记项目
        </button>
      </div>
      {props.projects.map((p) => (
        <div
          key={p.id}
          style={{
            ...card,
            border:
              p.id === props.selectedId ? "2px solid #89b4fa" : "2px solid transparent",
            cursor: "pointer",
          }}
          onClick={() => props.onSelect(p.id)}
        >
          <div style={{ fontWeight: 600 }}>{p.name}</div>
          <div style={{ color: "#a6adc8", fontSize: 12 }}>{p.path}</div>
        </div>
      ))}
      {caps.length > 0 && (
        <div style={card}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>能力协商结果</div>
          {caps.map((c) => (
            <div key={c.agentId} style={{ fontSize: 13, marginBottom: 4 }}>
              <span style={{ color: "#f9e2af" }}>{c.agentId}</span>：
              {c.installed ? "已安装" : "未安装/未验证"} ·{" "}
              {Object.entries(c.capabilities)
                .map(([k, v]) => `${k}=${v.status}`)
                .join("，")}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ----------------------------- 任务 ----------------------------- */

function TasksView(props: { projectId: string; disabled: boolean }): JSX.Element {
  const [tasks, setTasks] = useState<TaskDTO[]>([]);
  const [title, setTitle] = useState("");
  const [goal, setGoal] = useState("");
  const [agent, setAgent] = useState<AgentId>("claude-code");
  const [busy, setBusy] = useState(false);

  const load = async () => {
    if (!props.projectId) return setTasks([]);
    try {
      setTasks(await call("tasks.list", { projectId: props.projectId }));
    } catch {
      setTasks([]);
    }
  };
  useEffect(() => {
    void load();
  }, [props.projectId]);

  const create = async () => {
    if (!title || !goal) return;
    setBusy(true);
    try {
      await call("tasks.create", {
        projectId: props.projectId,
        title,
        goal,
      });
      setTitle("");
      setGoal("");
      await load();
    } finally {
      setBusy(false);
    }
  };

  const start = async (taskId: string) => {
    await call("tasks.startRun", { taskId, agentId: agent });
    await load();
  };

  if (props.disabled)
    return <div>请先在「项目」中选择一个项目。</div>;

  return (
    <div>
      <h2>任务</h2>
      <div style={{ marginBottom: 12 }}>
        <input style={inputStyle} placeholder="标题" value={title} onChange={(e) => setTitle(e.target.value)} />
        <input style={inputStyle} placeholder="目标" value={goal} onChange={(e) => setGoal(e.target.value)} />
        <select
          style={inputStyle}
          value={agent}
          onChange={(e) => setAgent(e.target.value as AgentId)}
        >
          {AGENTS.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <button style={btn} disabled={busy} onClick={create}>
          创建任务
        </button>
      </div>
      {tasks.map((t) => (
        <div key={t.id} style={card}>
          <div style={{ fontWeight: 600 }}>{t.title}</div>
          <div style={{ color: "#a6adc8", fontSize: 13 }}>状态：{t.status}</div>
          <div style={{ color: "#a6adc8", fontSize: 13 }}>目标：{t.goal}</div>
          <div style={{ marginTop: 6 }}>
            <button style={btn} onClick={() => start(t.id)}>
              用 {agent} 启动
            </button>
          </div>
          {t.runs.map((r) => (
            <div key={r.id} style={{ fontSize: 12, color: "#9399b2", marginTop: 4 }}>
              Run {r.id.slice(0, 8)} · {r.agentId} · {r.status}
              {r.controllable ? " · 可中断" : " · 外部会话"}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/* --------------------------- 对话交接 --------------------------- */

function HandoffsView(props: { projectId: string; disabled: boolean }): JSX.Element {
  const [id, setId] = useState("");
  const [report, setReport] = useState<IntegrityReport | null>(null);
  const [target, setTarget] = useState<AgentId>("codex");
  const [goal, setGoal] = useState("");
  const [result, setResult] = useState<string>("");

  const consume = async () => {
    if (!id) return;
    try {
      const run = await call("handoff.consume", {
        handoffId: id,
        targetAgentId: target,
        goal: goal || "继续处理交接内容",
      });
      setResult(`已为 ${run.agentId} 创建 Run ${run.id.slice(0, 8)}`);
    } catch (e) {
      setResult(`失败：${e instanceof Error ? e.message : String(e)}`);
    }
  };

  if (props.disabled) return <div>请先选择一个项目。</div>;

  return (
    <div>
      <h2>对话交接</h2>
      <p style={{ color: "#a6adc8" }}>
        交接包由源 Agent 导出（handoff.create，需要会话引用）。此处支持按交接包 id
        检索、校验完整性并分发给目标 Agent。
      </p>
      <div style={{ marginBottom: 12 }}>
        <input style={inputStyle} placeholder="交接包 id" value={id} onChange={(e) => setId(e.target.value)} />
        <button style={btn} onClick={async () => {
          try { setReport(await call("handoff.integrity", { handoffId: id })); }
          catch (e) { setReport(null); setResult(String(e)); }
        }}>校验完整性</button>
      </div>
      {report && (
        <div style={card}>
          <div>已读取可见消息：{report.readCount} 条</div>
          <div>源记录条数：{report.sourceCount ?? "未知"}</div>
          <div>完整性：{report.complete ? "完整" : "不完整"}</div>
          {report.missing.length > 0 && (
            <div style={{ color: "#f38ba8" }}>缺失：{report.missing.join("，")}</div>
          )}
          {report.largeAttachments.length > 0 && (
            <div style={{ color: "#f9e2af" }}>
              过大附件：{report.largeAttachments.join("，")}
            </div>
          )}
        </div>
      )}
      <div style={{ marginTop: 12 }}>
        <select style={inputStyle} value={target} onChange={(e) => setTarget(e.target.value as AgentId)}>
          {AGENTS.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
        <input style={inputStyle} placeholder="目标 Agent 的处理目标" value={goal} onChange={(e) => setGoal(e.target.value)} />
        <button style={btn} onClick={consume}>分发给目标 Agent</button>
      </div>
      {result && <div style={{ marginTop: 8, color: "#a6e3a1" }}>{result}</div>}
    </div>
  );
}

/* --------------------------- 共享配置 --------------------------- */

function ConfigView(props: { projectId: string; disabled: boolean }): JSX.Element {
  const [artifacts, setArtifacts] = useState<{ id: string; kind: string; name: string }[]>([]);
  const [diff, setDiff] = useState<PublishDiff | null>(null);
  const [target, setTarget] = useState<AgentId>("codex");

  useEffect(() => {
    if (!props.projectId) return setArtifacts([]);
    call("config.scan", { projectId: props.projectId })
      .then((a) => setArtifacts(a.map((x) => ({ id: x.id, kind: x.kind, name: x.name }))))
      .catch(() => setArtifacts([]));
  }, [props.projectId]);

  const preview = async () => {
    try {
      setDiff(await call("config.previewPublish", {
        projectId: props.projectId,
        targetAgentId: target,
      }));
    } catch {
      setDiff(null);
    }
  };

  if (props.disabled) return <div>请先选择一个项目。</div>;

  return (
    <div>
      <h2>共享配置</h2>
      <div style={{ marginBottom: 12 }}>
        <button style={btn} onClick={preview}>扫描并对 {target} 预览发布</button>
        <select style={inputStyle} value={target} onChange={(e) => setTarget(e.target.value as AgentId)}>
          {AGENTS.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
      </div>
      {artifacts.map((a) => (
        <div key={a.id} style={card}>
          {a.kind} · {a.name}
        </div>
      ))}
      {diff && (
        <div style={card}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>发布预览（{diff.entries.length} 项）</div>
          {diff.entries.map((e: PublishDiffEntry) => (
            <div key={e.path} style={{ fontSize: 13 }}>
              {e.path}：{e.status}
            </div>
          ))}
          <button style={btn} onClick={async () => {
            const choices: Record<string, "keep-native" | "overwrite-with-shared" | "manual-merge"> = {};
            diff.entries.forEach((e) => (choices[e.path] = "overwrite-with-shared"));
            await call("config.publish", { diffId: diff.id, choices });
          }}>按预览发布（共享覆盖）</button>
          <button style={btn} onClick={async () => {
            const choices: Record<string, "keep-native" | "overwrite-with-shared" | "manual-merge"> = {};
            diff.entries.forEach((e) => (choices[e.path] = "keep-native"));
            await call("config.publish", { diffId: diff.id, choices });
          }}>保留原生</button>
        </div>
      )}
    </div>
  );
}

/* --------------------------- 记忆互转 --------------------------- */

function MemoryView(props: { projectId: string; disabled: boolean }): JSX.Element {
  const [entries, setEntries] = useState<MemoryEntryDTO[]>([]);
  const [agent, setAgent] = useState<AgentId>("claude-code");
  const [transfer, setTransfer] = useState<MemoryTransferDiff | null>(null);

  useEffect(() => {
    if (!props.projectId) return setEntries([]);
    call("memory.list", { projectId: props.projectId, agentId: agent })
      .then(setEntries)
      .catch(() => setEntries([]));
  }, [props.projectId, agent]);

  if (props.disabled) return <div>请先选择一个项目。</div>;

  return (
    <div>
      <h2>记忆互转</h2>
      <div style={{ marginBottom: 12 }}>
        <select style={inputStyle} value={agent} onChange={(e) => setAgent(e.target.value as AgentId)}>
          {AGENTS.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
      </div>
      {entries.map((e) => (
        <div key={e.id} style={card}>
          <div style={{ fontSize: 13 }}>{e.source}</div>
          <div style={{ fontSize: 12, color: "#a6adc8" }}>{e.originalText.slice(0, 120)}</div>
          <button style={btn} onClick={async () => {
            setTransfer(await call("memory.previewTransfer", {
              entryIds: [e.id],
              targetAgentId: "codex",
              destination: "project_guidance",
            }));
          }}>预览转给 codex</button>
        </div>
      ))}
      {transfer && (
        <div style={card}>
          <div style={{ fontWeight: 600 }}>转移预览</div>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{transfer.previewText}</pre>
          <button style={btn} onClick={async () => {
            await call("memory.applyTransfer", { diffId: transfer.id });
            setTransfer(null);
          }}>应用（手工确认后写入）</button>
        </div>
      )}
    </div>
  );
}

/* --------------------------- 用量统计 --------------------------- */

function UsageView(props: { projectId: string; disabled: boolean }): JSX.Element {
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [skills, setSkills] = useState<SkillUsageSummary | null>(null);

  useEffect(() => {
    if (!props.projectId) return;
    call("usage.summary", {
      filter: { projectId: props.projectId },
    })
      .then(setSummary)
      .catch(() => setSummary(null));
    call("usage.skills", { projectId: props.projectId })
      .then(setSkills)
      .catch(() => setSkills(null));
  }, [props.projectId]);

  if (props.disabled) return <div>请先选择一个项目。</div>;

  return (
    <div>
      <h2>用量统计</h2>
      {summary && (
        <div style={card}>
          <div>事件数：{summary.events}</div>
          <div>输入 token：{summary.inputTokens ?? "未知（无来源）"}</div>
          <div>输出 token：{summary.outputTokens ?? "未知（无来源）"}</div>
          <div>缓存 token：{summary.cacheTokens ?? "未知（无来源）"}</div>
          <div>未知覆盖率：{(summary.unknownCoverage * 100).toFixed(1)}%</div>
        </div>
      )}
      {skills && (
        <div style={card}>
          <div>已发现技能：{skills.discovered.length}</div>
          <div>已确证调用：{skills.invoked.length}</div>
          <div style={{ fontSize: 12, color: "#a6adc8" }}>
            注意：仅「确证调用」计入实际用量，发现不等于使用。
          </div>
        </div>
      )}
    </div>
  );
}

/* --------------------------- 工作流 --------------------------- */

function WorkflowsView(props: { projectId: string; disabled: boolean }): JSX.Element {
  const [taskId, setTaskId] = useState("");
  const [wfId, setWfId] = useState("");
  const [status, setStatus] = useState<string>("");

  if (props.disabled) return <div>请先选择一个项目。</div>;

  const start = async () => {
    const def: WorkflowDef = {
      id: "demo-wf",
      name: "示例工作流 A→B",
      nodes: [
        {
          id: "a",
          agentId: "claude-code" as AgentId,
          input: "执行步骤 A",
          dependsOn: [],
          writesRepo: false,
          optional: false,
          completionCondition: "agent_reports",
        },
        {
          id: "b",
          agentId: "codex" as AgentId,
          input: "执行步骤 B",
          dependsOn: ["a"],
          writesRepo: true,
          optional: false,
          completionCondition: "agent_reports",
        },
      ],
    };
    const wf = await call("workflow.start", { taskId, definition: def });
    setWfId(wf.id);
    setStatus("已启动，推进中");
  };

  const advance = async () => {
    if (!wfId) return;
    const wf = await call("workflow.advance", { workflowRunId: wfId });
    setStatus(wf.nodes.map((n) => `${n.id}:${n.status}`).join("，"));
  };

  return (
    <div>
      <h2>工作流</h2>
      <p style={{ color: "#a6adc8" }}>示例 DAG：A → B（B 写仓库，依赖 A 成功）。</p>
      <div style={{ marginBottom: 12 }}>
        <input style={inputStyle} placeholder="任务 id" value={taskId} onChange={(e) => setTaskId(e.target.value)} />
        <button style={btn} onClick={start}>启动工作流</button>
        <button style={btn} onClick={advance}>推进</button>
      </div>
      {status && <div style={card}>{status}</div>}
    </div>
  );
}

/* --------------------------- 恢复与诊断 --------------------------- */

function RecoveryView(): JSX.Element {
  const [report, setReport] = useState<RecoveryReport | null>(null);
  return (
    <div>
      <h2>恢复与诊断</h2>
      <button style={btn} onClick={async () => setReport(await call("recovery.reconcile", undefined))}>
        运行启动恢复检查
      </button>
      {report && (
        <div style={card}>
          <div>可恢复任务数：{report.recoveredTasks}</div>
          <div>孤儿工作区：{report.orphanWorktrees.length}</div>
          <div>半成品发布：{report.halfWrittenPublications.length}</div>
          <div style={{ fontSize: 12, color: "#a6adc8" }}>{report.notes.join("；")}</div>
        </div>
      )}
    </div>
  );
}
