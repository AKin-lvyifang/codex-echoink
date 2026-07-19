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
  本批次仍待最终 cached diff 审计和 Git 提交。
- 本批次没有接管 legacy reader/writer，也没有连接生产删除。Root Registry、
  root binding digest、全局 mutation coordinator/lock，以及 Trash finalize 的
  durable Journal 自授权仍是下一阻断项。Node 最后一个 syscall 的外部竞争窗口
  继续按已声明的协作 writer 威胁边界处理。
- 没有修改真实 Vault，也没有执行 migration、retention、Raw GC、历史删除或
  Native 批量 cleanup。
