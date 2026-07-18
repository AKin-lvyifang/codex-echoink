# EchoInk Harness 记录生命周期进度

更新时间：2026-07-19

## 当前结论

正式方案与 ADR 已建立，文档检查点正在收口；Phase 0 代码尚未开始。当前没有
执行任何真实历史删除、Native 批量 cleanup、retention 清理或 Vault 迁移。

本任务分支：

- 分支：`codex/harness-record-lifecycle`
- Worktree：`/private/tmp/codex-harness-record-lifecycle`
- 基线：`main@a91f1b8`

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
| 文档与决策 | 进行中 | ADR 0005、主计划、进度页、实施日志 | 文档 lint、public guard、提交 |
| Phase 0：inventory / dry-run | 未开始 | 只读审计和报告契约已形成 | 测试先行、metadata-only 真实 dry-run |
| Phase 1：Context / Native lifecycle | 未开始 | `/clear`、workspace、rollover、Editor、cleanup 根因已定位 | Phase 0 基线冻结 |
| Phase 2：数据治理 | 未开始 | Conversation V2、Run retention、Raw 引用图、mutation journal 已设计 | Phase 1 核心不变量通过 |
| Phase 3：Backend capability | 未开始 | Codex/OpenCode 当前能力已核对；Hermes 保守为 unsupported | Phase 2 schema 稳定 |
| Phase 4：迁移与实机验收 | 未开始 | 尚未部署或修改真实数据 | dry-run、备份、用户确认 |

## 已确认决定

- EchoInk Conversation 是跨后端唯一对话真源。
- Codex thread、OpenCode session、Hermes run/session 是短期 Native Execution。
- Chat 与 `knowledge.ask` 可使用有界 lease；结构化任务和 Editor 按 attempt/phase 隔离。
- 本地 durable commit 先于 Native cleanup；cleanup 失败不改变业务结果。
- `/clear` 的产品语义是“开启新上下文”，不是删除历史。
- Run payload 默认 30 天，Run summary 默认 90 天；恢复证据不参与普通 retention。
- Native cleanup 最多自动尝试 6 次，之后 quarantine；队列必须保障新任务公平性。
- Agent-native Memory 不属于精确 session cleanup 的范围。

## 当前阻断项

- Phase 0 报告和测试尚未落代码。
- 当前 V2 Hook 不按 Git common-dir 自动识别临时 worktree；本任务必须保持线程
  cwd 为主仓库，只从主根触发 V2。
- 旧 `.codex-memory/spec/knowledge-base-thread-lifecycle.md` 的“普通 Chat 原生
  thread 必须永久保留 resume”已被 ADR 0005 替代，但迁移保留的旧文件还需由
  V2 记忆整理流程标记 superseded。
- retention 会改变现有 Archive Catalog “完整本地记录可查”的范围，Phase 2
  必须同步产品 copy 和检索降级。

## 下一检查点

1. 完成文档检查并提交独立 docs commit。
2. 新增 Phase 0 失败夹具和 inventory schema。
3. 实现 metadata-only inventory / dry-run。
4. 在测试 fixture 与真实 Vault 上证明零写入、稳定 fingerprint 和 partial 降级。

## 当前验证

基线已通过：

- `npm run typecheck`
- `npm run test`，输出 `All tests passed`

文档完成后将重新运行：

- `git diff --check`
- `npm run check:public`
- Markdown anti-slop lint
