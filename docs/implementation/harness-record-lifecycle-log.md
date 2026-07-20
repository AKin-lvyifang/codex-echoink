# EchoInk Harness 记录生命周期实施日志

本文件只追加阶段事实。当前有效计划见
[`harness-record-lifecycle.md`](harness-record-lifecycle.md)，当前状态见
[`harness-record-lifecycle-progress.md`](harness-record-lifecycle-progress.md)。

## 2026-07-19：项目记忆切换到本机 codex-memory V2

- 在迁移前把原 `.codex-memory`、`AGENTS.md` 和全局 V2 config 备份到
  `<BACKUP_ROOT>/20260719-000602-echoink-project-memory-v2-migration`。
- 将 EchoInk 主仓库加入 V2 `project_roots`，
  移除旧的“EchoInk 继续保留 V1”排除项。
- 运行 `migrate-v1`，保留全部 V1 Markdown，只增加：
  - `manifest.json`
  - `.runtime/`
  - Task `meta.json`
  - `tasks/index.v2.md`
- V2 manifest：
  - `project_id=dd0b8209-1272-4f70-a402-630de403e5d1`
  - `schema_version=2`
  - `layout_mode=compat-v1`
- V2 Hook 首次自动整理成功：
  - `memory_revision=1`
  - outcome=`write`
  - Curator=`gpt-5.6-sol`
  - Doctor `healthy=true`
  - trusted Hook `7/7`
- `AGENTS.md` 的 V1 路由块已替换为 V2 入口；后续禁止再调用
  `codex-memory-task-init`、`codex-memory-sync` 等 V1 Skill。
- 只读审计确认 Hook 只按线程 cwd 匹配 `project_roots`，不会把
  `/private/tmp` worktree 按 Git common-dir 自动归到主根。本任务保留主根 cwd，
  worktree 只承载代码文件。

## 2026-07-20：Phase 4 完成度审计

- Phase 0–3 已完成并提交；Phase 3 checkpoint 为 `19f183b`。
- 只读核对确认，live Conversation writer 仍主要使用 V1 Store。现有 V2 Store、
  migration validator、manifest、reverse exporter 和全局 RecordMutation authority
  不能单独证明生产 reader/writer 已经完成原子切换。
- 当前也没有覆盖新 Run、普通 Conversation 写入、Memory commit、retention 和
  cleanup 的统一迁移静默窗口。只补局部 admission gate 或独立 CLI 仍会留下并发
  writer，不能作为真实 cutover 授权。
- 因此本轮不新增半套 Phase 4 coordinator，不执行真实 Vault 备份、迁移、部署、
  retention、Raw GC、Native cleanup 或 UI 验收。下一开发门禁是先完成统一 V2
  reader/writer 路由和同进程静默窗口；真实数据仍按现有 blocker fail closed。

## 2026-07-18 至 2026-07-19：记录生命周期只读审计

- 从 `main@a91f1b8` 建立分支 `codex/harness-record-lifecycle` 和专用 worktree。
- 基线 `npm run typecheck`、`npm run test` 通过。
- 审计 Conversation Store、Run Ledger、Native Execution Store、Knowledge
  History、Raw sidecar、Memory Archive Catalog 和三个 backend adapter。
- 确认主要缺口：
  - `/clear` 只隐藏 UI，未建立真实 context boundary。
  - workspace switch 与 lease rollover 会丢失旧 native binding 的 cleanup 引用。
  - Editor 三后端没有完整 Native 台账和结算。
  - Codex prewarm 产生无 Harness run 的 thread。
  - cleanup 缺少有限重试、quarantine、single-flight 和公平队列。
  - Run/History/Raw/Conversation 的正文与 retention 所有权不统一。
- 形成五层权威模型，并接受 ADR 0005。
- Phase 0–4 期间禁止批量删除真实历史；先做 metadata-only dry-run、备份、
  side-by-side migration 和回滚演练。

## 2026-07-19：Phase 0 metadata-only inventory 完成

- 新增只读 scanner、严格 report contract、三后端 metadata probe、确定性报告构建器
  和开发 CLI。scanner 只有 `readFile`、`readdir`、`lstat`、`realpath` 能力；
  Raw 路径只做目录与 stat 盘点，不读取或散列正文。
- 报告中的来源标识全部使用 SHA-256 opaque ref；状态码、关系类型、指标名和
  finding metadata 使用固定白名单。未知 Provider 状态会降级成固定
  `provider-probe-partial`，不会把任意后端字符串带进 JSON 或 Markdown。
- 本机 SQLite probe 只查询 ID、cwd / directory 和时间字段，并使用
  `sqlite3 -readonly -json`。本机查询只能证明正向存在；由于 standalone CLI
  无法证明当前 Obsidian device key，查无记录保持 ambiguous，不签发 missing。
- 真实 Vault 双次运行得到相同结构快照：
  - `reportId=storage-inventory-f1a57a97ac7125141db10d86`
  - `snapshotFingerprint=sha256:f1a57a97ac7125141db10d860780e7eb35ffdbf1cc20cc51427274e523294002`
  - 插件目录前后均为 286 个条目，目录项、类型、size、mtime 摘要完全一致
  - CLI 退出码为 `1`，含义是报告已生成但迁移被真实数据阻断
- 正式报告复现了审计基线：
  - `data.json` 有 9 个会话，Conversation Store 有 19 个，10 个待归属
  - History 有 445 条消息；Harness Run 有 152 个、12,378 条事件
  - Native Store 有 76 条记录，其中 64 条处于 cleanup backlog
  - Raw 有 10 个引用、9 个文件和 1 个失联引用
  - Codex 73 个 linked records 均正向命中；OpenCode 1 个和 Hermes 2 个保持
    partial / ambiguous，未误报 missing
- 当前 migration 有 129 个 blocking findings：1 个 `raw-reference-missing`、
  64 个 `run-terminal-missing`、64 个 `run-local-commit-missing`。这些结果只作为
  Phase 1/2 的恢复与治理输入，未触发修复、迁移、retention 或 cleanup。
- 最终代码状态通过 `npm run typecheck`、`npm run test`、`npm run build`、
  `npm run lint` 和 `git diff --check`；`npm run check:public` 在新增文件暂存后
  覆盖 356 个 tracked files 并通过。

## 2026-07-19：Phase 1 Context 与 Native 生命周期自动化收口

- 新增统一 Context rotation，覆盖 Knowledge `/clear`、Workspace switch、
  History restore、Reset Agent cache 和 lease rollover。每次 rotation 都生成
  workspace fingerprint、target generation 与 commit identity，并先登记旧 binding
  retirement，再提交 Conversation。
- Conversation commit 失败会回滚 revision、context 和 binding，且不会 cleanup。
  在 Conversation 已提交、retirement 尚未晋级时中断，启动恢复按精确 generation
  与 commit identity 晋级、abort 或 quarantine；证据不唯一时 fail closed。
- Native cleanup 增加六次自动尝试上限、quarantine、公平队列和 single-flight。
  启动恢复统一处理 `awaiting-local-commit`、pending cleanup 与旧 lease retirement，
  新任务不会被历史失败 backlog 饿死。
- 移除 Editor prewarm。Codex、OpenCode、Hermes 都在 Prompt 或进程启动前登记
  Native ID；登记失败会阻止 Prompt，并只执行一次 best-effort 回收。
- Editor 产品入口成为候选校验后的终态权威。Kernel 使用
  `terminalAuthority="surface"`，无效候选只提交一个 `failed`；terminal receipt
  必须匹配 run ID、事件类型、backend 和 payload。terminal 提交失败时保留
  `localCommit=false`，不得把 Native 记录清理掉，也不得再写第二个终态。
- Structured Knowledge 的三后端入口同样执行 Native 先登记、本地结果先提交、
  Native 后结算。cleanup 基础设施失败只形成可恢复状态，不反转已提交的业务结果。
- Settings 普通保存与 workflow CAS 共用 canonical persistence helper。固定顺序为：
  完整 Conversation pass 1、History 投影与压缩、压缩后 Conversation pass 2、
  最后 `data.json`。History 中出现的记录始终已有 durable Conversation source；
  多会话部分失败时立即同步已耐久前缀，不覆盖并发 live 修改。
- Prompt Enhancer、Memory Curator 和 Settings backend probe 已统一接入
  ephemeral Utility lifecycle；Prompt 前完成 Native 登记，产品结果或正式 Memory
  transaction 耐久后才允许 settlement 与 cleanup。
- Provider endpoint identity 统一 canonicalize：安全 origin 和内部 transport
  sentinel 可直接保留，带凭据、scope、query、fragment 或未知 opaque 内容只保存
  幂等 `endpoint-sha256`。登记端与 cleanup adapter 使用同一 identity。
- Hermes ACP descriptor 由 runtime 原样传入 Native Store，Editor 与 generic
  Knowledge 保存真实 `session / provider-persistent / acp-stdio`；成功路径缺少
  callback 时 fail closed，旧记录缺少 `transport` 仍兼容。
- Hermes production factory 的测试 fixture 改用 `/bin/sh` 同步启动收据，消除
  500ms ACP 初始化预算下二次 Node 冷启动造成的假 `ENOENT`，同时继续证明 ACP
  只尝试一次且不会降级执行 CLI Prompt。
- 当前完整 diff 已通过 13 组末轮 Phase 1 focused suites、`npm run test`、
  `npm run typecheck`、`npm run build`、`npm run lint`、`npm run check:release`
  和 `git diff --check`。Lint baseline 相对当前分支已提交基线从 985 向下收紧为
  961，无新增 finding；
  明确暂存预期文件后，`npm run check:public` 通过；`.codex-memory` 和
  `node_modules` 共享软链接未进入暂存区。当前 checkpoint 未部署。
- 本阶段没有修改真实 Conversation、Run、Raw、Native backlog 或 Vault 数据，
  也没有执行 retention、迁移或真实 Native cleanup。

## 2026-07-20：Phase 2 本地记录基础设施与显式恢复门禁

- 新增 side-by-side Conversation V2：不可变 payload、append-only metadata chain
  与原子 head。head 是可见 commit marker；metadata 已发布但 head 尚未推进时，
  相同 candidate 可以幂等恢复，不同 candidate 明确冲突。正常 commit 不允许删除
  或改写既有 message 前缀。
- 新增 Workflow/Attempt Run Record Store。summary 与短期 payload 分层保存；
  payload 明确区分 `present`、`expired`、`not-captured`、`missing` 和 `corrupt`。
  状态、local commit、cleanup、引用和时间戳保持单调，tombstone 后不得复活。
- 新增 Conversation mutation lane，同一 Conversation 串行、不同 Conversation
  可并行；已覆盖 Chat、Knowledge、Stop、Watchdog、context rotation、workspace
  switch 和终态持久化等入口。
- 新增 RecordMutation Journal、Trash 与 fixture-only Recovery。Journal 使用
  append-only digest chain、participant 完备门禁和 CAS；Trash 的 prepare 阶段
  只建立 durable 可恢复副本，finalize 才把 source 移入受控 retirement evidence。
  文件、目录树、空目录、部分恢复和幂等重试已有夹具；symlink、hardlink、socket
  与特殊文件 fail closed。
- 终态 Conversation/Run/Native 持久化失败会进入独立 `recoveryRequired` 门禁。
  Send、Resume、自动启动和 dequeue 都不能绕过；显式恢复只有在持久化终态标记
  全部清除后才重新开放。
- 独立复核发现 View 重启后不会从持久化终态标记重建门禁。现已在首次渲染前扫描
  `runTerminalRecoveryPending/echoInkRunTerminalRecovery` 并恢复门禁；即使
  authority 缺损也保持 fail closed，并增加回归测试。
- 最终 staged tree 已通过 `npm run test`、`npm run typecheck`、`npm run build`、
  相关 focused suites、`npm run lint`、`npm run check:release`、
  `npm run check:public` 和 `git diff --check`。Lint 的 961 个 finding 与 baseline
  完全一致；public guard 在明确暂存后检查 390 个 tracked files。门禁中发现的
  unknown lifecycle error 字符串化问题已修复，不再生成 `[object Object]`。
  本批次随后已提交为 `b2db2f5`。
- 本批次没有接管 legacy reader/writer，也没有连接生产删除。Root Registry、
  root binding digest、全局 mutation coordinator/lock，以及 Trash finalize 的
  durable Journal 自授权仍是下一阻断项。Node 最后一个 syscall 的外部竞争窗口
  继续按已声明的协作 writer 威胁边界处理。
- 没有修改真实 Vault，也没有执行 migration、retention、Raw GC、历史删除或
  Native 批量 cleanup。

## 2026-07-20：Root Registry 与首次 chain 原子发布

- 新增 Root Registry 基础实现。每个 binding 保存 opaque registry ID、逻辑
  `rootId`、authority、canonical root/boundary path digest、目录 dev/inode、
  revision 和 digest，不把本机绝对路径写进 record。
- `plugin-owned` root 必须严格位于 registry storage root 内；
  `vault-managed` root 必须严格位于声明的 Vault owner boundary 内。同一
  `rootId` 重复登记相同目录时幂等，换成其他目录时冲突。
- 验证阶段先要求同 revision/digest 的 binding 仍存在于 Root Registry 真源，
  再重新 canonicalize 并核对 owner boundary、path digest 和目录 identity。
  Registry authority 丢失、目录被重建、换绑、symlink、移出 boundary、
  future schema 或 unknown entry 均 fail closed。
- binding revision chain 逐条保持 authority、root/boundary digest 和目录 identity
  不变，伪造后续 revision 不能换绑 immutable root。
- append-only CAS 先在 staging 目录耐久写入首条 entry，再把完整目录原子发布为
  chain；同版本 writer 不再看到“空 claim 已存在、首条 entry 尚未发布”的中间态。
  `after-chain-claim` 现在表示完整 chain 已原子发布并同步，故障后可直接 durable
  readback；旧版本留下的空 claim 仍能在新写入前清理。
- 提交前 staged tree 已通过新 focused suite、RecordMutation Journal/Trash
  focused、`npm run test`、typecheck、build、目标生产文件 ESLint、完整 lint、
  release/public guard 与 `git diff --check`。Lint 的 961 个 finding 与 baseline
  一致；public guard 明确暂存后检查 393 个 tracked files。
- 由于 Node 未提供 directory `renameat2(RENAME_NOREPLACE)`，上述并发承诺限于使用
  同版本协议的 cooperative writers；旧版 writer 混跑与同权限外部进程制造的最后
  一个 syscall 竞态仍在威胁边界之外。
- 在该 checkpoint，Root Binding 尚未进入 destructive intent、Trash receipt 或
  recovery evidence；全局 mutation coordinator/lock 也尚未实现。因此这一步仍不允许生产删除，
  真实 Vault 保持完全未修改。

## 2026-07-20：跨层冻结 Root Binding Ref

- `RecordRootBindingRef` 扩展为完整物理引用：registry ID、逻辑 `rootId`、
  authority、root/boundary path digest、目录 dev/inode、revision 与 binding
  digest。新增 ref 严格解析、完整相等比较与“回读 Registry + 物理再验证”入口。
- destructive RecordMutation intent 必须携带按 `rootId` 排序且不重复的 Root
  Binding Ref；非 destructive intent 必须为空。Intent digest 覆盖完整引用。
- prepared Trash receipt、finalization receipt 与 low-level Trash roots 改为携带
  source/trash Root Binding Ref；locator root ID 必须与引用一致，跨层 ref
  不一致不能 replay、finalize 或 restore。
- recovery evidence 冻结与 intent 相同的 Root Binding Ref 集合。Recovery decision
  遇到换绑直接返回 `root-binding-mismatch`；fixture compensation receipt 的两份
  引用必须属于 intent，检查发生在写入 compensation step 之前。
- 新增 intent 缺失/乱序/重复 ref、receipt 换绑、recovery evidence 换绑、
  receipt 不属于 intent 以及 Registry ref readback 的 fail-closed 反例。
- 提交前 staged tree 已通过 RecordMutation/Root Registry focused suites、
  `npm run test`、typecheck、build、完整 lint、release/public guard 与
  `git diff --check`。Lint 的 961 个 finding 与 baseline 一致；public guard
  明确暂存后检查 394 个 tracked files。
- 本批仍未实现全局 mutation coordinator；low-level Trash effect 尚不回读
  Registry 验证 ref 与当前物理 root，生产删除 guard 必须继续关闭。没有连接
  生产删除或真实 Vault。

## 2026-07-20：全局 RecordMutation Coordinator

- 新增 `record-mutation-coordinator.ts`。每个 storage root 使用一个 durable
  全局 authority，不同 Conversation 的记录 mutation 不能并行执行 source
  retirement 或 restore。Lock 记录 pid、mutation ID 与随机 token；损坏 lock
  fail closed，死亡进程遗留的 lock 先隔离再恢复。
- 前向路径固定为：取得 authority、预检 Root Binding、durable Trash prepare、
  Journal `trash-staged`、回读 Registry 与物理目录、low-level finalize、Journal
  `source-retired`。`source-retired.evidenceDigest` 绑定 finalization receipt，
  不只复用 prepared receipt。
- 补偿路径要求 immutable Journal chain 同时存在 `trash-staged`、
  `source-retired` 和 `compensation-prepared`。之后才重新验证 source/trash
  Root Binding、执行 no-clobber restore，并写入 `trash-restored`。
- source 与 trash 目录都必须已登记且物理独立。相同目录、父子嵌套、目录重建、
  symlink、boundary 变化或 Registry 换绑都会在破坏性 effect 前阻断。
- 新增两个关键崩溃窗口的重放：source 已退休但 Journal 尚未记账，以及 source
  已恢复但 Journal 尚未记账。重入时根据 durable receipt 与物理 readback 补齐
  Journal step，不重复破坏性 effect。
- 新增架构门禁：生产 `finalizeRecordMutationTrash()` 调用只能来自 coordinator；
  唯一直接 restore 旁路仍是 fixture-only recovery，并必须通过系统临时目录门禁。
- 当前 worktree 已通过 coordinator/architecture focused suites、`npm run test`、
  typecheck、build、完整 lint、目标 ESLint 与 `git diff --check`。完整 lint 仍为
  961 个已提交 baseline finding，没有新增 finding。最终明确暂存 8 个预期文件后，
  release/public guard 均通过；public guard 检查 396 个 tracked files。
- 本批仍未接入四类产品删除操作、生产 recovery runner、legacy reader/writer 或
  真实 Vault。没有执行 migration、retention、Raw GC、历史删除或 Native 批量
  cleanup。

## 2026-07-20：RecordMutation Schema V2 与 Production Recovery Runner

- 审计 production recovery 接线前发现，原 intent 只冻结 expected generation 与
  commit ID，没有冻结 content revision 和目标状态；旧 Recovery Evidence 的
  `localCommit="exact-target"` 无法由 Journal 自身证明。由于 RecordMutation 仍是
  side-by-side、尚未激活生产 reader/writer，本批在生产接线前把 schema 升为 V2。
- V2 Intent 增加 `expectedConversationContentRevision` 与
  `targetConversation`。非删除操作冻结目标 generation、commit ID 与 content
  revision；删除操作必须冻结 durable tombstone ID 与 digest。开启新上下文和
  清空记录必须 generation +1，重置 Agent 缓存必须保持 generation，目标 commit
  不得复用 expected commit。
- Recovery Evidence V2 不再保存调用方给出的分类字符串，而是保存实际
  Conversation observation。Classifier 逐项比较 target 和 before proof：
  tombstone 缺失只能是 unknown；generation/commit 相同但 content revision 不同
  视为 contradictory。
- 新增 `record-mutation-recovery-runner.ts`。它从 Conversation inspector 和
  coordinator 的 Trash inspection 生成 evidence；destructive roll-forward 与
  restore 都重新经过全局 authority、Registry/物理 Root 再验证和 durable receipt。
  Root 重建或 Trash 不完整时只返回 blocked，不补写 source-retired 或 terminal。
- Runner API 强制整轮通过 `withConversationMutation`；生产接线必须传入产品写入
  使用的同一 Conversation mutation authority。Runner 在 effect 前和 Journal
  终态发布前重复读回 Conversation。读回发生变化时返回
  `conversation-evidence-changed`；即使 source 已退休，也只保留可恢复的 staged
  Journal，不会用过期证据提交终态。
- Runner 已覆盖非破坏操作的 exact-target roll-forward 与 before-target abort，
  destructive 操作的退休补账、restore、终态提交、Conversation authority
  串行化、终态前 drift 阻断，以及 contradictory/unknown readback。架构门禁禁止
  产品代码直接调用纯 decision 函数；fixture-only recovery 保留测试旁路。
- `mark-source-deleted` participant 的 Memory/Artifact 正式事务 adapter 尚未实现。
  Runner 遇到缺少 forward proof 或需要 compensation 的 participant 时返回
  `participant-adapter-required`，不会伪造 `participant-staged/restored`。
- 当前 worktree 已通过相关 focused suites、`npm run test`、typecheck、build、
  完整 lint、目标 ESLint、`git diff --check`、release contract 与 public guard。
  完整 lint 保持 961 个 baseline finding，无新增 finding；public guard 检查 398 个
  tracked files。暂存区仅包含本批 15 个预期文件。
- 本批没有接入产品删除入口或真实 Vault，也没有执行 migration、retention、
  Raw GC、历史删除或 Native 批量 cleanup。

## 2026-07-20：Memory/Artifact Source-deletion Participant Adapter

- 新增通用 `record-mutation-source-participant.ts`。Runner 要求 adapter 与 intent
  的 `mark-source-deleted` participant 完整同序；receipt 绑定 mutation、
  Conversation、participant、record kind、phase、effect ID/digest 与时间。
- Adapter 只先取得 Store mutation lane；随后验证 frozen Root Binding、恢复既有
  Store、再次验证 Root，才允许 inspect/effect。Root 重建或正式 Store 缺失时
  effect 前阻断，Memory 不会在替换或空目录里先初始化新 Store。
- Memory formal index 增加稳定排序、只增不减的 `sourceConversationIds` 和
  `sourceDeletions`。Forward 与 restore 均走正式 Memory transaction；restore
  保留原 marker 并追加 restoring transaction proof。旧记录缺目标 lineage 时
  fail closed。
- 新增 Workflow Artifact append-only lifecycle Store。首 revision 冻结
  artifact ID、kind 和 Conversation lineage；后续 revision 追加 source deletion
  或 restoration。注册冲突、缺 registration、chain 不连续/损坏与 lineage 不完整
  都会阻断。
- Roll-forward 先标 Memory/Artifact，再退休 Trash；compensation 先补齐已落盘但
  Journal 丢步的 forward proof，再恢复 Trash，最后恢复 Memory/Artifact。
  Store effect、readback 与 Journal `participant-staged/restored` 位于同一 lane。
  committed/aborted 的 noop recovery 也会重读并验证 Store receipt。
- 新增 focused suite 覆盖双 participant 前向、补偿、Memory index crash replay、
  缺 adapter、Root 重建、正式 Store 缺失、lineage 缺失、Artifact 注册冲突、
  restore 幂等和 chain 损坏；Memory 回归同时覆盖 lineage 合并和稳定排序。
- 当前已通过 participant focused suite、完整 test、typecheck、build、完整 lint、
  目标 production ESLint 与 `git diff --check`。完整 lint 仍为 961 个 baseline
  finding，没有新增 finding。明确暂存 17 个预期文件后，release/public guard
  通过；public guard 检查 402 个 tracked files。
- 这仍是 side-by-side Phase 2 基础设施。四类产品操作、legacy reader/writer、
  retention、Raw GC preview、migration validator 和 V2→V1 exporter 尚未接线；
  产品删除 guard 保持关闭，真实 Vault 未修改。
- 本批随后提交为 `c90ebeb`。

## 2026-07-20：非破坏性 Live Journal 与 Native Promotion Authority

- `ConversationMutationLane` 现在向回调签发运行时不可伪造的 opaque authority。
  authority 绑定单个 Conversation，回调结束立即失效；伪造、跨 Conversation
  使用或过期复用都会失败。Production recovery runner 增加“已持 authority”
  入口，Context Rotation 可在同一 lane 内收口 Journal，不会重复加锁死锁。
- `start-new-context` 与 `agent-cache-reset` 的产品顺序改为：构造并校验候选、
  创建并 stage RecordMutation Journal、登记 Native retirement、提交
  Conversation、在同一 authority 下读回并收口 Journal、最后 promotion。
  Journal stage 或终态失败时不会触发 provider cleanup。
- 每条新 Native binding retirement 保存 `recordMutationId`，Native Store
  validator、retirement identity comparison、live promotion 与启动恢复都把它
  纳入 authority。Live promotion 会先完整验证整个批次的 Journal 绑定和 committed
  终态；缺 reader、非终态或错绑 Journal 在第一个 Native transition 前失败。
- 启动顺序先恢复非终态 RecordMutation Journal，再恢复各 Surface local commit，
  最后处理 Native retirement。Journal committed 只允许 exact target promotion；
  Journal aborted 只允许 exact source/before-target abort；非终态、损坏、未知或
  错绑证据会 quarantine 当前 retirement 并关闭全局 cleanup gate。
- 两类非破坏操作的 candidate 现在只允许约定的缓存/可见性变化；消息或其他
  durable Conversation 记录改写会在 Journal 和 Native effect 前失败。
- 新增崩溃与反例覆盖：Journal stage 后但 Conversation commit 前、Conversation
  commit 后但 Journal terminal 前、Journal terminal 后但 Native promotion 前、
  forged/expired authority、Journal 非终态、Journal aborted、live promotion 缺少
  committed authority，以及重启恢复幂等。
- 本批仍没有打开清空/删除产品 guard，没有切换 legacy reader/writer，也没有对
  真实 Vault 执行 migration、retention、Raw GC、历史删除或 Native 批量 cleanup。
- 本批提交为 `1bd72af`。

## 2026-07-20：破坏性 Conversation Reader/Writer 第一批

- Conversation Store 新增破坏性 source planner。清空记录前会冻结全部旧
  context payload 目录与 legacy payload 文件，不只依赖 active/previous 指针；
  非法条目、symlink、丢失 active payload、重复或变化的 source plan 都会在目标
  commit 前失败。
- `clear-conversation-records` writer 只接受新的空 Conversation context：消息、
  snapshot、rolling summary、可见性标记、token usage 与 Native binding 必须清空，
  shell/workspace identity 保持不变，generation 前进一代。目标 metadata 不保留
  `previousPayloadKey`，旧 payload 也不执行普通 GC，留给 RecordMutation Trash。
- `delete-conversation` writer 新增严格 digest 的 deletion tombstone。tombstone
  是删除 target 的 durable commit marker；旧 Conversation session 目录仍在，
  只有后续完整 Journal participant 才能退休。tombstone 与 source authority
  不匹配、字段未知、digest 错误或同 Conversation 冲突会 fail closed。
- 启动 reconciliation 读取 tombstone 后不再恢复已删除 Conversation，并能修复
  “tombstone 已提交、index projection 尚未更新”的崩溃窗口；Settings hydration
  同步丢弃旧 data shell。
- 新增真实文件夹测试覆盖：清空 target 提交后全部旧 payload 仍在且 source plan
  漂移阻断；删除 tombstone 在 index 更新前故障后仍保持删除 authority、旧 source
  可恢复、重启索引可修复。
- 本批 `npm run test`、typecheck、build、Conversation Store 目标 ESLint、
  `git diff --check`、完整 lint、release contract 与 public guard 通过；完整 lint
  仍为 961 个 baseline finding、无新增。
- 当前仍未实现跨重启 participant execution plan、Root Registry/Trash production
  接线、Run/Raw 处置、Memory/Artifact 选择或 Native retirement；删除产品 guard
  保持关闭，真实 Vault 未修改。

## 2026-07-20：Participant Execution Plan 与破坏性启动恢复

- 新增不可变 `RecordMutationExecutionPlan`。plan 必须在第一个 Journal stage 前
  原子发布，绑定 mutation ID、operation、Conversation、intent digest 和完整有序
  participant；已有 plan 可在重启后幂等加载，Journal 已 stage 后禁止凭空补建。
- Trash participant 冻结 source/trash root ID 与规范化相对路径；Memory/Artifact
  participant 冻结 subject ID，并分别冻结 formal/confirmation 状态或 artifact
  kind。plan 不保存绝对路径，Root 使用集合必须与 intent 的 Root Binding 精确
  相等；未知 Root、漏用 Root、subject 错绑、非法路径、digest 损坏或未知 entry
  全部 fail closed。
- 新增 execution runtime。它用正式 Root Registry 重建当前物理 Root，要求 runtime
  roots 与 frozen refs 完整同序且物理目录互不相同、不嵌套；adapter factory 必须
  返回同 participant、record kind、storage/root/boundary 与 binding，任何错绑都
  在 Trash copy 前失败。
- coordinator 新增 prepare-only 正式入口：取得全局 authority、验证 Root、建立
  durable Trash copy、写 `trash-staged` 后释放 authority，source 始终保持原位。
  后续 retirement 会幂等复用相同 receipt，并在 destructive effect 前再次验证
  Root。
- production root catalog 为 Conversation、Run、Raw、Memory、Artifact 和独立
  Trash 定义稳定逻辑 ID 与真实目录。插件自有 Root 可按选择初始化；vault-managed
  Memory Root 必须已经存在，删除恢复不会初始化一套空 Memory Store。
- Settings startup recovery 不再对全部 destructive Journal 直接报
  “participants required”。它会加载 immutable plan、重建 production roots、
  prepare/replay Trash 与 Memory/Artifact adapter，再交给 production runner。
  真实目录测试已覆盖“deletion tombstone 已提交、Trash 尚未 prepare”的崩溃窗口：
  重启能补齐 Trash、退休旧 Conversation session、提交 Journal，重复启动保持幂等。
- Memory adapter 现在可冻结 formal/confirmation subject state，Artifact adapter
  可冻结 artifact kind；状态或 kind 漂移会在正式 Store effect 前阻断。
- 当前全量 `npm run test`、typecheck、build、完整 lint、release/public guard、
  新增 production 文件目标 ESLint 与 `git diff --check` 已通过。完整 lint 保持
  961 个 baseline finding、无新增；public guard 明确暂存后检查 408 个 tracked
  files。Watchdog terminal commit error 仍是故障注入测试的预期日志。
- 本批没有打开 clear/delete 产品 guard，没有枚举真实 Run/Raw/Memory/Artifact，
  没有触发真实 Vault migration、retention、Raw GC、历史删除或 Native cleanup。

## 2026-07-20：Conversation 级严格只读记录盘点

- Run Record Store 新增全量 subject scan。盘点从正式 head/manifest/generation
  反查 Workflow、Attempt 与 payload identity，校验完整 chain 和 payload bytes；
  missing/unexpected Attempt、payload 状态矛盾、未知目录、staging 残留、损坏记录
  或扫描期间 head 漂移都会 fail closed。
- Run payload inventory 只提取显式 `rawRef` metadata，不返回 event body；结果同时
  保存全 Store Raw owner，使 Raw exclusivity 不依赖目标 Conversation 的局部视图。
- Workflow Artifact Lifecycle 新增 existing-store 全链扫描。缺 Root 返回空且不
  初始化；存在 Root 时要求 namespace、staging 和全部 chain 合法，并以双次稳定
  snapshot 防止选择期间漂移。
- EchoInk Memory V2 新增正式 existing-store snapshot。该路径不会创建目录、
  迁移 index 或修复 Markdown projection；严格读取 manifest/index/pending journal
  与 transaction source，manifest/index revision 不一致、损坏 transaction 或读中
  变化都会阻断。pending event、未收口和 durable-pending transaction 会进入统一
  Conversation blocker。
- 新增 `conversation-record-inventory.ts`，合并 Run、Memory、Artifact 与 Raw：
  shared Raw 固定 retain，只有 exclusive Raw 生成 discard；Memory confirmation
  与 Artifact 没有显式 retain 决定时保持 blocked；结果不包含消息正文、Run event
  body、Memory statement 或绝对路径。
- 新增回归覆盖确定性双读、跨 Conversation shared Raw、missing Raw、pending
  Memory、Artifact 显式选择、Run 漏挂以及 Store 未初始化/不修复行为。
- 当前 `npm run test`、typecheck、build、完整 lint、目标 production ESLint、
  release/public guard 与 `git diff --check` 已通过；完整 lint 保持 961 个
  baseline finding、无新增，public guard 检查 410 个 tracked files。
- 本批仍未实现 Workflow Run source-deletion adapter、execution participant
  构造、live clear/delete runner 或 Native retirement；产品 guard 继续关闭，
  没有读取 Raw 正文，也没有修改真实 Vault。

## 2026-07-20：Workflow Run Payload Source-deletion

- Run Record Store 新增 `user-deleted` payload tombstone 的 inspect、recover 与
  restore 合同。原 payload generation 被 Trash 退休后，正式 head 仍返回
  `expired`，不会退化成 `missing/corrupt`；补偿在 Trash source 恢复后发布新的
  active payload generation，不回写旧 head。
- Forward 与 restore 都能恢复“generation/manifest 已发布、head link 尚未完成”
  的崩溃窗口。恢复会校验 Workflow Run、Attempt、Harness Run、原 payload digest、
  tombstone 与前后 generation chain，重复进入保持幂等。
- 新增 `run-record-source-deletion.ts`，把 Run payload 接入通用
  `mark-source-deleted` participant。Receipt 绑定 mutation、Conversation、逻辑
  participant、冻结 payload identity 与 effect；production factory 已能从
  immutable execution plan 和 Run Root 重建 adapter。
- Run inventory 的 present payload 现在返回正式 generation 相对路径，供后续
  Trash participant 构造使用；路径仍不包含绝对目录或 event body。
- 当前未提交树的 `npm run test`、`npm run typecheck`、`npm run build`、完整
  `npm run lint`、新增生产文件定向 ESLint 与 `git diff --check` 已通过；完整
  lint 保持 961 个 baseline finding、无新增。Watchdog terminal commit error 是
  故障注入预期日志。明确暂存 13 个预期文件后，release contract 与 public guard
  通过；public guard 检查 412 个 tracked files，暂存区不含共享软链接。
- 容量审计确认 32 个 Journal participant 不能等同于 32 条叶子记录。后续按
  record kind、action 与 frozen Root 生成确定性 bundle，Journal 保存 aggregate
  step，execution plan 与 Store/Trash receipt 保留完整逐叶证据。单纯提高
  participant/step/revision 上限或拆成多个独立业务 mutation 均被拒绝。
- 本批没有打开 clear/delete 产品 guard，没有修改真实 Vault，也没有执行
  migration、retention、Raw GC、历史删除或 Native cleanup。

## 2026-07-20：Deterministic Bundle Planning

- Execution Plan schema 升级为 V2，最大 durable plan 为 8 MiB，单个 bundle
  最多保存 16,384 条叶子。新增 `retain-bundle`、`trash-bundle` 与
  `source-deletion-bundle`，participant ID 绑定 record kind、action、Root、
  selection digest 和完整有序叶子集合。
- retain bundle 不再只保存不可逆 item ID。Run summary、Attempt summary、
  expired/not-captured payload 都保存正式 identity 与 digest/reason；shared Raw
  保存 `rawRef`、相对路径和 owner proof digest。对应 Run/Raw Root 同时进入 intent
  的冻结 Root Binding，后续 runtime 可以逐叶回读。
- 同一 inventory 的所有 bundle 必须使用同一个 selection digest；同一
  record kind/action/Root 逻辑组只能出现一次，不能拆组绕过容量上限。Workflow Run
  payload 的 source-deletion 与 Trash bundle 必须覆盖完全相同的叶子 identity。
- 新增 Conversation mutation planner，把 ready unified inventory、冻结的
  Conversation source 和 Root Binding 编译成 intent 与 execution plan。40 个
  Workflow Run 的回归包含 127 条唯一记录，只生成 8 个逻辑 participant；输入逆序
  结果一致。delete/clear source 必须分别绑定目标 Conversation 目录或其合法 payload；
  blocked inventory、缺失 Attempt summary、重复或跨 Conversation source、Root
  缺失、16,385 条单组、selection 不一致和重复逻辑组均在 Journal/effect 前阻断。
- bundle runtime 尚未接线时，materializer 明确返回
  `bundle_runtime_required`，Journal 保持 `planned`，Conversation source 不变，
  Trash prepare 与 Store effect 都不会发生。
- 当前 `npm run test`、`npm run typecheck`、`npm run build`、完整
  `npm run lint`、新增生产文件定向 ESLint 与 `git diff --check` 已通过；完整
  lint 保持 961 个 baseline finding、无新增。Watchdog terminal commit error 是
  故障注入测试的预期日志。明确暂存 12 个预期文件后，release contract 与
  public guard 通过；public guard 检查 414 个 tracked files，共享软链接未暂存。
- 本批仍未打开 clear/delete 产品 guard，没有部署或修改真实 Vault，也没有执行
  migration、retention、Raw GC、历史删除或 Native cleanup。

## 2026-07-20：Trash Bundle Runtime 与恢复语义

- Trash bundle 使用现有逐叶 durable receipt 作为真源。aggregate prepared receipt
  绑定 mutation、participant、selection、source/trash Root、完整有序路径和 leaf
  receipt digest；aggregate finalization receipt 绑定全部逐叶 finalization
  digest。两类 aggregate receipt 都可由逐叶证据重建，不单独保存可变副本。
- coordinator 只在全部叶子 prepare 后发布一次 `trash-staged`，只在全部叶子
  retirement 后发布一次 `source-retired`。部分叶子崩溃会留下可重放证据，但不会
  留下部分 Journal 成功；重启会先补齐整组，再发布 aggregate step。
- bundle restore 在写第一个叶子前先检查整组 judgment。已知冲突会整体阻断；
  运行中断造成的部分 restore 可以重入。全部恢复后才发布一次 `trash-restored`，
  其 evidence 与 `compensation-prepared` 都绑定 aggregate prepared digest。
- 每个叶子 effect 前重新验证物理 Root Binding。bundle participant ID 再次绑定
  record kind、action、selection、完整 items 与 source/trash Root，不能绕过
  execution plan 换一组路径。重复路径和父子嵌套路径在 plan/runtime effect 前
  fail closed。
- execution materializer 已支持跨重启重建 `trash-bundle` participant；
  production recovery runner 已支持 single/bundle 两类 Trash participant，可对
  partial retirement 先整组补齐再补偿恢复。
- focused suites 已覆盖确定性 prepare/replay、逐叶 evidence 重排、部分 prepare、
  部分 retirement、部分 restore、冲突预检、materializer 重启、exact-target
  roll-forward 与 before-target compensation。`npm run test`、typecheck、build、
  baseline lint、修改生产文件定向 ESLint 和 `git diff --check` 已通过；完整 lint
  保持 961 个 baseline finding、无新增。
- 明确暂存 11 个预期文件后，release contract 与 public guard 通过；public guard
  检查 414 个 tracked files，暂存区不含共享软链接或无关文件。
- `retain-bundle` 与 `source-deletion-bundle` runtime 仍未接线。产品 guard 保持
  关闭，本批没有部署或修改真实 Vault。

## 2026-07-20：Source-deletion Bundle Runtime 与聚合恢复

- 新增 logical source bundle adapter。Run、Memory、Artifact 每个叶子继续使用
  原 Store adapter 与独立 durable receipt；aggregate forward/restore receipt
  由 frozen subject、selection digest、Root Binding 和完整有序 leaf receipt
  digest 推导，不新增可漂移的聚合 Store。
- 只有所有叶子 forward 并稳定回读后，Journal 才发布一次
  `participant-staged`。部分 forward 崩溃后，通用 adapter 的可选
  `reconcileForward` 只在已经存在部分 durable effect 时补齐缺失叶子；全组 before
  时不会为了补偿凭空制造 forward effect。
- compensation 绑定 aggregate forward digest。部分 restore 可幂等补齐；如果
  所有叶子已经恢复、但进程在 aggregate `participant-restored` 发布前中断，重启会
  接受已有 `compensation-prepared` 与 forward proof，再重建 aggregate restore
  receipt 并收口 Journal。
- 每个叶子 recover、inspect、forward 与 restore 前后重新验证 frozen Root
  Binding。bundle participant ID、selection、subject 顺序、语义叶子 ID、Store
  adapter 和物理 Root 任一漂移都会在首个叶子 effect 前失败。
- production factory 按正式 subject 构造逐叶 adapter：Run 使用
  `workflowRunPayloadParticipantId(workflowRunId, attemptId)`，Memory 使用
  `memoryId`，Artifact 使用 `artifactId`。execution materializer 已接受
  `source-deletion-bundle`，并保持 `retain-bundle` fail closed。
- focused source-bundle、execution-runtime 与 production Run adapter suites
  通过；全量 `npm run test` 输出 `All tests passed`，`npm run typecheck`、
  `npm run build`、修改生产文件定向 ESLint 与 `git diff --check` 通过。完整
  `npm run lint` 保持 961 个 baseline finding、无新增。Watchdog terminal commit
  error 是故障注入测试的预期日志。
- `retain-bundle`、live clear/delete、Conversation target commit 与 Native
  retirement 仍未接线，destructive product guard 保持关闭。本批未部署或修改真实
  Vault。

## 2026-07-20：Retain Bundle Runtime 与 destructive startup recovery

- `retain-bundle` 已从 `bundle_runtime_required` 升级为首次 Trash prepare 前的
  frozen selection 门禁。materializer 先重载 durable Journal；缺少合法 proof 时
  必须调用 production verifier，缺 verifier 返回
  `inventory_verification_required`，选择漂移返回 `inventory_mismatch`。
- production verifier 连续两次重建完整 Conversation inventory，从 execution plan
  恢复 Memory/Artifact 处置选择和 Conversation source，再通过正式 planner 重编译
  intent 与 participants。snapshot、selection digest、intent、participant 顺序和
  runtime Root 集合必须全部与冻结计划一致。
- 每个 retain bundle 的 `prepared` evidence 绑定 mutation、intent、execution
  plan、participant、完整 subjects 和 Root Binding。全部 retain proof 必须先于
  第一条 `trash-staged`；错误 evidence、Trash 已 stage 但 proof 缺失均 fail
  closed。
- runtime 在 verifier 前后和每条 proof 发布前重新验证 retain Root 的 Registry
  authority 与当前物理 binding。测试已覆盖 verifier 抛错、shared Raw owner graph
  漂移、Root 目录替换、伪造 evidence、多个 retain bundle 有序发布和旧 Journal
  snapshot 幂等重放。
- destructive startup recovery 取得同一 Conversation mutation authority 后，
  在 authority 内完成 execution plan load、Root materialize、selection proof 和
  recovery runner，不再重复取得 authority。目标 Conversation 已通过 deletion
  tombstone 移出 data shell 时，已有完整 proof 可直接复用；缺 proof 时仍因无法
  重建 inventory 而阻断。
- 当前 focused execution-runtime、Conversation inventory 与 Conversation Store
  startup suites 已通过；最终工作树的 `npm run test` 输出 `All tests passed`，
  typecheck、build、baseline lint 和 `git diff --check` 通过。完整 lint 仍为
  961 个历史 finding、无新增；两个新增/修改的 Harness 生产文件定向 ESLint 为
  0。明确暂存 10 个预期文件后，release contract 与 public guard 通过，public
  guard 检查 417 个 tracked files；共享软链接未暂存。本批尚待提交。
- destructive product guard 保持关闭；没有部署或修改真实 Vault，也没有执行
  migration、retention、Raw GC、历史删除或 Native cleanup。

## 2026-07-20：Live Conversation RecordMutation 与跨 Store authority

- 新增 live `ConversationRecordMutation` coordinator。普通 Conversation 的清空和
  删除现在统一执行双次稳定 inventory、Root Registry、不可变 execution plan、
  retain proof、Journal/Trash、Conversation target CAS、Store readback recovery、
  Native retirement 与 `data.json` 投影；每个会话使用独立 mutation 和 receipt。
- `clear-conversation-records` 提交新的空 payload/context 并保留会话壳；
  `delete-conversation` 提交外置 deletion tombstone。目标写入 Promise 抛错后仍以
  durable readback 为准：tombstone 已落盘则 roll-forward，未落盘则补偿并恢复
  原 Conversation。
- 删除会话产品 guard 已移除；普通会话右键菜单新增“清空会话记录”。preview
  blocker 与用户取消都不会创建 mutation，Knowledge/运行中会话继续阻断。
- 产品确认文案明确 Memory/Artifact 边界：会话操作只保留记录并追加来源变化；
  如需丢弃，必须先在正式 Memory 或产物管理中单独处理。
- Native deletion retirement 新增 tombstone target identity。promotion 必须读到
  committed RecordMutation Journal，并同时匹配 mutation、source Conversation、
  tombstone ID/digest；partial registration 失败时已登记记录会被补偿为
  failed/aborted，不能进入 cleanup。
- Storage Inventory 新增正式来源 `record-mutations`，严格扫描完整 revision
  chain。deleted Native retirement 只有同时匹配 deletion tombstone、committed
  Journal 与 source/target identity 才视为 linked；aborted Journal 只有在原
  Conversation 精确恢复且 retirement 已 aborted 时视为一致，错绑继续阻断迁移。
- 故障注入覆盖 target CAS 失败、tombstone 耐久后 Promise 抛错、`data.json`
  投影失败后的重启修复、Native retirement 部分登记、用户取消、preview blocker
  和 tombstone digest 错绑。本批最终全量 `npm run test` 已输出
  `All tests passed`；typecheck、build、baseline lint、`git diff --check` 与新增
  coordinator 定向 ESLint 均通过。明确暂存 25 个预期文件后 release contract 与
  public guard 通过，public guard 检查 419 个 tracked files；checkpoint commit
  尚待收口。
- 本批没有部署或修改真实 Vault，也没有执行 migration、retention、Raw GC、
  历史删除或 Native 批量 cleanup。Phase 2 仍未完成；下一批进入 Knowledge
  History 引用投影、Raw GC preview、retention、migration validator 与 V2→V1
  exporter。

## 2026-07-20：Knowledge History V2 引用投影

- `src/knowledge-base/history-store.ts` 已改为 reference-only V2。日文件只保存
  Conversation/message identity、message revision 和可选 run ID；浏览时按 revision
  回读 canonical Conversation，正文、Raw 和 backend binding 不再复制进 History。
- generation 使用 staging → 完整 manifest/index/suppressions/day refs 校验 →
  source 二次读取 → `active.json` 原子切换。故障或 Conversation 漂移发生在 active
  发布前时，旧 generation 继续可读。
- rebuild、persist、retention 与 delete 进入同一个 root-keyed writer lane。
  显式删除发布 suppression；普通保存或 rebuild 不复活旧 message，同日期的新
  message 仍可进入投影。History remove-all 发布空 generation，不删除 V1 root、
  Conversation 或 Conversation-owned Raw。
- Settings 保存固定为完整 Conversation durable pass → History projection →
  `data.json` shell；History 不再压缩 canonical message，也不再触发第二次
  Conversation flush。设置页移除了已经失真的“压缩旧过程记录”操作。
- V1 cutover 采用显式门禁：普通启动/保存不切换 populated V1，rebuild、delete、
  retention 和 direct persist 统一抛出 migration-required；只有正式 migrate
  入口传入 `allowLegacyCutover` 才能在 V1 与 canonical Conversation 完整对账后
  发布 active。空 V1 可直接初始化；冲突时 V1 原字节、active 和迁移 receipt 均
  保持未变。
- Storage Inventory 已升级 History schema 扫描，验证 active generation、
  manifest、index、suppressions、strict ref、digest、row count 和 source revision。
  History 不再参与 Raw owner graph；History→Conversation 关系明确区分 linked、
  missing 和 ambiguous。
- 新增/调整测试覆盖 reference-only schema、旧 active 保留、source drift、
  suppression、writer lane、startup/ordinary-save cutover gate、所有 mutation
  gate、空 V1、显式迁移、V1 冲突与字节保留，以及 Inventory 的 Raw ownership 和
  strict reference findings。
- 最终 `npm run test` 输出 `All tests passed`（108.9 秒）；typecheck、build、
  release/public guard 与 `git diff --check` 通过。History/Inventory 三个主要生产
  文件定向 ESLint 为 0；完整 lint 从 961 降到 942 并同步收紧 baseline。明确暂存
  12 个预期文件，public guard 检查 419 个 tracked files；共享软链接未暂存。
- 代码 checkpoint 已提交为 `3b1ca7f`。本批没有执行真实 migration、retention、
  Raw GC、历史删除、Native cleanup、部署或 Vault 修改。Phase 2 下一步进入 Raw
  GC preview、跨 Store 30/90 天 retention、Archive Catalog、migration validator
  与 V2→V1 exporter。

## 2026-07-20：Metadata-only Raw GC preview

- 新增全局 Raw GC preview。输出只有 opaque subject ref、文件大小/mtime、owner
  count/kind 与 retain/quarantine-candidate，不读取或返回 Raw body、rawRef、文件名
  或绝对路径。
- owner graph 合并全部 canonical Conversation message 与全部正式 Run payload。
  Memory/Artifact 当前没有 Raw owner 字段，但仍执行 strict existing-store scan；
  未知 entry、损坏 chain 或 future schema 不能被当成“无 owner”。
- Run inventory 的 expected Attempt/payload 检查由目标 Conversation 扩展到全
  Store。无关 Conversation 的 ownership gap 也会阻断全局 GC，而不是被过滤掉。
- Conversation、Run、Memory、Artifact 和 Raw Store 会完整 capture 两次；跨扫描
  任一 digest 漂移时整轮返回 `inventory-drift`，不保留旧 candidate 分类。
- missing Raw、缺 canonical Conversation authority、Run ownership 不完整或任一
  Store corruption 会把 preview 标为 blocked，并令全部 candidate
  `eligibleForQuarantine=false`。safety receipt 固定零 action、零 destructive
  effect、禁止 automatic action。
- 测试覆盖 Conversation/Run owner 与真实 orphan 的分类、正文/路径不泄露、缺失
  Raw、扫描中 Raw 漂移、无关 Run gap、Conversation Store 缺失和损坏 Artifact
  Store。focused suite 与全量测试均通过；全量 `npm run test` 输出
  `All tests passed`（111.1 秒）。
- typecheck、build、完整 baseline lint、修改生产文件定向 ESLint、
  `git diff --check`、release/public guard 均通过；lint 保持 942 条 baseline，
  public guard 检查 419 个 tracked files。
- 代码 checkpoint 已提交为 `f1b4caf`。本批没有移动、隔离或删除任何 Raw，也没有
  修改真实 Vault。后续 destructive checkpoint 必须接入可恢复 Trash/Journal，
  并在至少 7 天后通过第二次完整稳定 owner scan 才能永久删除。

## 2026-07-20：Run Record retention 与可恢复逻辑过期

- 新增全 Store Run Record retention。默认合同为 Attempt payload 30 天、
  Attempt/Workflow summary 90 天；Conversation、Workflow Artifact 与正式
  Memory 继续由各自 authority 和保留期治理。
- preview 在恢复证据 authority 内执行两次稳定的只读 inventory。底层会完整
  读取、解析并校验 payload events；preview/plan 只输出 record metadata，不返回
  事件正文。WAL、Artifact lineage、人工恢复等 hold 会从 payload/Attempt 传播
  到整个 Attempt，再聚合到 Workflow，避免局部 summary 被普通策略过期。
- executor 固定按 payload → Attempt summary → Workflow summary 发布逻辑
  tombstone，并使用不可变 plan 与 append-only progress Journal。not-captured 和
  已 expired 视为 settled；Attempt summary 只有 payload settled 后可过期，
  Workflow summary 只有全部 Attempt summary settled 后可过期。
- `FileRunRecordStore` 新增 root-keyed、可重入的 Store mutation lane。普通
  generation publication 与 retention mutation 共用 authority；计划后新增或减少
  subject、首个 effect 前 snapshot 改变、执行时 hold/eligibility 改变都会拒绝旧
  plan。
- tombstone 已发布但 progress step 尚未落盘时，执行器可从 Store readback 补齐
  有序 Journal prefix。相同 payload tombstone 重放幂等；不同 tombstone、prior
  digest 漂移、越序 effect 或 Journal 损坏继续 fail closed。
- Archive Catalog、README、Memory V2 实现说明和中英文设置文案已同步 30/90 天
  合同，并明确区分 `expired`、`missing` 与 `corrupt`，不再承诺所有历史明细永久
  可查。
- 审查发现并修复两项旧计划穿透：新增 Store subject 现在会阻断执行；preview 后
  新增恢复 hold 会在第一个 tombstone 前阻断。部分 action 已完成时，剩余 action
  通过稳定 tombstone digest 复核，不会因重编排 ordinal 误报漂移。
- Run Record retention 与 Run Record Store focused suites、全量
  `npm run test`（`All tests passed`，114.3 秒）、typecheck、build、完整
  baseline lint、release/public guard 与 `git diff --check` 均通过。完整 lint
  保持 942 条 baseline finding；明确暂存 11 个预期文件，public guard 检查
  421 个 tracked files，共享软链接未暂存。
- 代码 checkpoint 已提交为 `48264d6`。本批只完成逻辑 expiration 与 recovery
  Journal：immutable payload 字节尚未通过 Trash 物理退休，Journal root 尚未进入
  Storage Inventory 或生产启动恢复，也未接入自动 retention、部署或真实 Vault。

## 2026-07-20：Run payload 可恢复物理退休与生产启动恢复

- 新增 `AttemptPayloadRetirementReceiptV1`。receipt 精确绑定 policy tombstone、
  prior payload generation/manifest、payload digest 与 SHA-256、Trash prepare/
  finalization receipt、retention transaction 和相邻 Store revision。
- Run Store 新增 `retired` content kind。policy tombstone 只证明逻辑过期；prior
  generation 缺失但没有匹配 retirement receipt 时仍判 `corrupt`，不能伪装成
  正常 `expired`。Attempt summary 必须等预期 payload 完成物理退休后才能过期。
- Retention payload action 改为
  `trash-prepared → tombstone-published → source-retired`。execution header 在
  第一次 prepare 前冻结路径、Root Binding、generation 和 digest。prepare、
  tombstone、source rename、receipt publication 与 progress publication 的崩溃
  窗口均可幂等重放。
- prepare 后或 tombstone 后新增 hold 都会阻断后续破坏性阶段。tombstone 后不
  自动补偿 policy expiration；source 保留，transaction 维持非终态并等待安全
  roll-forward。
- 新增生产 recovery-evidence authority。它在全局 RecordMutation authority 与
  Run Store mutation lane 内读取真实维护 WAL、未收口 RecordMutation、
  Workflow Artifact lineage 和 Run inventory。WAL writer、Artifact lifecycle
  writer 与破坏性 Conversation mutation 同样接入这把 authority，避免 snapshot
  在不可逆 effect 前失效。
- 新增 `recoverStartedRunRecordRetentionSweeps()` 并接入
  `EchoInkHarnessService`。启动顺序位于全部 local commit recovery 之后、Native
  retirement promotion/provider cleanup 之前。它只枚举已有 `plan.json`，不会
  preview、生成 transactionId 或创建新 sweep；根缺失返回 0，所有 Journal 在第一个
  retention effect 前完整验证。
- Run/Trash Root Binding 由 production root catalog 按需重建。Root resolver 只有
  在存在未完成 payload action 时调用；completed replay 不新增 generation、
  receipt、Journal phase 或 Root 初始化。
- Storage Inventory schema 升为 V2，新增 `run-record-retention` source，严格扫描
  plan、execution header、step、Trash prepare/finalization evidence、phase chain、
  pending/completed 数量和 staging/unsafe/corrupt finding。输出保持
  metadata-only，不泄露 transaction ID、subject ID 或路径。
- focused suites、`npm run test`（`All tests passed`，122.2 秒）、
  `npm run typecheck`、`npm run build`、`npm run lint`、release/public guard 与
  `git diff --check` 已通过。lint 保持 942 个 baseline finding，无新增；明确暂存
  24 个预期文件，public guard 检查 422 个 tracked files。
- 本批没有自动创建 retention sweep，没有部署或修改真实 Vault，也没有执行 Raw
  quarantine、migration、历史批量删除或 Native 批量 cleanup。

## 2026-07-20：Raw quarantine、七天隔离与可恢复 purge

- 新增 `raw-gc-quarantine.ts`。显式执行必须提交精确 preview digest、排序且唯一的
  opaque subject 集合和确认时间；执行时重复完整 metadata-only owner scan，
  candidate/owner/source snapshot 漂移会在 Journal 创建前失败。
- append-only plan 冻结 transaction、Raw/Trash Root Binding、source relative
  path 与 dev/inode/size/mtime/ctime。Trash prepare、source quarantine、
  purge recheck、purge authorization、两份 Trash unlink 和终态 receipt 都有独立
  evidence/step；未知文件、非连续 step、错绑 receipt 或 future schema fail closed。
- quarantine 先建立带 SHA-256 的独立 Trash copy，再把 exact source rename 到
  retired 区。source move 后但 progress 前的崩溃可从 finalization readback
  roll-forward，不会重新发明 source、Root 或 transaction identity。
- 永久 purge 至少等待 7 天，并重新运行全量稳定 Conversation/Run/Memory/
  Artifact/Raw owner scan。新 owner 会表现为 missing reference blocker；相同
  rawRef 被重建也会阻断。`purge-authorized` 在首个 unlink 前耐久发布，unlink 后、
  progress 前崩溃可幂等收口；Trash SHA/identity 改变时两份副本都保留。
- 生产 owner authority 持有 settings saveQueue、Raw owner lane、全局
  RecordMutation authority 和 Run Store mutation lane。Raw 外置写入、启动 Raw
  migration 与普通 Conversation mutation 已进入相同冻结边界，避免未提交引用被
  当成 orphan。
- 启动 reconciliation 在全部 local commit recovery 后先恢复已发布 Raw GC plan，
  再恢复 Run retention，最后才处理 Native promotion/provider cleanup。启动不
  preview、不创建 GC transaction，也不会因满 7 天自动发布 purge authorization。
- Storage Inventory schema 升为 V3，新增 `raw-gc-quarantine` source，严格解析
  plan/step/prepare/finalization/recheck/purge evidence 并仅报告 metadata 计数。
- 故障注入覆盖 source quarantine 后、purge authorization 后、retired-source
  unlink 后的崩溃；还覆盖 preview drift、七天门禁、late owner、启动不自动授权和
  Trash byte tamper。focused suite 与全量 `npm run test`（`All tests passed`，
  125.1 秒）、typecheck、build、baseline lint、release/public guard 和
  `git diff --check` 均通过。lint 保持 942 个 baseline finding；明确暂存 15 个
  预期文件，public guard 检查 424 个 tracked files。
- 本批没有创建真实 Vault GC transaction，没有移动或删除真实 Raw，没有部署、
  migration、retention sweep 或 Native 批量 cleanup。

## 2026-07-20：Migration Validator 与 History/Deletion 迁移门禁

- 新增完整 subject/owner migration ledger 与 validator。缺失、额外项、parent、
  ordinal、revision、正文 digest 和 owner 漂移都会阻断；报告与 quarantine 只含
  opaque SHA-256 ref，trusted proof 只在当前进程内有效。
- V1/V2 Conversation Store 新增严格只读 migration snapshot；不会初始化或修复
  Store。未知字段、未知 entry、index/payload/metadata/staging 漂移均 fail closed。
- side-by-side copier 对完全相同记录幂等复用，同 ID 冲突不覆盖，并默认耐久发布
  metadata-only quarantine。Conversation manifest validated transition 必须消费
  validator trusted proof。
- Conversation V2 新增 immutable deletion tombstone namespace。迁移只接受目标
  Store 真实 readback；active Conversation 与同 ID tombstone 不能同时存在。
- active cutover fence 保存完整 active manifest。fence 发布后崩溃时 reader 保持
  V1 并报告 `active-cutover-pending`；恢复幂等补齐 manifest entry 后才选 V2。
- History 首次 cutover 现在比较真实 V1 index/day ledger 与 staged V2 generation，
  首轮不应用 retention/suppression，也不把 canonical 全量清单冒充 legacy source。
  冲突在 active publish 前写 opaque quarantine；V2 reference 移除 legacy
  `runId`，History reader/rebuild 能按 active manifest 读取 Conversation V2。
- 当前 `npm run test` 输出 `All tests passed`（128.0 秒）；typecheck、build、
  baseline lint、release guard、四组 focused suites 与 `git diff --check` 通过。
  lint 保持 942 个 baseline finding，无新增；public guard 在明确暂存本批文件后
  执行。
- 本批未部署、未改真实 Vault、未执行真实 migration/retention/Raw GC/History
  删除或 Native cleanup。真实 Native/Run/settings owner proof 与 V2→V1 exporter
  仍是 Phase 2 后续门禁。

## 2026-07-20：V2→V1 compatibility exporter 与 portable 回迁

- 新增 `conversation-v1-exporter.ts`。Exporter 只从 manifest-selected active
  canonical V2 Store 读取，两次 source scan 必须得到相同 fingerprint；generation
  ID 同时绑定 active manifest digest、source fingerprint 和
  `conversation-portable-v1` 投影。
- 输出固定为
  `conversation-v1-exports/export-<digest>/{plan.json,store,validation.json}`。
  Export 与 reader activation 分离；原始 V1、active V2 和现有 reader route 不会
  因导出成功而变化。
- V1 restore writer 新增 plan-bound import。每次写入前严格验证同代 plan、普通
  文件/目录、generation、source identity 与 digest；missing→created、
  exact→reused、different→conflict。Conversation 与 tombstone 均不覆盖冲突项。
- portable projection 保留产品 Conversation/Context/message/Snapshot/Raw/
  Presentation，排除 Native、backend 和 Run diagnostics。V2 execution lineage
  必须由外部 Run owner edge 证明，不能降级伪装成 V1 `runId`。
- Migration inventory schema 升为 V2，proof 绑定 projection 与 V1↔V2 方向。
  Conversation revision 改用跨版本稳定的产品摘要，V2→V1→V2 ledger 因而可直接
  对账。
- 测试覆盖完整 round-trip、幂等 replay、source drift、缺 Run owner、非 canonical
  source、future index、同 ID 冲突与 opaque quarantine，以及 seed rename 和
  commit marker 崩溃恢复。恢复阶段曾把缺失字段与 `undefined` 误判成冲突，现已在
  readback 规范化后修复。
- exporter 与四组相关 focused suites、`npm run test`（`All tests passed`，
  128 秒）、typecheck、build、baseline lint、release/public guard 和
  `git diff --check` 均通过。lint 保持 942 个 baseline finding；public guard
  在明确暂存 12 个预期文件后检查 430 个 tracked files。
- 本批未实现 reverse activation、精确 namespaced reader route 或真实
  Native/Run/settings Store proof；未部署、未修改真实 Vault，也未执行 migration、
  retention、Raw GC、History 删除或 Native cleanup。

## 2026-07-20：Reverse activation 与精确 restored-V1 route

- 新增独立 Conversation restore manifest，固定按
  `reverse-copying → reverse-validated → reverse-active` 推进，并绑定 forward
  active digest、source/target fingerprint、export generation 与 plan digest。
- reverse active fence 在终态 entry 前发布；fence 后崩溃时 reader 继续选择 V2，
  recovery 只能补齐 fence 内同一候选，完成后才选择精确
  `v1-export:<generationId>/store`。
- Store selection 统一返回 store ref、精确 root、route revision/digest 与双
  manifest。forward authority、plan 或 export directory chain 损坏时 fail closed，
  不会回落 retained legacy V1。
- History list/read/day resolve/rebuild 已改用 selection root。真实集成 fixture
  故意污染 legacy V1 同 ID 正文后，restored route 仍解析 exported V1 的正确正文。
- fresh activation 同时验证 source 与 target；source/target drift、future schema、
  未知 entry、plan tamper、missing/symlink root、missing forward authority、
  并发 CAS 和 fence crash/recovery 均有反例。architecture guard 阻止生产代码绕过
  exporter coordinator 直接发布 active transition。
- focused suites、`npm run test`（`All tests passed`，131 秒）、typecheck、build、
  baseline lint、release/public guard 与 `git diff --check` 通过。lint 保持 942 个
  baseline finding，无新增；明确暂存 14 个预期文件后，public guard 检查 433 个
  tracked files。
- 本批未部署、未修改真实 Vault，也未执行 migration、retention、Raw GC、History
  删除或 Native cleanup。下一批接真实 Native/Run/settings owner proof 与副本
  dry-run。

## 2026-07-20：Phase 2/3 收口与 Hermes ACP session resume

- Phase 2 最终策略确定为：自动维护只恢复已发布的 retention/Raw GC 事务，不自动
  创建新的清理任务。自动清理不是本轮待补项。
- 本机只读核对 Hermes 0.18.0：ACP protocol 1 公开 `session/list`、
  `session/load` 和不稳定的 `session/resume`，未公开 delete。EchoInk 选择稳定
  `session/load`，不直接调用 Hermes 内部数据库删除方法。
- ACP runtime 保存真实 capability snapshot。Adapter 连接后才决定 Hermes resume
  是 native 还是 emulated；缺 capability 时保持 context rehydrate。
- 已登记 session 复用前按 cwd 枚举并加载精确 ID。加载回放的旧历史被隔离，不会
  冒充本轮输出；load 返回不存在时在 Prompt 前 fail closed，不新建替代 session。
- OpenCode 1.4.3 的 CLI 继续公开 session list/delete；既有 resume/delete 接线
  不变。Hermes cleanup 继续 truthful unsupported。
- 专项只运行主路径和 stale-load 阻断路径；最终统一运行一次全量门禁。
  `npm run test`、typecheck、build、release/public guard 和 `git diff --check`
  通过；lint 保持 942 个 baseline finding，无新增。实机只读 capability probe
  通过。没有部署、修改真实 Vault、执行迁移或清理。
