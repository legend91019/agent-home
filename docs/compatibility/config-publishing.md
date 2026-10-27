# 共享规则与 skill 发布安全约定

## 已验证目标

- Claude Code：规则或用户选择的知识发布到项目 `CLAUDE.md`；skill 发布到 `.claude/skills/<name>/`。[官方 skills 路径](https://code.claude.com/docs/en/skills)
- Codex：规则或用户选择的知识发布到项目 `AGENTS.md`；skill 发布到 `.agents/skills/<name>/`。[官方 skills 路径](https://learn.chatgpt.com/docs/build-skills)
- Antigravity、ZCode、WorkBuddy 的目标路径未在此发布器验证，预览显示 `publishable:false` 及原因；不会创建猜测的 `.antigravity.md` 等文件。

发布器只负责复制已选择的配置与资源。它不会执行 skill 脚本，也不承诺跨工具的扩展字段具有相同语义。

## 预览与选择

每个 `PublishDiffEntry` 包含来源 `artifactId`、`sourcePath`、`kind`、目标 `path`、共享/原生/上次发布哈希及不可发布原因。`choices` 必须以 `artifactId` 为键，不能以目标路径为键。

多个规则源可能映射同一个 `CLAUDE.md` 或 `AGENTS.md`。预览会提示冲突，一次只能选择其中一个来源覆盖；多选时整批拒绝，不会按扫描顺序覆盖。未选择的来源保持原样，发布器不自动拼接规则。

`manual-merge` 目前没有承载合并结果的接口，明确拒绝应用。请在外部完成合并后重新预览；人工合并绝不会被当成“用共享内容覆盖”。

来源与目标相同或字节一致时操作为 no-op，不删除目录、不创建虚假的发布记录。相同 skill 名称同时出现在共享来源和已发布原生目录时优先使用非原生共享来源；若多个独立共享来源同名而现有清单无法区分，则阻止发布，要求先消除歧义。工作台备份目录不作为发布来源。

## 应用与失败恢复

1. 应用前核验选定源、原生目标和发布基线仍与预览一致；漂移时要求重新预览。
2. 将原生内容备份，并把完整共享文件或 skill 目录复制到项目内暂存区。复制结果的哈希也必须与预览一致。
3. 再次校验整个选定计划，随后替换目标。单个文件使用重命名替换；目录先移动旧目录，再移入完整暂存目录，替换失败立即恢复旧目录。
4. 所有目标写入成功后，在一个数据库事务中记录发布与准确目标。文件写入或数据库提交失败时，逆序恢复已写入目标；恢复失败会明确报告，并保留备份证据。

操作拒绝项目路径之外的目标、符号链接/junction、来源与目标的父子重叠以及非法文件类型。不会通过递归删除进入外部目录。

备份保存在 `.agent-workbench/backups/<diffId>/`，包含原始字节和 `recovery.json`，不使用会与其他 Agent 混淆的全局侧车哈希。正常发布结束后预览即被消费，无法重放。进程被强制结束或断电时尚无自动重放恢复；保留的恢复清单与原始备份用于人工恢复。多文件写入不具备操作系统级的跨文件原子性，也不能对其他进程提供文件锁。

## 重启后回滚与数据库迁移

迁移 v3 给 `publications` 增加 `target_agent_id`、`target_path`、`artifact_kind`、`shared_hash`、`native_before_hash` 与 `published_at_before`。数据库持久化的是实际目标路径，而非运行时重新猜测的 Agent 路径。

新建 `ConfigPublisher` 后仍可按 receipt ID 回滚。回滚前验证目标仍是本次发布的字节，且原始备份存在且哈希匹配；用户编辑或后续发布改变了目标时拒绝覆盖。首次发布且原生目标原本不存在时，仅删除本次新建的目标。数据库失败同样恢复回滚前的目标字节。

v1/v2 旧记录新增字段保留 NULL，不伪造目标、Agent 或哈希。此类记录拒绝自动回滚，需要依据已有备份人工确认；不会再默认落到 WorkBuddy 路径。

## 验证

`npx vitest run tests/unit/config-publisher.test.ts`：24 项通过，覆盖路径冲突、单选来源、源/目标漂移、人工合并拒绝、两个官方 skill 路径、同源目标 no-op、未知工具降级、重启回滚、新文件回滚、回滚漂移保护、数据库失败恢复、按目标区分基线、备份来源过滤、旧库迁移、已有 skill 资源完整恢复、junction 保护和预览重放拒绝。

`npm run typecheck` 与 `npm run typecheck:electron`：通过。
