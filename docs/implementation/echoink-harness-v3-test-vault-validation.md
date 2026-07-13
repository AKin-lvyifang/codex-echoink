# EchoInk Harness 2.0 / V3 Test Vault 验收矩阵

更新时间：2026-07-14 CST

## 结论

Harness 2.0 / V3 在 `codex/echoink-harness-v3-main-integration` 的产品验收状态为 **完成**。27 项 main 集成检查全部 PASS；自动化、真实 Test Vault 产品验收和最终 DoD 审计均已闭环。只部署了专用 Test Vault，正式 Vault 未部署。

### 2026-07-14 main 集成 27 项验收

计数口径：20 项 Test Vault 产品链路、6 项提示词增强合同、1 项 UI / 滚动组合检查，共 27 项。`PASS-REAL` 表示在真实 Obsidian Test Vault 中操作并核对落盘或 DOM；`PASS-AUTO` 表示故障注入或纯合同边界由自动化验证。

| # | 验收项 | 状态 | 集成分支证据 |
| --- | --- | --- | --- |
| 1 | Codex 连续 5 轮复用 Thread | PASS-REAL | `run-1783971778779-31tvl5` bootstrap，后四轮至 `run-1783972244371-wlbe3c` incremental；同一 Thread `019f5d01-1163-71d0-982f-8f262bd1a661` |
| 2 | OpenCode 连续 5 轮复用 Session | PASS-REAL | `run-1783976147142-kz2l1k` bootstrap，后四轮 incremental；同一 Session `ses_0a2bc35ddffeNbJTFPGBRucyfW`，末轮返回 `OF2-714-A｜BETA-714` |
| 3 | Hermes 两轮无 Resume 降级 | PASS-REAL | `run-1783963566736-s3pq0x` 与 `run-1783963598886-gkvofq` 均 bootstrap / 新 Run；第二轮恢复 `HR1-714` 并追加 `HR2-714` |
| 4 | Codex -> Hermes -> Codex catch-up | PASS-REAL | `run-1783963655435-ytyebc` bootstrap，`run-1783963716144-j8rid1` Hermes bootstrap，`run-1783963745174-25rv1m` Codex catch-up 并返回两个跨 Agent 标记 |
| 5 | 重启后 Session、消息、Cursor、Lease 恢复 | PASS-REAL | 禁用/启用插件后 `session-1783976106431-r4gued` 的 10 条消息、5-turn Lease、Context Cursor 均恢复；磁盘与运行时默认 Backend 同为 Codex/default/Codex |
| 6 | Native Session 外部删除后重建 | PASS-REAL | OpenCode 原 Session 外部删除后，`run-1783964575531-2ewgnt` 使用新 Session `ses_0a36cc7a2ffeg0X7nhxlnTBLHx` bootstrap，并恢复五个本地口令 |
| 7 | Knowledge `/ask` 连续追问和切 Agent | PASS-REAL | `knowledge-codex-cli-1783972683543-2wq441` 与 `knowledge-codex-cli-1783972943524-6582wv` 复用 Thread；Hermes `knowledge-hermes-1783972995238-wgaapu` 继续返回 `KBH-KBX-714` |
| 8 | `/check` 与 `/maintain` 独立 ephemeral-run | PASS-REAL | `/maintain` `knowledge-codex-cli-1783973192596-t45poj` 使用 Thread `019f5d16-aac0-7d61-a5a4-396dda25d246`；`/check` `knowledge-codex-cli-1783973452197-vwytxu` 使用 Thread `019f5d1a-a0a3-7e73-b547-cf1bedfdc2fd` |
| 9 | Codex cleanup 为 archive | PASS-REAL | `knowledge-codex-cli-1783973192596-t45poj` local commit 后 `archive/disposed`，未声明或记录 delete |
| 10 | OpenCode cleanup 为 delete | PASS-REAL | `knowledge-opencode-1783965719870-7xizdz` local commit 后 `delete/disposed` |
| 11 | Hermes cleanup 为 unsupported | PASS-REAL | `knowledge-hermes-1783976418436-njlvy5` 业务完成、local commit 完成，cleanup=`unsupported`，业务结果未改判 |
| 12 | 本地提交失败时 cleanup 调用为 0 | PASS-AUTO | 故障注入 `knowledge-codex-cli-1783974614014-mxdap0` 落 `failed/retained-for-recovery`；`native-execution.ts` 断言 cleanup calls 严格为 0 |
| 13 | Chat 取消只有一个终态 | PASS-REAL | `run-1783973409864-j2b6jo` 本地消息 canceled，Ledger 唯一 terminal 为 `run.cancelled` |
| 14 | Knowledge 取消只有一个终态 | PASS-REAL | `knowledge-codex-cli-1783973452197-vwytxu` 唯一 terminal 为 `run.cancelled`，Native cleanup 完成 |
| 15 | 插件重载恢复只有一个终态 | PASS-REAL | `knowledge-codex-cli-1783973487471-ba32i9` 重载后唯一 terminal 为 `run.failed`，未残留运行中状态 |
| 16 | Raw 与受保护知识正文安全 | PASS-REAL | Hermes `/check` 前后聚合 SHA256：Raw `39ca499bf70d48a23ace1854c66fd3194e0f1b705e892cf62d4f9c6d73ebbabd`，Wiki `f3b3b8ec9e9575a08c5a9f2a5c6c0d13f306f580f57148c3d356bfe26b815ed2`，均不变 |
| 17 | Editor Action 取消不落盘 | PASS-REAL | `editor-generating-run-1783967831640-y4prua` 为 `run.cancelled`；`inbox/test.md` SHA256 与 mtime 不变 |
| 18 | Editor Action 确认只写候选范围 | PASS-REAL | `editor-generating-run-1783977238932-g7nab8` 完成；真实确认后 `prefixEqual=true`、`suffixEqual=true`，两个哨兵行不变，仅选区替换；临时夹具随后删除 |
| 19 | Session、Settings、提示词设置迁移不丢失 | PASS-REAL | 集成前 19 个 Session 全部保留，验收后为 20 个且 missing=0；`editorActions` 规范化 SHA256 前后同为 `ac694aa2834d3043ba838bca88cb6e69f6aa002c047d4a990b96f5b0bb6b85b0` |
| 20 | 正式 Vault 未部署 | PASS-REAL | 正式 Vault `codex-echoink` 47 个文件聚合基线 SHA256 `ce88640bedd4256072ec7e117491cecc1e9c364a1160134f31f0bbe329887ad8`；最终门禁后再次对账 |
| 21 | 提示词增强空输入无副作用 | PASS-AUTO | `prompt-enhancer.ts` 断言 Editor Run 0、Chat Turn 0、草稿逐字不变 |
| 22 | 已足够详细输入不重复增强 | PASS-AUTO | 断言 Harness Run 0、Chat Turn 0、草稿不变 |
| 23 | 增强成功只改变草稿 | PASS-AUTO | 输出合同为 `editor-candidate`，Editor Run 1；Conversation revision、Lease、Chat Turn 均不变；真实 Run `editor-generating-run-1783973686607-q5upbf` 完成 |
| 24 | 恢复原文逐字一致 | PASS-AUTO | 自动化保留输入首尾空白与换行，点击恢复后与原始字符串严格相等 |
| 25 | 增强取消或失败保留原草稿 | PASS-AUTO | failed/cancelled 双路径均断言草稿、Conversation、Chat Turn 不变；另有真实 cancelled Run |
| 26 | 增强后发送只新增一次 Chat Turn | PASS-REAL | `editor-generating-run-1783967899026-6vsw1n` 后仅产生一个 Chat Run `run-1783967941455-crs3k8` 和一对 user/assistant 消息，返回 `PROMPT-SEND-714` |
| 27 | 3 宽度、6 状态与滚动组合 | PASS-REAL | CDP 检查 320/420/560px × 用户/普通回复/运行中/完成过程/Knowledge/失败取消共 18/18 无横向溢出；10 次流式更新吸底、上滑暂停、过程折叠漂移和手动恢复跟随均满足计划阈值 |

本轮修复后部署哈希：`main.js` `e8cdfb13ce3c1f3d0cde3f9600f535de15be7ab0892cebedbff1b0ebea0e53d8`，`styles.css` `896197b0f1b756fac7d7a856086bfa9c856b94447cc9c63d243e1f165b77623e`，`manifest.json` `7598c041b480eb926104ebaaf7a284e125d9f28e140d26d235ac30e53e239cb9`；仓库构建与 Test Vault 部署文件逐个一致。

### 2026-07-13 最终修复与补验收

- OpenCode 普通 Chat 5 轮复用同一 Native Session `ses_0a7de8de9ffe9Tmob85bJSXjVI`；外部删除后新 Session 从 EchoInk Context bootstrap 恢复。
- OpenCode JSONL 多消息污染已修复。`run-1783906158288-ei5va8` 最终只返回 `OPARSER-713`，不再夹带内部 compaction summary。
- Hermes 原生消息流通过：`run-1783890628407-2bzd9g` 有 5 个 `agent.message.delta`，无 raw thought / reasoning 伪摘要，最终返回 `HSTREAM-713`。
- Session Revision 真实触发 `1 -> 2`，旧 Codex Thread 不再错误 Resume；全局 LRU 真实删除最旧 OpenCode Session并保留 16 条 EchoInk 消息。
- Memory Candidate 过滤残句和占位符；Hermes 新会话与 Codex `run-1783905856015-evpcoy` 均在禁止工具/文件读取条件下返回 `MEMORY-713`。
- OpenCode ephemeral-run 成功路径 `knowledge-opencode-1783906372888` 完成 local commit 后 delete/disposed；用户取消 `knowledge-opencode-1783907203475` 唯一终态为 `run.cancelled`；插件重载 `knowledge-opencode-1783907584292` 唯一恢复终态为 `run.failed`，对应 CLI 进程均不存在。
- 重复 Native cleanup 实机通过：先外部删除 `ses_0a6c3b014ffepwZMLTEJ5Iduma`，再从 EchoInk UI 重置缓存，OpenCode 记录为 `cleanup=disposed`、`appliedDisposition=delete`、无错误；本地 20 条消息保留。
- 临时 EchoInk Session `session-1783894023883-p14kbg` 已从 Settings、Conversation Store 索引和 Session 目录移除；Codex Thread archive/disposed。Test Vault 默认 Chat 与 Knowledge 后端均已恢复为 `codex-cli`。

## 状态定义

| 状态 | 含义 |
| --- | --- |
| PASS-REAL | Test Vault 真实 Obsidian 操作通过，且有落盘事件、状态或文件证据 |
| PASS-AUTO | 自动化测试通过，但本轮没有独立实机证据 |
| PARTIAL | 只完成部分轮次、部分 Backend 或部分证据 |
| FAIL | 已复现明确产品问题 |
| NOT-VERIFIED | 本轮没有足够证据，不能判断通过 |

## 证据基线

- 专用 Test Vault：`<TEST_VAULT>`（本机验收实例为 `testing/echoink-four-step-vault`）
- 部署插件：`.obsidian/plugins/codex-echoink/main.js`
- 当前 main 集成部署与仓库 `dist/main.js` SHA256：`e8cdfb13ce3c1f3d0cde3f9600f535de15be7ab0892cebedbff1b0ebea0e53d8`
- Run Ledger：`.obsidian/plugins/codex-echoink/harness-runs/*.jsonl`
- Native Execution Store：`.obsidian/plugins/codex-echoink/harness-native-executions/native-executions-index.json`
- EchoInk Memory：`.echoink/memory/index.json`、`.echoink/memory/events.jsonl`
- 自动化：`src/tests/harness-v2/`、`src/tests/run-tests.ts`
- 2026-07-13 最终修复批次曾新鲜通过：`npm run typecheck`、`npm run test`、`npm run build`、`npm run check:public`、`git diff --check`；最终文档修改后再次 fresh 重跑，结果见 progress / log。
- 正式 Vault 未操作。

## 用户指定九类产品验收

| 验收项 | 状态 | 证据 |
| --- | --- | --- |
| 普通 Chat 同一 Agent 连续复用 lease | PASS-REAL | `run-1783878822499-6j6agt` 为 `bootstrap`；`run-1783878923817-ywdck7` 为 `incremental`；Native Thread 相同 |
| Codex -> Hermes -> Codex 上下文连续 | PASS-REAL | `run-1783879184425-cdvrwv` 为 Hermes `bootstrap`，返回 `ALPHA-731 / HERMES-842`；`run-1783879297012-j565dl` 为 Codex `catch-up`，返回同一上下文 |
| 重启 Obsidian 后会话和上下文恢复 | PASS-REAL | 重启后 `run-1783879030352-kcsa9e` 复用 Codex lease，模式为 `incremental`，返回 `ALPHA-731` |
| Knowledge `/ask` 连续追问和切 Agent | PASS-REAL | Codex 两轮复用同一 Thread：`knowledge-codex-1783879402836`、`knowledge-codex-1783879520703`；随后切到 Hermes 的追问也完成 |
| `/check`、`/maintain` 使用独立 ephemeral run | PASS-REAL | `knowledge-codex-1783880171432` 和 `knowledge-codex-1783880530223` 均为 `ephemeral-run`，使用不同 Native Thread，提交后 archive |
| EchoInk 历史保留，Native Session 按能力处置 | PASS-REAL | `/ask` 为 retained；Codex ephemeral 为 archive/disposed；Hermes 真实返回 unsupported；EchoInk 本地消息仍在 |
| 本地提交失败不得清理 Native Session | PASS-AUTO | `src/tests/harness-v2/native-execution.ts` 覆盖 local commit / ledger commit 失败后 `retained-for-recovery` 且 cleanup 调用数为 0；未做破坏性实机故障注入 |
| 取消、失败、插件重载和 Raw 安全 | PASS-REAL | 取消：`run-1783881222817-yze766`；重载恢复：`run-1783881338905-c16zlv` 唯一 `sequence=72 run.cancelled`；Raw/知识正文哈希边界在 `/check`、`/maintain` 实机报告中保持不变；故障顺序另有自动化覆盖 |
| Editor Action 回归 | PASS-REAL | `editor-understanding-run-1783882953828-6rfe25`、`editor-generating-run-1783882976175-ift4ob` 完成；Esc 取消后 `inbox/test.md` SHA256 与 mtime 不变 |

## V3 19.16 必测场景

### 普通 Chat

| 场景 | 状态 | 证据 / 缺口 |
| --- | --- | --- |
| Codex 连续 5 轮复用 Thread | PASS-REAL | `run-1783884159629-zn6twg` 首轮 bootstrap；`run-1783884223542-wngmlq`、`run-1783884262607-h88mjh`、`run-1783884305699-q5ehb8`、`run-1783884339554-e4lya7` 后四轮均 incremental，五轮使用同一 Lease / Thread `019f57c8-2cfa-7092-a2e9-6684949a6a12` |
| OpenCode 连续 5 轮复用 Session | PASS-REAL | 修复后 `run-1783890009534-2mo2fd` 为 bootstrap，后四轮 `run-1783890085250-9qmqh0` 至 `run-1783890359725-inw6mk` 均为 incremental；五轮复用同一 Lease / Session `ses_0a7de8de9ffe9Tmob85bJSXjVI` |
| Hermes 不支持 Resume 时由 Context Compiler 模拟连续 | PASS-REAL | `run-1783884809367-c6gub3` 与 `run-1783885097347-djdd5v` 均创建新 Hermes run + bootstrap；第二轮仍从 EchoInk Context 正确返回旧标记 `H2-973` |
| Codex 切 Hermes | PASS-REAL | `run-1783879184425-cdvrwv` |
| Hermes 切 OpenCode | PASS-REAL | Hermes `run-1783884809367-c6gub3` 写入 `H2-973`；切回 OpenCode 的 `run-1783884900671-0wxgly` 从 EchoInk bootstrap 正确返回 `H2-973` |
| 切回 Codex且旧 Lease 有效 | PASS-REAL | `run-1783879297012-j565dl` 为 Codex `catch-up` |
| 切回 Codex但 Lease 已失效 | PASS-AUTO | Lease expiry / bootstrap 重建由 `session-context.ts`、`contracts.ts` 覆盖；实机只观察到过期后新 bootstrap，没有完整跨 Backend 回切序列 |
| Native Session 被外部删除 | PASS-REAL | 外部删除 OpenCode Session 后 `run-1783890507841-zv7pw9` 以新 Session bootstrap，并从 EchoInk Context 返回 `OF5-713` |
| Session Revision 改变导致 Lease 重建 | PASS-REAL | 真实触发 revision `1 -> 2`；旧 Codex Thread 未复用，新 Thread 以 bootstrap 重建 |
| 用户关闭并重新打开 Obsidian | PASS-REAL | 重启后 `run-1783879030352-kcsa9e` 恢复 |
| 用户新建 EchoInk Session | PASS-REAL | Test Vault 中已实际新建 Chat Session |
| 用户删除 EchoInk Session | PASS-REAL | UI 删除 `session-1783894023883-p14kbg` 后，Settings、Conversation Store 索引和 Session 目录均无该 ID；Native record `session.delete:session-1783894023883-p14kbg:codex-cli` 为 committed / disposed / archive |
| 全局 Lease 超限触发 LRU | PASS-REAL | `run-1783892387234-ga82gh` 创建第 3 个后端 Lease 后，最旧 OpenCode Session `ses_0a7d6f565ffeBkz2ygLlMBL4Fg` 被真实删除；EchoInk 16 条消息保留 |

### Context

| 场景 | 状态 | 证据 / 缺口 |
| --- | --- | --- |
| Bootstrap 不遗漏 Goal / Decisions / Constraints | PASS-REAL | Hermes bootstrap 能返回 Codex 轮次的 `ALPHA-731`、test-vault 约束和 `HERMES-842` |
| Incremental 不重复历史 | PASS-AUTO | `session-context.ts` 精确断言只包含 cursor 后消息；实机验证了模式和答案，未抓取完整注入包 |
| Catch-up 包含其他 Agent 新消息 | PASS-REAL | Codex catch-up 返回 Hermes 新增的 `HERMES-842` |
| Summary 与最近消息不重复 | PASS-AUTO | Context Compiler 测试覆盖摘要范围与最近消息窗口 |
| Summary 失败时回退 | PASS-AUTO | Context Compiler 回退测试覆盖 |
| Token Budget 不裁 Core Policy | PASS-AUTO | `session-context.ts`、`contracts.ts` 断言 Core Policy 保留 |
| 不同 Surface 使用不同 Context | PASS-AUTO | Chat、Knowledge `/ask`、结构化命令、Editor 的 Context 模式合同测试覆盖 |
| Context Manifest 可重建 | PASS-AUTO | Run Ledger / Context Manifest / 重载恢复测试覆盖；实机 Ledger 可审计模式与 lease 事件 |
| Memory Disabled 时仍正常 | PASS-AUTO | Noop Memory Provider 与 Context Compiler 测试覆盖 |

### Knowledge

| 场景 | 状态 | 证据 / 缺口 |
| --- | --- | --- |
| `/ask` 连续追问复用 Lease | PASS-REAL | 两轮 Codex `/ask` 使用同一 Native Thread，第二轮为 incremental |
| `/maintain` 使用独立 Ephemeral Run | PASS-REAL | `knowledge-codex-1783880530223`，独立 Thread，提交后 archive |
| `/maintain` 不加载普通闲聊 | PASS-AUTO | workflow context 装配测试覆盖；实机未抓取完整输入包 |
| Knowledge Workflow 结束后仍能继续 `/ask` | PASS-REAL | `/check`、`/maintain` 后执行 `knowledge-codex-1783884965032`，返回 `KB-AFTER-551`，local commit 完成，Native cleanup retained |
| 切换 Backend 后 Knowledge 追问不断层 | PASS-REAL | Codex -> Hermes Knowledge 追问均返回既有口令 |
| Knowledge 卡片和通用 Tool 卡片同时正常 | PASS-REAL | `kb-run-1783891662343-4caq48` 的 `/ask HV3-DUAL-CARD` 同时呈现 Knowledge 卡与 Agent/tool 过程，最终 Knowledge 卡 completed 并返回目标一级标题 |
| Native Cleanup 不删除 Knowledge Session | PASS-REAL | `/ask` retained、ephemeral archive 后同一 Knowledge 本地 Session 仍继续使用 |

### 数据迁移

| 场景 | 状态 | 证据 / 缺口 |
| --- | --- | --- |
| 旧普通 Session 消息迁移 | PASS-AUTO | `conversation-store.ts` 覆盖 legacy session/history 外置迁移 |
| 旧 Knowledge JSONL 迁移或兼容读 | PASS-AUTO | Knowledge history migration / compatibility 回归覆盖 |
| 旧 `threadId` 迁移为 Codex Binding | PASS-AUTO | `conversation-store.ts` 与 settings migration 测试覆盖，保存态不再写 `threadId` |
| 中途崩溃可恢复 | PASS-REAL | 插件重载后本地 interrupted 消息保留并回填唯一 Ledger 终态；崩溃点矩阵另有自动化覆盖 |
| 不长期双写 | PASS-AUTO | 源码护栏证明 settings 不再承载完整普通历史，旧字段只兼容读 |
| 未提交 Pending 数据不会被清理 | PASS-AUTO | Native Execution fault-injection 覆盖 `retained-for-recovery`；Test Vault 也保留历史 failed records |

## 主计划 Phase 7 Memory MVP

| 验收 / 工作项 | 状态 | 证据 / 问题 |
| --- | --- | --- |
| File Provider、目录、确认、冲突、去重、检索、删除、过期、supersede、审计、导出、备份 | PASS-REAL | Test Vault Memory UI 实操和 `.echoink/memory/` 落盘证据；完整生命周期另有 `memory.ts` 自动化 |
| 新会话恢复项目当前状态 | PASS-REAL | Hermes 新会话从 EchoInk Memory 返回 `MEMORY-713`；Codex 新会话/新 Lease 也在禁止工具和文件读取时返回同一值 |
| 切换 Agent 读取同一份 Memory | PASS-REAL | Hermes 与 Codex `run-1783905856015-evpcoy` 均读取同一条已确认 EchoInk Memory |
| Archive 默认不注入 | PASS-AUTO | supersede、delete、expire 后检索排除测试 |
| 冲突记忆不会静默覆盖 | PASS-AUTO | 冲突候选未经确认进入 `conflicts`，确认后 supersede |
| 用户可查看来源和删除 | PASS-REAL | 设置页状态、来源、删除确认、archive/audit 投影均已实操 |
| Agent 私有 Memory 不自动覆盖 EchoInk Memory | PASS-AUTO | Memory Provider 和 Context Compiler 边界测试 |
| Candidate 提取质量 | PASS-REAL | 修复后候选仅保留完整事实“跨会话口令 MEMORY-713”，残句、占位符与弱语义候选被过滤；相关反例自动化通过 |

## 总体 Definition of Done 审计

### Harness 2.0 原 DoD

| DoD | 状态 | 主要证据 |
| --- | --- | --- |
| 唯一 RunOrchestrator | PASS-AUTO | `harness-kernel.ts` 与源码护栏 |
| Chat、Knowledge、Editor 不直接调用具体 Agent | PASS-AUTO | Controller / backend branch 源码护栏 |
| Codex、OpenCode、Hermes 实现相同 Adapter | PASS-AUTO | Adapter conformance suite |
| 同一会话切换 Agent且上下文连续 | PASS-REAL | Codex -> Hermes -> Codex bootstrap / catch-up |
| Vault Skill 可被三种 Agent 使用 | PASS-AUTO | `resources.ts` 的 any-backend resolver 测试 |
| Vault MCP 可被三种 Agent 使用 | PASS-AUTO | MCP Broker、structured/text loop 与 backend-neutral resource tests |
| Agent Native Skill / MCP 仍能使用 | PASS-AUTO | Native resource provider / namespace / adapter snapshot tests |
| 两类资源来源在 UI 和日志中可区分 | PASS-AUTO | Resource source UI、URI、selection snapshot tests |
| 通用对话栏由统一事件驱动 | PASS-REAL | 三 Backend 运行与统一 Ledger / Event Projection |
| 不支持事件有明确降级 | PASS-REAL | Hermes cleanup=`unsupported` / 无 reasoning summary 按能力降级；OpenCode provenance 归一为实际 provider/model；三后端自动化投影通过 |
| Knowledge 进度由 Workflow Event 驱动 | PASS-REAL | `/check`、`/maintain` 实机过程与 Ledger |
| Knowledge 报告由 Ledger 生成 | PASS-REAL | 2026-07-13 check / maintain 报告与 EchoInk Ledger 区块 |
| Agent 最终文本不决定业务成功 | PASS-AUTO | Workflow state / validator / ledger tests |
| Core Knowledge Policy 从 `LLM-WIKI.md` 抽出 | PASS-AUTO | `core-policy.ts` 与 profile tests |
| `LLM-WIKI.md` 只承载 Vault Profile | PASS-AUTO | Profile parser / migration tests |
| Raw 安全、Evidence、回滚完整测试 | PASS-REAL | 自动化全覆盖；实机 `/check`、`/maintain` 哈希边界不变 |
| Memory Provider 正式扩展点 | PASS-AUTO | Noop/File Provider 与统一 Context Compiler |
| `.codex-memory/` 有迁移方案 | PASS-REAL | 只读迁移预览 UI 实操与自动化 |
| 第四个 Agent 只需新增 Adapter | PASS-AUTO | `FakeFourthAgent` registry / conformance 测试 |
| 原历史、设置和 Workspace 可迁移 | PASS-AUTO | conversation/settings/native migration tests；重启恢复有实机证据 |

### Native Lifecycle DoD

| DoD | 状态 | 主要证据 |
| --- | --- | --- |
| Knowledge 历史由 EchoInk 本地恢复 | PASS-REAL | 重启后 Knowledge Session 仍在 |
| 切换三 Backend 不改变 Knowledge Session | PASS-REAL | Codex、Hermes、OpenCode 均在同一 Knowledge 本地 Session 运行；结构化 ephemeral cleanup 不删除本地 Session |
| Agent Native Execution 只是租约 | PASS-REAL | leased / ephemeral policy 与 Native Store |
| Local Durable Commit 是显式状态 | PASS-REAL | Ledger `run.local_commit.*` |
| 未提交时不清理 Native Execution | PASS-AUTO | fault-injection tests |
| 任务结果与 cleanup 结果分离 | PASS-REAL | Hermes unsupported 不改判已成功 `/ask` |
| Codex Archive 在 Adapter | PASS-REAL | Codex ephemeral 实机 archive；源码边界测试 |
| OpenCode 处置按真实能力检测 | PASS-REAL | `knowledge-opencode-1783906372888` local commit 后 delete/disposed；外部删除后重复 cleanup 归一为 disposed，未把 disconnect 当 cleanup |
| Hermes 处置按真实能力检测 | PASS-REAL | 实机 unsupported + Adapter tests |
| 不把 Disconnect 当 cleanup | PASS-AUTO | `disconnectCalls === 0` 回归 |
| 不把 Archive 写成 Delete | PASS-REAL | Codex manifest 只声明 archive，delete 为 unsupported |
| Native Store 不在 Vault 同步目录 | PASS-REAL | 位于插件私有 `.obsidian/plugins/codex-echoink/` |
| Pending / Failed 不被 200 条截断 | PASS-AUTO | store retention tests |
| Cleanup Worker 退避、幂等、重载恢复 | PASS-REAL | fault matrix 自动化；外部删除 OpenCode Session 后 UI 重置仍 disposed；重载恢复保留未提交 Native record |
| 旧 `managedThreads` 完成迁移 | PASS-AUTO | legacy migration tests，正式 settings 字段已移除 |
| 旧 Codex 专属 cleanup 代码删除 | PASS-AUTO | architecture boundary tests |
| Knowledge UI 显示本地提交和 cleanup | PASS-REAL | Test Vault 消息元信息实机检查 |
| cleanup 失败不改判 Knowledge 成功 | PASS-REAL | Hermes `/ask` success + cleanup unsupported |
| 本地提交失败保留 Native Execution | PASS-AUTO | fault-injection tests |
| Journal / Review 不主要依赖 Native History | PASS-AUTO | 本地历史 / Vault evidence source tests |
| 合同、故障注入、迁移、回归测试通过 | PASS-AUTO | `npm run test` |
| `npm run typecheck` | PASS-AUTO | fresh gate |
| `npm run test` | PASS-AUTO | fresh gate |
| `npm run build` | PASS-AUTO | fresh gate |
| 不形成第二套 Kernel / Adapter / Ledger / Session | PASS-AUTO | architecture source guards |

### V3 Context DoD 追加项（18.15）

| DoD | 状态 | 主要证据 |
| --- | --- | --- |
| EchoInk Session Context 是权威真源 | PASS-REAL | 跨 Agent、重启恢复 |
| Agent 原生上下文只是可丢弃缓存 | PASS-AUTO | lease / rebuild contracts |
| Knowledge `/ask` 使用 leased-conversation | PASS-REAL | 两轮同 Thread |
| `/ask` 不每轮创建并清理 Native Session | PASS-REAL | reused + retained |
| 同 Backend 连续追问复用 Lease | PASS-REAL | Chat 与 Knowledge 两轮实机 |
| 切换 Backend 后目标、决定、约束和最近对话连续 | PASS-REAL | `ALPHA-731 / HERMES-842` |
| Native Session 丢失后从本地 Context 重建 | PASS-REAL | 外部删除 `ses_0a7de8de9ffe9Tmob85bJSXjVI` 后新 Session bootstrap 并返回 `OF5-713` |
| Session Context 与长期 Memory 分层 | PASS-AUTO | Context Compiler / Memory Provider 合同 |
| 没有第二套 Context Manager | PASS-AUTO | architecture source guards |
| Context Compiler 支持 Bootstrap / Incremental | PASS-REAL | Test Vault Ledger 两种模式 |
| Resume 成功和失败有明确合同 | PASS-REAL | 五轮复用证明成功合同；外部删除触发 recovery failure 事件并 bootstrap 重建 |
| Journal / Review 不主要依赖 Native History | PASS-AUTO | evidence source tests |
| 本章节新增测试全部通过 | PASS-AUTO | `npm run test` |

### V3 19.17 DoD

| DoD | 状态 | 主要证据 |
| --- | --- | --- |
| 所有 Conversation 使用同一 Session Service | PASS-AUTO | Chat / Knowledge source guards |
| 普通 Chat 与 Knowledge 使用同一 Context Compiler | PASS-AUTO | Harness Kernel / Context tests |
| 普通 Chat 与 Knowledge 使用同一 Conversation Store | PASS-AUTO | Conversation Store integration tests |
| Knowledge 只保留专属 Workflow、Policy、UI | PASS-AUTO | architecture boundary tests |
| 普通 Chat 默认 leased-conversation | PASS-REAL | Chat bootstrap / incremental |
| Knowledge `/ask` 默认 leased-conversation | PASS-REAL | Knowledge same-thread reuse |
| Knowledge 结构化命令使用 ephemeral-run | PASS-REAL | `/check`、`/maintain` |
| 每个 Backend Binding 有独立 Context Cursor | PASS-AUTO | session-context / binding tests |
| 同 Backend 连续只发送增量 | PASS-REAL | Ledger 为 incremental；注入内容精确性由自动化覆盖 |
| 新 Backend 使用 Bootstrap | PASS-REAL | Hermes bootstrap |
| 切回旧 Backend 使用 Catch-up | PASS-REAL | Codex catch-up |
| Session Revision 不一致时不错误 Resume | PASS-REAL | 生产路径 revision `1 -> 2`，旧 Codex Thread 未复用，新 Thread bootstrap |
| Native Session 丢失可重建 | PASS-REAL | 外部删除 OpenCode Session 后从 EchoInk Context 重建 |
| Agent 原生上下文只是缓存 | PASS-AUTO | lease policy contracts |
| EchoInk Message History 是权威真源 | PASS-REAL | 重启恢复与本地 history |
| Rolling Summary 有来源消息范围 | PASS-AUTO | summarized-through cursor tests |
| Context Manifest 可审计 | PASS-REAL | Test Vault Run Ledger |
| Message 可追踪 Backend / Model / Run | PASS-REAL | Test Vault message metadata / Ledger |
| Lease 有 TTL、轮次、容量、LRU | PASS-REAL | TTL/轮次/容量自动化；`run-1783892387234-ga82gh` 真实触发全局 LRU 并删除最旧 Native Session |
| 清理 Native Cache 不删除 EchoInk Session | PASS-REAL | archive / unsupported 后本地 Session 保留 |
| Conversation Store 有旧数据迁移 | PASS-AUTO | migration tests |
| Settings 不承载完整普通 Chat 历史 | PASS-AUTO | save boundary tests |
| Codex 专属 Knowledge Context Bridge 已删除 | PASS-AUTO | architecture guards |
| 非 Codex One-shot Chat 旁路已删除 | PASS-AUTO | architecture guards |
| 第四 Agent 不修改 Chat / Knowledge Context Core | PASS-AUTO | FakeFourthAgent test |
| V3 测试全部通过 | PASS-REAL | 19.16 场景均有 PASS-REAL 或针对非破坏性边界的 PASS-AUTO；最终门禁全绿 |
| 原 Harness 2.0 与 Native Lifecycle DoD 全部成立 | PASS-REAL | Candidate、provenance、stream、revision、LRU、session delete、ephemeral cancel/reload 与幂等 cleanup 均已闭环 |

## 缺陷闭环

| ID | 首次发现 | 最终状态 | 修复与证据 |
| --- | --- | --- | --- |
| HV3-MEM-001 | Candidate 残句和占位文本 | PASS | 候选过滤完整事实；反例自动化与 Test Vault `MEMORY-713` 候选通过 |
| HV3-OPEN-001 | OpenCode provider/model provenance 不一致 | PASS | 运行消息与设置均归一到实际 `opencode/big-pickle`；实机消息元数据可审计 |
| HV3-OPEN-002 | OpenCode 未复用 Native Session | PASS | 五轮复用同一 Session，首轮 bootstrap、后四轮 incremental |
| HV3-HERMES-001 | raw thought 被显示为推理摘要 | PASS | raw thought 不再投影为 reasoning；Hermes 原生 message delta 实机通过 |
| HV3-REV-001 | Session Revision 无生产递增 | PASS | 生产 mutation 路径递增 revision，实机 `1 -> 2` 重建 Thread |
| HV3-LRU-001 | 全局 LRU 无生产调度 | PASS | 全局 Lease 枚举和 cleanup 接入，真实删除最旧 OpenCode Session |
| HV3-SESSION-001 | 删除 Session 留下本地与 Native 残留 | PASS | `session-1783894023883-p14kbg` 三处本地状态移除，Codex archive/disposed |
| HV3-OPEN-003 | OpenCode 最终答案夹带内部总结 | PASS | JSONL 按主消息聚合；`run-1783906158288-ei5va8` 只返回 `OPARSER-713` |
| HV3-MEM-002 | Codex Memory 自动注入证据不足 | PASS | `run-1783905856015-evpcoy` 禁止工具和文件读取时返回 `MEMORY-713` |
| HV3-RESET-001 | 不存在的 OpenCode Session cleanup 误记 failed | PASS | 外部删除 `ses_0a6c3b014ffepwZMLTEJ5Iduma` 后 UI reset 记录 disposed/delete、无错误 |
| HV3-OPEN-004 | OpenCode `/check` 取消和重载无终态、进程泄漏 | PASS | 成功 `knowledge-opencode-1783906372888`；取消 `knowledge-opencode-1783907203475`；重载 `knowledge-opencode-1783907584292`；均有唯一终态且无残留进程 |

## 最终判断

两份计划的全部 DoD 已有真实代码与测试证据。历史 FAIL 保留在 Git 历史和本表“首次发现”列，不再作为当前未完成项。后续工作属于发布、性能或新功能范围，不再阻塞 Harness 2.0 / V3 完成。
