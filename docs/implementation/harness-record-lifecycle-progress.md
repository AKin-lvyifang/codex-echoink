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
digest；跨层 ref 缺失、乱序或不一致都 fail closed。Ref 与当前 Registry/物理
目录的重新验证尚未接入低层 Trash effect，必须由下一批 coordinator 在 finalize
前执行。

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
- 当前批次：Root Registry 与首次 chain 原子发布

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
| Phase 2：数据治理 | 进行中 | `b2db2f5` 基础 checkpoint、Root Registry、首次 chain 原子发布与跨层 Root Binding Ref | 实现全局 coordinator/lock 与受控生产入口 |
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

- Conversation V2、Run Record 与 RecordMutation 当前均为 side-by-side 基础设施；
  legacy reader/writer 尚未切换，不能把合同测试写成生产数据已迁移。
- destructive intent、prepared/finalization Trash receipt 与 recovery evidence
  已冻结完整 Root Binding Ref；全局 mutation lock/coordinator 仍未实现，现有
  fixture-only 恢复也尚未升级为生产 recovery runner。
- `finalizeRecordMutationTrash()` 仍是低层原语，不会自行读取 durable Journal
  验证 `trash-staged` 授权；在 coordinator 把授权证明接入前，生产删除 guard
  必须保持关闭。当前仓库只有 fixture 调用它。
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

1. 实现全局 mutation coordinator/lock，让 Trash finalize 只能在 durable
   Journal 授权和 Root Binding 再验证后发生。
2. 接入生产 side-by-side reader/writer、History 引用投影、Raw owner graph/GC
   preview、四类用户操作 coordinator、migration validator 与 V2 → V1 exporter。
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

`.codex-memory` 和 `node_modules` 两个共享软链接保持 untracked，后续明确暂存时
必须继续排除。

真实 Vault 双次 dry-run 得到相同结果：

- `reportId=storage-inventory-f1a57a97ac7125141db10d86`
- `snapshotFingerprint=sha256:f1a57a97ac7125141db10d860780e7eb35ffdbf1cc20cc51427274e523294002`
- 运行前后插件目录均为 286 个结构条目，metadata 摘要完全一致
- `actionsApplied=0`、`deletionsApplied=0`、`rawBodiesRead=false`
- 第二次运行的 `generatedAt` 不同，但 report ID 和 fingerprint 不变

Phase 0、Phase 1 与 `b2db2f5` 的 public guard 都已在各自明确暂存状态下复验。
