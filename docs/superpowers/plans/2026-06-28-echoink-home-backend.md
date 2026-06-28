# EchoInk 首页后端数据落地计划

## 目标

把首页从“前端样式 + 部分 snapshot + 局部模拟数据”升级为真实知识库 dashboard：

- 首页状态与右侧 Wiki 状态同口径。
- 日历、热力图、今日复盘、行动日志、维护报告、卡片推荐都来自真实 Vault 数据或插件维护历史。
- 卡片按钮保持当前版本，不做结构改动。
- 修正状态标签颜色，让 `Raw 待提炼` / `Wiki 更新` 等标签不被 Obsidian 主题强调色污染。

## 验收标准

- `dashboard.ts` 不再只提供原始目录统计，还提供首页可直接消费的数据。
- `home-view.ts` 不再用 `day % 3`、固定 `18:00`、固定热力图分布这类模拟逻辑。
- 卡片筛选数量与实际展示池一致，不再“全部=全库数量，但只展示 recentFiles”。
- 隐藏文件、索引文件、tracker、registry 不出现在首页卡片。
- 状态标签：Raw 橙、Wiki 绿、Inbox 紫、Output 蓝，`strong` 继承颜色。
- 固定命令通过：`npm run test`、`npm run typecheck`、`npm run build`、`OBSIDIAN_VAULT=/Users/lyuakin/Documents/AKin-note-management npm run deploy`。
- 真实 Obsidian 打开 `/Users/lyuakin/Documents/AKin-note-management` 后能看到首页加载真实数据。

## 数据设计

在 `KnowledgeBaseDashboardSnapshot` 中新增首页专用字段：

- `activity.days`
  - 每天聚合 raw/wiki/inbox/outputs 文件 mtime 与维护/体检历史。
  - 字段：`date`、`raw`、`wiki`、`inbox`、`outputs`、`checks`、`failures`、`total`。
- `activity.heatmapRows`
  - 首页年度热力图直接渲染的 4 行：知识健康度、Wiki 变更、Raw 变更、维护完成。
  - 每行 52 个周级单元，字段：`level`、`count`、`status`。
- `activity.logs`
  - 从最近维护历史、最新报告、当天 raw/wiki/inbox 变化生成。
  - 没有历史时显示真实空状态，不写固定假时间。
- `outputs.latestReportSummary`
  - 从最新报告解析标题、mtime、关键发现和摘要，不只显示路径。
- `recommendations.cards`
  - 统一卡片池，按真实文件状态、更新时间、来源类型计算排序。
  - 卡片摘要优先取 frontmatter/首段/报告片段；取不到时才用类型兜底文案。
  - count 与展示池一致。

## 实施步骤

1. 测试先行
   - 给 `buildKnowledgeBaseDashboardSnapshot()` 增加活动聚合、热力图、日志、报告摘要、推荐卡片断言。
   - 给首页卡片和 CSS 增加状态标签颜色断言。
   - 先运行测试，确认因缺字段/旧断言失败。

2. 数据层实现
   - 扩展 `dashboard.ts` 类型。
   - 在一次目录扫描结果内完成活动聚合，避免重复全量扫 Vault。
   - 输出最近文件池时提高 recent limit，避免首页卡片过少。
   - 解析 Markdown 标题、frontmatter 摘要、首段和最新报告摘要。

3. 首页渲染接入
   - 日历使用 `snapshot.activity.days`。
   - 年度热力图使用 `snapshot.activity.heatmapRows`。
   - 行动日志使用 `snapshot.activity.logs`。
   - 卡片使用 `snapshot.recommendations.cards`；老逻辑保留兼容兜底。

4. 前端收口
   - 修正 `.codex-home-card-status strong { color: inherit; }`。
   - 补齐 legend 新状态颜色。
   - 不改卡片按钮。

5. 验证与部署
   - 跑固定命令。
   - 部署到 AKin Vault。
   - 打开真实 Obsidian 首页验收。
