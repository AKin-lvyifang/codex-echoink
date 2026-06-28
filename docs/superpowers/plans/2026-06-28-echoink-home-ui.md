# EchoInk Home UI Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:executing-plans or equivalent checklist-driven execution. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the EchoInk homepage as a closeable Obsidian editor tab that visually follows the approved V2+V3 concept: daily calendar/review on top, knowledge card feed below.

**Architecture:** Add a dedicated Obsidian `ItemView` for the homepage and keep it separate from the existing right sidebar chat view. First ship the UI using existing dashboard snapshot data, then wire actions to existing commands and knowledge-base manager methods. Avoid new backend storage or recommendation engines in this pass.

**Tech Stack:** Obsidian plugin API, TypeScript, existing dashboard snapshot builder, `styles.css`, current test runner.

---

## UI Contract

- The homepage is a normal Obsidian tab named `EchoInk 首页`; it can be closed by the user.
- A command palette entry `打开 EchoInk 首页` reopens the homepage.
- Settings adds `启动时自动打开首页`, separate from the existing sidebar auto-open switch.
- The approved design must be preserved:
  - Header: vault name, health status, last check time, quick actions.
  - Upper area: monthly calendar plus `今日复盘`.
  - Middle strip: annual checkup heatmap.
  - Lower area: filter chips plus masonry-style knowledge cards.
- The first implementation prioritizes frontend fidelity. Data is sourced from existing snapshot fields; advanced recommendation logic is deferred.

## Files

- Create: `src/home/home-view.ts`
  - Defines `VIEW_TYPE_ECHOINK_HOME`.
  - Renders homepage layout, loading, error, and empty states.
  - Uses existing dashboard snapshot data and safe local derived card data.
- Modify: `src/main.ts`
  - Register homepage view.
  - Add `activateHomeView()` and command `open-echoink-home`.
  - Open homepage on layout ready when the setting is enabled.
  - Ribbon action opens homepage and existing Codex sidebar together.
- Modify: `src/settings/settings.ts`
  - Add `autoOpenHome` to settings interface, defaults, and normalization.
- Modify: `src/settings/i18n.ts`
  - Add Chinese/English labels for homepage setting.
- Modify: `src/settings/settings-tab.ts`
  - Add homepage startup toggle near existing sidebar startup toggle.
- Modify: `styles.css`
  - Add `codex-home-*` styles matching the design.
  - Use Obsidian CSS variables; no new UI library.
- Modify: `src/tests/run-tests.ts`
  - Add assertions for settings default/normalization, command/view registration strings, and key homepage CSS selectors.
- Modify if needed: `src/tests/obsidian-shim.ts`
  - Only if tests need missing Obsidian API shims.

## Task 1: Register Homepage View and Startup Setting

- [ ] Add `autoOpenHome: boolean` to settings types/defaults and normalizer.
- [ ] Add setting copy in `i18n.ts`.
- [ ] Add toggle in general settings.
- [ ] Add `VIEW_TYPE_ECHOINK_HOME` and `EchoInkHomeView` skeleton.
- [ ] Register the view in `main.ts`.
- [ ] Add `open-echoink-home` command.
- [ ] Add `activateHomeView()` to open in main editor tab.
- [ ] Change ribbon click to open homepage and right Codex sidebar.
- [ ] Use `autoOpenHome` to open homepage on Obsidian layout ready.

## Task 2: Static UI Shell

- [ ] Render the homepage shell with static placeholder values while loading.
- [ ] Implement header area:
  - Vault name.
  - Health badge.
  - Last check time.
  - Quick action buttons: `体检`, `维护`, `收集`, `历史`.
- [ ] Implement upper grid:
  - Left monthly calendar.
  - Right `今日复盘`.
- [ ] Implement heatmap strip below upper grid.
- [ ] Implement filter chips.
- [ ] Implement knowledge card feed.
- [ ] Add loading and error states that do not break layout.

## Task 3: Data Wiring From Existing Snapshot

- [ ] Call `plugin.getKnowledgeBaseManager()?.getDashboardSnapshot()`.
- [ ] Use snapshot fields for:
  - `vaultName`
  - `health`
  - `checkFreshness`
  - `checkHeatmap`
  - `raw.fileCount`, `raw.changedCount`, `raw.todayCount`, `raw.digestStatus`
  - `wiki.fileCount`, `wiki.todayCount`, `wiki.groups`
  - `inbox.fileCount`, `inbox.todayCount`
  - `outputs.latestReportPath`
- [ ] Build card feed from `recentFiles` on raw/wiki/inbox/outputs.
- [ ] Build filter modes:
  - `全部`
  - `最近常看`
  - `很久未看`
  - `Raw 待提炼`
  - `Wiki 更新`
  - `猜你想看`
- [ ] Keep `猜你喜欢` rule-based in this pass.

## Task 4: Interactions

- [ ] Refresh button reloads snapshot.
- [ ] `体检` sends/opens existing knowledge command path for `/check`.
- [ ] `维护` sends/opens existing knowledge command path for `/maintain`.
- [ ] `历史` opens existing knowledge history path through the sidebar command route.
- [ ] Card `打开` opens vault files when the file exists.
- [ ] Card secondary actions are visible but conservative:
  - `提炼` opens knowledge channel with a prefilled or direct command only if existing APIs support it safely.
  - If not safe, show a notice in this pass rather than inventing backend logic.

## Task 5: CSS Fidelity

- [ ] Match approved image proportions:
  - Main content max width fits Obsidian editor pane.
  - Upper calendar/review area uses two-column layout on desktop.
  - Heatmap is a horizontal strip.
  - Card feed uses responsive columns.
- [ ] Use 8px or smaller radius except small chips/buttons.
- [ ] Use Obsidian variables for background/text/borders.
- [ ] Avoid marketing hero, glow, glass, decorative blobs, and heavy gradients.
- [ ] Ensure text does not overflow buttons/cards on narrow pane widths.
- [ ] Add responsive fallback to single-column layout.

## Task 6: Tests and Verification

- [ ] Add unit/static assertions:
  - `DEFAULT_SETTINGS.autoOpenHome === false`.
  - Normalization preserves boolean value and defaults invalid values to false.
  - `main.ts` contains `open-echoink-home`, `VIEW_TYPE_ECHOINK_HOME`, and ribbon opens home plus sidebar.
  - `styles.css` contains key layout selectors and responsive rules.
- [ ] Run:
  - `npm run test`
  - `npm run typecheck`
  - `npm run build`
  - `OBSIDIAN_VAULT=/Users/lyuakin/Documents/AKin-note-management npm run deploy`
- [ ] Real Obsidian validation:
  - Homepage opens on startup when enabled.
  - Homepage tab can be closed.
  - Command palette reopens homepage.
  - Ribbon opens homepage and right Codex sidebar.
  - Wiki/Raw/heatmap data appears.
  - UI visually matches the approved V2+V3 image.

## Acceptance Criteria

- Opening Obsidian can show `EchoInk 首页` as the selected main tab when `autoOpenHome` is enabled.
- Closing the homepage tab does not recreate it immediately.
- Command palette can reopen the homepage.
- The homepage shows Wiki status, Raw status, and the check heatmap.
- The first screen resembles the approved V2+V3 design: calendar/review top, card feed bottom.
- Existing sidebar dashboard and knowledge-base commands continue to work.
- All required validation commands pass, or any failure is reported with exact output and cause.
