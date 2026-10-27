# Claude Code 深度适配器（2026-10-27）

实现依据：[CLI reference](https://code.claude.com/docs/en/cli-reference)、[Manage sessions](https://code.claude.com/docs/en/sessions)。无需新增 SDK 依赖，复用用户已登录的 CLI，不读取令牌、凭据或数据库。

- 本地会话：读取 `CLAUDE_CONFIG_DIR`（默认 `~/.claude`）下 `projects/<encoded-project>/*.jsonl`。按源文件顺序保留 user/assistant 消息、消息 ID、时间戳与完整工具输入输出；忽略 bookkeeping 和 thinking。文件损坏时明确报错，不将部分读取宣称为完整历史。
- 手工 JSON/JSONL 导入继续可用。读取是当前文件快照；正在写入的半行会报 invalid_data，可在写入完成后重试。当前项目没有 transcript 时返回空列表。
- 启动：`auth status` 只读确认登录；通过无 shell 的原生 exe / npm CLI 脚本执行 `-p --output-format stream-json --verbose --session-id <uuid>`（恢复时使用 `--resume`）。目标经 stdin 原样传递，不经过 shell；不传绕过权限选项。handoffPath 存在时提示先读取 UTF-8 完整交接文件。
- 只有收到匹配 session_id 的 system/init 后才返回 RunHandle。启动前失败抛 process_failed；waitForCompletion 根据退出码和 result.is_error 返回终态。支持后台等待，暂不声明 interrupt 或精确用量能力。

验证：专项 10 个离线夹具/伪 CLI 测试，覆盖完整原文、隐藏推理过滤、初始化、完成及启动失败；两个 TypeScript 检查通过。真实 CLI 仅执行 --help/--version/auth status；本仓库当前没有本地 transcript。未执行付费模型调用，不声称已完成订阅模型端到端测试。

限制：仅支持本地 CLI 持久化的主会话，云端和桌面独立会话列表、subagent 独立 transcript、二进制附件和原生权限交互未接入；不保证分叉 transcript 的 active message chain 与 CLI picker 一致。未知格式需重新验证适配器。进程重启后无法恢复已丢失的进程完成句柄，仍可通过已持久化会话 ID 读取历史。
