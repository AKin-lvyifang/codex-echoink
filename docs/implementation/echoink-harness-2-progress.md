# EchoInk Harness 2.0 Progress Handoff

更新时间：2026-07-14 CST

## 当前结论

Harness 2.0 主计划与 V3 补充计划已经完成，并已按领域移植到 `main@5f8079d` 的独立集成分支。7 个领域提交、最终修复提交 `16fa335`、27 项产品检查、V3 19.16 场景、三层 Definition of Done 和自动化门禁均已闭环；只部署了专用 Test Vault，正式 Vault 未部署。以当前 Git、代码、Run Ledger、Native Execution Store 和新鲜测试为准：

完整逐项验收矩阵见 `docs/implementation/echoink-harness-v3-test-vault-validation.md`。矩阵明确区分 PASS-REAL、PASS-AUTO、PARTIAL、FAIL 和 NOT-VERIFIED；自动化覆盖不再写成实机通过。

- Chat / Editor / Knowledge Controller 不再用具体 backend 分支调度。
- Knowledge Workflow Event 已驱动 UI 进度，`/maintain` 成功报告会写入 EchoInk Ledger 区块。
- 旧 `workspaceResources` 只保留旧设置输入迁移，不再作为运行路径兼容桥。
- Codex Raw 通知只在 `CodexRichNotificationHub` / Driver 内路由，Chat、Editor、Knowledge 通过 Harness 事件和 `awaitResult` 收口。
- 同一 `runId` 并发调用只启动一次 Agent；快速终态不会抢在 Native Execution / Lease 元数据之前提交。
- Codex 中断失败写入明确失败终态，不再假装取消成功；无归属的全局 Codex error 会广播给活跃 Driver。
- EchoInk MCP 调用支持 `AbortSignal`，取消会传到 Broker、HTTP 请求或 stdio 传输。

2026-07-14 main 集成收口：

- 集成分支：`codex/echoink-harness-v3-main-integration`；基线：`main@5f8079d`；7 个领域提交止于 `d4d3ec4`。
- 最终修复提交：`16fa335 fix(integration): 收口 Test Vault 验收缺陷`，修复 OpenCode 参数/空 JSONL、Hermes cleanup 口径、Codex 终态兜底、取消后 fallback、Knowledge 重载与提交顺序、侧栏恢复、滚动吸底和 Tab placeholder。
- 27 项 main 集成验收全部 PASS。完整 Run ID、Native ID、哈希和 UI 阈值见 `docs/implementation/echoink-harness-v3-test-vault-validation.md`。
- Test Vault 最终默认设置已恢复为 Chat `codex-cli`、capability routing `default`、Knowledge `codex-cli`；运行时与 `data.json` 一致。
- Test Vault 部署与仓库构建一致：`main.js` `e8cdfb13ce3c1f3d0cde3f9600f535de15be7ab0892cebedbff1b0ebea0e53d8`，`styles.css` `896197b0f1b756fac7d7a856086bfa9c856b94447cc9c63d243e1f165b77623e`，`manifest.json` `7598c041b480eb926104ebaaf7a284e125d9f28e140d26d235ac30e53e239cb9`。
- `npm run typecheck`、`npm run test`、`npm run build`、`npm run check:public`、`git diff --check` 已在修复后 fresh 通过；`npm run test` 输出 `All tests passed`，public guard 检查 254 个 tracked 文件。

本轮新增完成：

- Knowledge Runtime Controller 改为 runner table，OpenCode / Hermes 走统一 Task Runtime + Harness，不再在 `agent-runner.ts` 按具体 backend 分生产调度。
- `/journal` 主要证据改为 EchoInk 本地会话历史 + Vault 文件变化；Agent Native History 仅作为可选补充。
- Editor UI 预热能力下沉到 `HarnessBackendRuntimeProfile`，`codex-view.ts` 不再直接判断 `codex-cli`。
- Adapter factory 改为注册表式创建，第四个 Agent 可通过外部 registry 接入，不需要修改 Chat / Knowledge Context Core。
- `EchoInkHarnessKernel` 持有单一 `RunOrchestrator`，`runWithAdapter()` 只注册 Adapter 并调用同一个 orchestrator。
- `/maintain` 成功路径会生成同一个 `KnowledgeRunLedger`，并把可审计的 `## EchoInk Ledger` 区块写回 Markdown 报告。
- V3 Lease 策略已有可配置 TTL、maxTurns、contextChars、per-session/per-backend capacity 与 LRU cleanup plan。
- OpenCode leased-conversation、JSONL 主消息聚合、provider/model provenance、进程取消与 not-found 幂等 cleanup 已修复。
- Hermes raw thought 不再冒充 reasoning summary，原生 message delta 按真实能力投影。
- Session Revision 生产递增、全局 Lease LRU、Conversation Store 删除和会话级 Agent 缓存重置均已接入生产路径。
- Memory Candidate 过滤残句、占位符和弱语义候选；Codex / Hermes 新会话均能读取同一份 EchoInk Memory。

## DoD 证据索引

- 唯一 RunOrchestrator：`src/harness/kernel/harness-kernel.ts`，测试护栏在 `src/tests/run-tests.ts`。
- Controller 不直接调用具体 Agent：`src/ui/codex-view/turn-runner.ts`、`src/ui/codex-view/editor-action-runner.ts`、`src/knowledge-base/manager.ts`、`src/knowledge-base/agent-runner.ts` 均有源码护栏。
- 三 Backend Adapter：`src/harness/agents/adapter-factory.ts`、`src/harness/agents/adapters/codex-rich-adapter.ts`、`src/harness/agents/adapters/task-runtime-adapter.ts`、`src/tests/harness-v2/adapters.ts`。
- Session / Context / Lease：`src/harness/kernel/run-orchestrator.ts`、`src/harness/kernel/native-session-lease-manager.ts`、`src/harness/conversation/conversation-store.ts`、`src/tests/harness-v2/session-context.ts`、`src/tests/harness-v2/conversation-store.ts`。
- Resource Plane V2：`src/resources/registry.ts`、`src/resources/vault-resource-catalog.ts`、`src/tests/harness-v2/resources.ts`。
- Knowledge Workflow / Ledger：`src/knowledge-base/manager.ts`、`src/knowledge-base/maintain-report-card.ts`、`src/knowledge-base/report.ts`、`src/workflows/knowledge/ledger/knowledge-run-ledger.ts`。
- Core Policy / Vault Profile：`src/workflows/knowledge/policy/core-policy.ts`、`src/workflows/knowledge/profile/profile-parser.ts`、`src/tests/harness-v2/knowledge-policy-profile.ts`。
- Memory Provider / `.codex-memory` migration preview：`src/harness/memory/file-memory.ts`、`src/tests/harness-v2/memory.ts`、`src/settings/settings-tab.ts`。
- Raw 安全、Evidence、回滚：`src/knowledge-base/raw-integrity.ts`、`src/knowledge-base/digest-evidence.ts`、`src/knowledge-base/transaction-snapshot.ts`，对应回归在 `src/tests/run-tests.ts`。

## 当前完成到哪个 Phase

- Phase 0-1：完成。Harness 合同、ADR、Kernel、Run Ledger、Memory Provider、Resource Resolver、Native Execution / Lease 合同均有代码和测试。
- Phase 2：完成到当前 DoD。Chat / Editor / Knowledge 业务入口调用 Harness / Adapter，后端特性由 runtime profile / adapter factory / session binding 承担。
- Phase 3-4：完成。EchoInk Vault Skill / MCP、Agent Native Skill / MCP、资源来源 UI/日志区分、Conversation Store、Settings history 外置均有代码和测试。
- Phase 5：完成到当前 DoD。Core Policy 从 `LLM-WIKI.md` 抽出，Vault Profile 只承载偏好；Workflow Event 驱动 UI，Ledger 驱动报告卡和 Markdown Ledger 区块。
- Phase 6：完成。Memory Provider 是正式扩展点，初始化和 `.codex-memory` 只读迁移预览已接入。
- Phase 7：完成。FileMemoryProvider 支持候选过滤、冲突与去重、确认、检索、删除/过期、supersede、审计、导出和备份；真实 Test Vault 已验证候选质量、新会话恢复和跨 Agent 读取。
- Phase 8：完成当前清理目标。`managedThreads`、保存态 `threadId`、旧 Knowledge Context Bridge、非 Codex one-shot Chat 旁路、旧 `workspaceResources` 运行桥均已退出。

## 验证记录

本轮已跑并通过：

- `npm run test`
- `npm run typecheck`
- `npm run build`

2026-07-13 测试前检查点 fresh 验证通过：

- `npm run typecheck`
- `npm run test`
- `npm run build`
- `git diff --check`
- `npm run check:public`

2026-07-13 Completion Audit 缺陷记录后再次 fresh 通过：

- `npm run typecheck`
- `npm run test`
- `npm run build`

最终文档修改后再次 fresh 执行 `npm run typecheck`、`npm run test`、`npm run build`、`npm run check:public`、`git diff --check`，五项全部通过。

## 当前集成分支注意

- 分支：`codex/echoink-harness-v3-main-integration`。
- 7 个领域提交和 `16fa335` 修复提交已存在；三份实施文档单独提交为 `docs(harness): 记录 main 集成验收`。
- 每次提交只选择性暂存约定文件；禁止 `git add .`。参考文档、Test Vault 数据、运行存储、构建产物和两份被忽略计划不进入提交。
- `docs/architecture/` 与 `docs/**/*plan*.md` 受 `.gitignore` 影响；不要误以为未跟踪计划文件会自动进入 Git。

## 剩余风险

- Harness 2.0 / V3 当前无阻塞性遗留项。历史缺陷 `HV3-MEM-001` 至 `HV3-OPEN-004` 均在验收矩阵中保留首次发现和最终闭环证据。
- Codex 只声明并执行 archive，不把 archive 写成 delete；Hermes 无清理能力时明确返回 unsupported；OpenCode 仅在同 device / vault 上按真实 delete 能力处置。
- 本地提交失败、跨设备 Binding 和插件重载中断仍采取保守保留策略，这是合同要求，不是未完成缺陷。
- 两份计划文件受 `.gitignore` 影响，已经更新最终勾选但按用户要求不暂存、不提交；Git 中的完成证据以本 progress、implementation log、验收矩阵、代码和测试为准。
