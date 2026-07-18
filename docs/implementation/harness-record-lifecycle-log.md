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
