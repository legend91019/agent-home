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
  SessionRef,
  VisibleEvent,
  RedactionFinding,
  HandoffEdit,
  WorkflowNodeDef,
  WorkflowRunDTO,
  MergeProposalDTO,
} from "../shared/contracts";

type ViewKey =
  | "projects"
  | "tasks"
  | "handoffs"
  | "config"
  | "memory"
  | "usage"
  | "workflows"
  | "merge"
  | "recovery";

const NAV: { key: ViewKey; label: string }[] = [
  { key: "projects", label: "项目" },
  { key: "tasks", label: "任务" },
  { key: "handoffs", label: "对话交接" },
  { key: "config", label: "共享配置" },
  { key: "memory", label: "记忆互转" },
  { key: "usage", label: "用量统计" },
  { key: "workflows", label: "工作流" },
  { key: "merge", label: "合并审查" },
  { key: "recovery", label: "恢复与诊断" },
];

const AGENTS: AgentId[] = [
  "claude-code",
  "codex",
  "antigravity",
  "zcode",
  "workbuddy",
  "deepseek-harness",
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
  const [mergeSource, setMergeSource] = useState<{ projectId: string; workflowRunId: string } | null>(null);

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
          agent-home
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
          <WorkflowsView key={projectId} projectId={projectId} disabled={!projectId} onMerge={(workflowRunId) => { setMergeSource({ projectId, workflowRunId }); setActive("merge"); }} />
        )}
        {active === "merge" && <MergeView key={projectId} projectId={projectId} workflowRunId={mergeSource?.projectId === projectId ? mergeSource.workflowRunId : ""} />}
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
  const [error, setError] = useState("");

  const register = async () => {
    if (!path) return;
    setBusy(true);
    setError("");
    try {
      await call("projects.register", { path });
      setPath("");
      props.onChanged();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
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
      {error && <p role="alert" style={{ color: "#f38ba8" }}>{error}</p>}
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
  const [error, setError] = useState("");

  const load = async () => {
    if (!props.projectId) return setTasks([]);
    try {
      setTasks(await call("tasks.list", { projectId: props.projectId }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  useEffect(() => {
    void load();
    const timer = setInterval(() => { void load(); }, 3000);
    return () => clearInterval(timer);
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
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const start = async (taskId: string) => {
    setBusy(true); setError("");
    try { await call("tasks.startRun", { taskId, agentId: agent }); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const interrupt = async (runId: string) => {
    setBusy(true); setError("");
    try {
      const result = await call("tasks.interrupt", { runId });
      if (!result.ok) throw new Error("中断未完成，请刷新状态后重试");
      await load();
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  if (props.disabled)
    return <div>请先在「项目」中选择一个项目。</div>;

  return (
    <div>
      <h2>任务</h2>
      <button style={btn} disabled={busy} onClick={() => { setError(""); void load(); }}>刷新状态</button>
      <p>运行状态每 3 秒自动刷新。</p>
      {error && <div role="alert" style={{ color: "#f38ba8" }}>{error}</div>}
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
            <button style={btn} disabled={busy || t.runs.some((r) => ["starting", "queued"].includes(r.status))} onClick={() => start(t.id)}>
              用 {agent} 启动
            </button>
          </div>
          {t.runs.map((r) => (
            <div key={r.id} style={{ fontSize: 12, color: "#9399b2", marginTop: 4 }}>
              Run {r.id.slice(0, 8)} · {r.agentId} · {r.status}
              {["starting", "running", "waiting_for_user"].includes(r.status) ? r.controllable ? <button style={btn} disabled={busy} onClick={() => interrupt(r.id)}>中断运行</button> : " · 当前不支持中断" : " · 已结束"}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/* --------------------------- 对话交接 --------------------------- */

function HandoffsView(props: { projectId: string; disabled: boolean }): JSX.Element {
  const [source, setSource] = useState<AgentId>("claude-code");
  const [workbuddyFile, setWorkbuddyFile] = useState("");
  const [sessions, setSessions] = useState<SessionRef[]>([]);
  const [sessionId, setSessionId] = useState("");
  const [id, setId] = useState("");
  const [report, setReport] = useState<IntegrityReport | null>(null);
  const [events, setEvents] = useState<VisibleEvent[]>([]);
  const [target, setTarget] = useState<AgentId>("codex");
  const [goal, setGoal] = useState("");
  const [result, setResult] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [sessionRefresh, setSessionRefresh] = useState(0);
  const [findings, setFindings] = useState<RedactionFinding[]>([]);
  const [edits, setEdits] = useState<Record<number, string | null>>({});
  const [consumed, setConsumed] = useState(false);

  useEffect(() => {
    let current = true;
    setSessions([]); setSessionId(""); setId(""); setReport(null); setEvents([]); setReviewed(false); setError(""); setResult(""); setConsumed(false); setEdits({}); setFindings([]);
    if (!props.projectId) return;
    call("sessions.list", { projectId: props.projectId, agentId: source })
      .then((list) => { if (current) setSessions(list); })
      .catch((e) => { if (current) setError(e instanceof Error ? e.message : String(e)); });
    return () => { current = false; };
  }, [props.projectId, source, sessionRefresh]);

  const inspect = async (handoffId: string) => {
    setReviewed(false); setReport(null); setEvents([]); setFindings([]); setEdits({});
    const [summary, integrity, history, warnings] = await Promise.all([
      call("handoff.summary", { handoffId }),
      call("handoff.integrity", { handoffId }),
      call("handoff.search", { handoffId, query: "" }),
      call("handoff.findings", { handoffId }),
    ]);
    if (summary.projectId !== props.projectId) throw new Error("交接包不属于当前项目");
    setConsumed(summary.consumed);
    setReport(integrity); setEvents(history); setFindings(warnings);
  };
  const create = async () => {
    const session = sessions.find((s) => s.id === sessionId);
    if (!session) return;
    setBusy(true); setError(""); setResult(""); setReport(null); setEvents([]); setReviewed(false);
    try {
      const handoff = await call("handoff.create", { projectId: props.projectId, session });
      setId(handoff.id); setConsumed(false); await inspect(handoff.id);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const importWorkBuddy = async () => {
    setBusy(true); setError(""); setResult("");
    try {
      await call("workbuddy.importSession", { projectId: props.projectId, filePath: workbuddyFile.trim() });
      setWorkbuddyFile("");
      setSessionRefresh((count) => count + 1);
      setResult("会话已导入当前项目，请从源会话列表中选择并审查。");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const consume = async () => {
    if (!id || !reviewed || !report) return;
    setBusy(true); setError(""); setResult("");
    try {
      const run = await call("handoff.consume", { handoffId: id, targetAgentId: target, goal: goal || "继续处理交接内容" });
      setResult(`已为 ${run.agentId} 创建 Run ${run.id.slice(0, 8)}，可在任务页查看状态`);
      setReviewed(false); setConsumed(true);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const saveEdits = async () => {
    setBusy(true); setError(""); setReviewed(false);
    try {
      const changes: HandoffEdit[] = Object.entries(edits).map(([index, text]) => ({ eventIndex: Number(index), text }));
      await call("handoff.edit", { handoffId: id, edits: changes });
      await inspect(id);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  if (props.disabled) return <div>请先选择一个项目。</div>;
  return <div>
    <h2>对话交接</h2>
    <p>选择当前项目的源会话，审查交接原文和完整性，再启动目标 Agent。</p>
    {error && <div role="alert" style={{ color: "#f38ba8", marginBottom: 12 }}>{error}</div>}
    <div style={card}>
      <label>源 Agent <select aria-label="源 Agent" style={inputStyle} value={source} disabled={busy} onChange={(e) => setSource(e.target.value as AgentId)}>
        {AGENTS.map((a) => <option key={a} value={a}>{a}</option>)}
      </select></label>
      {source === "workbuddy" && <div style={{ marginTop: 12 }}>
        <p>WorkBuddy 桌面实时会话暂不能直接读取。准备符合兼容格式的可见消息 JSON/JSONL 文件后，在这里输入路径并导入本机私有副本。</p>
        <input aria-label="WorkBuddy 会话文件路径" style={{ ...inputStyle, minWidth: 360 }} value={workbuddyFile} disabled={busy} onChange={(e) => setWorkbuddyFile(e.target.value)} placeholder="D:/exports/conversation.json" />
        <button style={btn} disabled={busy || !workbuddyFile.trim()} onClick={importWorkBuddy}>导入 WorkBuddy 会话</button>
      </div>}
      <label>源会话 <select aria-label="源会话" style={{ ...inputStyle, maxWidth: 420 }} value={sessionId} disabled={busy} onChange={(e) => { setSessionId(e.target.value); setId(""); setReport(null); setEvents([]); setReviewed(false); setResult(""); }}>
        <option value="">请选择会话</option>
        {sessions.map((s) => <option key={s.id} value={s.id}>{s.title || s.id} · {s.messageCount} 条</option>)}
      </select></label>
      <button style={btn} disabled={busy} onClick={() => setSessionRefresh((n) => n + 1)}>刷新会话</button>
      <button style={btn} disabled={busy || !sessionId} onClick={create}>创建交接包</button>
      {sessions.length === 0 && <p>此 Agent 当前没有可读取的项目会话；可刷新或选择其他源 Agent。</p>}
    </div>
    <details style={card}><summary>打开已有交接包</summary>
      <input aria-label="交接包 id" style={inputStyle} placeholder="交接包 id" value={id} disabled={busy} onChange={(e) => { setId(e.target.value); setReport(null); setEvents([]); setReviewed(false); setResult(""); }} />
      <button style={btn} disabled={busy || !id} onClick={async () => { setBusy(true); setError(""); try { await inspect(id); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } }}>校验并预览</button>
    </details>
    {report && <div style={card}>
      <div>交接包：{id}</div>
      <div>已读取可见消息：{report.readCount} 条</div><div>源记录条数：{report.sourceCount ?? "未知"}</div>
      <div>完整性：{report.complete ? "完整" : "不完整"}</div>
      {!report.complete && <p style={{ color: "#f9e2af" }}>交接内容存在缺失或源记录数未知；启动目标前请审查以下说明。</p>}
      {report.missing.length > 0 && <div style={{ color: "#f38ba8" }}>缺失：{report.missing.join("，")}</div>}
      {report.largeAttachments.length > 0 && <div>过大附件：{report.largeAttachments.join("，")}</div>}
      <h3>交接原文预览</h3>
      <p>编辑和删除只修改交接副本，源会话保持原样。保存后请重新审查。</p>
      {findings.length === 0 ? <p>未发现匹配的敏感提示，请继续人工审查。</p> : findings.map((finding, i) => <p key={i} style={{ color: "#f9e2af" }}>敏感提示：{finding.kind} · {finding.field} · {finding.snippet}</p>)}
      {events.map((event) => <article key={event.index} style={{ borderTop: "1px solid #585b70", padding: "10px 0" }}>
        <div>#{event.index + 1} · {event.role} · {event.timestamp}</div>
        <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{event.text}</pre>
        {!consumed && <div>
          <textarea aria-label={`编辑消息 ${event.index + 1}`} style={{ ...inputStyle, width: "95%", minHeight: 70 }} disabled={busy || edits[event.index] === null} value={edits[event.index] ?? event.text ?? ""} onChange={(e) => { setEdits((previous) => ({ ...previous, [event.index]: e.target.value })); setReviewed(false); }} />
          <button style={btn} disabled={busy} onClick={() => { setEdits((previous) => ({ ...previous, [event.index]: previous[event.index] === null ? event.text ?? "" : null })); setReviewed(false); }}>{edits[event.index] === null ? "恢复消息" : "删除消息"} {event.index + 1}</button>
          {edits[event.index] === null && <span>此消息将在保存时从副本中移除</span>}
        </div>}
        {event.toolCalls?.map((tool) => <details key={tool.id}><summary>工具 {tool.name} · {tool.status}</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{tool.inputSummary}{"\n"}{tool.outputSummary}</pre></details>)}
        {event.attachments?.map((a) => <div key={a.name}>附件：{a.name} · {a.available ? "可读取" : "不可读取"}</div>)}
      </article>)}
      {!consumed && <button style={btn} disabled={busy || Object.keys(edits).length === 0} onClick={saveEdits}>保存交接副本</button>}
      {Object.keys(edits).length > 0 && <p>存在未保存的修改，请先保存再启动目标。</p>}
      <label><input type="checkbox" checked={reviewed} disabled={busy || Object.keys(edits).length > 0 || consumed} onChange={(e) => setReviewed(e.target.checked)} />我已审查交接原文及敏感内容</label>
    </div>}
    <div style={{ marginTop: 12 }}>
      <label>目标 Agent <select aria-label="目标 Agent" style={inputStyle} value={target} disabled={busy} onChange={(e) => setTarget(e.target.value as AgentId)}>{AGENTS.map((a) => <option key={a} value={a}>{a}</option>)}</select></label>
      <input aria-label="处理目标" style={inputStyle} placeholder="目标 Agent 的处理目标" value={goal} disabled={busy} onChange={(e) => setGoal(e.target.value)} />
      <button style={btn} disabled={busy || !id || !report || !reviewed || consumed || Object.keys(edits).length > 0} onClick={consume}>启动目标 Agent</button>
    </div>
    {busy && <p role="status">正在处理，请稍候…</p>}
    {result && <div role="status" style={{ marginTop: 8, color: "#a6e3a1" }}>{result}</div>}
  </div>;
}
/* --------------------------- 共享配置 --------------------------- */

function ConfigView(props: { projectId: string; disabled: boolean }): JSX.Element {
  const [artifacts, setArtifacts] = useState<{ id: string; kind: string; name: string }[]>([]);
  const [diff, setDiff] = useState<PublishDiff | null>(null);
  const [target, setTarget] = useState<AgentId>("codex");
  const [choices, setChoices] = useState<Record<string, "keep-native" | "overwrite-with-shared" | "manual-merge">>({});
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setDiff(null);
    setChoices({});
    setMessage("");
    if (!props.projectId) return setArtifacts([]);
    call("config.scan", { projectId: props.projectId })
      .then((a) => setArtifacts(a.map((x) => ({ id: x.id, kind: x.kind, name: x.name }))))
      .catch(() => setArtifacts([]));
  }, [props.projectId, target]);

  const preview = async () => {
    setMessage("");
    try {
      const next = await call("config.previewPublish", {
        projectId: props.projectId,
        targetAgentId: target,
      });
      setDiff(next);
      setChoices(Object.fromEntries(next.entries.map((entry) => [entry.artifactId, "keep-native"])));
    } catch (reason) {
      setDiff(null);
      setMessage(reason instanceof Error ? reason.message : String(reason));
    }
  };

  const publish = async () => {
    if (!diff) return;
    setBusy(true);
    setMessage("");
    try {
      const receipt = await call("config.publish", { diffId: diff.id, choices });
      setMessage(`发布完成：${receipt.id}`);
      setDiff(null);
      setChoices({});
    } catch (reason) {
      setMessage(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  if (props.disabled) return <div>请先选择一个项目。</div>;

  return (
    <div>
      <h2>共享配置</h2>
      <div style={{ marginBottom: 12 }}>
        <button style={btn} disabled={busy} onClick={preview}>扫描并对 {target} 预览发布</button>
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
            <div key={e.artifactId} style={{ fontSize: 13, marginBottom: 10 }}>
              <div>{e.kind} · {e.sourcePath} → {e.path || "无受支持目标"}：{e.status}</div>
              {e.reason && <div style={{ color: "#f9e2af" }}>{e.reason}</div>}
              <select
                style={inputStyle}
                value={choices[e.artifactId] ?? "keep-native"}
                onChange={(event) => setChoices((current) => ({ ...current, [e.artifactId]: event.target.value as "keep-native" | "overwrite-with-shared" | "manual-merge" }))}
              >
                <option value="keep-native">保留原生文件</option>
                <option value="overwrite-with-shared" disabled={e.publishable === false}>用共享内容覆盖</option>
                <option value="manual-merge">人工合并，暂不写入</option>
              </select>
            </div>
          ))}
          <button style={btn} disabled={busy} onClick={publish}>按以上选择发布</button>
        </div>
      )}
      {message && <p role="status">{message}</p>}
    </div>
  );
}

/* --------------------------- 记忆互转 --------------------------- */

function MemoryView(props: { projectId: string; disabled: boolean }): JSX.Element {
  const [entries, setEntries] = useState<MemoryEntryDTO[]>([]);
  const [agent, setAgent] = useState<AgentId>("claude-code");
  const [target, setTarget] = useState<AgentId>("codex");
  const [destination, setDestination] = useState<"project_guidance" | "task_context">("project_guidance");
  const [transfer, setTransfer] = useState<MemoryTransferDiff | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setTransfer(null); setMessage(""); setError("");
    if (!props.projectId) return setEntries([]);
    call("memory.list", { projectId: props.projectId, agentId: agent })
      .then(setEntries)
      .catch((reason) => { setEntries([]); setError(reason instanceof Error ? reason.message : String(reason)); });
  }, [props.projectId, agent]);

  const preview = async (entryId: string) => {
    setBusy(true); setError(""); setMessage("");
    try {
      setTransfer(await call("memory.previewTransfer", {
        entryIds: [entryId], targetAgentId: target, destination,
      }));
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  const apply = async () => {
    if (!transfer) return;
    setBusy(true); setError("");
    try {
      await call("memory.applyTransfer", { diffId: transfer.id });
      setMessage(`已发布给 ${transfer.targetAgentId}；由工作台启动的该 Agent 任务会读取指导文件。`);
      setTransfer(null);
      setEntries(await call("memory.list", { projectId: props.projectId, agentId: agent }));
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  };

  if (props.disabled) return <div>请先选择一个项目。</div>;

  return (
    <div>
      <h2>记忆互转</h2>
      {error && <div role="alert" style={{ color: "#f38ba8" }}>{error}</div>}
      {message && <div role="status">{message}</div>}
      <div style={{ marginBottom: 12 }}>
        <label>来源 Agent <select aria-label="来源 Agent" style={inputStyle} value={agent} onChange={(e) => setAgent(e.target.value as AgentId)}>
          {AGENTS.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select></label>
        <label>目标 Agent <select aria-label="记忆目标 Agent" style={inputStyle} value={target} onChange={(e) => { setTarget(e.target.value as AgentId); setTransfer(null); }}>
          {AGENTS.map((a) => <option key={a} value={a}>{a}</option>)}
        </select></label>
        <label>用途 <select aria-label="记忆用途" style={inputStyle} value={destination} onChange={(e) => { setDestination(e.target.value as typeof destination); setTransfer(null); }}>
          <option value="project_guidance">项目指导</option>
          <option value="task_context">任务上下文</option>
        </select></label>
      </div>
      {entries.map((e) => (
        <div key={e.id} style={card}>
          <div style={{ fontSize: 13 }}>{e.source}</div>
          <div style={{ fontSize: 12, color: "#a6adc8" }}>{e.originalText.slice(0, 120)}</div>
          <button style={btn} disabled={busy} onClick={() => void preview(e.id)}>预览转给 {target}</button>
        </div>
      ))}
      {transfer && (
        <div style={card}>
          <div style={{ fontWeight: 600 }}>转移预览</div>
          <div>目标：{transfer.targetAgentId} · {transfer.destination === "project_guidance" ? "项目指导" : "任务上下文"} · 原生记忆写入：{transfer.nativeWriteSupported ? "支持" : "不支持"}</div>
          <pre style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>{transfer.previewText}</pre>
          <button style={btn} disabled={busy} onClick={() => void apply()}>发布为工作台任务指导</button>
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

function WorkflowsView(props: { projectId: string; disabled: boolean; onMerge: (id: string) => void }): JSX.Element {
  const [tasks, setTasks] = useState<TaskDTO[]>([]);
  const [taskId, setTaskId] = useState("");
  const [name, setName] = useState("项目工作流");
  const [nodes, setNodes] = useState<WorkflowNodeDef[]>([{ id: "node-1", agentId: "claude-code", input: "", dependsOn: [], writesRepo: false, optional: false, completionCondition: "agent_reports" }]);
  const [workflow, setWorkflow] = useState<WorkflowRunDTO | null>(null);
  const [workflowId, setWorkflowId] = useState(() => localStorage.getItem(`workbench.workflow.${props.projectId}`) ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [nextId, setNextId] = useState(2);
  const updateNode = (id: string, change: Partial<WorkflowNodeDef>) => setNodes((previous) => previous.map((n) => n.id === id ? { ...n, ...change } : n));
  const capture = (wf: WorkflowRunDTO | null) => {
    if (!wf) throw new Error("找不到工作流，请检查工作流 ID");
    setWorkflow(wf); setWorkflowId(wf.id); localStorage.setItem(`workbench.workflow.${props.projectId}`, wf.id);
  };
  const execute = async (operation: () => Promise<void>) => {
    setBusy(true); setError("");
    try { await operation(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  useEffect(() => {
    if (!props.projectId) return;
    let current = true;
    call("tasks.list", { projectId: props.projectId }).then((items) => { if (current) setTasks(items); }).catch((e) => { if (current) setError(String(e)); });
    return () => { current = false; };
  }, [props.projectId]);
  const inspect = async () => {
    const wf = await call("workflow.get", { workflowRunId: workflowId });
    if (wf && !tasks.some((task) => task.id === wf.taskId)) throw new Error("此工作流不属于当前项目任务");
    capture(wf);
  };
  const addNode = (parallel: boolean) => {
    const id = `node-${nextId}`; setNextId((n) => n + 1);
    setNodes((previous) => [...previous, { id, agentId: "codex", input: "", dependsOn: parallel || previous.length === 0 ? [] : [previous[previous.length - 1].id], writesRepo: false, optional: false, completionCondition: "agent_reports" }]);
  };
  const start = async () => {
    if (!taskId || !nodes.length || nodes.some((node) => !node.input.trim())) throw new Error("请选择项目任务，并填写每个节点的指令");
    const visiting = new Set<string>(); const complete = new Set<string>();
    const visit = (id: string): void => {
      if (visiting.has(id)) throw new Error("节点依赖存在循环，请调整依赖");
      if (complete.has(id)) return;
      visiting.add(id); const node = nodes.find((n) => n.id === id);
      if (!node) throw new Error("节点依赖不存在");
      node.dependsOn.forEach(visit); visiting.delete(id); complete.add(id);
    };
    nodes.forEach((node) => visit(node.id));
    const definition: WorkflowDef = { id: crypto.randomUUID(), name: name.trim() || "项目工作流", nodes };
    capture(await call("workflow.start", { taskId, definition }));
  };
  if (props.disabled) return <div>请先选择一个项目。</div>;
  return <div>
    <h2>工作流</h2>
    {error && <div role="alert" style={{ color: "#f38ba8" }}>{error}</div>}
    <p>顺序节点默认依赖前一节点；并行节点默认无依赖，可按需修改。写仓库节点使用独立工作区。</p>
    <div style={card}>
      <label>工作流任务 <select aria-label="工作流任务" style={inputStyle} value={taskId} disabled={busy} onChange={(e) => setTaskId(e.target.value)}><option value="">请选择任务</option>{tasks.map((task) => <option key={task.id} value={task.id}>{task.title}</option>)}</select></label>
      <label>名称 <input aria-label="工作流名称" style={inputStyle} value={name} disabled={busy} onChange={(e) => setName(e.target.value)} /></label>
      {nodes.map((node) => <fieldset key={node.id} style={{ marginTop: 12, border: "1px solid #585b70" }} disabled={busy}>
        <legend>{node.id}</legend>
        <label>Agent <select aria-label={`节点 ${node.id} Agent`} style={inputStyle} value={node.agentId} onChange={(e) => updateNode(node.id, { agentId: e.target.value as AgentId })}>{AGENTS.map((agent) => <option key={agent} value={agent}>{agent}</option>)}</select></label>
        <textarea aria-label={`节点 ${node.id} 指令`} style={{ ...inputStyle, display: "block", width: "95%", margin: "8px 0" }} placeholder="此节点的执行指令" value={node.input} onChange={(e) => updateNode(node.id, { input: e.target.value })} />
        <label>依赖（可多选） <select multiple aria-label={`节点 ${node.id} 依赖`} style={inputStyle} value={node.dependsOn} onChange={(e) => updateNode(node.id, { dependsOn: Array.from(e.target.selectedOptions, (option) => option.value) })}>{nodes.filter((n) => n.id !== node.id).map((n) => <option key={n.id} value={n.id}>{n.id}</option>)}</select></label>
        <label><input aria-label={`节点 ${node.id} 写仓库`} type="checkbox" checked={node.writesRepo} onChange={(e) => updateNode(node.id, { writesRepo: e.target.checked })} />写仓库</label>
        <label><input aria-label={`节点 ${node.id} 人工审查门`} type="checkbox" checked={node.completionCondition === "user_review"} onChange={(e) => updateNode(node.id, { completionCondition: e.target.checked ? "user_review" : "agent_reports" })} />启动前人工审查</label>
        <button style={btn} disabled={nodes.length === 1} onClick={() => setNodes((previous) => previous.filter((n) => n.id !== node.id).map((n) => ({ ...n, dependsOn: n.dependsOn.filter((dep) => dep !== node.id) })))}>移除 {node.id}</button>
      </fieldset>)}
      <div style={{ marginTop: 12 }}><button style={btn} disabled={busy} onClick={() => addNode(false)}>添加顺序节点</button><button style={btn} disabled={busy} onClick={() => addNode(true)}>添加并行节点</button><button style={btn} disabled={busy || !taskId} onClick={() => void execute(start)}>启动工作流</button></div>
    </div>
    <div style={card}>
      <input aria-label="工作流运行 ID" style={inputStyle} value={workflowId} disabled={busy} placeholder="已有工作流运行 ID" onChange={(e) => { setWorkflowId(e.target.value); setWorkflow(null); }} />
      <button style={btn} disabled={busy || !workflowId || !tasks.length} onClick={() => void execute(inspect)}>读取工作流状态</button>
      {workflow && <div>
        <h3>{workflow.definition.name}</h3><div>工作流 {workflow.id} · {workflow.paused ? "已暂停调度" : "调度已启用"}</div>
        <p>暂停只停止后续调度；已运行的任务可到任务页查看。</p>
        <button style={btn} disabled={busy || workflow.paused} onClick={() => void execute(async () => capture(await call("workflow.advance", { workflowRunId: workflow.id })))}>推进工作流</button>
        <button style={btn} disabled={busy} onClick={() => void execute(async () => { if (workflow.paused) capture(await call("workflow.resume", { workflowRunId: workflow.id })); else { await call("workflow.pause", { workflowRunId: workflow.id }); capture(await call("workflow.get", { workflowRunId: workflow.id })); } })}>{workflow.paused ? "恢复调度" : "暂停调度"}</button>
        <button style={btn} disabled={busy} onClick={() => props.onMerge(workflow.id)}>查看合并提案</button>
        {workflow.nodes.map((state) => <div key={state.id} style={{ ...card, marginTop: 10, background: "#1e1e2e" }}>
          <div>{state.id} · {workflow.definition.nodes.find((n) => n.id === state.id)?.agentId} · {state.status}</div>
          {state.runId && <div>Run：{state.runId}</div>}
          {state.status === "blocked" && <button style={btn} disabled={busy} onClick={() => void execute(async () => capture(await call("workflow.approve", { workflowRunId: workflow.id, nodeId: state.id })))}>批准 {state.id}</button>}
          {state.status === "failed" && <button style={btn} disabled={busy || workflow.paused} onClick={() => void execute(async () => capture(await call("workflow.retry", { workflowRunId: workflow.id, nodeId: state.id })))}>重试 {state.id}</button>}
        </div>)}
      </div>}
    </div>
  </div>;
}

function MergeView(props: { projectId: string; workflowRunId: string }): JSX.Element {
  const [workflowId, setWorkflowId] = useState(props.workflowRunId || localStorage.getItem(`workbench.workflow.${props.projectId}`) || "");
  const [proposal, setProposal] = useState<MergeProposalDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [finished, setFinished] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const execute = async (operation: () => Promise<void>) => {
    setBusy(true); setError(""); setMessage("");
    try { await operation(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const decide = async (decision: "apply" | "reject") => {
    if (!proposal) return;
    const result = await call("merge.apply", { proposalId: proposal.id, decision });
    if (!result.ok) throw new Error(result.message);
    setMessage(result.message); setFinished(true); setReviewed(false);
  };
  if (!props.projectId) return <div>请先选择一个项目。</div>;
  return <div>
    <h2>合并审查</h2>
    {error && <div role="alert" style={{ color: "#f38ba8" }}>{error}</div>}
    <label>工作流运行 ID <input aria-label="合并工作流 ID" style={inputStyle} value={workflowId} disabled={busy} onChange={(e) => { setWorkflowId(e.target.value); setProposal(null); setFinished(false); setReviewed(false); }} /></label>
    <button style={btn} disabled={busy || !workflowId} onClick={() => void execute(async () => {
      const [workflow, tasks] = await Promise.all([call("workflow.get", { workflowRunId: workflowId }), call("tasks.list", { projectId: props.projectId })]);
      if (!workflow || !tasks.some((task) => task.id === workflow.taskId)) throw new Error("请选择当前项目的工作流");
      setProposal(await call("merge.create", { workflowRunId: workflowId })); setReviewed(false); setFinished(false);
    })}>创建合并提案</button>
    {proposal && <div style={{ ...card, marginTop: 12 }}>
      <div>提案：{proposal.id}</div><div>目标分支：{proposal.targetBranch}</div><div>基线提交：{proposal.baselineCommit}</div><div>基线：{proposal.baselineValid ? "有效" : "已失效，请刷新或重新创建提案"}</div>
      {proposal.branches.map((branch) => <article key={branch.runId} style={{ padding: "10px 0", borderBottom: "1px solid #585b70" }}>
        <strong>{branch.branch}</strong><div>{branch.agentId} · Run {branch.runId} · 基线 {branch.baseCommit}</div>
        <div>已提交：{branch.committedChanges} · 未提交：{branch.uncommittedChanges} · 未跟踪：{branch.untrackedFiles}</div>
        <div>验证命令：{branch.testCommand || "未提供"} · 验证结果：{branch.testResult || "未运行"}</div>
      </article>)}
      <h3>冲突</h3>
      {proposal.conflicts.length ? <div><p style={{ color: "#f38ba8" }}>请先在分支处理并提交以下冲突，再重新创建提案；有冲突时无法应用。</p>{proposal.conflicts.map((conflict) => <div key={conflict}>{conflict}</div>)}</div> : <p>未发现冲突。</p>}
      {proposal.branches.some((branch) => branch.uncommittedChanges > 0) && <p style={{ color: "#f9e2af" }}>分支有未提交改动；请先提交并重新创建提案。</p>}
      <button style={btn} disabled={busy || finished} onClick={() => void execute(async () => { setReviewed(false); setProposal(await call("merge.refresh", { proposalId: proposal.id })); })}>刷新提案</button>
      <p><label><input type="checkbox" checked={reviewed} disabled={busy || finished || !proposal.baselineValid || proposal.conflicts.length > 0 || proposal.branches.some((branch) => branch.uncommittedChanges > 0)} onChange={(e) => setReviewed(e.target.checked)} />我已审查分支差异与验证结果</label></p>
      <button style={btn} disabled={busy || finished || !reviewed || !proposal.baselineValid || proposal.conflicts.length > 0 || proposal.branches.some((branch) => branch.uncommittedChanges > 0) || proposal.branches.length === 0} onClick={() => void execute(() => decide("apply"))}>应用无冲突合并</button>
      <button style={btn} disabled={busy || finished} onClick={() => void execute(() => decide("reject"))}>拒绝提案</button>
    </div>}
    {message && <p role="status">{message}</p>}
  </div>;
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
