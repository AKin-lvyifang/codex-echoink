# EchoInk Harness 记录生命周期进度

更新时间：2026-07-20

## 当前结论

正式方案、ADR、Phase 0 只读盘点和 Phase 1 自动化实现已经完成。Phase 2 第一批
基础设施已提交为 `b2db2f5`：Conversation V2、Workflow/Attempt Run Record、
Conversation mutation lane、RecordMutation Journal/Trash/Recovery，以及终态提交失败
后的显式 UI 恢复门禁。它们已经通过当前全量测试和 typecheck，但仍是
side-by-side 基础设施，尚未接管生产 reader/writer，也没有连接任何真实删除路径。

第二批建立 Root Registry，能把逻辑 `rootId` 绑定到
registry、canonical path digest、owner boundary、目录 dev/inode 与不可变 digest；
同绑定可幂等加载，不同物理目录不能复用同一 ID。首次 chain 以包含首条 entry 的
完整 staging 目录原子发布，不再向同版本 writer 暴露空 claim；旧版本遗留的空
claim 仍可恢复。

第三批已把完整 Root Binding 引用冻结进 destructive intent、prepared/finalization
Trash receipt 与 recovery evidence。引用不仅包含逻辑 `rootId`，还包含
registry、authority、root/boundary digest、目录 dev/inode、revision 和 binding
digest；跨层 ref 缺失、乱序或不一致都 fail closed。这一批已提交为 `ab1a061`。

第四批已实现 side-by-side RecordMutation coordinator。前向删除固定为：取得
storage root 下唯一的 durable 全局 authority、预检两份 Root Binding、建立可恢复
Trash、写入 Journal `trash-staged`、重新读取 Registry 与物理目录，再退休 source
并写入 `source-retired`。补偿必须先有 durable `compensation-prepared`，然后在
同一 authority 下重新验证 Root Binding、执行 no-clobber restore，最后写入
`trash-restored`。目录重建、source/trash root 重叠、损坏 lock、授权缺失和 receipt
不一致都会 fail closed；死亡进程留下的 stale lock 可隔离后恢复。

第五批把 RecordMutation schema 升为 V2，并新增 production recovery runner。
Intent 现在同时冻结变更前的 Conversation generation、commit ID、content revision，
以及目标 Conversation 或删除 tombstone；Recovery Evidence 保存实际 readback，
再由纯函数判定 `exact-target / before-target / contradictory / unknown`，不再接受
调用方直接声称 `exact-target`。Runner 对 destructive participant 先在全局
authority 下检查 durable receipt、Registry、物理 Root 与 Trash content，再经
coordinator roll-forward 或 restore。Memory/Artifact 的 `mark-source-deleted`
adapter 已通过正式 Store transaction 与 append-only lifecycle chain 实现；缺失、
错序或无法证明 lineage 的 adapter 会明确 blocked。
Recovery API 要求整轮通过 `withConversationMutation`，生产接线必须使用产品写入的
同一 authority。Runner 在 effect 前、Journal 终态发布前重复读回 Conversation；
证据发生变化时保留可恢复的 staged Journal，不以旧 observation 收口。

第六批已经把两类非破坏性产品操作接入 live Journal：
`start-new-context` 与 `agent-cache-reset` 都必须先 stage Journal，之后才允许登记
Native retirement 或提交 Conversation。Conversation 提交后，runner 在同一枚
不可伪造、回调结束即失效的 Conversation authority 下读回并提交/中止 Journal；
只有 committed Journal 与 exact Conversation target 同时可证明时，Native
retirement 才能 promotion。启动恢复先收口非终态 Journal，再处理 Native；Journal
非终态、损坏、错绑或 reader 缺失会关闭全局 cleanup gate。两类操作同时禁止借
`mutate` 改写 durable Conversation 记录。

破坏性操作的 Conversation 正式 reader/writer 第一批已经实现，但产品 guard 仍然
关闭：

- `clear-conversation-records` 先冻结全部旧 payload source（包括 active、
  previous 与恢复 orphan），再提交新的空 payload/context；旧 payload 不走普通
  GC，也不写入 `previousPayloadKey`，必须留给后续 Journal/Trash participant 收口。
- `delete-conversation` 以独立 deletion tombstone 作为删除 target 的 durable
  commit marker。tombstone 提交后，Conversation reader 不再返回旧会话，但旧
  session 目录继续保留，等待 Journal 在完整参与者证明后退休。
- 启动 reconciliation 会以 tombstone 排除已删除 Conversation，并修复 tombstone
  已提交但 index projection 尚未更新的崩溃窗口；`data.json` 的旧 shell 同步移除，
  不会把已删除 Conversation 复活。
- 当前 worktree 已建立不可变 participant execution plan、prepare-only Trash
  coordinator、正式 production root catalog 与破坏性启动恢复。plan 在第一个
  Journal stage 前发布，绑定 intent digest、完整 participant、逻辑 Root、相对
  source path 以及 Memory/Artifact subject identity，不保存绝对路径。启动恢复
  能从 plan 重建 Root、Trash receipt 与正式 adapter；缺失、损坏、晚建、Root/
  subject 错绑全部在 effect 前阻断。
- 当前 worktree 已新增 Conversation 级严格只读 inventory：
  - Run Store 会扫描全部正式 subject，验证 Workflow→Attempt→payload 所有权、
    head/manifest/generation 和 payload bytes，并提取显式 Raw owner；漏挂、
    未知 entry、损坏 chain 或扫描期间漂移都会阻断。
  - Memory existing-store snapshot 不初始化 Store、不迁移旧 index、不修复
    projection，且会把 pending journal 与未收口 transaction 一并纳入 blocker。
  - Artifact inventory 严格扫描全部 append-only chain；缺 Store 返回空，不会
    创建 namespace，未知 chain/staging/lineage 损坏 fail closed。
  - Raw owner graph 合并全部 Conversation message 与全部 Run payload owner，
    只按目录项和 stat 建快照，不读取或散列正文；shared Raw 固定 retain，
    exclusive Raw 才能进入 discard 选择。
  - pending confirmation 与正式 Artifact 必须有显式 retain 选择，不能被
    Conversation 删除静默处置。
- 当前开发批次已实现 Workflow Run payload source-deletion adapter。正式
  `user-deleted` tombstone 在原 payload generation 被 Trash 退休后仍保持
  `expired` authority；补偿先恢复 Trash source，再发布新的 active payload
  generation。forward/restore 的 manifest-link 崩溃窗口可恢复，production
  adapter factory 已能从 execution plan 的冻结 subject 重建 adapter。
- Execution Plan schema 已升级为 V2，支持 `retain-bundle`、`trash-bundle` 与
  `source-deletion-bundle`。每个 bundle 绑定共同的 inventory selection digest、
  frozen Root 和完整有序叶子；retain 叶子保存可回读的 Run digest 或 Raw
  identity/path/owner proof。重复逻辑组、Run source-deletion/Trash 覆盖不一致、
  超过 16,384 条的单组和超过 8 MiB 的 plan 都在 Journal stage 前整体阻断。
- 新增 Conversation mutation planner，把 ready unified inventory、Conversation
  source 和精确 Root Binding 编译为确定性 intent 与 execution participants。
  40 个 Workflow Run 的夹具包含 127 条唯一记录，只生成 8 个逻辑 participant；
  输入逆序结果保持一致。blocked inventory、缺失 Attempt summary、重复 source、
  跨 Conversation source、Root 缺失、selection 漂移和拆组绕过容量均有失败回归。
- Trash、source-deletion 与 retain bundle 已接入 materializer。retain bundle
  会在首次 Trash prepare 前连续重建两次 unified inventory，用冻结选择重新编译
  完整计划，并依次发布绑定 mutation、intent、plan、participant、subjects 与
  Root 的 `prepared` evidence；全部 retain proof 必须先于第一条
  `trash-staged`。proof 缺失、伪造、Root 漂移或 owner graph 变化均 fail closed。
  启动恢复在同一 Conversation mutation authority 内完成 materialize 与 runner；
  tombstone 已提交时可复用完整 proof，不会重新依赖已删除的 live Conversation。
  live clear/delete runner、Conversation target commit 与 Native retirement
  仍未接入，因此当前 checkpoint 仍不代表用户删除已经安全可用。

真实 Vault 的 Phase 0 metadata-only 报告仍为 `blocked`：现有数据包含 Raw 失联
引用和旧 Run 结算缺口。Phase 1 没有修改这些历史记录，也没有执行真实历史删除、
Native 批量 cleanup、retention 清理或 Vault 迁移。Phase 2 必须继续建立数据治理、
迁移预览和恢复合同，不能把 Phase 1 的绿灯解释为允许清理真实数据。

本轮独立复核发现并修复了一个 UI 恢复旁路：`recoveryRequired` 原先只保存在
View 内存中；若插件启动时自动恢复失败，持久化终态标记仍在，但重新打开 View
不会恢复门禁。现在 View 在首次渲染前会从
`runTerminalRecoveryPending/echoInkRunTerminalRecovery` 重建门禁；缺损的持久化
authority 也按 fail closed 处理。

本任务分支：

- 分支：`codex/harness-record-lifecycle`
- Worktree：`/private/tmp/codex-harness-record-lifecycle`
- 创建基线：`main@a91f1b8`
- 已同步主线：`main@d4d4ec4`
- Phase 2 基础 checkpoint：`b2db2f5`
- Root Registry checkpoint：`e510349`
- 跨层 Root Binding Ref checkpoint：`ab1a061`
- 当前已提交批次：RecordMutation schema V2 与 production recovery runner
- Memory/Artifact participant checkpoint：`c90ebeb`
- 非破坏性 Live Journal checkpoint：`1bd72af`
- 破坏性 Conversation reader/writer checkpoint：`67719de`
- Participant execution plan / production root checkpoint：`d683b10`
- Conversation 统一 inventory checkpoint：`7f1b841`
- Workflow Run payload source-deletion checkpoint：`d27c56a`
- Deterministic bundle planning checkpoint：`92ea4db`
- Trash bundle runtime checkpoint：`5ce326d`
- Source-deletion bundle runtime checkpoint：`8a72e6e`
- 当前开发批次：`retain-bundle` unified inventory 二次复验、prepared proof、
  Root 再验证与 destructive startup recovery
- 下一批次：live clear/delete runner、Conversation target commit 和
  Native retirement

项目开发记忆已切到本机 `codex-memory` V2：

- `schema_version=2`
- `layout_mode=compat-v1`
- `project_id=dd0b8209-1272-4f70-a402-630de403e5d1`
- `auto_sync=true`；V2 Hook 持续整理，最近核对时无未完成 transaction
- 旧 `.codex-memory` Markdown 保留，没有被迁移器覆盖或删除

这套本机 V2 只记录开发进度，与 EchoInk 插件内置 Memory V2 分开验收。

## 阶段状态

| Phase | 状态 | 当前证据 | 下一门禁 |
| --- | --- | --- | --- |
| 文档与决策 | 已完成 | ADR 0005、主计划与 `ae4ec4b` 文档提交 | 随代码行为持续校准 |
| Phase 0：inventory / dry-run | 已完成并提交 | `f362a59`、fixture、真实 Vault 双次 dry-run 与稳定 fingerprint | 保持只读基线，不执行自动修复 |
| Phase 1：Context / Native lifecycle | 已完成并提交 | 统一 rotation、commit/recovery、Native cleanup、三后端 Editor/Knowledge/Utility 接线与当前全量门禁 | 进入 Phase 2 |
| Phase 2：数据治理 | 进行中 | `b2db2f5`、`e510349`、`ab1a061`、`5091493`、`661327f`、`c90ebeb`、`1bd72af`、`67719de`、`d683b10`、`7f1b841`、`d27c56a`、`92ea4db`、`5ce326d`、`8a72e6e`；当前 worktree 正在收口 retain bundle | live 清空/删除、Conversation target commit 与 Native retirement |
| Phase 3：Backend capability | 未开始 | Codex/OpenCode 当前能力已核对；Hermes 保守为 unsupported | Phase 2 schema 稳定 |
| Phase 4：迁移与实机验收 | 未开始 | Phase 0 已证明只读基线；尚未部署或修改真实数据 | 备份、side-by-side、用户确认 |

## 已确认决定

- EchoInk Conversation 是跨后端唯一对话真源。
- Codex thread、OpenCode session、Hermes run/session 是短期 Native Execution。
- Chat 与 `knowledge.ask` 可使用有界 lease；结构化任务和 Editor 按 attempt/phase 隔离。
- 本地 durable commit 先于 Native cleanup；cleanup 失败不改变业务结果。
- `/clear` 的产品语义是“开启新上下文”，不是删除历史。
- Run payload 默认 30 天，Run summary 默认 90 天；恢复证据不参与普通 retention。
- Native cleanup 最多自动尝试 6 次，之后 quarantine；队列必须保障新任务公平性。
- Provider endpoint 的 Native identity 只保留安全 origin、内部 sentinel 或
  `endpoint-sha256`；不得把凭据、scope、query、fragment 或未知 opaque token
  写入 Native Store。
- Hermes ACP 返回的 session 必须按真实
  `session / provider-persistent / acp-stdio` descriptor 登记；成功路径缺少登记
  callback 时 fail closed，不能退回模糊 `run / unknown`。
- Phase 0 的 `snapshotFingerprint` 只覆盖目录项与 record metadata 等结构信息，
  不读取或散列 Raw 正文字节。
- Conversation 清空或删除必须逐类处理 formal active、pending/unresolved 与
  pending journal Memory；状态不明时 fail closed。
- 本地 mutation 与 Native cleanup 是正交状态；启动恢复同时对账
  `awaiting-local-commit` 和 pending 记录，cleanup 失败不反转业务成功。
- Agent-native Memory 不属于精确 session cleanup 的范围。

## 迁移阻断项

- 真实报告有 129 个 blocking findings：1 个 Raw 引用缺少正文、64 个 Run
  缺少 terminal、64 个由 Native `localCommit=committed` 反查出的 Run
  local-commit 证据缺口。迁移必须保持 `blocked`。
- Native Store 有 64 个 cleanup backlog，并已达到 quarantine candidate 条件；
  这些记录只能在 Phase 1/2 建立有限重试、恢复证据和公平队列后治理。
- 10 个持久 Conversation 未被 `data.json` 选择；这是待归属数据，不是可自动删除
  的孤儿。
- OpenCode 的 1 个 linked record 和 Hermes 的 2 个 linked records 只能部分核验。
  查无记录保持 ambiguous；Hermes `run` 与本机 `session` 类型不一致时也不得判 missing。
- 当前 V2 Hook 不按 Git common-dir 自动识别临时 worktree；本任务线程继续绑定
  主仓库，只从主根触发 V2。
- 旧 `.codex-memory/spec/knowledge-base-thread-lifecycle.md` 的“普通 Chat 原生
  thread 必须永久保留 resume”已被 ADR 0005 替代，但迁移保留的旧文件还需由
  V2 记忆整理流程标记 superseded。
- retention 会改变现有 Archive Catalog “完整本地记录可查”的范围，Phase 2
  必须同步产品 copy 和检索降级。

## Phase 2 生产接线阻断项

- Conversation V2、Run Record 与 destructive RecordMutation 仍主要是
  side-by-side 基础设施；legacy reader/writer 尚未切换，不能把两类非破坏操作的
  live Journal 接线写成生产数据已迁移。
- destructive intent、prepared/finalization Trash receipt 与 recovery evidence
  已冻结完整 Root Binding Ref；全局 lock/coordinator 与 production recovery
  runner 已建立安全执行入口；`start-new-context` 与 `agent-cache-reset` 已接入，
  `clear-conversation-records` 与 `delete-conversation` 仍未接入。
- `finalizeRecordMutationTrash()` 仍是低层原语。架构门禁现已把生产 source
  retirement 调用限制在 `record-mutation-coordinator.ts`；唯一直接 restore 旁路
  仍为 `fixtureOnly`，并强制位于系统临时目录。调用方接线完成前，产品删除 guard
  继续关闭。
- Production runner 已能通过正式 adapter 处理 Memory/Artifact
  `mark-source-deleted` 的 forward、compensation、崩溃重放与 terminal proof；
  adapter 缺失或不完整时仍返回 `participant-adapter-required`。启动恢复已能从
  immutable execution plan 和 production root catalog 重建这些 adapter，但两类
  破坏性产品操作尚未完成 Run/Raw/Memory/Artifact 的真实枚举与选择，因此产品
  删除 guard 继续关闭。
- execution plan 必须在第一个 Journal stage 前耐久发布；它只冻结逻辑 Root ID、
  相对路径和 subject identity，不保存绝对路径。Root/adapter 错绑会在 prepare
  前失败。prepare-only coordinator 只写 durable Trash 与 `trash-staged`，不会
  退休 source；启动恢复可幂等重建 receipt 后再由 Runner 决定 forward/compensate。
- retain bundle 已建立首次 destructive prepare 前的完整 inventory 二次复验、
  确定性 `prepared` evidence、物理 Root 再验证和重启复用；这只证明冻结选择不会
  被 materializer 静默绕过，尚未代替 live runner 的 Conversation target CAS、
  Native retirement 和用户收据。
- Memory adapter 通过正式 index transaction 保存 Conversation lineage 与
  source-deleted/restored transaction proof；Artifact adapter 通过独立 append-only
  lifecycle chain 保存同类证明。两者都是 side-by-side 基础设施，尚未代表 legacy
  reader/writer 已切换。
- Node 没有暴露 `openat/unlinkat/renameat2 no-replace`；当前安全声明只覆盖
  canonical、插件自有 root 和使用同版本协议的协作 writer，不能宣称抵御旧版
  writer 混跑，或同权限外部进程制造的最后一个 syscall 竞态。

## 已知非阻断债务

- History `days` 中的非 object 元素尚未单独报 corrupt；Run Ledger 仍兼容缺少
  `eventId` 的旧事件。这两项必须在迁移 schema 冻结前决定兼容或阻断策略。
- Settings/History 已覆盖逐写点失败和 fresh restart，但尚未用真实进程 kill 做
  每个原子写点的崩溃注入。
- Editor 产品入口已覆盖默认生产表达式和真实 Kernel，但组合测试通过窄 adapter
  builder seam 注入 runtime；默认 runtime factory 与真实 Native Manager 的各自
  合同由独立套件覆盖，尚无一个端到端进程级组合夹具。
- Editor terminal receipt 已按 run ID、事件类型、backend 和 payload fail closed；
  当前回归覆盖提交抛错，尚未逐项注入四类错误 receipt。
- `--format both` 采用 Markdown 先落盘、JSON 最后作为 commit marker 的逐文件
  原子协议；后续可升级为 generation 目录加原子 manifest，消除中途失败时的新旧
  双文件组合。
- `vault` scope 的 Provider cwd 归属仍是词法比较，可能漏掉大小写或 symlink
  别名；它只影响“待归属候选”枚举，不会产生 missing 或自动 cleanup。

## 下一检查点

1. 提交 retain bundle 的 unified inventory 复验与启动恢复 checkpoint；随后
   接入 live clear/delete runner、Conversation target CAS 与 Native retirement。
2. 接入 History 引用投影、Raw owner graph/GC
   preview、migration validator 与 V2 → V1 exporter。
3. 继续保持真实 Vault migration `blocked`；Phase 4 与用户单独确认前不执行
   历史删除、retention、Raw GC 或批量 Native cleanup。

## 当前验证

Phase 2 基础 checkpoint `b2db2f5` 已通过：

- `npm run test`，输出 `All tests passed`
- `npm run typecheck`
- `npm run build`
- `npm run lint`，961 个 finding 与 baseline 完全一致，无新增 finding
- `npm run check:release`
- `npm run check:public`，明确暂存后检查 390 个 tracked files 并通过
- Conversation V2、Run Record、RecordMutation Journal/Trash/Recovery、
  context rotation、Knowledge turn、Native binding replacement、
  surface settlement 与 Chat UI focused suites
- `git diff --check`

本轮新增的重启恢复门禁已同时通过 `surface-run-settlement` focused suite 和
全量测试。Watchdog 持久化失败日志是故障注入的预期输出。

上述 checkpoint 已提交。其后的 Root Registry 批次目前已通过：

- Root Registry focused suite
- RecordMutation Journal 与 Trash focused suites
- `npm run test`，输出 `All tests passed`
- `npm run typecheck`
- `npm run build`
- `npm run lint`，961 个 finding 与 baseline 完全一致
- `npm run check:release`
- `npm run check:public`，明确暂存后检查 393 个 tracked files 并通过
- 目标生产文件 ESLint
- `git diff --check`

这一批的验证证据绑定提交前 staged tree；后续修改必须重新运行相应门禁。

跨层 Root Binding Ref 批次已通过：

- RecordMutation Journal/Trash/Recovery 与 Root Registry focused suites
- `npm run test`，输出 `All tests passed`
- `npm run typecheck`
- `npm run build`
- `npm run lint`，961 个 finding 与 baseline 完全一致
- `npm run check:release`
- `npm run check:public`，明确暂存后检查 394 个 tracked files 并通过
- 目标生产文件 ESLint
- `git diff --check`

全局 RecordMutation coordinator 批次当前已通过：

- Coordinator focused suite：前向授权顺序、全局串行、stale/corrupt lock、
  root 重叠、目录重建、finalize/restore 崩溃重放
- Architecture focused suite：生产 finalize 只能调用 coordinator；直接 restore
  旁路仍限制为临时目录 fixture
- `npm run test`，输出 `All tests passed`
- `npm run typecheck`
- `npm run build`
- `npm run lint`，961 个 finding 与 baseline 完全一致，无新增 finding
- 目标生产文件 ESLint，0 finding
- `git diff --check`

最终明确暂存 8 个预期文件后，`npm run check:release` 与
`npm run check:public` 也已通过；public guard 检查 396 个 tracked files。暂存区
不含 `.codex-memory`、`node_modules` 或其他无关文件。

RecordMutation schema V2 与 production recovery runner 批次当前已通过：

- Intent before/target proof 与 Conversation observation classifier focused suite
- Production runner focused suite：非破坏操作 roll-forward/compensate、删除
  roll-forward/restore、Conversation authority 串行、终态前 drift blocked、
  contradictory readback、Root 重建 blocked
- Architecture focused suite：产品 recovery decision 必须经过 production runner
- `npm run test`，输出 `All tests passed`
- `npm run typecheck`
- `npm run build`
- `npm run lint`，961 个 finding 与 baseline 完全一致
- 目标生产文件 ESLint，0 finding
- `git diff --check`
- `npm run check:release`
- `npm run check:public`，检查 398 个 tracked files

这一批已提交为 `661327f`；提交前暂存区核对为 15 个预期文件，不含共享软链接
或无关内容。

Memory/Artifact source-deletion participant adapter 批次当前已通过：

- Memory + Artifact exact-target roll-forward、before-target compensation 与
  committed/aborted terminal noop proof
- Memory formal Store 已写 index、Journal 尚未记账的崩溃重放；重放不重复 marker
- 缺 adapter、Root 重建、正式 Memory Store 缺失、Memory lineage 缺失均在 effect
  前 blocked；缺失正式 Store 不会被初始化为空 Store
- Memory lineage 更新合并旧来源与新来源，并强制唯一、稳定排序
- Artifact 注册冲突、restore 幂等、revision chain 损坏与 lineage 不完整 fail closed
- 架构门禁：participant coordinator 的 production caller 只能是 recovery runner
- participant focused suite、`npm run test`、`npm run typecheck`、`npm run build`
- `npm run lint`，961 个 finding 与 baseline 完全一致
- 新增 production 文件及 recovery runner 目标 ESLint，0 finding
- `git diff --check`
- 明确暂存 17 个预期文件后，`npm run check:release` 与
  `npm run check:public` 通过；public guard 检查 402 个 tracked files

本批次已提交为 `c90ebeb`；提交树不含 `.codex-memory` 与 `node_modules` 两个
共享软链接。

非破坏性 live Journal 与 Native promotion authority 批次当前已通过：

- Conversation authority forged/cross-conversation/expired 反例
- Context Rotation 与 UI lifecycle focused suites：Journal stage → Native
  register → Conversation commit → Journal settle → promotion/cleanup
- on-disk crash recovery：stage 后未 commit 自动 abort；Conversation commit 后
  未写 Journal terminal 自动 roll-forward；重复启动恢复为 no-op
- Native startup focused suite：committed/exact 才 promotion，aborted/before
  才 abort，非终态或错绑 Journal 在 cleanup 前关闭门禁
- Live promotion focused suite：缺 reader、非 committed 或错绑 Journal 在整个
  batch 的第一个 Native transition 前失败
- Architecture focused suite：under-authority runner 只有 runner façade 与
  Settings Store 生产调用点
- `npm run test`，输出 `All tests passed`
- `npm run typecheck`
- `npm run build`
- `npm run lint`，961 个 finding 与 baseline 完全一致，无新增 finding
- 本批直接改动且无历史 baseline finding 的 8 个生产文件目标 ESLint，0 finding
- `git diff --check`
- `npm run check:release`
- `npm run check:public`，检查 402 个 tracked files

`.codex-memory` 和 `node_modules` 两个共享软链接保持 untracked，后续明确暂存时
必须继续排除。

Participant execution plan 与破坏性启动恢复批次当前已通过：

- execution plan 原子发布、重启加载、晚建阻断、Root 精确覆盖、非法相对路径、
  digest/subject 错绑与绝对路径不落盘
- execution runtime 跨重启 materialize、Root/adapter 错绑 effect 前阻断、
  prepare receipt 幂等重放且 source 保持原位
- production root catalog：Conversation/Run/Raw/Memory/Artifact/Trash 稳定 ID，
  Memory Root 缺失时不初始化空 Store
- Settings startup 真实目录崩溃夹具：deletion tombstone 已提交而 Trash 未
  prepare 时，重启可补齐 prepare、退休旧 session 并提交 Journal
- Memory formal/confirmation state 与 Artifact kind 漂移反例
- `npm run test`，输出 `All tests passed`
- `npm run typecheck`
- `npm run build`
- `npm run lint`，961 个 finding 与 baseline 完全一致，无新增 finding
- 新增 production 文件目标 ESLint，0 finding
- `git diff --check`
- `npm run check:release`
- 明确暂存 18 个预期文件后，`npm run check:public` 检查 408 个 tracked files

本批次尚待提交；暂存区不含 `.codex-memory` 与 `node_modules` 两个共享软链接。

真实 Vault 双次 dry-run 得到相同结果：

- `reportId=storage-inventory-f1a57a97ac7125141db10d86`
- `snapshotFingerprint=sha256:f1a57a97ac7125141db10d860780e7eb35ffdbf1cc20cc51427274e523294002`
- 运行前后插件目录均为 286 个结构条目，metadata 摘要完全一致
- `actionsApplied=0`、`deletionsApplied=0`、`rawBodiesRead=false`
- 第二次运行的 `generatedAt` 不同，但 report ID 和 fingerprint 不变

Phase 0、Phase 1 与 `b2db2f5` 的 public guard 都已在各自明确暂存状态下复验。

## Trash bundle runtime（已提交）

Trash bundle 已从 execution plan 接入正式 coordinator、materializer 与 production
recovery runner。每个叶子继续使用独立的 durable Trash prepare/finalization
receipt；bundle prepared/finalization receipt 只由完整有序的逐叶 receipt 推导，
不新增一份可漂移的聚合存储。

当前实现遵守以下发布边界：

- 所有叶子 prepare 并稳定回读后，Journal 才追加一次 aggregate `trash-staged`。
- 所有叶子 retirement 完成后，Journal 才追加一次 aggregate `source-retired`。
- 部分 prepare、部分 retirement 或部分 restore 崩溃后，重启按 durable leaf
  receipt 幂等补齐；Journal 不发布部分 aggregate 成功。
- compensation 先用 aggregate prepared digest 记录
  `compensation-prepared`，所有叶子恢复完成后再追加一次 `trash-restored`。
- 每个叶子 effect 前重新验证当前物理 Root Binding。selection digest、完整
  items、source/trash Root 与 participant ID 必须一致；逐叶 evidence 重排、
  digest 漂移、重复路径或父子嵌套路径都会在 effect 前阻断。

execution materializer 现在可以跨重启重建 `trash-bundle` recovery participant；
production runner 可以对整组执行 roll-forward，或先补齐部分 retirement 再整组
restore。该批次已提交为 `5ce326d`。

本轮当前证据：

- coordinator、execution plan、execution runtime 与 recovery runner focused
  suites 通过
- `npm run test`，输出 `All tests passed`
- `npm run typecheck` 通过
- `npm run build` 通过
- `npm run lint` 通过，961 个 finding 与 baseline 完全一致，无新增 finding
- 本轮修改的 production 文件定向 ESLint 为 0 finding
- `git diff --check` 通过

明确暂存 11 个预期文件后，`npm run check:release` 与
`npm run check:public` 通过；public guard 检查 414 个 tracked files，暂存区不含
共享 `.codex-memory`、`node_modules` 或无关文件。没有部署或修改真实 Vault，也
没有执行 migration、retention、Raw GC、历史删除或 Native cleanup。

## Source-deletion bundle runtime（已提交）

Run、Memory 与 Artifact 的 `source-deletion-bundle` 现在使用一个逻辑 Journal
participant 协调完整有序的逐叶 Store adapter。每个叶子仍保存原有 durable
forward/restore receipt；aggregate receipt 只由 frozen subject、selection digest、
Root Binding 和全部逐叶 receipt digest 确定性推导，不创建第二份聚合 Store。

当前实现遵守以下恢复边界：

- 全部叶子 forward 并稳定回读后，Journal 才追加一次 aggregate
  `participant-staged`；部分 forward 崩溃不会发布聚合成功，重启只补齐缺失叶子。
- compensation 只接受与 aggregate forward digest 一致的
  `compensation-prepared`；全部叶子 restore 后才追加一次 aggregate
  `participant-restored`。
- 叶子全部恢复但 aggregate Journal 尚未发布的崩溃窗口可以重放；已有完整
  forward proof 的 partial restore 继续按 source-deleted 聚合态补齐剩余叶子。
- 每个叶子 recover、inspect、forward 与 restore 前后都重新验证 frozen Root
  Binding。selection、subject 顺序、语义叶子 ID、adapter Root 或 participant ID
  漂移会在首个叶子 effect 前阻断。
- production factory 会为 Run 使用 `workflowRunId + attemptId` 的正式叶子 ID，
  为 Memory/Artifact 使用正式 record ID，再构造 logical bundle adapter；
  materializer 已不再阻断 `source-deletion-bundle`。

该批次已提交为 `8a72e6e`。对应 focused suites、全量测试、typecheck、build、
baseline lint、修改生产文件定向 ESLint、`git diff --check`、release contract 与
public guard 均已通过；本批没有部署或修改真实 Vault。

## Retain bundle runtime 与统一选择复验（当前开发批次）

`retain-bundle` 不执行删除，但它证明“本轮明确保留的 Run summary、Attempt
summary、expired/not-captured payload 状态与 shared Raw owner graph”仍与最初
冻结的选择一致。当前实现固定为：

- 首次 destructive preparation 前连续生成两次完整 Conversation inventory，
  从 execution plan 恢复 Memory/Artifact 处置选择和 Conversation source，再用
  planner 重新编译；snapshot、intent、participants、selection digest 和 runtime
  Root 集合必须全部同序一致。
- 复验成功后才为每个 retain bundle 依次写入 `prepared` evidence；evidence 绑定
  mutation、intent、execution plan、participant、完整 subjects 与 Root Binding，
  且全部 retain proof 必须排在第一条 `trash-staged` 之前。
- proof 发布前重新读取 Registry 并验证 retain Root 的当前物理 binding。verifier
  抛错、owner graph 漂移、Root 替换、伪造 evidence，或 Trash 已 stage 但 proof
  缺失都会在 Trash/Store effect 前阻断。
- materializer 会先重载 durable Journal；调用方持有旧 snapshot 时仍能复用已经
  发布的合法 proof。多个 retain bundle 的部分 checkpoint 可重入，完整 proof
  存在时不会再次依赖 live inventory。
- destructive startup recovery 现在在同一 Conversation mutation authority 中
  完成 plan load、Root materialize、retain proof 处理与 recovery runner。删除
  tombstone 已提交、目标 Conversation 已从 data shell 移除时，完整 proof 可直接
  复用；proof 不完整则明确阻断。

当前 focused execution-runtime、Conversation inventory 与 Conversation Store
startup suites 已经通过；最终工作树的 `npm run test` 输出 `All tests passed`，
typecheck、build、baseline lint 和 `git diff --check` 通过。完整 lint 仍为 961 个
历史 finding、无新增；两个新增/修改的 Harness 生产文件定向 ESLint 为 0。
明确暂存 10 个预期文件后，release contract 与 public guard 通过，public guard
检查 417 个 tracked files；共享 `.codex-memory` 与 `node_modules` 软链接未暂存。
产品 guard 继续关闭；live clear/delete runner、Conversation target commit、
Native retirement、retention/GC 和真实迁移尚未接线。本批没有部署或修改真实
Vault。
