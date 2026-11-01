# DeepSeek Harness Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add official dsh to Agent Home for project configuration, managed tasks, and user-triggered full visible-history handoff.

**Architecture:** A dsh adapter implements the existing `AgentAdapter` interface. ACP JSON-RPC controls sessions and runs; an import module consumes official Web exports into local `VisibleEvent` snapshots. Existing publishers, handoff builder, runtime, and UI reuse those interfaces.

**Tech Stack:** Electron 45, Node 22, TypeScript 5.6, React 18, Vitest 5, Windows PowerShell, official dsh ACP v1 and Web session export.

## Global Constraints

- Windows local desktop first; project scope first.
- Memory transfer only on user action, with full committed visible history, no hidden reasoning or credentials.
- Rules and skills publish through preview, conflict detection, backup and rollback.
- Capability and token reports must reflect evidence; unavailable dsh means no real integration test claim.
- Do not read raw files inside `~/.dsh/sessions`.

## File map

- `src/main/adapters/deepseek-acp.ts`: ACP transport and server request handling.
- `src/main/adapters/deepseek.ts`: capability probe, session listing, managed task lifecycle, imported-session lookup.
- `src/main/adapters/deepseek-export.ts`: strict parser for official exported Markdown/ZIP, with explicit completeness metadata.
- `src/main/ipc/deepseek.ts`: project-bound import endpoint and local snapshot storage.
- `src/shared/contracts.ts`: Agent ID and IPC contract.
- `src/main/config/publisher.ts`, `src/main/memory/inventory.ts`: dsh native project paths.
- `src/main/services.ts`, `src/main/ipc/index.ts`, `src/renderer/App.tsx`: registration, endpoint and UI.
- `tests/unit/deepseek*.test.ts`: transport, export, and publisher edge cases.
- `README.md`, `docs/compatibility/deepseek-harness.md`: user instructions and capability limits.

### Task 1: Register dsh and publish its project configuration

**Interfaces:** `AgentId` adds `deepseek-harness`; `ConfigPublisher.nativeTarget()` maps rules/knowledge to `AGENTS.md` and skills to `.dsh/skills/<name>`; `MemoryInventory` reads `AGENTS.md` for dsh.

- [ ] **Step 1: Write failing tests.** Extend config publication tests to assert dsh skill target, shared `AGENTS.md` conflict behavior, and rollback; extend memory inventory tests for dsh instructions.
- [ ] **Step 2: Run tests to see failures.** `npm test -- --run tests/unit/config-publisher.test.ts tests/unit/memory-inventory.test.ts`; expect missing dsh ID/path assertions.
- [ ] **Step 3: Implement.** Add `deepseek-harness` to `AgentId` and `AGENT_LABELS`; add the target branches, dsh native-skill source exclusion, memory path and all Agent selectors.
- [ ] **Step 4: Verify.** `npm run typecheck; npm run typecheck:electron; npm test -- --run tests/unit/config-publisher.test.ts tests/unit/memory-inventory.test.ts`; expect exit 0.
- [ ] **Step 5: Commit.** `git add src tests; git commit -m "feat: register dsh project configuration"`.

### Task 2: ACP transport and managed task lifecycle

**Interfaces:** `connectDeepSeek(command, cwd): Promise<DeepSeekConnection>` exposes `request()`, `onNotification()`, `onServerRequest()`, `close()`, `pid`; `DeepSeekAdapter` implements `AgentAdapter` and takes optional transport factory for tests.

- [ ] **Step 1: Write failing protocol tests.** Exercise `initialize`, concurrent numeric-ID requests, `session/request_permission` rejection, timeout, process exit and `session/update` notification routing. Write adapter tests with fake ACP connection for session list, new/prompt/cancel, completion classification.
- [ ] **Step 2: Run tests to see failures.** `npm test -- --run tests/unit/deepseek-acp.test.ts tests/unit/deepseek-adapter.test.ts`; expect missing modules.
- [ ] **Step 3: Implement transport.** Spawn `dsh --profile acp` with absolute cwd and hidden window; frame newline JSON-RPC, pair responses by ID, reject pending work on exit; use ACP v1 `initialize`. Reply to permission requests with an explicit rejection until a review UI exists. Close child and drain streams on errors.
- [ ] **Step 4: Implement adapter.** Probe `dsh --version` and ACP handshake; list sessions with cwd filter and pagination; start new session and prompt with the reviewed handoff path/content; track only owned runs for cancellation and completion. Surface `tasks.start` as degraded while permissions cannot be approved; mark unsupported stream/usage if no verifiable events.
- [ ] **Step 5: Verify and commit.** Run the two focused suites plus typechecks, then `git add src/main/adapters src/main/services.ts tests; git commit -m "feat: control dsh tasks through ACP"`.

### Task 3: User-triggered export import and handoff

**Interfaces:** `importDeepSeekExport(projectId, filePath): Promise<SessionRef>` copies the source into private app data, validates project/session origin, and stores parsed `VisibleEvent[]`; `DeepSeekAdapter.listSessions()` includes imported snapshots, while `readVisibleSession()` reads only a validated snapshot.

- [ ] **Step 1: Write failing parser/import tests.** Cover known official event types, message ordering, omitted reasoning, tool results, attachment availability, unknown versions, malformed ZIP entries/path traversal, size ceilings and SHA-256 source provenance.
- [ ] **Step 2: Run tests to see failures.** `npm test -- --run tests/unit/deepseek-export.test.ts tests/unit/deepseek-import.test.ts`; expect missing modules.
- [ ] **Step 3: Implement parser and import.** Use official export ZIP as the primary format, preserving the selected root log and available attachment bytes. Accept official `Copy Session as Markdown` saved as UTF-8 `.md` as a visibly degraded text-only fallback. Reject unsupported formats instead of truncating or inventing history. Never inspect private `.dsh` storage.
- [ ] **Step 4: Wire UI and IPC.** Add `deepseek.importSession` and the dsh import control next to WorkBuddy import; after import refresh sessions and handoff preview. Show exact source, capture time and completeness state. Use existing project-path validation and handoff confirmation.
- [ ] **Step 5: Verify and commit.** Run focused suites, UI tests for source selection and handoff, then `git add src tests; git commit -m "feat: import dsh visible session history"`.

### Task 4: Documentation, integration checks and release

**Interfaces:** User-facing README and compatibility record reflect exact supported/degraded/unsupported capabilities.

- [ ] **Step 1: Document use.** Add dsh install/probe, project config preview, ACP task start, Web export/import, handoff and limitations to `README.md` and `docs/compatibility/deepseek-harness.md`.
- [ ] **Step 2: Verify repository.** Run `npm run typecheck`, `npm run typecheck:electron`, `npm test`, and build/package smoke if the environment supports it; resolve failures, then stop optional testing.
- [ ] **Step 3: Real dsh check if installed.** Run `dsh --version`, a project-scoped ACP list/new/cancel fixture, and Web export import round trip. If `dsh` is absent, record this exact limitation in the compatibility record.
- [ ] **Step 4: Commit and push.** `git add README.md docs; git commit -m "docs: explain DeepSeek Harness integration"; git push origin main`. If network fails, preserve local commits and report the exact push failure.

## Self-review

Every design section maps to a task. The ACP and import modules have separate tests and can fail independently. Unknown dsh formats and missing live CLI are explicit capability states, never success claims.
