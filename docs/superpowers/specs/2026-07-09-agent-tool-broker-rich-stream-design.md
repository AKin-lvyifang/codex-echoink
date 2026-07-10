# EchoInk Agent Tool Broker and Rich Stream Design

日期：2026-07-09  
状态：待实施  
范围：MCP broker 真实调用闭环、工具调用事件接入 AgentEvent、OpenCode/Hermes rich stream  
暂不包含：Hermes 管家化、dream、profile memory、主动维护

## 结论

下一阶段应该按这个顺序做：

1. MCP broker 真实调用闭环。
2. 工具调用接入 AgentEvent，让用户能看到“请求工具、审批、执行、结果、失败”。
3. OpenCode/Hermes rich stream，只接真实后端公开事件，不伪造 Codex 级直播。

原因很直接：EchoInk 的目标是成为 Agent 宿主。宿主能力的核心不是“过程 UI 更热闹”，而是 EchoInk 自己管资源、权限、工具调用、日志和落盘。rich stream 是体验增强，MCP broker 是产品地基。

## 第一性原理

Agent 后端要使用知识库资源，只有三条路：

1. 后端原生支持 MCP passthrough。
   - EchoInk 生成临时 MCP 配置，后端自己调用。
   - 好处是自然；风险是权限和日志可能不完全在 EchoInk 手里。

2. 后端原生支持结构化工具调用。
   - 后端请求工具，EchoInk 审批和执行。
   - 这是理想形态，但 OpenCode/Hermes 当前还没有稳定落成。

3. EchoInk 自己做工具循环。
   - EchoInk 把可用工具说明放进 prompt。
   - Agent 用固定格式请求工具。
   - EchoInk 解析、审批、调用 MCP、把结果喂回 Agent。
   - 这是当前 OpenCode/Hermes 最可控的路线。

所以本设计采用“能力分层”：

- Codex：继续走 native rich path 和 native MCP passthrough。
- OpenCode/Hermes：先走 EchoInk broker-mediated tool loop；后端真正暴露 rich stream 后，再切到 native/rich adapter。
- EchoInk：始终拥有 MCP 连接、权限、日志、状态、工具事件。

## 当前事实

当前代码已有这些基础：

- `src/resources/mcp-broker.ts` 已能对单个 MCP resource 执行 `tools/list` 和 `tools/call`，并记录 approval / denied / completed / failed。
- `src/resources/mcp-connections.ts` 已能区分 `仅导入 / 缺连接配置 / 可连接 / 已验证 / 连接失败`。
- `src/main.ts` 已暴露 `listEchoInkMcpTools()` 和 `callEchoInkMcpTool()`。
- `src/agent/events.ts` 已有 `tool_call_requested`、`permission_requested`、`tool_call_completed`、`tool_call_failed` 等事件类型。
- `src/ui/codex-view/agent-event-renderer.ts` 已能把工具事件渲染到聊天消息 details。
- `src/agent/registry.ts` 里 OpenCode/Hermes 仍是 `structuredToolCalls: false`、`nativeMcpPassThrough: false`。

缺口也很明确：

- Broker 能被手动调用，但还没有成为 Agent runtime 的统一工具能力。
- Tool call log 是 broker 内部日志，还没有稳定变成聊天/知识库/编辑区可见事件。
- OpenCode 当前是 CLI lifecycle fallback，不是 HTTP ACP rich stream。
- Hermes 只有在真实暴露 public stream / ACP / event API 时才能显示 rich events。

## 产品原则

### 1. 真实优先

只显示后端真实公开的过程。不能把普通 lifecycle 状态包装成“工具调用直播”。

### 2. EchoInk 主控

MCP 连接、工具审批、调用日志、Vault 写入边界由 EchoInk 管。Agent 后端只提出请求。

### 3. 默认安全

第一阶段只默认启用只读或低风险工具。写 Vault、执行命令、外部网络类工具必须明确审批，并进入日志。

### 4. 可解释

用户要能看懂：

- 哪个 Agent 请求了哪个工具。
- 参数是什么。
- 是否被批准。
- 工具返回了什么。
- 失败原因是什么。

### 5. 不把导入误说成可调用

`仅导入` 仍然只是目录记录。只有有 EchoInk 连接配置并通过 broker 验证的 MCP，才能进入可调用工具集合。

## 核心设计

### A. MCP Tool Catalog

新增一个 broker 级工具目录。

职责：

- 根据当前 scope 找到启用的 MCP resources。
- 过滤掉 `仅导入`、缺连接配置、连接失败的资源。
- 对每个资源调用 `tools/list`。
- 生成 EchoInk 工具名，例如：
  - `notes.read_note`
  - `memory.search_notes`
- 记录工具来自哪个 resource。
- 缓存短时间内的工具列表，避免每次 prompt 都重新启动 MCP server。

建议文件：

- `src/resources/mcp-tool-catalog.ts`

### B. Agent Tool Bridge

新增 Agent 运行时可用的工具桥。

职责：

- 把 MCP tools 转成 Agent 可理解的工具说明。
- 解析 Agent 请求工具的固定格式。
- 调用 broker。
- 发出 AgentEvent。
- 控制最大工具调用轮数，避免死循环。

建议文件：

- `src/agent/tool-bridge.ts`

固定工具请求格式：

````markdown
```echoink-tool-call
{
  "tool": "notes.read_note",
  "arguments": {
    "path": "wiki/example.md"
  }
}
```
````

必须要求完全匹配 `echoink-tool-call` 代码块。普通 JSON、普通代码块、自然语言都不能触发工具调用。

### C. Broker-Mediated Tool Loop

OpenCode/Hermes 当前没有稳定 native structured tool call，所以第一阶段使用 EchoInk 工具循环：

1. EchoInk 生成工具说明，附到 prompt 前部。
2. Agent 如果需要工具，只输出一个 `echoink-tool-call` 代码块。
3. EchoInk 解析请求。
4. EchoInk 触发权限审批。
5. EchoInk 调用 MCP broker。
6. EchoInk 把工具结果追加回下一轮 prompt。
7. Agent 输出最终答案。

默认限制：

- 单次任务最多 3 次工具调用。
- 单次工具参数 JSON 最多 8KB。
- 单次工具结果注入最多 20KB，超出要截断并说明。
- 工具调用失败后最多给 Agent 一次修正机会。
- 编辑区动作默认不启用写入类 MCP 工具。

### D. AgentEvent Tool Visibility

工具调用必须进入同一套 AgentEvent：

- `tool_call_requested`：Agent 请求工具。
- `permission_requested`：EchoInk 请求用户审批。
- `tool_call_completed`：MCP 返回成功。
- `tool_call_failed`：MCP 调用失败或被拒绝。
- `usage`：如果后端给了 token / usage，再显示。

聊天 UI 已有 reducer，但需要补齐：

- tool input 展示要截断。
- tool output 展示要截断。
- 被拒绝要显示“已拒绝”，不是普通失败。
- lifecycle fallback 也能显示工具事件。

### E. OpenCode Rich Stream

OpenCode 下一步不要再用 stdio ACP 假设。因为本机已验证 `opencode acp` 是 HTTP ACP server，不是 stdio JSON-RPC。

正确路线：

1. 先做 discovery spike，确认本机 OpenCode HTTP ACP 的启动命令、端口、事件通道。
2. 如果有 SSE/WebSocket/session update 事件，新增 HTTP ACP runtime。
3. 如果没有稳定事件通道，继续 CLI lifecycle fallback，只把工具 loop 和 AgentEvent 做扎实。

建议文件：

- `src/agent/http-acp-runtime.ts`
- 或 `src/agent/opencode-http-acp-runtime.ts`

### F. Hermes Rich Stream

Hermes rich stream 只在后端真实支持时接入。

可能来源：

- `hermes acp`
- `hermes serve` 的 stream endpoint
- `/runs/:id/events`
- CLI JSON lines / streaming output

实施时必须先验证本机能力。没有公开事件就不升级 capabilities。

建议文件：

- `src/agent/hermes-stream-runtime.ts`

## 用户体验

### Resource / MCP 页

保留现在的状态文案：

- 仅导入
- 缺连接配置
- 可连接
- 已验证
- 连接失败

新增可选信息：

- 已发现工具数。
- 最近一次测试时间。
- 最近一次调用状态。
- 调用日志入口。

### 聊天区

工具过程应该像这样：

```text
Hermes 请求工具：notes.search_notes
等待审批
已批准
工具完成：notes.search_notes
Hermes 总结结果
```

用户不需要看到底层 MCP JSON-RPC 细节。

### 知识库任务

知识库任务可以使用 broker，但必须继续遵守：

- raw 保护。
- transaction rollback。
- timeout / cancel。
- 真实 Vault 测试只用 `testing/`。

### 编辑区动作

编辑区写作要谨慎：

- 第一阶段只允许 prompt-only Skill 和只读 MCP。
- 写入类工具暂不自动开放给编辑区动作。
- Enter / Esc 候选确认逻辑不能被工具 loop 破坏。

## 非目标

- 不做 Hermes 管家化。
- 不把 Hermes memory 当知识库事实来源。
- 不让 MCP server 直接改 Vault，绕过 EchoInk transaction。
- 不声明 OpenCode/Hermes 已达到 Codex rich timeline。
- 不为了 UI 好看伪造 tool calls。

## 风险

### 风险 1：文本工具协议不稳定

OpenCode/Hermes 可能不按 `echoink-tool-call` 输出。

缓解：

- 工具说明必须非常短、非常硬。
- 只识别固定代码块。
- 失败时给一次纠错 prompt。
- 后续一旦 native structured tool call 可用，替换掉文本协议。

### 风险 2：工具越权

Agent 可能请求危险工具或越权参数。

缓解：

- 工具 allowlist 来自当前 scope 的已启用资源。
- 每次调用前检查 resourceId、toolName、scope、backend。
- 默认审批。
- 写 Vault / 命令 / 网络工具必须进入高风险提示。

### 风险 3：MCP server 长时间挂起

缓解：

- listTools 和 callTool 都有 timeout。
- 单次任务有总 timeout。
- MCP transport finally close。
- call log 记录失败原因。

### 风险 4：rich stream 被过度承诺

缓解：

- capabilities 只有真实 adapter 验证后才改。
- UI 明确 fallback 状态。
- 文案不写“Codex 级别”。

## 成功标准

### P0 成功

- 一个已配置 MCP 可以被 OpenCode/Hermes 通过 EchoInk tool loop 调用。
- 用户能看到工具请求、审批、结果。
- broker call log 有完整记录。
- imported-only MCP 不会进入可调用工具集合。

### P1 成功

- 知识库任务可以使用已验证的只读 MCP 辅助检索。
- 工具事件在聊天和知识库任务中统一展示。
- 工具失败不会污染最终答案，也不会让任务卡死。

### P2 成功

- OpenCode 如果真实提供 HTTP ACP event stream，就显示 streamed text / public thinking / tool events。
- Hermes 如果真实提供 native stream，就显示 public stream events。
- 不支持时稳定 fallback。
