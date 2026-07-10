# EchoInk 多 Agent 后端与 Hermes 接入改造计划

> 状态：2026-07-08 已完成第一阶段实现与验收，并已把隔离 worktree 的完整实现同步回主仓。Hermes CLI 已安装并接入后端；EchoInk Resource Registry、Agent runtime 工厂、知识库分流、普通聊天、编辑区写作、MCP broker 基础层、设置迁移与 UI 已落地。`npm run test`、`npm run typecheck`、`npm run build`、真实 Vault deploy 已通过。真实 Obsidian 已重启并迁移到 `settingsVersion: 29`。已修复旧版把 `hermes/hermes-agent` 写成默认 provider/model 的问题；无显式配置时插件不再传 provider/model，而是让 Hermes 使用自身默认配置。真实 Obsidian 已完成 Hermes 检测、知识库 `/ask`、编辑区候选生成、`Esc` 取消、`Enter` 确认验收。

## 执行状态快照

| 范围 | 当前状态 | 证据 / 说明 |
| --- | --- | --- |
| Hermes 本机验证 | 完成 | `/Users/lyuakin/.local/bin/hermes`，`Hermes Agent v0.18.0 (2026.7.1)`；`hermes config check` 可检测到 `DEEPSEEK_API_KEY`。 |
| Hermes provider 真实问答 | 完成 | `hermes -z "只回复 PONG"` 返回 `PONG`；通过真实 Obsidian 命令 `codex-echoink:test-hermes-connection` 写入 `providerConfigured=true`，且不再写入旧占位值 `hermes/hermes-agent`。 |
| Agent 设置与迁移 | 完成 | settingsVersion 升到 `29`，真实 Vault data.json 已包含 `agents`、`capabilities`、`resources.mcpBroker`。 |
| EchoInk Resource Registry | 完成 | Skill / MCP / Tool bundle 进入插件级资源目录；开关按 chat / knowledge / editor-actions scope 保存，不写回 Codex/Hermes/OpenCode 全局配置。 |
| Agent runtime 工厂 | 完成 | KnowledgeBaseManager 的 OpenCode / Hermes 知识库任务改走 `createAgentTaskRuntime`；Codex 保留 rich runtime。 |
| 知识库通用化 | 完成 | `/ask`、`/check`、`/maintain`、`/journal` 按能力层调用 Agent；raw 保护、事务、timeout、cancel 仍由 EchoInk 收口。 |
| 普通聊天 / 编辑区 | 完成 | Codex 保留 rich timeline；OpenCode/Hermes 使用 simple task path；Hermes 普通聊天已在真实 Obsidian 返回 `PONG`；编辑区候选文案已去 Codex 中心化。 |
| MCP / Skill 桥接 | 完成第一版 | Skill 已 prompt-only 通用化；MCP 已有 EchoInk broker 基础层，支持显式 `metadata.mcp` 连接配置的 list tools / call tool / 审批 / 日志。仅导入但无连接配置的 MCP 会显示为不可直接 broker 调用。 |
| 真实 Obsidian Hermes 任务验收 | 完成第一阶段 | 已通过真实 Obsidian 侧栏发送 Hermes `/ask`；编辑区写作在 `testing/` 笔记中完成候选生成、`Esc` 取消不落盘、`Enter` 确认落盘验证。`/check` 的 timeout/cancel 由单测覆盖，未在真实 Vault 触发全库维护以避免写入业务知识库报告。 |
| 管家化探索 | 完成文档 | `docs/hermes-butler-roadmap.md` 已定义 profile / memory / dream / insights 边界：只能先产出建议或草稿，不直接改 raw/wiki。 |

## 目标

把 EchoInk 从“Codex 为中心的 Obsidian 插件”改造成“多 Agent 后端宿主”：

- Codex、OpenCode、Hermes 都是可切换 Agent 后端。
- 普通聊天、知识库维护、知识库问答、日记、编辑区写作逐步走统一 Agent 能力接口。
- MCP、Skill、工具包由 EchoInk 本体统一管理；Codex/OpenCode/Hermes 只是调用这些资源的后端。
- 知识库规则文件仍是能力层规则，不绑定某个 Agent；不同 Agent 都按同一份知识库操作指南执行。
- Agent 相关设置集中在 Agent 设置区；知识库、复盘、资源管理、写作等能力设置保持通用。
- Hermes 先作为完整后端接入，不只做一个命令按钮；后续再探索 memory、SOUL/profile、insights/dream 类能力如何让 EchoInk 更像知识库管家。

## 第一性原理

Agent 后端不是“一个 CLI 命令”，而是一组能力：

- 运行入口：CLI、server、SDK、API、desktop bridge。
- 会话能力：创建、继续、取消、恢复、历史。
- 模型能力：模型列表、provider、API key、输入模态。
- 工具能力：文件读写、命令执行、结构化 tool call、是否能接收外部 MCP/Skill。
- 过程能力：流式输出、reasoning、tool call、file change、approval。
- 安全能力：权限模式、可写目录、取消、timeout、raw 保护。
- 个性能力：profile、memory、人格、长期偏好。

所以改造的根本不是“加 Hermes 选项”，而是把 EchoInk 当前 Codex 专属的这些能力拆成：

- **Agent 后端层**：每个 Agent 自己怎么连接、发 prompt、取消、列模型、列 profile、处理事件。
- **EchoInk 资源层**：插件自己发现、归一化、开关、加载 MCP/Skill/工具包；资源开关只作用于当前插件，不直接改写各 Agent 全局配置。
- **通用能力层**：知识库、复盘、写作、UI 状态，只依赖 Agent runtime 和 EchoInk 资源层，不直接知道 Codex/OpenCode/Hermes 细节。

## 当前事实

### OpenCode 接入方式

OpenCode 不是只接 CLI，也不是只接 SDK。当前实现是：

- 用 `resolveOpenCodeCommand()` 找 CLI；没有显式 serverUrl 时，用 CLI 启动 `opencode serve`。
- 再用 `@opencode-ai/sdk/v2` 连接 OpenCode server。
- 模型、Agent、session、prompt、abort、file status 都通过 SDK server API 完成。

证据：

- `src/core/opencode-backend.ts` 通过 `createOpencodeClient` 接 SDK，并在 `connect()` 中必要时启动 OpenCode server。
- `src/core/opencode-models.ts` 负责 CLI 路径探测。
- `src/core/opencode-backend.ts` 的 `startOpenCodeServer()` 解析 `opencode server listening ...` 输出。

这说明 Hermes 也应该优先采用“CLI 管安装/doctor/model，server/API 管会话任务”的结构；如果只用一次性 CLI，会丢会话、取消、资源、过程事件。

### 现有后端抽象只做了一半

- `src/agent/types.ts` 已有 `AgentBackend`，但只覆盖 OpenCode 风格的一次性任务接口，`AgentBackendKind` 只有 `codex-cli | opencode`。
- `src/settings/settings.ts` 的 `agentBackend` 和 `knowledgeBase.backend` 也只有这两个值。
- `src/knowledge-base/manager.ts` 已能在 Codex/OpenCode 间分流，但实现是 `if backend === "opencode"`，不是统一工厂。
- 普通聊天 `src/ui/codex-view/turn-runner.ts` 仍直接调用 `plugin.codex.startThread/startTurn`。
- 编辑区写作 `src/ui/codex-view/editor-action-runner.ts` 仍直接依赖 `ensureCodexConnected()` 和 `plugin.codex.startTurn()`。
- 当前资源管理 `src/settings/settings-tab.ts` 的 plugins/MCP/skills 仍通过 `plugin.codex.refreshWorkspaceResources()` 读取。这是现状，不是目标架构；目标是 EchoInk 自己成为资源宿主。
- 自定义 API provider 仍是 Codex 专属：`src/core/codex-service.ts` 把 provider 写成 Codex `model_provider/base_url/wire_api="responses"` 启动参数。

## 产品信息架构

### Agent 设置

新增一个独立的 Agent 设置区，按 Agent 分 tab 或卡片：

- `Codex`
  - CLI 路径
  - 登录态
  - 自定义 API provider
  - 默认模型、reasoning、service tier、权限
  - Codex 原生资源导入状态，只作为 EchoInk Resource Registry 的一个来源
- `OpenCode`
  - CLI 路径
  - serverUrl / host / port / autoStart
  - providerId / modelId
  - Agent profile
  - 支持模态
- `Hermes`
  - CLI 路径
  - 安装/doctor 状态
  - server/API 地址或启动方式
  - profile/SOUL/memory 状态
  - provider/model 配置入口
  - later：insights/dream/personality 能力开关

全局只保留一个“默认 Agent 后端”。能力可以选择“跟随默认”或“指定 Agent”。

### 通用能力设置

这些不属于某个 Agent：

- 知识库：规则文件、调度、raw 保护、历史保留、报告路径。
- 复盘：周报范围、输出目录、是否自动打开 HTML。
- 写作：动作列表、提示词、风格、上下文长度、候选确认体验。
- 资源：MCP / Skill / 工具包由 EchoInk 本体统一管理，可从 Codex 配置、Hermes 配置、本地目录或手动配置导入；开关只影响当前插件的运行上下文。
- 首页：只看知识库状态和任务状态，不关心背后 Agent。

## 目标架构

### 1. Agent Registry

新增统一注册表：

```ts
type AgentBackendKind = "codex-cli" | "opencode" | "hermes";

interface AgentBackendDefinition {
  kind: AgentBackendKind;
  label: string;
  capabilities: AgentBackendCapabilities;
  createRuntime(settings, vaultPath): AgentRuntime;
}
```

能力声明不要假装所有 Agent 一样：

```ts
interface AgentBackendCapabilities {
  chat: boolean;
  knowledgeTasks: boolean;
  editorActions: boolean;
  listModels: boolean;
  listAgents: boolean;
  fileStatus: boolean;
  richEvents: boolean;
  structuredToolCalls: boolean;
  nativeMcpPassThrough: boolean;
  promptInstructionInjection: boolean;
  customProviderConfig: "codex-responses" | "opencode-provider" | "hermes-model" | "external";
}
```

### 2. EchoInk Resource Registry

MCP/Skill 不应继续作为 Codex 状态服务的附属品。目标是 EchoInk 自己维护一个插件级资源注册表。

```ts
type EchoInkResourceKind = "skill" | "mcp-server" | "tool-bundle";
type EchoInkResourceSource = "echoink-local" | "codex-import" | "hermes-import" | "opencode-import" | "manual";

interface EchoInkResource {
  id: string;
  kind: EchoInkResourceKind;
  source: EchoInkResourceSource;
  name: string;
  description: string;
  enabled: boolean;
  scopes: Array<"chat" | "knowledge" | "editor-actions">;
  configPath?: string;
  contentPath?: string;
}
```

资源来源：

- `echoink-local`：EchoInk 插件自己的资源目录，优先级最高。
- `codex-import`：从 Codex app-server/config 读取后导入，只作为初始来源，不把开关写回 Codex 全局配置。
- `hermes-import`：从 Hermes skills/mcp/profile 能力读取后导入，只作为来源。
- `opencode-import`：从 OpenCode 可暴露的 agent/tool 配置导入。
- `manual`：用户在插件设置中手动添加。

资源执行方式：

- Skill：插件读取说明、引用文件、脚本入口，统一转成 prompt 指令或附件上下文；这是最容易跨 Agent 通用的部分。
- MCP：插件必须自己实现 MCP client / tool broker，负责启动或连接 server、列工具、执行工具、处理 OAuth/密钥、做权限审批和日志。
- 工具包：插件内置的知识库工具，例如搜索、读文件、写报告、raw 安全检查，优先由插件自己执行，不交给 Agent 自由发挥。

关键原则：

- 开关只改变 EchoInk 当前 Vault / 当前插件的资源加载，不改各 Agent 的全局 MCP/Skill 设置。
- 所有 Agent 都通过 EchoInk Resource Broker 获得同一套资源，但具体桥接方式取决于 Agent runtime 能力。
- 如果后端支持原生 MCP passthrough，可以把 EchoInk 生成的临时 MCP 配置传进去。
- 如果后端支持结构化 tool call，EchoInk 作为 broker 执行工具。
- 如果后端两者都不支持，只能使用 prompt-only skill，不假装 MCP 可用。

### 3. Agent Runtime 接口分层

不要用一个接口硬套所有场景。建议拆三层：

```ts
interface AgentTaskRuntime {
  kind: AgentBackendKind;
  connect(): Promise<AgentConnectionStatus>;
  listModels(): Promise<AgentModelInfo[]>;
  listAgents?(): Promise<AgentProfileInfo[]>;
  runTask(input: AgentTaskInput): Promise<AgentTaskResult>;
  abort(runId: string): Promise<void>;
}

interface AgentChatRuntime extends AgentTaskRuntime {
  startChatSession(input: AgentSessionOptions): Promise<AgentSessionRef>;
  sendChatTurn(input: AgentChatTurnInput): Promise<AgentTurnRef>;
}

interface PreparedAgentResources {
  promptPrefix?: string;
  mcpConfig?: Record<string, unknown>;
  toolBridge?: EchoInkToolBridge;
}
```

原因：

- 知识库维护和编辑区写作只需要任务结果。
- 普通聊天需要会话、流式事件、停止、消息过程。
- MCP/Skill/工具包属于 EchoInk 资源层；Agent runtime 只负责接收 `PreparedAgentResources` 并按自身能力使用。

### 4. 设置数据迁移

把现在的平铺字段迁到 agents 结构，但保留兼容迁移：

```ts
interface AgentSettings {
  defaultBackend: AgentBackendKind;
  codex: CodexAgentSettings;
  opencode: OpenCodeSettings;
  hermes: HermesAgentSettings;
}

interface CapabilityBackendSettings {
  chatBackend: "default" | AgentBackendKind;
  knowledgeBackend: "default" | AgentBackendKind;
  editorActionBackend: "default" | AgentBackendKind;
}
```

迁移规则：

- 旧 `agentBackend` -> `agents.defaultBackend`。
- 旧 `cliPath/providerMode/apiProviders/defaultModel/...` -> `agents.codex`。
- 旧 `opencode` -> `agents.opencode`。
- 旧 `knowledgeBase.backend` 保留语义，后续迁入 `capabilities.knowledgeBackend`。

## Hermes 接入策略

### 官方能力预研结论

Hermes 官方文档显示它具备：

- CLI 安装与 `hermes doctor`。
- `hermes model` 配置 provider/model。
- `hermes serve` / API server 类入口。
- `hermes mcp`、`hermes skills`、`hermes memory`、`hermes profile`、`hermes sessions`、`hermes insights` 等命令族。
- 支持 DeepSeek 等 provider 环境变量，例如 `DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`。

参考：

- https://hermes-agent.nousresearch.com/docs/getting-started/installation
- https://hermes-agent.nousresearch.com/docs/reference/cli-commands
- https://hermes-agent.nousresearch.com/docs/reference/environment-variables
- https://hermes-agent.nousresearch.com/docs/user-guide/features/api-server
- https://hermes-agent.nousresearch.com/docs/integrations/providers

### Hermes 第一版边界

第一版不把 dream/personality 当成功标准。成功标准是：

- 插件能检测 Hermes CLI。
- 插件能引导或展示 `hermes doctor` 状态。
- 插件能通过 Hermes 后端执行知识库 `/ask`、`/check`、`/maintain`、`/journal`。
- Hermes 的模型/provider 设置在 Agent 设置区可见。
- Hermes 任务遵守本插件 raw 保护、timeout、cancel、报告落盘。

### Hermes 技术路线

优先级：

1. **API server / serve 路线**  
   如果 Hermes server 提供稳定任务接口，作为正式实现。它更适合 session、abort、资源、状态。
2. **CLI non-interactive 路线**  
   只用于探测和兜底，不作为长期主路径。例如 `hermes -z "..."` 能验证模型和 provider，但不适合完整 UI 过程。
3. **ACP/TUI gateway 路线**  
   作为后续深度集成候选，先不放进第一版。

## 实施计划

### Phase 0：Hermes 本机验证

- [ ] 确认安装方式：
  - macOS/Windows 推荐 Desktop installer。
  - CLI-only 可用 `curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash`。
  - 若不需要浏览器工具，考虑 `--skip-browser`。
- [ ] 安装后验证：
  - `which hermes`
  - `hermes --help`
  - `hermes doctor`
  - `hermes model`
  - `hermes config check`
- [ ] 配置 DeepSeek 或 OpenAI-compatible provider：
  - 优先用 Hermes 官方 `hermes model`。
  - 不先让插件直接写 Hermes 配置，避免破坏用户的 Hermes profile。
- [ ] 验证任务入口：
  - 一次性 prompt。
  - server/API prompt。
  - cancel/timeout 可行性。
  - 是否能指定 cwd 为 Vault。
  - 是否能限制可写目录或至少通过插件事务保护兜底。

输出：

- Hermes 本机安装路径。
- 可用命令清单。
- 推荐接入方式：API server 或 CLI fallback。
- 第一版 HermesBackend 的接口约束。

### Phase 1：类型与设置骨架

- [ ] 扩展 `AgentBackendKind`：加入 `hermes`。
- [ ] 新增 `HermesAgentSettings`：
  - `cliPath`
  - `serverUrl`
  - `autoStart`
  - `hostname`
  - `port`
  - `profile`
  - `providerId`
  - `modelId`
  - `lastConnectedAt`
  - `lastError`
  - `capabilities`
- [ ] 新增 `AgentSettings`，逐步迁移旧字段。
- [ ] 保留旧字段读取兼容，避免现有用户 data.json 崩。
- [ ] 更新 normalize 和 tests。

验收：

- 旧 data.json 可以正常 normalize。
- 新设置默认仍走 Codex。
- OpenCode 设置不丢。

### Phase 2：EchoInk Resource Registry

- [ ] 新建 `src/resources/registry.ts`，作为插件级资源目录。
- [ ] 新建 `src/resources/types.ts`，定义 `EchoInkResource`、`EchoInkResourceKind`、`EchoInkResourceSource`。
- [ ] 新建 `src/resources/skill-loader.ts`：
  - 从 Codex `skills/list` 导入 skill metadata。
  - 从 Hermes skills 命令或目录导入 skill metadata。
  - 从 EchoInk 本地资源目录导入 skill。
  - 输出统一 skill catalog。
- [ ] 新建 `src/resources/mcp-loader.ts`：
  - 从 Codex config 导入 MCP server 配置。
  - 从 Hermes MCP 配置导入 MCP server 配置。
  - 支持 EchoInk 手动添加 MCP server。
  - 不把开关写回 Codex/Hermes 全局配置。
- [ ] 新建 `src/resources/tool-bundles.ts`：
  - 注册 EchoInk 内置知识库工具，例如本地检索、读文件、写报告、raw 变更检查。
- [ ] 设置中新增插件级 `resources` 数据结构：
  - `catalog`
  - `enabledByScope`
  - `importedFrom`
  - `lastScannedAt`
  - `lastError`
- [ ] 将旧 `workspaceResources` 迁移为 EchoInk 资源开关，不再理解为 Codex workspace resource override。

验收：

- 不连接 Codex 时，EchoInk 仍能读取自己本地保存的资源 catalog。
- 从 Codex 导入的 skill/MCP 只成为 EchoInk catalog 条目。
- 开关只影响当前插件/Vault 的运行，不修改 Codex/Hermes 全局配置。
- 旧 settings 的 `workspaceResources.skills/mcpServers/plugins` 可迁移。

### Phase 3：Agent Runtime 工厂

- [ ] 新建 `src/agent/registry.ts`。
- [ ] 新建 `src/agent/runtime.ts`。
- [ ] 把 OpenCode backend 接入统一 runtime。
- [ ] 给 Codex 增加 wrapper，不急着重写 CodexService。
- [ ] Agent runtime 接收 `PreparedAgentResources`，但不负责发现资源。
- [ ] KnowledgeBaseManager 不再自己 new OpenCodeBackend，而是通过 factory 获取 runtime。

验收：

- 现有 Codex/OpenCode 知识库测试通过。
- `runMaintenance`、`ask`、`journal` 不再出现新的后端分支爆炸。
- runtime tests 覆盖“无资源、prompt-only skill、MCP disabled”三种输入。

### Phase 4：知识库能力通用化

- [ ] 把 `runCodexKnowledgeTask` / `runOpenCodeKnowledgeTask` 收敛为 `runKnowledgeAgentTask`。
- [ ] `AgentTaskInput` 统一携带：
  - prompt
  - sources
  - permission
  - writableRoots
  - model
  - profile/agent
  - prepared resources
  - tools policy
  - timeout
- [ ] KnowledgeBaseManager 在进入 Agent 前调用 Resource Registry：
  - 读取知识库 scope 启用的 skills。
  - 生成 prompt prefix。
  - 准备 MCP/tool bridge，但只在后端能力允许时启用。
- [ ] 将 Codex 的 rich notification 作为 CodexRuntime 内部实现。
- [ ] 将 OpenCode timeout/abort 作为 OpenCodeRuntime 内部实现。
- [ ] 预留 HermesRuntime 的 timeout/abort。
- [ ] raw 保护、transaction、report 保存继续在 KnowledgeBaseManager 层做，不交给 Agent 自觉。

验收：

- `/check` read-only 仍不能改写 raw。
- `/maintain` 仍只允许白名单路径。
- cancel、timeout、failed 状态全部落盘。
- 测试覆盖 Codex、OpenCode、Hermes mock 三个后端。

### Phase 5：Agent 设置 UI 重构

- [ ] Settings 增加 `Agent` 主 tab。
- [ ] Agent tab 内按 Codex / OpenCode / Hermes 卡片或 tabs 展示。
- [ ] General 只保留默认 backend、语言、自动打开等真正全局项。
- [ ] Knowledge tab 只保留知识库能力设置；backend 选择器使用 Agent registry。
- [ ] Resource tab 显示 EchoInk 插件级资源：
  - Skills
  - MCP servers
  - Tool bundles
  - 来源标签：EchoInk local / imported from Codex / imported from Hermes / manual
  - scope 开关：chat / knowledge / editor-actions
- [ ] Agent tab 只显示 Agent 自身设置，不承载 MCP/Skill 开关。
- [ ] Setup guide 改成按当前能力所需后端检查，而不是永远要求 Codex。

验收：

- 切换默认 Agent 时，相关 Agent 设置在同一屏可见。
- 知识库仍可单独固定某个 Agent。
- 未安装 Hermes 时只 warning/block Hermes 路径，不影响 Codex/OpenCode。
- Resource tab 不因 Codex 未连接而完全不可用；最多只影响“重新从 Codex 导入”动作。

### Phase 6：HermesBackend 最小可用

- [ ] 新建：
  - `src/core/hermes-backend.ts`
  - `src/core/hermes-models.ts`
  - `src/core/hermes-errors.ts`
- [ ] 支持：
  - CLI 探测。
  - doctor/config 状态。
  - connect。
  - listModels 或读取当前 model。
  - runTask。
  - abort 或本地进程 kill。
  - lastError。
- [ ] 根据 Phase 0 结果选择 server/API 或 CLI fallback。
- [ ] 加入 settings UI 检测按钮。
- [ ] 加入 setup check。

验收：

- Hermes mock 单测通过。
- 本机 Hermes `/ask` 能返回本地依据。
- `/check` Hermes 模式 timeout/cancel 可收口。
- Hermes 模式失败时错误文案能说明是 Hermes，不再写 Codex/OpenCode。

### Phase 7：普通聊天与编辑区通用化

- [ ] 普通聊天从 `plugin.codex.startThread/startTurn` 改为 `AgentChatRuntime`。
- [ ] Codex rich timeline 继续保留。
- [ ] 非 richEvents 后端先显示简化过程：连接中、运行中、完成、失败。
- [ ] 普通聊天在发送前从 Resource Registry 准备 chat scope resources。
- [ ] 编辑区动作从 Codex turn 改为 `runTask`。
- [ ] 编辑区写作在发送前从 Resource Registry 准备 editor-actions scope resources。
- [ ] 编辑区严格模式仍保留“生成 -> 校验 -> 审校”两步。
- [ ] `Codex 候选` 文案改成 `Agent 候选` 或当前后端名。

验收：

- Codex 行为不回退。
- OpenCode/Hermes 至少能跑编辑区改写/扩写/续写。
- Enter 确认、Esc 取消、Markdown 保留仍通过真实 Obsidian 验收。

### Phase 8：MCP/Skill 调用桥接

- [ ] Skill 通用化：
  - 把 `CodexSkill` 泛化为 `EchoInkSkillResource`。
  - Skill 选择菜单从 Resource Registry 读取。
  - 选中 skill 后由插件注入 prompt 指令或附件上下文。
  - 如果 skill 有脚本入口，插件负责审批和执行，不让 Agent 随意执行。
- [ ] MCP 通用化：
  - 新建 EchoInk MCP client / manager。
  - 插件负责启动或连接 MCP server。
  - 插件负责 list tools、tool schema、调用、结果回传、日志。
  - OAuth/密钥状态由插件管理或显式引用外部配置。
- [ ] Agent 桥接模式：
  - `nativeMcpPassThrough`：生成临时 MCP 配置传给支持的后端。
  - `structuredToolCalls`：Agent 发结构化工具请求，EchoInk 执行并回传。
  - `promptOnly`：只注入 skill 指令，不开放 MCP。
- [ ] MCP 开关从全局 `mcpEnabled` 改为插件资源 scope：
  - chat scope
  - knowledge scope
  - editor-actions scope
  - per-resource enable/disable

验收：

- Codex 仍可使用原有 MCP/skills，但来源是 EchoInk Resource Registry。
- OpenCode/Hermes 能使用 prompt-only skills。
- MCP 只有在 bridge 可用时才显示“可调用”，否则明确显示“已导入但当前后端不可调用”。
- 同名 skill/MCP 从不同来源导入时有稳定 id，不互相覆盖。
- 所有工具调用进入 EchoInk 日志和权限审批链。

### Phase 9：命名与体验收口

- [ ] UI 文案去 Codex 中心化：
  - `Codex 侧栏` -> `EchoInk Agent`
  - `Codex 状态` -> `Agent 状态`
  - `Codex 候选` -> `Agent 候选`
- [ ] 内部类名可后续慢慢改，不在第一轮强制大改。
- [ ] README 隐私/权限说明更新为多 Agent 后端。
- [ ] 设置页补充各 Agent 需要本机安装和 API key 的边界。

验收：

- 用户视角不再误以为插件只支持 Codex。
- Obsidian review 需要的隐私披露仍清晰。

### Phase 10：管家化探索

在 Hermes 可用后再设计：

- SOUL.md / profile 如何映射到“方哥知识库管家人格”。
- Hermes memory 与 EchoInk 本地 history、Obsidian wiki、`.codex-memory` 的边界。
- insights/dream 类能力是否输出到 `outputs/hermes-insights/`。
- 主动建议必须先进入 inbox/报告，不直接改 raw/wiki。
- 管家主动性分级：
  - 只读建议
  - 草稿生成
  - 待确认改写
  - 自动维护

验收：

- 主动能力可审计、可关闭、可回滚。
- 不绕过 raw 保护。
- 不把人格记忆和知识库事实混在一起。

## 风险与对策

- **风险：把 Hermes 接成一次性命令，后续聊天/取消/资源全返工。**  
  对策：Phase 0 必须验证 server/API 能力；CLI fallback 只做兜底。

- **风险：为了多 Agent 把 Codex rich timeline 做丢。**  
  对策：runtime 分 richEvents 与 simpleEvents；Codex 继续走原过程事件。

- **风险：EchoInk 只导入了 MCP/Skill 列表，却没有真正的调用桥接。**  
  对策：Skill 先做 prompt-only 通用化；MCP 必须等 EchoInk MCP client / tool broker / 权限日志可用后才标记为“可调用”。

- **风险：把资源开关写回 Codex/Hermes 全局配置，污染用户其他工具。**  
  对策：导入和开关分离；导入只读取来源，开关只保存在 EchoInk 当前 Vault/plugin data。

- **风险：Hermes memory/dream 主动修改知识库。**  
  对策：所有写入仍走 EchoInk transaction、raw snapshot、writableRoots 或等价保护。

- **风险：设置迁移破坏老用户。**  
  对策：保留旧字段 normalize；测试覆盖旧 data.json。

## 验证清单

每个代码阶段至少跑：

- `npm run test`
- `npm run typecheck`
- `npm run build`

涉及插件功能变更后固定跑：

- `OBSIDIAN_VAULT=/Users/lyuakin/Documents/AKin-note-management npm run deploy`
- 打开真实 Obsidian `/Users/lyuakin/Documents/AKin-note-management`
- 只在 `testing/` 下验证 `/ask`、`/check`、`/maintain`、编辑区动作

Hermes 阶段额外跑：

- `which hermes`
- `hermes doctor`
- `hermes model` 或等价非交互状态检查
- Hermes 后端 `/ask` 真实问答
- Hermes 后端 `/check` cancel/timeout 测试

## 执行顺序建议

先执行 Phase 0-4，完成“插件级资源注册表 + Agent runtime + 知识库后端通用化”。  
再执行 Phase 5-8，完成 Agent 设置、Hermes 后端、普通聊天/写作和 MCP/Skill 调用桥接。  
最后执行 Phase 9-10，完成命名收口和 Hermes 管家化讨论。

原因：知识库能力是目标核心，且已有 Codex/OpenCode 双后端基础；MCP/Skill 要先成为 EchoInk 本体资源，否则后续每个 Agent 适配都会重复造一套资源逻辑。普通聊天和编辑区强绑 Codex，重构风险更高，应该在 runtime 和资源层稳定后再动。
