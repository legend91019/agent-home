# Codex app-server 兼容性验证（2026-10-27）

此记录替代旧报告中“Codex 未安装、所有任务启动必然失败”的结论。实现遵循 [官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)，并以本机 `codex app-server generate-json-schema` 生成的 0.164.0 schema 核验新 item 类型。

## 本机只读验证

- Windows 本机 `codex.exe --version` 返回 `codex-cli 0.164.0`。
- stdio `initialize` → `initialized` 握手成功。
- `account/read` 使用 `refreshToken:false`，仅判断账户是否存在，不保存或输出账户信息；`authenticated:true`。
- 项目 `D:\Desktop\agent-home` 的 `thread/list` 返回 1 条会话。
- `thread/read` + `thread/turns/list`（`sortDirection:asc`、`itemsView:full`）读取 196 个可见事件：用户 12、助手 42、工具 109、系统 33。会话持续变化，条数只代表测试时快照。
- 没有启动真实模型 turn、读取凭据文件、扫描私有数据库或打印会话正文。

## 能力与边界

- CLI 探测使用 Windows 的 `codex.exe`，避免不带扩展名的可执行文件解析问题。CLI 存在而 app-server 不兼容时仍保留 `installed:true`，对应能力降级为 unknown。
- 列表包含 cli、vscode、exec、appServer 来源，并限制项目 cwd；完整处理 nextCursor。未包含归档、远程主机及所有子 agent 线程，不承诺覆盖其他桌面会话。
- 历史只保留可见用户消息、助手消息、工具输入输出和可见控制项。reasoning item 整体排除。未知 item 明确报 unsupported_version，避免静默生成不完整交接；附件仅保留引用，available:false，不自动下载。
- `SessionRef.messageCount` 使用 0 表示列表未提供计数（当前公共契约只允许 number）；读取后的实际事件计数由调用方计算。
- 新任务通过 thread/start 和 turn/start 创建；指定 sessionId 时使用 thread/resume。handoffPath 会作为 UTF-8 历史文件入口写入首条提示。
- waitForCompletion 根据 turn/completed 区分 succeeded、failed、cancelled；进程退出按 failed 结算。任务完成或启动失败回收 app-server。
- interrupt 仅针对当前适配器启动并保留的 threadId/turnId，不支持应用重启后恢复运行控制。
- 当前采用 workspace-write 沙箱与 approvalPolicy:never；需要审批的操作不会获批，未知服务端请求返回 JSON-RPC -32601。尚无交互审批 UI。
- 任务启动和中断已由伪服务测试验证，未执行真实收费请求，因此 tasks.start/tasks.interrupt 为 degraded。公开契约尚无逐条流式事件订阅，tasks.stream 为 unsupported；精确用量仍为 unknown。

## 自动验证

`npx vitest run tests/integration/codex-app-server.test.ts tests/integration/codex-adapter.test.ts`：26 项通过，包括真实子进程伪服务 stdio 握手/分块响应、分页、可见历史、推理排除、终态、中断、交接提示、进程退出和手工导入回退。测试不依赖实际 Codex 安装或账户。

`npm run typecheck:electron`：通过。全项目 `npm run typecheck` 的最终结果以主任务整体验证为准。
