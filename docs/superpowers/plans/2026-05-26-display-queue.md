# 显示队列功能计划

## Summary

- 做“侧栏任务队列”：普通对话和知识库频道的输入型任务都可排队，但每个会话独立排队。
- 当前任务运行中：输入框有内容时，右下角按钮是“入队发送”；输入框为空时，按钮是“停止当前任务”。
- 每条任务入队时锁定文本、附件、skill、模型、权限、模式、工作区等参数。
- 队列只保存在本次插件运行内；Obsidian / 插件重启后清空。
- 当前任务成功完成才自动执行下一条；失败或手动停止后，保留队列并暂停，用户手动继续。

## Key Changes

- 新增运行期队列状态模块，保存 `QueuedTurnItem`、会话维度队列、重排、删除、暂停 / 继续逻辑；不写入 `settings`，不做数据迁移。
- 重构 `CodexView` 发送链路：把“读取输入框”和“启动任务”拆开，普通对话与知识库命令都可从队列项启动。
- 在输入框上方新增队列 UI：显示任务预览、拖拽手柄、删除按钮、暂停后的继续入口；拖拽只调整未执行任务，不影响当前运行任务。
- 调整 toolbar 状态：运行中且输入非空时点击入队；运行中且输入为空时点击停止；空闲且队列暂停 / 待执行时可继续队列。
- 知识库命令保持串行：`/ask`、`/maintain`、`/journal` 等通过队列逐条执行；`/clear`、`/history` 这类本地 UI 命令不排队，运行中提示稍后操作。

## Interfaces / Types

- 新增 `QueuedTurnItem`：包含 `id`、`sessionId`、`text`、`attachments`、`skill`、`turnOptions`、`kind`、`createdAt`。
- 新增纯函数 / 小类：`enqueue`、`dequeueNext`、`removeQueuedItem`、`reorderQueuedItem`、`hasQueuedItems`、`pauseSessionQueue`、`resumeSessionQueue`。
- `sendMessage()` 改为协调入口；新增内部启动函数处理普通对话和知识库队列项，复用现有 `startThread` / `resumeThread` / `startTurn` / `sendKnowledgeBaseMessage` 能力。

## Test Plan

- 单元测试：入队、出队、删除、拖拽重排、按会话隔离、失败后暂停、成功后继续。
- 单元测试：composer 主按钮状态，覆盖“运行中有输入 = 入队”“运行中无输入 = 停止”“空闲 = 发送 / 继续队列”。
- 回归测试：知识库命令运行中不会并发启动第二个知识库任务。
- 固定验证命令：`npm run test`、`npm run typecheck`、`npm run build`、`OBSIDIAN_VAULT=/Users/lyuakin/Documents/AKin-note-management npm run deploy`。
- 真实 Obsidian 复验：普通会话排队、拖拽改序、删除排队项、失败 / 停止后暂停；知识库频道用 `testing/` 相关只读 `/ask` 验证队列串行。

## Assumptions

- v1 不覆盖编辑区“改写 / 扩写 / 续写”候选生成。
- v1 不做并发 Agent；队列只是串行调度。
- v1 不持久化队列；重启清空是明确需求。
- 关闭或重启插件时，未执行队列不恢复、不自动运行。
