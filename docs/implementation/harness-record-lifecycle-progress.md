# EchoInk Harness 记录生命周期进度

更新时间：2026-07-19

## 当前结论

正式方案、ADR、Phase 0 只读盘点和 Phase 1 自动化实现已经完成。Phase 1 已把
Context rotation、Conversation commit、Native retirement/cleanup、Editor 产品终态、
临时 Utility 以及 Settings/History source authority 收口到统一合同；当前 checkpoint
已通过定向测试与全量工程门禁，但没有部署到真实 Obsidian。

真实 Vault 的 Phase 0 metadata-only 报告仍为 `blocked`：现有数据包含 Raw 失联
引用和旧 Run 结算缺口。Phase 1 没有修改这些历史记录，也没有执行真实历史删除、
Native 批量 cleanup、retention 清理或 Vault 迁移。Phase 2 必须继续建立数据治理、
迁移预览和恢复合同，不能把 Phase 1 的绿灯解释为允许清理真实数据。

本任务分支：

- 分支：`codex/harness-record-lifecycle`
- Worktree：`/private/tmp/codex-harness-record-lifecycle`
- 创建基线：`main@a91f1b8`
- 当前主线：`main@d4d4ec4`；最终集成前仍需同步并复验

项目开发记忆已切到本机 `codex-memory` V2：

- `schema_version=2`
- `layout_mode=compat-v1`
- `project_id=dd0b8209-1272-4f70-a402-630de403e5d1`
- V2 Hook 7/7 trusted，首次自动整理已 `write`
- 旧 `.codex-memory` Markdown 保留，没有被迁移器覆盖或删除

这套本机 V2 只记录开发进度，与 EchoInk 插件内置 Memory V2 分开验收。

## 阶段状态

| Phase | 状态 | 当前证据 | 下一门禁 |
| --- | --- | --- | --- |
| 文档与决策 | 已完成 | ADR 0005、主计划与 `ae4ec4b` 文档提交 | 随代码行为持续校准 |
| Phase 0：inventory / dry-run | 已完成并提交 | `f362a59`、fixture、真实 Vault 双次 dry-run 与稳定 fingerprint | 保持只读基线，不执行自动修复 |
| Phase 1：Context / Native lifecycle | 已完成（当前 checkpoint） | 统一 rotation、commit/recovery、Native cleanup、三后端 Editor/Knowledge/Utility 接线与当前全量门禁 | 进入 Phase 2 |
| Phase 2：数据治理 | 未开始 | Conversation V2、Run retention、Raw 引用图、mutation journal 已设计 | 冻结基础 schema 与 crash contract |
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

1. 进入 Phase 2，先冻结 Conversation V2、Workflow/Attempt summary、mutation
   journal 与 retention 的 schema 和 crash contract。
2. 完成 History 引用投影、Raw owner graph/GC、四类用户操作 coordinator 和
   side-by-side migration/reverse exporter。
3. 继续保持真实 Vault migration `blocked`；Phase 4 与用户单独确认前不执行
   历史删除、retention、Raw GC 或批量 Native cleanup。

## 当前验证

当前完整 Phase 1 diff 已通过：

- `npm run test`，输出 `All tests passed`
- 13 组末轮 Phase 1 focused suites，全部绑定同一源码指纹
- `npm run typecheck`
- `npm run build`
- `npm run lint`，961 个 finding 与当前 baseline 完全一致，无新增 finding；
  baseline 相对当前分支已提交基线由 985 向下收紧
- `npm run check:release`
- `npm run check:public`，明确暂存后通过
- `git diff --check`

`.codex-memory` 和 `node_modules` 两个共享软链接保持 untracked，没有进入暂存区。

真实 Vault 双次 dry-run 得到相同结果：

- `reportId=storage-inventory-f1a57a97ac7125141db10d86`
- `snapshotFingerprint=sha256:f1a57a97ac7125141db10d860780e7eb35ffdbf1cc20cc51427274e523294002`
- 运行前后插件目录均为 286 个结构条目，metadata 摘要完全一致
- `actionsApplied=0`、`deletionsApplied=0`、`rawBodiesRead=false`
- 第二次运行的 `generatedAt` 不同，但 report ID 和 fingerprint 不变

Phase 0 与当前 Phase 1 的 public guard 都已在各自明确暂存状态下复验。
