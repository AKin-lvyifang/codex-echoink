# `/maintain` 知识库维护可靠性改造计划

> 修订说明（2026-07-18）：旧版关于固定后端优先级和手动入口例外的
> 路由规则已经全部作废。本文是当前唯一有效版本；所有维护入口统一执行：
> “启动时锁定当前所选 Agent；成功只运行它；仅在真实且可安全切换的失败后，
> 才串行检查下一个已就绪 Agent。”
> 已发送的旧聊天正文和截图不能原位改写，只作为历史记录，不得再作为实现依据。

## 当前实施状态（2026-07-18）

维护 Harness 的实现、自动化门禁、部署和真实 Obsidian testing Vault 验收均已完成：

- 手动 `/maintain`、命令面板、定时维护和启动补跑已汇入同一套维护 Harness。
- selected-first、安全故障转移、per-attempt Shadow Vault、精确写入围栏、逐来源验证、WAL 原子提交、崩溃恢复、部分提交和统一终态均已接入。
- 关键故障点确定性测试、固定 seed `0x5eedc0de` 的 30 轮故障注入、全量测试、类型检查和构建均已通过。
- 已部署到主 Vault 与 testing Vault。真实验收 `kb-run-1784382293013-bz3gx4` 由启动时所选 Codex 单独成功完成：`completion=full`、`selectedBackend=winnerBackend=codex-cli`、`attempts=1`、`terminalPhase=finalized`、`commitState=committed`，OpenCode/Hermes 零执行。
- Raw 正文原始指纹 `7bfcd3a08f7e...` 保持不变；只有 Harness 在验证成功后写入托管 frontmatter。报告、tracker、processedSources、history 和最终报告卡片已对账。

当前剩余的只有交付操作：改动保留在隔离分支 `codex/maintain-resilience`，尚未提交或合入主分支；主 worktree 存在其他未提交改动，不能直接覆盖。该边界不影响已经部署并通过验收的插件运行，但合并前仍应保持隔离。

## 目标

这次改造只解决一个问题：让 `/maintain` 和每日自动维护在 Agent 可用、网络正常、Vault 安全时稳定完成；遇到可恢复故障时自动恢复，不再把一次通知丢失、Raw 写入尝试或单个来源证据不足直接放大成整轮失败。

Raw 正文、路径和附件继续只读。可靠性不能靠放松证据边界换取。

## 唯一有效的 Agent 路由契约

手动 `/maintain`、命令面板、定时维护和启动补跑都在开始时冻结 EchoInk
顶部当前选中的 Agent。它是本轮唯一首选，不固定从 Codex 开始，也不存在
某个入口单独使用另一套优先级。

冻结发生在 `Manager.runMaintenance()` 的首个 `await` 之前，除 Agent 外还
包括 `workflowRunId`、调度时间和所有可变参数的深层副本。开跑后切换 Agent、
改设置或修改调用方原参数，只能影响下一轮，不能改变当前 workflow。

只有首选 Agent 出现可安全切换的真实失败时，才启用下面的备用顺序：

| 启动时所选 Agent | 真实失败后的串行备用顺序 |
| --- | --- |
| Codex | OpenCode → Hermes |
| OpenCode | Hermes → Codex |
| Hermes | Codex → OpenCode |

正常成功路径只有一个真实 attempt：所选 Agent 成功后立即结束，另外两个
Agent 的 readiness（就绪状态）检查次数和执行次数都必须为零。

- `full`、`recovered`、`partial` 和 `noop` 都是业务完成态，出现任一结果就停止切换。
- 只有满足下文“完整安全切换门槛”的当前尝试，才检查下一个已就绪 Agent。全文出现“安全切换”时均指这一完整门槛，不得缩写或放宽。
- 一旦生成 workflow WAL 提交意图，或进入任一提交阶段，就永久关闭本轮 Agent 切换，只允许恢复、继续提交或安全停止当前成果。
- 备用 Agent 按表中顺序惰性检查。前一个候选未就绪才检查后一个；找到首个已就绪 Agent 后立即执行，不会先把所有备用 Agent 都检查一遍。
- 未就绪的备用候选直接跳过，不计为真实执行 attempt。
- 同一轮不重复尝试同一个 Agent，也不并行运行多个 Agent。

用户取消、Raw 或权限策略拒绝、Vault 不安全、业务证据不合格、并发提交冲突、磁盘写入失败和未知状态均不触发切换。

### 完整安全切换门槛

切换是默认关闭的能力。只有以下条件全部成立，Harness 才能惰性检查一个
备用 Agent：

1. 错误命中封闭的基础设施白名单：Agent 未安装、未加载、未登录、启动前
   连接预检失败，或运行期网络断开、transport 关闭、timeout。未列出的错误
   默认不可切换。
2. 当前 attempt 没有 `full`、`recovered`、`partial`、`noop` 或其他可恢复、
   可验证、可提交成果。
3. 当前 attempt 尚未生成或持久化 workflow WAL 提交意图，也未进入任何提交
   阶段。
4. 启动前失败必须证明原生 Agent 执行从未开始、真实 Vault 零写入。运行后
   失败必须同时具备精确写入围栏、与本 attempt 同 lease 的原生终止确认、
   sealed 且 durable quarantine 的独立 Shadow Vault，以及零可恢复成果证明。
5. 当前 attempt 的 commit 和 cleanup authority 已撤销，旧执行不可能与备用
   Agent 并行写入。

任何证明缺失、互相矛盾或无法验证时都 fail closed：停止本轮、保留诊断，
不连接、不预检、不执行备用 Agent。

### 三个 Agent 共用同一维护 Harness

Codex、OpenCode、Hermes 只允许在连接、输入编码、原生事件、取消和终止确认
这些 invocation adapter（调用适配层）上不同。所选 Agent 快照、路由状态机、
完整安全切换门槛、Shadow Vault、Raw 边界、成果恢复、逐来源验证、WAL、
提交、清理和最终报告必须共用同一套维护 Harness；任何后端不得拥有更宽权限、
假 fallback 或另一套成功判定。

维护任务不继承普通聊天资源。三种后端都使用空的维护资源 profile；Codex
原生 thread 还必须显式下发空 MCP server 与空 plugin 配置，不能因为本机
普通聊天启用了 MCP、Plugin 或 Skill 就获得额外副作用通道。维护 Prompt
所需规则由 Harness 自身提供。

## 历史问题归因

历史失败不是一个单点缺陷，而是五类问题叠加：

1. Agent 终态被误当成业务结果。Codex 通知丢失或 timeout 时，即使报告和正文已经写出，维护仍会被判失败。
2. timeout 和取消没有可靠隔离。旧任务可能在插件收口后继续写文件，造成“界面失败、后台仍提交”的半提交。
3. 所有来源共用一个长事务。单个来源证据不足会拖垮已经完成的来源。
4. 多后端写权限不一致。Raw 保护过度依赖事后回滚，Agent 尝试越界时容易把可处理问题升级成红色失败。
5. 调度、历史和界面混用了不同状态。通知保存失败、旧健康记录或残留 `running` 可能覆盖真实维护结果。

## 目标流程

每轮维护使用一个 `workflowRunId`，每次 Agent 调用使用独立 `attemptId`：

```text
prepare
  → selected Agent preflight
  → isolated attempt
  → recover and verify
  → persist workflow WAL commit intent（永久关闭 Agent 切换）
  → atomic commit
  → finalize
  → full / recovered / partial / noop

满足完整安全切换门槛的真实基础设施失败
  → 按备用顺序惰性检查下一个候选
  → 首个已就绪候选使用新的 Shadow Vault 和 lease
  → isolated attempt
```

只有满足完整安全切换门槛的失败才进入备用分支。找到首个已就绪候选后
立即停止后续 readiness 检查；它必须使用新的 Shadow Vault 和 lease，不能
复用失败 Agent 的执行环境。

### 独立 Shadow Vault

每个 Agent attempt 在单独的 Vault 副本中运行：

- Prompt、附件、工作目录和可写根都指向该副本。
- Raw、规则文件、tracker 和插件控制文件不交给 Agent 写。
- Prompt 不再要求 Agent 更新 raw/index 或 tracker；两者统一由 Harness 在证据验证后维护，避免“提示它去写、执行层又拒绝”的自相矛盾。
- Agent 偶发尝试写受保护路径时，写入围栏只拒绝该次工具调用并把边界反馈给 Agent，允许它改走合法路径继续完成；单次被拦截不等于整轮业务失败。
- Codex、OpenCode 和 Hermes 的 adapter 都必须在提交 Prompt 前确认同一套精确写入边界；不能确认的运行路径预检失败，不得降级到权限更宽的 CLI，也不得伪装成另一个 Agent 执行。
- Codex thread/start 与 thread/resume 必须显式清空继承的 MCP 和 Plugin；
  Harness 资源选择必须为空，不能把普通聊天资源带入维护 attempt。
- 冲突副本隔离、目录结构整理和链接修复也必须先在 winner 的 Shadow
  Vault 内完成，再与 Agent 成果一起封存验证；禁止在 workflow WAL 建立前
  直接移动或改写真实 Vault。
- attempt 结束后重新扫描副本。winner 只返回 sealed changeset，不得在
  attempt 内提前 apply、重建真实索引或删除 Shadow。
- Harness 必须先持久化包含 winner、精确提交路径、托管写入和 settings 目标的
  workflow WAL commit intent，随后才允许使用 CAS（比较并交换）向真实 Vault
  提交。WAL 发布失败时真实 Vault 保持零业务写入。
- partial 的共享索引由 Harness 纯规划目标内容并纳入同一 WAL；不得先写真实
  索引再补提交记录。
- timeout 后仍可能写入的旧副本不复用、不立即删除，也不能影响后续 attempt。

### 文件系统安全边界

Agent 开始运行前，Adapter 必须先安装操作系统级精确写入围栏：Agent 只能写
自己的 Shadow Vault，不能写真实 Vault、Shadow 控制目录或其他 attempt。
如果这项证明缺失，维护不得启动，也不能靠提交阶段的检查补救。

真实 Vault 的提交和恢复以正常并发安全为目标。每条变更同时绑定父目录链
inode、目标文件 inode、内容与权限 CAS；创建、替换和删除使用 no-clobber
临时项、持久 journal 和逐步复验。父目录被换成 symlink、真实目录被替换、
目标被同内容换 inode，或 temp / displaced 路径出现第三值时，Harness 必须
保留现场并阻断，不能覆盖、误删或切换到另一个 Agent。已写入 WAL 提交意图
后发生崩溃，只允许重放同一 winner 的 journal。

这不是对本机恶意同 UID 进程的严格安全承诺。Node.js 在 macOS 暴露的公开
文件 API 没有 `openat`、`linkat`、`unlinkat`、`renameat` 这类基于已打开目录
句柄的完整操作族，因此路径检查与实际系统调用之间仍无法从纯 Node 层彻底
排除精心构造的 ancestor swap / ABA（路径被换走后又换回）竞态。当前实现会
在操作前后复验父链、文件 inode、link count 和 CAS，足以处理持久 symlink、
目录替换和常规并发；但不宣称能阻止一个本来就有权限直接改写真实 Vault 的
恶意本机进程。

若以后必须覆盖这一更强威胁模型，需要引入经过审计的原生目录句柄 helper，
或把提交器放进独立权限域。当前版本检测到父链、inode、CAS 或 journal
不一致时，一律保留 journal 与事务 artifact，结果进入阻断态且禁止 Agent
切换；产品文案不得把这一边界描述成“strict local adversary safety”。

### 成果恢复与部分提交

Agent 返回失败或终态丢失时，Harness 先检查实际产物：

- 报告、Wiki / Projects 正文和来源证据完整，按 `recovered` 完成。
- 一批来源中只有部分来源通过逐来源验证，只提交互不依赖的有效来源，结果为 `partial`；其余来源保持 pending。
- `partial` 不直接提交可能同时包含已验证与待处理页面的共享索引；插件只根据真实已提交的证据页重建 Harness 托管索引区块。索引重建失败时整轮回滚，来源保持 pending。
- 没有待处理来源时结果为 `noop`，不调用任何 Agent；Harness 仍可在同一 WAL
  中核对并规范化自己托管的 tracker、报告终态和 settings。界面必须显示
  “已检查（无新来源）”，不能暗示绝对零文件写入。
- 有产物但证据无效、共享目标存在依赖冲突或无法证明安全时，停止并保留诊断，不换 Agent。

tracker、Raw 托管元属性和 settings 只由插件在提交阶段写入。Agent 不能直接把来源标成已处理。

## 失败分类

| 类别 | 默认处理 |
| --- | --- |
| Agent 未安装、未加载、未登录或启动前连接预检失败 | 只有完整安全切换门槛成立，且能证明原生执行未启动、真实 Vault 零写入、零成果、零 WAL 提交意图时，才惰性检查下一个已就绪 Agent |
| 运行期网络断开、transport 关闭或 timeout | 先恢复成果；只有完整安全切换门槛成立，包括同 lease 原生终止确认、精确写入围栏、Shadow durable quarantine、零成果和零 WAL 提交意图，才惰性检查下一个已就绪 Agent |
| 用户取消 | 结束为 canceled，不提交、不切换 |
| Agent 尝试写 Raw、规则或插件托管文件，但被围栏成功拦截 | 作为可恢复的工具事件反馈给当前 Agent，继续本 attempt，不直接判整轮失败 |
| 受保护内容实际变化、围栏状态不可信，或 Agent 因策略拒绝无法形成业务结果 | 停止并保留诊断，不切换 |
| 单个来源证据不足 | 有独立有效来源时 partial；否则业务失败，不切换 |
| Vault 不安全、CAS 冲突、磁盘或 ledger 故障 | 整轮停止，不切换 |
| 未知错误或无法证明旧 Agent 已被隔离 | fail closed，不切换 |

## 实施阶段

1. 已完成：固化 7 月 15 日至 17 日的 timeout、半提交和终态丢失样本，建立故障分类与 selected-first 路由测试。
2. 已完成：接入 per-attempt Shadow Vault、精确写入围栏、Prompt/附件重映射和零结果证明。
3. 已完成：把 artifact recovery、逐来源证据验证、`partial` / `recovered` / `noop` 接入真实 runner。
4. 已完成：用追加式 attempt 记录替代同日覆盖，统一 scheduler、history、dashboard 和报告卡片状态。
5. 已完成验收、待交付确认：自动化、真实 test Vault 和故障注入均已通过；隔离分支尚未提交或合入主分支。

## 验收标准

- 三种 Agent 分别被选中时，都首先执行所选 Agent。
- 手动 `/maintain`、命令面板、定时维护和启动补跑都使用启动时锁定的当前所选 Agent，不存在入口特例。
- 首选成功只产生一个真实 attempt；其他 Agent 不会因本轮维护路由而被连接、预检或执行，readiness 检查次数为零。
- 首选启动前失败只有在完整安全切换门槛成立时才按顺序惰性检查备用 Agent；找到首个已就绪候选即执行并停止检查，后续候选的 readiness 检查次数为零。
- 运行期失败只有在封闭基础设施白名单、零可恢复成果、零 WAL 提交意图、同 lease 原生终止确认、精确写入围栏、Shadow durable quarantine 和旧权限撤销全部成立时才切换；abort acknowledgement 缺失时备用 readiness 检查次数为零。
- workflow WAL 提交意图一经持久化，后续 timeout、崩溃或重载都只能恢复同一 winner/attempt，备用 Agent 的 readiness 检查和执行次数为零。
- Codex、OpenCode、Hermes 在相同输入下都经过同一维护 Harness 状态机、安全切换门槛、Shadow、恢复、验证、WAL 与提交；仅 invocation adapter 可以不同。
- 首个 `await` 后修改 Agent 选择、`workflowRunId` 或嵌套资源参数，不会改变
  当前运行；Codex thread 配置中的 MCP 与 Plugin 均为空。
- 用户取消、策略拒绝、业务验证失败和未知错误不会切换。
- Agent 对 Raw、规则或 tracker 的单次越界写入尝试被执行层拦截后，可以继续在合法路径完成，不直接显示红色失败。
- 20 个来源中 19 个独立通过时提交 19 个，剩余 1 个保持 pending，并显示“部分完成”。
- timeout、崩溃和重载后没有真实 Vault 的迟到写入、假 processed 或重复提交。
- Raw 正文、路径、附件、权限和身份保持不变。
- 每个终态都有 `workflowRunId`、attempt、实际 backend、阶段和错误码。
- `npm run test`、`npm run typecheck`、`npm run build` 和真实 test Vault 验收全部通过。
- 所有关键故障点必须先完成确定性自动化覆盖，再执行 30 轮使用可记录、
  可复现固定 seed 的随机故障注入。目标为零 Raw 污染、零终态后真实写入、
  零重复 processed。
- 若上述测试运行稳定且耗时可接受，可以把随机故障注入扩展到最多 100 轮，
  作为可选加压测试；未跑满 100 轮不阻塞交付。这些轮次不调用真实 Agent，
  也不在真实业务 Vault 反复维护。
- 三个真实 Agent 和 Obsidian testing Vault 只跑少量代表性关键场景，不为
  凑满 100 轮重复联网调用。
