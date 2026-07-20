# EchoInk Harness 记录生命周期进度

更新时间：2026-07-20

## 当前结论

正式方案、ADR、Phase 0 只读盘点和 Phase 1 自动化实现已经完成。Phase 2 第一批
基础设施已提交为 `b2db2f5`：Conversation V2、Workflow/Attempt Run Record、
Conversation mutation lane、RecordMutation Journal/Trash/Recovery，以及终态提交失败
后的显式 UI 恢复门禁。后续批次已经在这些 side-by-side 合同上接通正式
Conversation clear/delete 路径，并以 `3b1ca7f` 提交 reference-only Knowledge
History V2 与对应 Storage Inventory 扫描；`f1b4caf` 又提交 metadata-only Raw
GC preview。`48264d6` 已提交跨 Store Run Record retention 的逻辑过期、稳定
恢复证据和可重放 Journal，`03201f0` 又完成 payload generation 的可恢复物理退休
与生产启动恢复，`b82df37` 完成 Raw quarantine、七天隔离、第二次完整 owner scan
与可恢复永久 purge，`3c7a10f` 又提交 Migration Validator、Conversation V2
deletion authority、History 首次迁移完整对账和 active V2 reader。自动创建新
retention sweep 或 Raw GC transaction 仍未接入维护调度。当前批次继续实现并验证
side-by-side V2→V1 exporter 和 V2→V1→V2 portable ledger 回迁夹具；reverse
activation、真实 owner Store proof、真实迁移和全量生产 writer cutover 仍未完成。

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

破坏性操作的 Conversation 正式 reader/writer 与 live 产品入口已经接通：

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
- live clear/delete coordinator 会在同一 Conversation mutation authority 内完成
  双次稳定 inventory、Root/plan/Journal/Trash、Conversation target CAS、Store
  readback recovery、Native retirement 与 `data.json` 投影。删除会话 UI 已启用，
  普通会话右键菜单新增“清空会话记录”；取消或 preview blocker 不创建 mutation。
- Memory/Artifact 在会话操作中只允许显式保留并追加来源变化标记。需要丢弃时必须
  先在正式 Memory 或产物管理中单独处理，不能由会话删除静默代替。
- Storage Inventory 已把 `record-mutations` 作为第七个正式来源。deleted Native
  retirement 只有同时匹配 deletion tombstone、committed Journal 和 source/target
  identity 才可关联；aborted Journal 只有在 Conversation 精确恢复且 retirement
  已 aborted 时才视为一致。

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
- Retain bundle / destructive startup recovery checkpoint：`63ce8b0`
- Live clear/delete coordinator checkpoint：`148e686`
- Knowledge History V2 / Inventory checkpoint：`3b1ca7f`
- Raw GC preview checkpoint：`f1b4caf`
- Run Record retention checkpoint：`48264d6`
- Run payload retirement checkpoint：`03201f0`
- Raw quarantine / permanent purge checkpoint：`b82df37`
- Migration Validator / Deletion authority / History cutover checkpoint：
  `3c7a10f`
- 当前批次：不可变 V2→V1 export generation、plan-bound restore writer 与
  V2→V1→V2 portable ledger 回迁夹具
- 下一批次：reverse activation、精确 reader route 与剩余 owner Store proof

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
| Phase 2：数据治理 | 进行中 | `b2db2f5` 至 `3c7a10f`，以及本批 V2→V1 exporter；live clear/delete、History V2、Run payload 可恢复物理退休、Raw 七天隔离/二次 owner scan、validated migration 与既有 transaction 启动恢复 | reverse activation、真实 owner Store proof、真实 dry-run 与自动调度授权 |
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
- Archive Catalog 与设置文案已按 retention 合同改为“仅保留期内可查”，并区分
  `expired`、`missing` 与 `corrupt`。生产 Run reader 与既有 retention sweep
  启动恢复已经接线；自动创建新 sweep 仍未获得调度授权。

## Phase 2 剩余生产门禁

- Conversation V2、Run Record 与 RecordMutation 仍保留 side-by-side 迁移边界；
  clear/delete 已使用正式 V2 authority，但不能据此声称全量 legacy reader/writer
  已 cutover 或真实数据已迁移。
- Run Record retention 已建立 30 天 payload、90 天 summary 的双次稳定只读
  preview、生产 recovery-evidence authority、不可变 plan 与 append-only
  Journal。payload action 固定执行
  `trash-prepared → tombstone-published → source-retired`，随后才能处理 Attempt
  summary 与 Workflow summary。policy tombstone 只证明逻辑过期；reader 只有在
  retirement receipt 同时绑定 prior generation、payload SHA、Trash prepare/
  finalization receipt 和 transaction 时，才接受 payload 字节缺失。
- Retention Journal 已进入当前 Storage Inventory V3；启动恢复只枚举已原子发布
  `plan.json` 的既有 transaction，不 preview、不创建 transactionId，也不自动
  发起新 sweep。生产 authority 在完整回调期间冻结 Run Store writer、维护 WAL、
  destructive RecordMutation 与 Artifact lineage；坏 Journal、坏 evidence、Root
  Binding 漂移或新增 hold 都会在后续 effect 前 fail closed。
- Raw GC 已从 metadata-only preview 接到独立 append-only plan/Journal。显式确认
  必须绑定精确 preview digest 与有序 opaque subject；执行前冻结 Raw/Trash Root
  Binding、相对 source path 和 dev/inode/size/mtime/ctime，并在生产 owner
  authority 内持有 settings/Raw lane、全局 RecordMutation authority 和 Run Store
  mutation lane。Trash prepare 先于 source quarantine，两个阶段的 receipt 与
  progress 崩溃窗口均可重放。
- Raw 永久 purge 与 quarantine 分离。所有候选至少隔离 7 天，再执行一次完整稳定
  Conversation/Run/Memory/Artifact/Raw owner scan；新 owner、路径重建、Store
  blocker、Root 漂移或 Trash SHA 改变都会阻断。稳定 recheck 与
  `purge-authorized` 先耐久发布，再按 exact identity unlink 两份 Trash payload；
  unlink 后、progress 前崩溃可继续 roll-forward。
- Raw GC 启动恢复只续跑已发布 quarantine plan，或已发布
  `purge-authorized` 的永久删除。仅仅达到 7 天不会由启动自动授权删除，也不会
  preview、生成 transactionId 或创建新 GC transaction。Storage Inventory schema
  已升为 V3，并以 metadata-only `raw-gc-quarantine` source 报告 transaction、
  phase 与 evidence 计数。
- 自动维护调度仍不得创建新的 retention sweep 或 Raw GC transaction。该授权要在
  migration validator 与真实 Vault dry-run 完成后单独决定，不能把“可恢复启动”
  误写成“自动清理已经上线”。
- destructive intent、prepared/finalization Trash receipt 与 recovery evidence
  已冻结完整 Root Binding Ref；全局 lock/coordinator 与 production recovery
  runner 已建立安全执行入口；`start-new-context`、`agent-cache-reset`、
  `clear-conversation-records` 与 `delete-conversation` 都已接入各自产品合同。
- `finalizeRecordMutationTrash()` 仍是低层原语。架构门禁现已把生产 source
  retirement 调用限制在 `record-mutation-coordinator.ts`；唯一直接 restore 旁路
  仍为 `fixtureOnly`，并强制位于系统临时目录。live 路径只能通过 immutable plan
  materializer 与 production runner 调用该原语。
- Production runner 已能通过正式 adapter 处理 Memory/Artifact
  `mark-source-deleted` 的 forward、compensation、崩溃重放与 terminal proof；
  adapter 缺失或不完整时仍返回 `participant-adapter-required`。启动恢复已能从
  immutable execution plan 和 production root catalog 重建这些 adapter；live
  preview/commit 已使用完整 Run/Raw/Memory/Artifact inventory 与显式 retain
  selection，任何 blocker 都在确认和 effect 前关闭本轮操作。
- execution plan 必须在第一个 Journal stage 前耐久发布；它只冻结逻辑 Root ID、
  相对路径和 subject identity，不保存绝对路径。Root/adapter 错绑会在 prepare
  前失败。prepare-only coordinator 只写 durable Trash 与 `trash-staged`，不会
  退休 source；启动恢复可幂等重建 receipt 后再由 Runner 决定 forward/compensate。
- retain bundle 已建立首次 destructive prepare 前的完整 inventory 二次复验、
  确定性 `prepared` evidence、物理 Root 再验证和重启复用；这只证明冻结选择不会
  被 materializer 静默绕过。live runner 已进一步把它和 Conversation target
  CAS、Native retirement、投影恢复及用户收据串成同一业务操作。
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

1. 提交本批 V2 → V1 exporter checkpoint。
2. 实现独立 reverse activation manifest/fence、精确 namespaced V1 reader
   selection，以及重启后 History reference 对 restored V1 的真实解析。
3. 把 Native、Run 与 settings 外部 owner 对账接到真实 Store proof，并在副本上
   完成 dry-run；继续保持真实 Vault migration `blocked`。
4. Phase 4 与用户单独确认前不执行
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

## Retain bundle runtime 与统一选择复验（已提交）

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
该 checkpoint 提交时产品 guard 仍关闭，live clear/delete runner、Conversation
target commit、Native retirement、retention/GC 和真实迁移尚未接线；后续 live
批次已接管前三项。本批没有部署或修改真实 Vault。

## Live clear/delete coordinator（已提交）

普通 Conversation 的“清空会话记录”和“删除会话”已从禁用提示切换到
preview → 用户确认 → durable commit 的正式路径。每个会话使用独立 receipt；
Knowledge 会话与运行中的会话仍不可进入该路径。

当前实现遵守以下边界：

- preview 只读取完整 unified inventory，并把 pending-confirmation Memory 与正式
  Artifact 转为显式 retain disposition；其他 blocker 直接阻断确认。
- commit 在同一 Conversation mutation authority 内再次连续盘点两次，冻结 Root、
  intent、execution plan 和 participant，完成 retain proof 与 Trash prepare 后才
  提交空 Conversation target 或 deletion tombstone。
- target Promise 抛错不能代替 Store readback。tombstone 已耐久时继续
  roll-forward；target 未提交时补偿 Trash/Store 并恢复原 Conversation。
- Journal committed 后才允许 promotion Native retirement。删除 target 必须绑定
  tombstone ID/digest、source identity 与 mutation ID；cleanup 失败不反转已提交
  的本地业务结果。
- `data.json` 只是投影。投影写入失败返回 committed/awaiting-recovery，重启按
  Conversation Store/tombstone 修复，不会复活删除会话。
- Storage Inventory 扫描完整 RecordMutation revision chain，并把 deletion
  tombstone、Journal 与 Native retirement 三方关联；错绑或缺证据继续阻断迁移。

当前 focused lifecycle、Conversation Store、Native startup reconciliation、
Storage Inventory 与 Chat UI suites 已通过；最终工作树的 `npm run test` 输出
`All tests passed`，typecheck、build、baseline lint 与 `git diff --check` 通过。
完整 lint 为 961 个历史 finding、无新增；新增 coordinator 的定向 ESLint 为 0。
明确暂存 25 个预期文件后 release contract 与 public guard 通过，public guard
检查 419 个 tracked files；共享 `.codex-memory` 与 `node_modules` 软链接未暂存。
checkpoint 已提交为 `148e686`。本批没有部署或修改真实 Vault，也没有执行
migration、retention、Raw GC、历史删除或 Native 批量 cleanup。

## Knowledge History V2 引用投影（已提交）

Knowledge History 已从复制完整消息的 V1 Store 改为 Conversation 的 dated
projection。V2 日文件只允许 `version`、`kind`、`conversationId`、`messageId`、
`messageRevision` 与可选 `runId`；正文、Raw、backend binding、角色、时间和未知
字段都不能进入 History。

当前实现遵守以下边界：

- Conversation 是唯一正文真源。History 浏览按 message revision 回读 canonical
  Conversation；source 缺失、revision/date/run 漂移、重复或歧义全部 fail closed。
- generation 先在 staging 完整写入 manifest、index、suppressions 与引用文件，
  校验文件集合、digest、计数及 canonical source 后，再原子发布 `active.json`。
  发布期间 Conversation revision 漂移时，旧 active generation 保持可读。
- rebuild、persist、retention、delete 共用 root-keyed writer lane。显式删除写入
  message-level suppression；普通保存和 rebuild 不会复活旧引用，同日新增消息仍
  可进入投影。
- `data.json` 只保留不含 Conversation-owned messages 的 shell。Settings 保存先
  耐久提交完整 Conversation，再发布 History 引用；History 不再压缩正文或触发
  第二次 Conversation 覆盖。
- V1 与 V2 side-by-side。已有实际 V1 数据且尚无 V2 active 时，普通启动和保存
  不执行 cutover；rebuild、delete、retention 与 direct persist 统一抛出显式迁移
  门禁。只有正式迁移入口携带 `allowLegacyCutover` 才能在完整 V1/Conversation
  对账后切换；冲突时 V1 字节和 active 状态不变。空 V1 可直接初始化 V2。
- Storage Inventory 已识别 active generation、manifest、index、suppressions 和
  strict refs。History 不再是 Raw owner；每条引用生成 linked、missing 或
  ambiguous 的 History→Conversation 关系，unknown/mixed/digest/count/source
  问题继续阻断迁移。

该批次已提交为 `3b1ca7f`。全量 `npm run test` 输出 `All tests passed`
（108.9 秒）；`npm run typecheck`、`npm run build`、`git diff --check`、
release contract 与 public guard 均通过。History/Inventory 三个主要生产文件
定向 ESLint 为 0；完整 lint 从 961 条旧债下降到 942 条并同步收紧 baseline，
没有新增 finding。明确暂存 12 个预期文件后，public guard 检查 419 个 tracked
files；共享 `.codex-memory`、`node_modules` 未暂存。

`3b1ca7f` 本身没有执行真实 V1→V2 migration、retention、Raw GC、历史删除、
Native cleanup、部署或 Vault 修改。其后的 `f1b4caf` 与 `48264d6` 已分别提交
Raw GC preview 和 Run Record 逻辑 retention；payload 物理 retirement、Raw
quarantine/二次稳定扫描、migration validator 与 V2→V1 exporter 仍未完成。

## Metadata-only Raw GC preview（已提交）

Raw GC 现在有独立的只读预览，不再从“某个调用者没引用”推断 orphan：

- owner graph 同时覆盖全部 canonical Conversation message 和全部正式 Run payload。
  Memory 与 Artifact 当前 schema 不声明 Raw owner，但 preview 仍严格扫描两个完整
  Store；未知或损坏 schema 会阻断，不能把潜在 owner 当作不存在。
- Run Record inventory 已从“只检查目标 Conversation 的 expected Attempt/payload”
  收紧为全 Store 校验。其他 Conversation 的 missing Attempt、payload state mismatch
  或漏挂记录同样阻断全局 Raw 分类。
- Conversation、Run、Memory、Artifact 与 Raw Store 连续生成两轮稳定 snapshot；
  任一 source digest 漂移会返回 `inventory-drift` 并清空本轮 subjects。
- preview 从不读取 Raw body，只输出 opaque subject hash、size、mtime、owner count/
  kind 和 `retain` / `quarantine-candidate`。缺 Raw、缺 canonical Conversation
  authority 或任何 Store corruption 时，所有候选的 `eligibleForQuarantine=false`。
- safety receipt 固定 `rawBodiesRead=false`、`actionsApplied=0`、
  `destructiveActionCount=0`、`automaticActionAllowed=false`；本批没有 Trash、
  move、delete 或永久 GC effect。

该批次已提交为 `f1b4caf`。focused owner-graph suite 与全量 `npm run test`
（`All tests passed`，111.1 秒）、typecheck、build、完整 baseline lint、两个生产
文件定向 ESLint、release/public guard 和 `git diff --check` 均通过；完整 lint
保持 942 条 baseline finding，无新增。明确暂存 3 个预期文件，public guard 检查
419 个 tracked files；共享软链接未暂存。

下一步仍需把 candidate 接入可恢复 Trash/Journaling，并要求至少 7 天后第二次完整
稳定扫描才允许永久删除；这属于后续独立 destructive checkpoint，当前真实 Vault
继续保持零写入。

## Run Record retention（已提交）

Run Record retention 已建立默认 30/90 天合同：详细 Attempt payload 默认保留
30 天，Attempt 与 Workflow summary 默认保留 90 天。Archive Catalog、README、
Memory V2 实现文档和中英文设置文案已同步说明：只有仍在保留期内的记录可查，
`expired`、`missing` 与 `corrupt` 是三种不同状态。

当前实现遵守以下边界：

- preview 不修改 Store，在同一恢复证据 authority 内连续取得两次稳定的 Run
  Store inventory。底层 inventory 会完整读取、解析并校验 payload events；
  preview/plan 只保留 record metadata，不返回事件正文。WAL、Artifact lineage、
  人工恢复等 hold 会从 payload/Attempt 传播到整个 Attempt，再聚合到 Workflow。
- execution 使用不可变 plan 和 append-only progress Journal，固定按 payload →
  Attempt summary → Workflow summary 发布 tombstone。相同 digest 的重复发布
  幂等；不同 tombstone、越序 effect、subject 集合变化、首个 effect 前 snapshot
  漂移或 hold/eligibility 漂移都会 fail closed。
- Store 级 root-keyed mutation lane 同时约束普通 generation publication 与
  retention mutation，避免同一 Run Store 内的协作 writer 穿透执行 authority。
- tombstone 已耐久但 progress step 尚未发布时，重启执行可从 Store readback
  补齐有序 Journal prefix；prior digest 改变、Journal 损坏或非前缀 effect 不会
  被自动解释为成功。

该批次已提交为 `48264d6`。Run Record retention 与 Run Record Store focused
suite 均通过；全量 `npm run test` 输出 `All tests passed`（114.3 秒）。
`npm run typecheck`、`npm run build`、`npm run check:release`、
`npm run check:public` 和 `git diff --check` 均通过。完整 lint 保持 942 条
baseline finding，无新增；明确暂存 11 个预期文件，public guard 检查 421 个
tracked files，共享 `.codex-memory` 与 `node_modules` 软链接未暂存。

本批只完成逻辑 expiration 与 recovery Journal。immutable payload 字节尚未通过
Trash 物理退休，Journal root 尚未接入 Storage Inventory 和生产启动恢复，也没有
接入自动 retention、部署或修改真实 Vault。Phase 2 下一批先补齐这些生产恢复
边界，再进入 Raw quarantine、migration validator 与 V2→V1 exporter。

## Run payload 物理退休与生产启动恢复（本轮）

本轮把 `48264d6` 留下的逻辑过期补成可恢复物理退休。Run Store 新增
`AttemptPayloadRetirementReceiptV1` 和 `retired` generation：普通 reader 不会因为
看见 policy tombstone 就接受 prior payload generation 消失，必须同时读到精确
匹配的 retirement receipt。只有 tombstone、没有 receipt 的缺字节状态继续判为
`corrupt`。

Retention executor 的 payload action 现在有三个正式阶段：

1. `trash-prepared`：冻结 execution header、prior generation、payload digest、
   Root Binding，并建立独立 Trash 副本。
2. `tombstone-published`：发布逻辑过期，但 source generation 仍然保留。
3. `source-retired`：重新核对 hold、Root Binding 和 Trash evidence 后退休 source，
   再发布 retirement receipt。

Attempt summary 必须等预期 payload 完成物理退休后才允许过期。prepare 后或
tombstone 后新增 WAL/Artifact/RecordMutation hold 都会阻断后续阶段；事务保持
非终态并等待 roll-forward，不自动补偿 policy tombstone。

生产 recovery-evidence authority 不使用空 holds。它在同一全局 mutation authority
和 Run Store mutation lane 内读取维护 WAL、未收口 RecordMutation、Workflow
Artifact lineage 与 Run inventory，并将真实证据编译成 hold snapshot。维护 WAL
发布/状态变化、Artifact lifecycle 写入和破坏性 Conversation mutation 同样进入
这把 authority，避免“检查后证据变化、删除已发生”。

启动链顺序保持为：

`RecordMutation recovery → Chat/Editor/Utility/Memory/Hermes local commit recovery
→ started retention recovery → Native retirement promotion → provider cleanup`。

启动恢复只继续已有的 `plan.json`；没有 retention root 时返回 0，坏 staging、坏
plan、坏 step 或坏 Trash evidence 在零 retention effect 前阻断。Run/Trash Root
Binding 由正式 production root catalog 重建，已完成 transaction 的重放不会增加
generation、receipt 或 Journal phase。

Storage Inventory schema 已升为 V2，并新增 `run-record-retention` source。扫描
只输出 transaction、action、phase、prepared/finalization evidence 和 corrupt/
unsafe/staging 统计，不泄露 transaction ID、subject ID 或本机路径。

当前验证已经通过：

- Run Record Store、Run Record retention、Storage Inventory、Native startup、
  WAL、Artifact/RecordMutation 与 architecture boundary focused suites。
- `npm run test`，输出 `All tests passed`（122.2 秒）。
- `npm run typecheck`。
- `npm run build`。
- `npm run lint`，942 个 finding 与 baseline 完全一致，无新增。
- `npm run check:release`。
- `npm run check:public`，明确暂存 24 个预期文件后检查 422 个 tracked files。
- `git diff --check`。

本轮没有创建自动 retention sweep，没有部署或修改真实 Vault，也没有执行历史
删除、Raw quarantine、migration 或 Native 批量 cleanup。下一步提交本 checkpoint，
再进入 Phase 2 剩余治理项。

## Raw quarantine、七天隔离与二次 owner scan（本轮）

本轮把 `f1b4caf` 的只读候选预览接到独立 destructive protocol。正式执行入口要求
显式确认精确 preview digest 和有序 opaque subject；任何确认后的 owner graph、
Raw metadata 或 candidate 集合变化都在 `plan.json` 发布前阻断。

Raw quarantine 状态机固定为：

1. 原子发布不可变 plan，冻结 transaction、preview/source snapshot、Raw/Trash
   Root Binding、相对路径与 source dev/inode/size/mtime/ctime。
2. `trash-prepared`：在全局 authority 下建立独立、可恢复且带 SHA-256 的 Trash
   副本，source 仍保留。
3. `source-quarantined`：重新验证 Root 和 receipt 后，把 exact source rename 到
   Trash retired 区，并发布 finalization evidence。
4. 至少等待 7 天；时间到达本身不产生任何授权。
5. 再次执行完整稳定 owner scan；计划内 Raw path 必须仍然缺席且没有任何 owner/
   Store blocker。先发布 `purge-recheck.json` 与 `purge-authorized`，再按 exact
   identity/SHA unlink prepared copy 和 retired source，最后发布 purge receipt。

生产 `RawGcStableOwnerAuthority` 会先收口正在进行的 Raw 外置写入并持有
settings saveQueue/Raw owner lane，再用全局 RecordMutation authority 冻结普通
Conversation、Artifact 和 WAL writer，并用 Run Store mutation lane 冻结 payload
owner。`externalizeMessageText`、启动 Raw migration 和普通 Conversation mutation
都已进入对应 authority，避免 Raw 字节已写入但 owner 尚未耐久的竞态。

启动顺序现在是：

`RecordMutation recovery → Chat/Editor/Utility/Memory/Hermes local commit recovery
→ started Raw GC recovery → started Run retention recovery
→ Native retirement promotion → provider cleanup`。

Raw 启动恢复只处理已有 plan；没有 `purge-authorized` 时，即使隔离已超过 7 天也不
执行永久删除。plan、step、receipt、Root、SHA、staging 或 owner evidence 损坏时，
在后续 effect 前 fail closed。Trash prepare 后、source move 后以及两次 unlink
后但 progress 尚未发布的窗口均有故障注入和幂等恢复覆盖。

Storage Inventory schema 升为 V3，新增 metadata-only
`raw-gc-quarantine` source；只输出 transaction/action/phase、prepared/
finalization 与 purge evidence 计数，不泄露 transaction ID、rawRef、文件名、
相对/绝对路径或 Raw body。

当前实现和全量回归已通过：

- `npm run test`，输出 `All tests passed`（125.1 秒）。
- `npm run typecheck`。
- `npm run build`。
- `npm run lint`，942 个 finding 与 baseline 完全一致，无新增。
- `npm run check:release`。
- `npm run check:public`，明确暂存 15 个预期文件后检查 424 个 tracked files。
- `git diff --check`。

本轮仍未对真实 Vault 创建 GC transaction、移动或删除 Raw，也未部署、迁移或执行
Native 批量 cleanup。Phase 2 下一步是 migration validator 与 V2→V1 exporter。

## Migration Validator、Deletion authority 与 History validated cutover（本轮）

本批新增完整 Migration Validator。Conversation、message、snapshot、deletion
tombstone 与 History reference 都进入稳定 subject ledger；Raw、Native、Run、
settings projection 与 History source 进入 owner ledger。Validator 精确比较
identity、parent、ordinal、revision、content digest 和 owner edge，只输出
SHA-256 opaque ref。同 identity 不同 revision/body 会生成 metadata-only conflict
quarantine；ready 结果只返回当前进程生成的不可序列化 trusted proof，伪造或重启
后的对象不能授权 manifest cutover。

V1/V2 Conversation Store 都增加严格只读 migration snapshot：Store 缺失时不
初始化，index、payload、metadata chain、staging、未知 entry 或扫描漂移都 fail
closed。side-by-side copier 只创建缺失 Conversation；完全相同项幂等复用，同 ID
冲突不覆盖目标，并默认把 quarantine 耐久写入 V2 namespace。legacy session 或
message 出现未知字段时直接阻断，不能静默丢弃新字段。

Deletion tombstone 已成为 Conversation V2 Store 的正式 immutable authority。
copier 会分别统计 created/reused/conflicting tombstone；active Conversation 与同 ID
tombstone 不允许共存。Migration Validator 只接受从目标 V2 Store 严格快照读回的
tombstone，不再接受调用方临时传入的“目标已删除”声明。

Knowledge History 首次 V1→V2 cutover 改为读取真实 V1 index/day rows，并与 staged
V2 generation 完整对账。首轮强制零 retention、零 suppression，只迁移 V1 当前
投影，不能把 canonical Conversation 全量清单冒充 V1 source ledger。同 ID 不同
正文会在 active publish 前阻断并持久化 opaque quarantine。History V2 reference
不再复制 legacy Harness `runId`；message revision 使用跨 V1/V2 稳定的 product
revision。History reader/rebuild 会按 Conversation Store active manifest 选择 V1
或 V2，active-fence 已发布但 manifest entry 尚未落盘时继续读 V1，恢复后才切 V2。

当前验证已通过 `npm run test`（`All tests passed`，128.0 秒）、`npm run
typecheck`、`npm run build`、`npm run lint`、`npm run check:release`、四组
Migration/Conversation/History/Inventory focused suites 与 `git diff --check`。
完整 lint 保持 942 个 baseline finding，无新增；public guard 在明确暂存本批文件
后执行。

真实 Vault 仍保持 `blocked`。Native、Run 与 settings external owner 目前只有完整
ledger 合同，尚未全部接入真实 Store proof；Conversation V2 全量生产 writer
cutover、V2→V1 exporter、reverse restore 演练、自动 retention/Raw GC 调度和真实
迁移都不属于本批已完成范围。

## V2→V1 compatibility exporter 与回迁夹具（本轮）

本轮新增独立 V2→V1 exporter。它只接受 manifest 当前明确选择的 canonical
`conversations-v2`，连续两次严格扫描 source，并用 active manifest digest 与
portable source fingerprint 生成确定性的
`conversation-v1-exports/export-<digest>`。原始 `<storage>/conversations`、
active V2 和 reader route 在整个导出与验证阶段保持不变。

每个 export generation 先发布不可变 `plan.json`，再写入独立 `store/`，最后发布
`validation.json`。V1 restore writer 只接受绑定同代 plan 的写入；每次 effect 前
都会重读并验证 generation、projection、Store 方向、source identity、digest、
普通文件和真实目录边界。plan 缺失、篡改、硬链接、路径逃逸或绑定不一致时，在
Conversation/tombstone 写入前阻断。

portable projection 保留 Conversation、当前 Context、消息、Snapshot、Raw 引用和
产品 Presentation，排除 backend binding、Native lease、Run diagnostics 与 token
usage。V2 message 带 `workflowRunId/attemptId` 时必须有对应 Run owner edge；
exporter 不把这组 lineage 伪装成 V1 `runId`。Conversation product revision 已改为
跨 V1/V2 稳定的产品字段摘要，不再使用 V2 metadata commit digest。

fixture 已覆盖 V1→V2→V1→V2 ledger 对账、V2-only Conversation、Context 边界、
Snapshot、完整 Presentation、deletion tombstone、幂等 replay、同 ID 冲突不覆盖、
opaque quarantine、source 漂移、缺 Run owner、非 canonical source、future V1
index，以及 seed rename/commit marker 两个崩溃窗口。崩溃恢复中“字段缺失”与
`undefined` 的误判已修正；恢复会识别等价 pristine seed 并补齐 index/commit。

当前验证已通过：

- exporter 定向套件，以及 Conversation V1/V2、Migration Validator、History
  projection/retention 相关 focused suites。
- `npm run test`，输出 `All tests passed`（128 秒）。
- `npm run typecheck`。
- `npm run build`。
- `npm run lint`，942 个 finding 与 baseline 完全一致，无新增。
- `npm run check:public`，明确暂存 12 个预期文件后检查 430 个 tracked files。
- `npm run check:release`。
- `git diff --check`。

本轮仍没有 reverse activation。导出成功不改变 active Store，也不授权 reader
切换；下一步必须独立实现 reverse manifest/fence、精确 namespaced V1 selection
和重启恢复。真实 Vault migration、retention、Raw GC、History 删除、Native 批量
cleanup 与部署均未执行。
