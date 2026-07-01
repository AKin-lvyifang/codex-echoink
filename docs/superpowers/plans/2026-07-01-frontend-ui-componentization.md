# Frontend UI Componentization Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按前端对抗式审查结论，把 `src/ui/codex-view.ts` 从单体 God View 拆成可维护的 Obsidian DOM UI 模块，保持用户可见行为不变。

**Architecture:** 保留 `CodexView` 作为 Obsidian `ItemView` 外壳和状态协调者；把历史弹窗、知识库 dashboard、header/composer/message 渲染逐步迁出到 `src/ui/codex-view/` 子模块。样式仍保留根 `styles.css`，本轮不改发布构建链路。

**Tech Stack:** TypeScript, Obsidian DOM API, existing esbuild build, existing `scripts/run-tests.mjs`.

---

## Goal Binding

本轮 active goal 必须完全按本文档执行：

> 完全按照 `docs/superpowers/plans/2026-07-01-frontend-ui-componentization.md` 执行前端 UI 组件化：先写结构测试和行为护栏，再拆 `CodexView` 的 History Modal、Knowledge Dashboard、Header、Composer、Message List；保持 UI 行为不变；完成后执行对抗性代码审查、`npm run test`、`npm run typecheck`、`npm run build`、真实 Vault deploy 和真实 Obsidian 验收。

## Behavior Boundaries

- 不做视觉重设计。
- 不引入 React、Tailwind、shadcn 或第二套 UI 框架。
- 不改变 `VIEW_TYPE_CODEX`、`CodexView` 对外入口。
- 不改变 `styles.css` 发布位置；Obsidian 仍加载根目录 `styles.css`。
- 不改变聊天、知识库 dashboard、`/ask`、`/maintain`、附件、队列、编辑区动作的用户行为。
- 每一步拆分后必须保持 `npm run test` 通过。

## File Map

- Create: `src/ui/codex-view/history-modal.ts`
- Create: `src/ui/codex-view/knowledge-dashboard.ts`
- Create: `src/ui/codex-view/header.ts`
- Create: `src/ui/codex-view/composer.ts`
- Create: `src/ui/codex-view/message-list.ts`
- Create: `src/ui/codex-view/menus.ts`
- Create: `src/ui/codex-view/tabs.ts`
- Create: `src/ui/codex-view/mcp-panel.ts`
- Create: `src/ui/codex-view/knowledge-context-bridge.ts`
- Create: `src/ui/codex-view/editor-action-runner.ts`
- Create: `src/ui/codex-view/turn-runner.ts`
- Modify: `src/ui/codex-view.ts`
- Modify: `src/tests/run-tests.ts`
- Keep: `styles.css` as root bundled stylesheet.

Implementation note: 为了让主文件真正低于 2500 行，并避免“空模块假拆”，本轮在计划内 5 个核心 UI 模块之外，把菜单、tabs、MCP 面板、知识上下文桥接、编辑动作运行器、turn 运行器也迁到同目录子模块；这些额外拆分不改变可见行为和样式链路。

---

### Task 1: Add Structure Guard Tests

- [x] **Step 1: Write failing tests**
  - Assert expected new module files exist.
  - Assert `src/ui/codex-view.ts` no longer defines `class KnowledgeBaseHistoryModal`.
  - Assert dashboard tooltip implementation moves out of `codex-view.ts`.
  - Assert `src/ui/codex-view.ts` stays under 2500 lines after refactor.

- [x] **Step 2: Verify red**
  - Run `npm run test`.
  - Expected: fail because module files do not exist and `CodexView` still contains the old implementation.

### Task 2: Extract History Modal

- [x] **Step 1: Move `KnowledgeBaseHistoryModal` and history helper functions**
  - New module exports `KnowledgeBaseHistoryModal`.
  - Preserve filtering semantics and `getDisplayKnowledgeBaseMessages` use.

- [x] **Step 2: Update `CodexView` imports**
  - `CodexView.openKnowledgeBaseHistory()` should instantiate imported modal.

- [x] **Step 3: Verify**
  - Run `npm run test`.

### Task 3: Extract Knowledge Dashboard Renderer

- [x] **Step 1: Move dashboard rendering and tooltip logic**
  - New module exports `renderKnowledgeDashboardView()`, `clearKnowledgeDashboardHealthTooltips()`, and `isKnowledgeDashboardHealthTooltipHoverPoint()`.
  - Keep tooltip DOM, ARIA attributes, close timers, hover bridge and fixed positioning behavior unchanged.

- [x] **Step 2: Update `CodexView` dashboard methods**
  - `CodexView` keeps state fields and delegates rendering to the module.
  - Re-export `isKnowledgeDashboardHealthTooltipHoverPoint` from `src/ui/codex-view.ts` for tests.

- [x] **Step 3: Verify**
  - Run `npm run test`.

### Task 4: Extract Header, Composer, Message List

- [x] **Step 1: Extract header renderer**
  - Move header DOM construction and usage/article panel renderer into `header.ts`.

- [x] **Step 2: Extract composer renderer**
  - Move toolbar/input/attachments/queue DOM construction into `composer.ts`.
  - Keep `CodexView` business methods as callbacks.

- [x] **Step 3: Extract message list renderer**
  - Move message/process/citation/diff rendering helpers into `message-list.ts`.
  - Preserve virtual list behavior and existing CSS class names.

- [x] **Step 4: Verify**
  - Run `npm run test`.
  - Run `npm run typecheck`.

### Task 5: Adversarial Review And Real Verification

- [x] **Step 1: Run adversarial code review**
  - Check regressions, hidden coupling, event cleanup, global listeners, stale timers, behavior drift, accidental CSS/class changes.
  - Result: 未发现阻断项；已修正 `history-modal.ts` 的 `App` 类型和 `renderTabs` 缩进噪音。
  - Residual risk: `turn-runner.ts` / `editor-action-runner.ts` 仍使用 `view: any` 作为过渡桥接，本轮用 `npm run test`、`npm run typecheck` 和真实 Obsidian 验收兜底；后续可单独收敛成明确接口类型。

- [x] **Step 2: Full command verification**
  - Run `npm run test`.
  - Run `npm run typecheck`.
  - Run `npm run build`.
  - Run `OBSIDIAN_VAULT=/Users/lyuakin/Documents/AKin-note-management npm run deploy`.
  - Result: all commands passed on 2026-07-01. Deploy target: `/Users/lyuakin/Documents/AKin-note-management/.obsidian/plugins/codex-echoink`.

- [x] **Step 3: Real Obsidian verification**
  - Open `/Users/lyuakin/Documents/AKin-note-management`.
  - Verify EchoInk sidebar opens.
  - Verify composer is visible.
  - Verify knowledge dashboard expands/collapses.
  - Verify `/ask` can return local source.
  - Save screenshot to `/tmp/echoink-frontend-componentization-verify.png`.
  - Result: verified in real Obsidian on 2026-07-01. Evidence screenshots:
    - `/tmp/echoink-frontend-componentization-verify.png`
    - `/tmp/echoink-dashboard-collapsed.png`
    - `/tmp/echoink-dashboard-expanded.png`
    - `/tmp/echoink-ask-final.png`

## Rollback Plan

- If behavior regresses, revert the latest extraction task only.
- Do not expand scope to settings page or visual redesign in this branch.
- Do not change stylesheet build chain in this branch.
