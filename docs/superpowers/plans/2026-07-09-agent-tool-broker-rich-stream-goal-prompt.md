# Goal Mode Prompt: EchoInk Agent Tool Broker and Rich Stream

把下面整段复制到新 Codex 线程，并用目标模式执行。

```text
方哥从一个坏掉的旧 Codex 线程迁移过来。不要尝试恢复旧线程，不要读取旧 thread id。

当前项目：
/Users/lyuakin/Desktop/Obsidian-plugins

目标：
按以下“设计文档”和“实施计划”实施 EchoInk 下一阶段多 Agent 宿主能力。设计文档决定方向，实施计划决定执行步骤。

设计文档：
/Users/lyuakin/Desktop/Obsidian-plugins/docs/superpowers/specs/2026-07-09-agent-tool-broker-rich-stream-design.md

实施计划：
/Users/lyuakin/Desktop/Obsidian-plugins/docs/superpowers/plans/2026-07-09-agent-tool-broker-rich-stream.md

必须实现：
1. MCP broker 真实调用闭环。
2. 工具调用接入 AgentEvent。
3. OpenCode/Hermes rich stream 真实接入或明确 fallback。

背景参考文档：
- /Users/lyuakin/Desktop/Obsidian-plugins/docs/superpowers/plans/2026-07-07-multi-agent-backend-hermes.md
- /Users/lyuakin/Desktop/Obsidian-plugins/docs/superpowers/plans/2026-07-08-agent-events-mcp-bridge.md

背景参考只用于理解已完成边界，不得覆盖本次设计文档和实施计划。

暂不做：
- Hermes 管家化
- dream / insights / personality / memory 主动维护
- 任何旧线程恢复
- 把 imported-only MCP 说成自动可调用
- 伪造 OpenCode/Hermes 的 Codex 级 rich timeline

必须先读：
1. /Users/lyuakin/Desktop/Obsidian-plugins/AGENTS.md
2. /Users/lyuakin/Desktop/Obsidian-plugins/.codex-memory/current.md
3. /Users/lyuakin/Desktop/Obsidian-plugins/.codex-memory/spec/index.md
4. /Users/lyuakin/Desktop/Obsidian-plugins/.codex-memory/tasks/index.md
5. /Users/lyuakin/Desktop/Obsidian-plugins/.codex-memory/tasks/active/multi-agent-backend/brief.md
6. 设计文档：/Users/lyuakin/Desktop/Obsidian-plugins/docs/superpowers/specs/2026-07-09-agent-tool-broker-rich-stream-design.md
7. 实施计划：/Users/lyuakin/Desktop/Obsidian-plugins/docs/superpowers/plans/2026-07-09-agent-tool-broker-rich-stream.md
8. 背景参考：/Users/lyuakin/Desktop/Obsidian-plugins/docs/superpowers/plans/2026-07-07-multi-agent-backend-hermes.md
9. 背景参考：/Users/lyuakin/Desktop/Obsidian-plugins/docs/superpowers/plans/2026-07-08-agent-events-mcp-bridge.md

执行方式：
- 先完整阅读设计文档和实施计划，再开始执行。
- 如果实施计划和背景参考冲突，以本次设计文档和实施计划为准。
- 使用计划里的顺序执行，不要跳到 rich stream。
- 先 TDD：每个任务先写失败测试，再实现，再跑验证。
- 可以用子 Agent 做只读调研、独立模块实现或验证，但主 Agent 必须做集成和最终验收。
- 不要为了多 Agent 而多 Agent；同一文件密集修改时不要并发改。
- 如果 OpenCode/Hermes 没有真实公开事件流，就保留 lifecycle fallback，并在文档/最终结果里说清楚。
- 所有 MCP 调用必须由 EchoInk broker 做连接、审批、调用、日志。
- 所有真实 Obsidian 测试只能用 /Users/lyuakin/Documents/AKin-note-management/testing/。

固定验收命令：
npm run test
npm run typecheck
npm run build
OBSIDIAN_VAULT=/Users/lyuakin/Documents/AKin-note-management npm run deploy

部署后还要核对：
shasum dist/main.js /Users/lyuakin/Documents/AKin-note-management/.obsidian/plugins/codex-echoink/main.js

真实 Obsidian 验收：
- 打开 /Users/lyuakin/Documents/AKin-note-management
- Resource/MCP 页仍准确区分“仅导入 / 补全连接配置 / 可连接 / 已验证 / 连接失败”
- imported-only MCP 不可被说成自动可调用
- 配置过的安全 MCP 可以通过 EchoInk broker list/call
- OpenCode/Hermes 聊天仍可用
- 工具请求、审批、完成/失败能在 AgentEvent/UI 里看到
- 编辑区候选生成、Esc 取消、Enter 确认仍正常
- 如果 macOS 辅助权限导致 UI 自动点击不稳定，必须明确说明，不要把命令验证说成完整 UI 验收

完成后必须：
- 更新 .codex-memory/current.md
- 更新 .codex-memory/tasks/active/multi-agent-backend/brief.md
- 更新 .codex-memory/tasks/active/multi-agent-backend/refs.md
- 必要时追加 .codex-memory/archive/2026-07.md
- 最终回复给出：改了哪些文件、跑了哪些命令、真实部署 hash、真实 Obsidian 验收情况、未完成或 fallback 的部分
```
