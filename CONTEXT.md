# EchoInk Harness

EchoInk Harness 管理用户记录、业务执行、后端缓存和长期事实之间的权威关系。
这些概念必须跨 Codex、OpenCode 和 Hermes 保持同一含义。

## Language

**Conversation**:
用户可见、后端无关的对话真源。它不依赖任何一个 Agent 的原生会话才能恢复连续性。
_Avoid_: Thread、Session、Chat cache

**Workflow Run**:
一次用户操作或自动工作流的逻辑执行记录，可以包含多个 Attempt Run。
_Avoid_: Harness invocation、Backend run

**Attempt Run**:
Workflow Run 在某个后端上的一次执行尝试，对应一次 Harness invocation。
_Avoid_: Workflow Run

**Native Execution**:
Codex thread、OpenCode session、Hermes session/run 或进程等可清理的后端执行缓存。
_Avoid_: Conversation、History

**Workflow Artifact**:
报告、Wiki、Tracker、WAL 或已确认编辑结果等独立保留的业务成果。
_Avoid_: Run log、Conversation message

**Long-term Memory**:
正式事实、待确认或未决候选，以及它们尚未收口的来源事务。
_Avoid_: Native Memory cache、Conversation history

**Record Mutation**:
跨一个或多个本地记录域执行的可恢复业务变更，拥有独立的提交或补偿终态。
_Avoid_: Native cleanup、直接删除

**Root Binding**:
逻辑 root ID 与一个物理目录身份及其 owner boundary 的不可变绑定。
_Avoid_: Path alias、未经验证的 root ID

**Mutation Authority**:
在一个 Record Mutation 中发布跨域业务成功标记的唯一权威。
_Avoid_: 单个 Store 写入成功、Native cleanup 完成

**Recovery Evidence**:
足以唯一判断继续提交、补偿或阻断的耐久证据。
_Avoid_: 内存状态、猜测性日志
