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
