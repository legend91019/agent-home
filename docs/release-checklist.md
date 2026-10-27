# Windows 候选版验证记录

日期：2026-10-27。此清单记录已执行的验证与仍需实测的边界，发布前应在最终源码上重跑全部命令。

## 已验证

- `npm run typecheck` 与 `npm run typecheck:electron`：通过。
- `npm test`：140/140 通过；包含真实 Git worktree、三分支冲突、目标脏工作区保护、交接哈希、状态终态、适配器伪服务协议。
- `npm run e2e`：7/7 通过。真实 Edge 浏览器配合模拟 IPC 验证配置逐项发布、项目错误、交接、任务、工作流、合并及记忆界面。不会产生模型请求。
- `npm audit --audit-level=high`：0 个漏洞。
- `npm run make`：生成 Windows Squirrel Setup 与 zip。
- `npm run smoke:package`：启动打包后的 Electron 程序，检查页面可见、preload IPC、SQLite 登记/读取临时项目；临时数据目录关闭后清理。
- 本机 Codex CLI 0.164.0：只读 app-server 探测、项目会话列表及完整可见事件读取通过。Claude CLI 登录状态只读探测通过。

## 发布前仍需人工实测

- 在用户愿意消耗账户配额的环境中，分别启动 Claude Code 与 Codex 小任务，观察终态、异常、中断和交接文件实际读取行为。
- 在安装版完成一次“项目登记 → 交接审查 → 目标任务 → 关闭重启 → 状态恢复”流程，确认应用数据保留。
- 在目标系统上验证 Squirrel 安装、升级和卸载行为；确认卸载不删除项目文件和 Agent 原生配置。
- 对大规模历史、长工具输出和 125% Windows 缩放做性能与可用性走查。
- 对 Antigravity、ZCode 分别做实际版本兼容性验证；WorkBuddy 继续验证桌面会话、任务接口及项目配置加载行为，详见 [兼容性说明](compatibility/workbuddy.md)。

## 发布判定

首版可以作为本地候选版试用。真实模型任务与安装/卸载的人工验证未完成前，不应宣称已通过全 Agent 端到端验收。缺失的能力继续显示为未知或降级。
