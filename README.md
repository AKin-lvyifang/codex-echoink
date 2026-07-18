<p align="center">
  <a href="https://github.com/AKin-lvyifang/codex-echoink">
    <img width="1024" alt="Codex EchoInk v1.3.0 release poster showing guided setup, one multi-Agent runtime, local memory, and utility models." src="docs/images/codex-echoink-v1.3.0-release.png">
  </a>
</p>

<h1 align="center">Codex EchoInk</h1>

<p align="center">
  <a href="#features">Features</a> ·
  <a href="docs/echoink-product-whitepaper.md">Whitepaper</a> ·
  <a href="#why-echoink">Why EchoInk</a> ·
  <a href="#whats-new">What's New</a> ·
  <a href="#install">Install</a> ·
  <a href="#quick-start">Quick Start</a> ·
  <a href="#privacy-and-permissions">Privacy</a> ·
  <a href="#screenshots">Screenshots</a> ·
  <a href="#development">Development</a> ·
  <a href="#license">License</a> ·
  <a href="README_CN.md">中文</a>
</p>

<p align="center">
  <a href="https://github.com/AKin-lvyifang/codex-echoink/releases/latest">
    <img src="https://img.shields.io/badge/platform-Obsidian_Desktop-7C3AED?style=flat-square&logo=obsidian&logoColor=white" alt="Platform: Obsidian Desktop">
    <img src="https://img.shields.io/badge/version-v1.3.0-0EA5E9?style=flat-square" alt="Version v1.3.0">
    <img src="https://img.shields.io/badge/license-MIT-10B981?style=flat-square" alt="MIT License">
    <img src="https://img.shields.io/badge/language-English_%2B_%E4%B8%AD%E6%96%87-F59E0B?style=flat-square" alt="English and Chinese README">
  </a>
</p>

<p align="center">
  <a href="https://github.com/AKin-lvyifang/codex-echoink/releases/latest"><strong>Download v1.3.0</strong></a>
  ·
  <a href="https://github.com/AKin-lvyifang/codex-echoink/releases/latest">Latest Release</a>
</p>

---

## Features

### First-run Setup Guide

<img width="1024" alt="Codex EchoInk first-run setup guide checks Codex CLI, Codex login, OpenCode, server, and models before Start." src="docs/images/codex-echoink-setup-guide-v0.6.0.png">

- Checks Codex CLI, Codex login, OpenCode CLI, OpenCode server, models, and Agent readiness before the user starts.
- Shows missing requirements first, with install commands, copy buttons, and documentation links.
- Lets users click `Run check again` after installing or logging in, then shows `Start` only when blocking checks are clear.
- `Start` opens the EchoInk sidebar and records setup completion; it does not send a message or run a Knowledge task.
- Keeps setup explicit: no silent installs, no surprise background Agent work.

### Multi-Agent Workspace

- Opens EchoInk Agent in the Obsidian sidebar.
- Supports Codex CLI, OpenCode API, and Hermes as switchable Agent backends.
- Routes all three backends through one EchoInk Harness, with shared run states, context rules, session handling, and conversation projection.
- Switches the main Agent from the sidebar header without clearing the current EchoInk session.
- Requires a folder picker for ordinary chat sessions before sending.
- Treats attached notes as turn context only; attaching a note does not make the whole vault the workspace.
- Keeps the `Knowledge` channel bound to the current vault for Raw, Wiki, Outputs, and Inbox maintenance.
- Lets the selected Agent backend read files, inspect folders, edit documents, and run allowed local operations according to its capability.
- Keeps the workflow inside Obsidian instead of bouncing between apps.

### Agent-style Process Timeline

- Uses the same EchoInk timeline for Codex, OpenCode, and Hermes instead of changing the conversation layout with the backend.
- Keeps the final answer prominent while reasoning, commands, file edits, and MCP calls stay in an expandable processing timeline.
- Shows only processing time when collapsed, then reveals the full process when expanded.
- Shows file chips for touched files, with vault files opening back in Obsidian.
- Keeps per-turn tokens and context usage visible without letting raw logs dominate the conversation.
- Supports Agent / Plan mode, model selection, reasoning effort, speed, and file permission modes.

### Turn Queue

<img width="1024" alt="Codex EchoInk turn queue and composer menus show three stability updates for queue entry interaction." src="docs/images/codex-echoink-turn-queue-v0.7.2.png">

- Queue follow-up tasks while the current Agent turn is still running.
- Keeps queues scoped to each session, so ordinary chat and Knowledge channel work do not mix.
- Captures the exact text, attachments, Skill, model, permissions, mode, and workspace at enqueue time.
- Shows queued cards above the composer, with delete and drag-to-reorder for work that has not started.
- Runs the next item only after the current task succeeds; stop or failure pauses the queue until you resume it.
- Keeps Knowledge commands such as `/ask`, `/maintain`, and `/journal` serial, so they do not run on top of each other.

### Home Dashboard

<img width="1024" alt="Codex EchoInk Home Dashboard with calendar, knowledge health, activity heatmap, and note cards." src="docs/images/codex-echoink-home-dashboard-v1.0.0.png">

- Opens an EchoInk Home tab on startup when enabled in settings.
- Adds an Obsidian command to reopen Home after the tab is closed.
- Makes the ribbon icon open both the EchoInk sidebar and the Home dashboard.
- Shows Wiki status, Raw pending work, health score, yearly check heatmap, calendar, and recent activity.
- Displays a responsive note-card stream that adapts to smaller laptop screens.
- Filters cards by status, recommendation group, update time, relevance, and first-level folder.
- Copies Obsidian internal links, relative paths, and Markdown links from each card.

### Knowledge Base Operations

<img width="1024" alt="Codex EchoInk Knowledge Safety shows Raw Protected, Local History, and Threads Archived." src="docs/images/codex-echoink-knowledge-safety-v0.8.0.png">

- Adds a persistent `Knowledge` channel for maintaining the current Obsidian vault.
- Treats chat as the main control surface: type `/init`, `/ask`, `/check`, `/maintain`, `/outputs`, `/journal`, or `/inbox`, then add your own instruction after the command.
- Adds an LLM Wiki initialization guide: `/init` previews folders, rules files, and existing-note routing suggestions; `/init confirm` creates the template.
- Answers read-only knowledge questions with `/ask`, searching Wiki first and then using Journal / Outputs as background evidence, while separating Vault evidence from external or model-based supplements.
- Writes daily journals with `/journal`, following the current `journal/` folder layout and recent note format; the workday window is `00:00` through before next-day `06:00`, with backend-specific evidence rules for Codex CLI, OpenCode API, or Hermes.
- Keeps only the latest active Knowledge day in the channel; older chat history is stored by day under the plugin `history/` data folder and browsed through `/history`.
- Shows Codex CLI knowledge-base runs with the same process cards as regular Agent chats: reasoning, commands, file changes, tool calls, and final results.
- Shows a pinned Knowledge health dashboard above the channel: rules file, Raw/Wiki/Inbox counts, health status, detailed Wiki folder table, Raw/Inbox table, and a full-year check heatmap.
- Uses `LLM-WIKI.md` as the knowledge-base rules source by default, or another Vault Markdown selected in settings. Before every Knowledge run, EchoInk reads the latest content, validates it, and injects it into system context; an unreadable or missing file blocks the Agent from starting. `AGENTS.md` may be absent and is never merged as Knowledge rules.
- Includes EchoInk Memory V2 as a parallel local layer without disabling or replacing native Codex, OpenCode, or Hermes memory. Regular Agent chat and `/ask` receive a small system catalog for on-demand search across the complete retained plugin usage archive and can retrieve the same curated local memory across sessions and backends; the full archive is never loaded wholesale. Maintenance workflows record results only after the local commit succeeds. Canonical curated data lives in Vault `.echoink/memory/index.json`; settings supports initialization, sync, recovery, conflict handling, deletion, and explicit import from legacy `.codex-memory`. External [`codex-memory-lite`](https://github.com/AKin-lvyifang/codex-memory-lite) remains compatible as a separate tool, but is no longer required for EchoInk long-term memory.
- Collects WeChat articles, web pages, and text files into Raw Sources before processing.
- Uses a four-step digest protocol: understand Raw, extract reusable knowledge, merge structured knowledge in Wiki / Projects, then mark Raw only after source evidence is verified.
- Keeps existing Raw files unchanged, then writes structured results to Wiki / Projects, Outputs, Journal, and tracker files.
- Runs `/check` as a digest audit only, `/maintain` as four-step digest, `/reingest` as forced redigest, and `/calibrate raw` as status calibration without new Agent extraction.
- Preserves Knowledge history in the plugin's local `history/` folder, so `/history` can still show records after Codex archived threads are removed.
- Archives background Codex threads created by Knowledge commands after local history is saved, reducing clutter in Codex Desktop's recent conversation list.
- Supports manual runs and daily maintenance when Obsidian is open.

### Weekly Reviews

- Adds a `Review` settings tab, with scheduled automation disabled by default.
- Lets you enable `Knowledge` and `Agent chat` weekly reviews separately.
- Runs by default every Sunday at 21:00, with catch-up the next time Obsidian opens.
- Writes Markdown and matching HTML files to `outputs/obsidian-weekly-review/`.
- Uses a fixed HTML dashboard template and opens it through EchoInk's built-in preview.

### Local-first Integration

- Reuses your local Codex CLI login state when Codex is selected.
- Can use OpenCode or Hermes as local Agent backends when they are installed and configured.
- Does not require storing an OpenAI API key by default.
- Optionally supports OpenAI Responses API-compatible custom providers, including multiple models per provider.
- Supports local proxy settings for the Codex child process.
- Keeps MCP, Skill, and tool-bundle switches scoped to the current vault instead of rewriting global Codex, OpenCode, or Hermes config.
- Adds an EchoInk MCP broker foundation: MCP resources with explicit `metadata.mcp` connection settings can list tools and run approved tool calls through EchoInk logs; imported-only MCP entries stay visible but are not falsely marked callable.
- Adds search and per-scope switches for current-vault resources: chat, Knowledge, and writing actions.

### Multi-Agent Backend Mode

- Keeps the original Codex CLI mode for users who want to reuse local Codex login state.
- Adds OpenCode API mode for chat, writing, and knowledge tasks when OpenCode is installed locally.
- Can detect or connect to an OpenCode server, refresh available models, and choose the active OpenCode model.
- Can refresh and choose OpenCode Agents, so different knowledge management workflows can use different agent profiles.
- Adds Hermes CLI/API settings for users who want Hermes profiles, memory, and provider configuration as the backend.
- Hermes provider/model setup is intentionally left to Hermes official configuration such as `hermes model` or its environment files; EchoInk stores only the selected connection metadata.
- EchoInk applies one conversation layout and one set of terminal states across backends. The amount of native event detail still depends on what each Agent exposes.

### Writing Context Harness

- Adds in-editor rewrite, expand, continue, and translate-to-English actions for selected text.
- Lets you choose `Fast`, `Quality`, or `Strict` writing quality modes.
- Uses visible article understanding for long-form context instead of silently running background summaries.
- Shows a writing context panel with the current note, model, understanding status, and structured article understanding.
- Reuses article understanding after small edits, so continuous rewrite / expand / continue / translate runs do not repeatedly re-read the whole note.
- Shows an inline candidate that can be accepted with `Enter` or canceled with `Esc`.
- Can run through Codex, OpenCode, or Hermes depending on the configured writing backend.
- Treats rewrite, expand, continue, and other writing actions as utility tasks with their own fast model routing, without changing the main chat model.

This feature is still experimental and disabled by default, but v0.3.0 makes it a much more deliberate writing workflow.

### Prompt Enhancement and Bookmark Routing

- Adds a Sparkles action to the sidebar composer for improving a draft request before it is sent.
- Gives prompt enhancement its own Agent backend, provider, API path, and model settings, independent from the main chat Agent and editor writing actions.
- Uses the built-in WorkBuddy Meta-Prompt and lets the user keep editing or restore the original input.
- Combines WeChat article and public web-page capture into one Bookmark action that routes the pasted URL automatically.

## Why EchoInk

Codex EchoInk turns ink into a codex, then lets it echo back as new ideas.

- `Ink` is the record: notes, clippings, drafts, sources, and conversations.
- `Codex` is the knowledge base: structured wiki pages, indexes, reports, and traceable source links.
- `Echo` is the activation layer: vault-aware questions, maintenance runs, writing help, and future inspiration workflows.

The name matches the Obsidian loop: record, organize, and get prompted into the next thought.

## What's New

### v1.3.0

<img width="1024" alt="Codex EchoInk v1.3.0 release poster showing guided setup, one multi-Agent runtime, local memory, and utility models." src="docs/images/codex-echoink-v1.3.0-release.png">

**Production-ready multi-Agent workspace:** Codex, OpenCode, and Hermes now share one guided setup path, runtime projection, and recovery model. EchoInk also adds local Memory V2 and backend-aware utility-model controls.

- Set up, repair, recheck, and monitor all three Agent backends from one settings dashboard.
- Read the same answer-first conversation layout across backends, with public reasoning and tools available in the expandable process timeline.
- Use Memory V2 for locally curated recall across sessions and backends while preserving each Agent's native memory.
- Reload and validate the selected Knowledge rules Markdown before every run without requiring `AGENTS.md`.
- Keep prompt enhancement independent from the main chat model, choose a backend-specific model, or add a custom model ID.
- Existing Vault files and EchoInk sessions do not require migration.

### v1.2.2

**Obsidian review compatibility fix:** Agent parameter menus now follow Obsidian's approved styling APIs, resolving the automated source-review failure reported for `v1.2.1`.

- Menu positioning, visibility, and interaction behavior remain unchanged.
- Existing Vault files, sessions, and settings do not require migration.

### v1.2.1

<img width="1024" alt="Codex EchoInk v1.2.1 lightweight Knowledge command menu with keyboard selection." src="docs/images/codex-echoink-v1.2.1-command-menu.png">

**Lightweight Knowledge command menu:** Typing `/` in the Knowledge channel now opens a cleaner responsive list with neutral text and a light-gray active state instead of heavy colored cards.

- Use `ArrowUp` and `ArrowDown` to move through commands; selection wraps and stays visible in long lists.
- Press `Enter` to fill the selected command without sending it, or `Escape` to close the menu.
- Existing Vault files, sessions, and settings do not require migration.

### v1.2.0

<img width="1024" alt="Codex EchoInk v1.2.0 release poster showing one Harness, rebuilt chat, and fast utilities." src="docs/images/codex-echoink-v1.2.0-release.jpg">

**Unified Agent Harness and rebuilt sidebar:** EchoInk now owns one run lifecycle, context path, and conversation projection for Codex, OpenCode, and Hermes. The entire sidebar has also been rebuilt around a clearer answer-first conversation and a lighter, responsive composer.

**Backend redesign:**

- Chat, Knowledge, writing, and prompt enhancement now enter one EchoInk Harness before an adapter talks to the selected backend.
- Codex, OpenCode, and Hermes share run states, context rules, native-session leases, stop behavior, and timeout semantics.
- Switching the main Agent applies to the next turn without clearing the current EchoInk session. Explicit per-capability overrides still take priority.

**UI rebuild:**

- Final answers stay prominent while reasoning, commands, edits, and tool calls live in an expandable processing timeline.
- Workspace selection, Plan state, Bookmark, Skill, prompt enhancement, permissions, model, reasoning, and speed now use a responsive Codex-style composer.
- The header adds a three-Agent switcher and lighter MCP / Settings buttons. Parameter menus reposition themselves to stay inside narrow sidebars.

**New capabilities and fixes:**

- Added independent prompt-enhancement settings with the WorkBuddy Meta-Prompt and a concise Restore action.
- Added automatic fast-model routing for writing and prompt utility tasks without changing the main chat model.
- Combined WeChat and public web-page capture into one Bookmark entry.
- Fixed message scroll snapping, Knowledge task/report jitter, inconsistent terminal states, stale composer or prompt-enhancer upgrades, and narrow-sidebar overflow.

**How to use:**

1. Install `v1.2.0` and reload Obsidian.
2. Choose Codex, OpenCode, or Hermes from the EchoInk header.
3. Use the Sparkles icon to enhance a draft prompt, or open settings when you want to override its utility model.
4. Existing Vault files, sessions, and custom model settings do not require migration.

### v1.1.0

<img width="1024" alt="Codex EchoInk v1.1.0 release poster showing Tool Broker, Process Timeline, and Four-Step Digest." src="docs/images/codex-echoink-v1.1.0-release.png">

**Agent tools and Knowledge digest update:** EchoInk can now show more of what an Agent is doing, connect vault-scoped tools more clearly, and guide Knowledge maintenance through a stricter four-step digest flow.

**What changed:**

- Added a tool broker foundation for vault resources, MCP tools, Skills, and tool bundles, with clearer per-scope switches.
- Improved the Agent process timeline so searches, file work, tool calls, and completion states are easier to follow.
- Added a stricter Knowledge digest path: understand Raw, extract reusable knowledge, merge it into Wiki / Projects, then mark Raw only after source evidence is checked.
- Added the first Hermes backend entry point, while keeping Hermes model and provider setup in Hermes itself.
- Split the large Agent sidebar view into smaller UI modules, making future UI review and maintenance safer.

**How to use:**

1. Install `v1.1.0`.
2. Open EchoInk in Obsidian and choose the Agent backend you already use.
3. Use `/check`, `/maintain`, or `/reingest` in the Knowledge channel when you want EchoInk to inspect or digest Raw notes.
4. Open settings to review resource switches for chat, Knowledge, and writing actions.

### v1.0.3

**Review style fix:** This update addresses the Obsidian community review rule for direct style assignment without changing the EchoInk workflow.

**What changed:**

- Replaced direct sidebar style assignments with Obsidian-supported `setCssStyles` and `setCssProps`.
- Kept the health tooltip, yearly heatmap, virtual message list, and context usage ring behavior unchanged.
- Added regression coverage to prevent direct style assignment from returning to the Agent sidebar.

**How to use:**

1. Install `v1.0.3`.
2. Open the EchoInk Home or Agent sidebar as usual.

### v1.0.2

**Review compatibility release:** This update fixes Obsidian community review findings without changing the core EchoInk workflow.

**What changed:**

- View registration now returns views directly instead of caching view instances on the plugin.
- Plugin unload no longer forcibly detaches EchoInk leaves, preserving the user's workspace layout.
- The plugin no longer depends on newer Obsidian APIs than the declared `minAppVersion`.

**How to use:**

1. Install `v1.0.2`.
2. Open the EchoInk Home, Agent sidebar, or review preview as usual.

### v1.0.1

**Small fixes release:** This update tightens the Home calendar, Knowledge maintenance, and large-file read behavior.

**What changed:**

- Home calendar now supports previous month, next month, and return-to-current-month controls.
- `/maintain` preflights numbered Wiki conflict duplicates and moves them to `outputs/maintenance/conflict-duplicates-*`.
- Knowledge maintenance now blocks `Title 2.md` style duplicate Wiki pages, preferring the canonical page or a conflict report.
- Dashboard, Raw discovery, and `/ask` now use bounded file reads to avoid loading large PDFs, images, and huge Markdown files into memory.
- Raw files over the read budget are not written to tracker and are not marked as processed.

**How to use:**

1. Install `v1.0.1`.
2. Run `/maintain` if your Wiki has numbered duplicate pages.
3. Check the maintenance report for moved duplicates and large Raw files skipped from this run.

### v1.0.0

**Home dashboard update:** EchoInk now opens as a knowledge-base command center inside Obsidian.

**What changed:**

- Added a closable Home tab that can open by default and can be reopened from the Obsidian command palette.
- Made the ribbon icon open both the EchoInk sidebar and Home dashboard.
- Added Home status modules for Wiki health, Raw pending work, yearly check heatmap, calendar, health score, and key vault counts.
- Added a responsive note-card stream for recent Wiki updates and recommendations.
- Added filters and sorting for tags, update time, relevance, and first-level folders.
- Added card actions for copying Obsidian internal links, relative paths, and Markdown links.

**How to use:**

1. Enable Home on startup in EchoInk settings.
2. Open Home from the ribbon icon or the Obsidian command palette.
3. Use the filters above the cards to focus the knowledge base view.
4. Use each card menu to copy the link format you need.

### v0.8.0

**Knowledge safety update:** Raw sources, local history, and background Codex threads are now handled as separate layers.

**What changed:**

- Strengthened Raw source protection across `/check`, `/maintain`, and `/calibrate raw`, including safer rollback when a task fails or is canceled.
- Kept Knowledge history readable from the plugin's local `history/` store instead of relying on Codex Desktop archived conversations.
- Archived background Codex threads created by Knowledge commands after task results are saved, reducing recent-list clutter in Codex Desktop.
- Made Knowledge task cancellation, retrying errors, timeouts, and status saves easier to recover from and easier to understand in the UI.
- Updated the dashboard Raw count to focus on actual source notes instead of counting `.assets/` image files as Raw notes.

**How to use:**

1. Run `/check` for a read-only digest audit.
2. Run `/maintain` to run the four-step digest on changed Raw sources.
3. Use `/history` to browse local Knowledge history; removing Codex archived conversations does not remove plugin history.

### v0.7.2

**Stability update:** Turn Queue and composer menus now close more predictably.

**What changed:**

- Clicking inside the composer area but outside Skill and Knowledge command menus now closes the open composer menus.
- Clicking a Skill or Knowledge command menu no longer closes that menu by mistake.
- Added regression coverage for composer menu containment, keeping the queue entry UI stable.

### v0.7.1

**Stability update:** Turn Queue now handles success, failure, stop, and Knowledge task concurrency more predictably.

**What changed:**

- Successful tasks continue the queue only when another item is waiting.
- Failed or stopped tasks pause the queue and keep remaining work for manual resume.
- Queued turns no longer start while an ordinary turn, Knowledge task, or queue startup is already in progress.
- Dragging queue cards stays inside the queue UI instead of leaking into the composer attachment drop area.

### v0.7.0

**New feature:** Turn Queue for ordinary chat and Knowledge channel tasks.

**What changed:**

- Added a session-scoped queue above the composer.
- While a task is running, a non-empty composer changes the primary button to `Enqueue`.
- With an empty composer, the same button still stops the current task.
- Queue items capture text, attachments, selected Skill, model, permission, mode, and workspace at enqueue time.
- Successful tasks advance to the next queued item automatically.
- Failed or stopped tasks pause the queue and keep the remaining items for manual resume.
- Knowledge commands such as `/ask`, `/maintain`, and `/journal` now run serially through the queue.

**How to use:**

1. Start a chat or Knowledge command.
2. Type the next task while the current one is running.
3. Click `Enqueue`.
4. Reorder or delete waiting items above the composer.
5. If a task is stopped or fails, click `Resume queue` when you are ready.

### v0.6.0

**Setup guide and knowledge maintenance update:** adds a first-run environment guide, safer rechecks, a clear `Start` step, and stronger Knowledge maintenance boundaries.

**New features:**

- Added a first-run setup guide in settings for Codex CLI, Codex login, OpenCode CLI, OpenCode server, models, and Agent readiness.
- Added install commands, copy buttons, and documentation links when a required runtime is missing.
- Added `Run check again` to re-detect CLI paths, refresh Codex login, and reconnect or start OpenCode when needed.
- Added `Start` as an explicit setup completion step. It opens the EchoInk sidebar without sending a message or running a Knowledge task.

**Fixes and maintenance:**

- Added Windows path detection for Codex CLI and OpenCode CLI.
- Upgraded Knowledge history to day-based archive storage with settings tools for indexing, export, and compaction.
- Tightened Knowledge maintenance so Agent tasks cannot directly rewrite Raw source bodies; raw path normalization is handled by plugin-side checks.
- Improved Knowledge maintenance reports, dashboard state, local note links, and history entry placement.

### v0.5.2

**Knowledge workflow and Windows diagnostics update:** adds weekly review reports, improves `/journal`, makes Knowledge runs easier to inspect, and fixes the bad `gpt-5.5` default that could trigger Windows WebSocket failures.

**New features:**

- Added Knowledge and Agent chat weekly reviews, with scheduled or manual runs and Markdown + HTML output in `outputs/obsidian-weekly-review/`.
- Added an EchoInk HTML preview for generated weekly review reports.
- Added `/week` and `/week agent` shortcuts in the Knowledge channel.
- Upgraded `/journal` to write into the current `journal/daily/YYYY-MM/YYYY-MM-DD-周X.md` layout, create missing journal folders, and use a fixed `00:00` to next-day `06:00` work window.
- Added OpenCode chat-history collection for `/journal` when the Knowledge backend uses OpenCode API.
- Expanded `/ask` evidence from `wiki/` to `wiki/`, `journal/`, and `outputs/`, with citation buckets, excerpt lines, relevance, and match reasons.
- Added a settings language switch for Chinese / English settings UI.

**Fixes:**

- Changed the Codex CLI default model to `Auto`; existing saved `gpt-5.5` defaults are migrated to `Auto`.
- Removed remaining hard-coded `gpt-5.5` fallback paths from Knowledge tasks and Plan mode.
- Added detailed Codex diagnostics for WebSocket, proxy refusal, missing CLI, timeout, and app-server exit errors.
- Added Windows `responses_websocket` / `os error 10061` troubleshooting guidance.
- Simplified Review settings so manual report generation has confirmation and clearer output paths.
- Shows Codex CLI Knowledge runs through the normal process timeline, so reasoning, commands, file edits, and final results stay in one visible flow.
- In the Knowledge channel, ordinary messages now stay as normal Agent chat. Only explicit `/ask`, `/query`, `/问`, or `/查询` commands trigger Knowledge Q&A.
- The Knowledge channel primary button now stops ordinary Agent chat when that chat is running, instead of canceling Knowledge maintenance by mistake.
- Knowledge failures now keep more complete app-server, JSON-RPC, OpenCode, and turn error details for easier troubleshooting.
- Local vault note paths and report paths in Knowledge replies render as clickable note links.

### v0.5.1

**Community review fix:** removed the redundant word `Obsidian` from `manifest.json` description and dropped the legacy `main` manifest field to satisfy automated community checks.

### v0.5.0

**Community-ready release:** renamed the plugin to `Codex EchoInk`, prepared the `codex-echoink` community plugin id, and added clearer privacy and permission disclosures for Obsidian review.

**What changed:**

- Renamed the plugin from `Codex for Obsidian` / `obsidian-codex` to `Codex EchoInk` / `codex-echoink`.
- Updated install paths, release links, packaging output, and visible repository references for the new community name.
- Kept compatibility with large raw message files stored by older manual installs under `.obsidian/plugins/obsidian-codex/raw`.
- Added privacy and permission notes covering Codex CLI, OpenCode, model providers, local API keys, and vault write boundaries.
- Prepared the three assets that Obsidian Community installation reads: `main.js`, `manifest.json`, and `styles.css`. The separate `codex-echoink-0.5.0.zip` was a manual-install convenience bundle, not a Community asset.

### v0.4.1

**New feature:** Knowledge channel refinements for querying, visibility, and day-to-day control.

**What changed:**

- Added `/ask` for read-only knowledge questions. It searches `wiki/` first, sends the most relevant notes as context, and asks the Agent to distinguish Vault evidence from supplemental information.
- Kept read-only Knowledge Q&A behind explicit `/ask`; ordinary natural-language messages stay as normal Agent chat in current behavior.
- Upgraded the Knowledge health heatmap from a short recent strip to a full-year GitHub-style view with month labels, weekday labels, success states, and failed checks.
- Added Codex CLI model and reasoning-effort controls directly in the Knowledge channel composer. The Knowledge task no longer has to use a hard-coded reasoning level.
- Added search boxes to the current-vault `Plugins`, `MCP`, and `Skills` capability tabs. Search covers name, id/path, metadata, and description, and multiple words work as an AND filter.
- Fixed long capability rows by clipping names, paths, and descriptions with ellipses, so the right-side checkbox remains visible and clickable.
- Kept `LLM-WIKI.md` as the default Knowledge rules file while allowing another Vault Markdown to be selected. EchoInk now force-loads the selected file for every run and no longer falls back to `AGENTS.md`.

**How to use:**

1. Open the `Knowledge` channel.
2. Type `/ask your question` when you want the Knowledge channel to search vault sources.
3. Use the bottom model button in Codex CLI mode to choose the model and reasoning effort for Knowledge tasks.
4. Expand the health dashboard to review the full-year check heatmap.
5. Open plugin settings, go to current-vault capability management, then search within `Plugins`, `MCP`, or `Skills` before toggling items.

### v0.4.0

**New feature:** Knowledge Base Operations for automated Obsidian vault maintenance.

**What changed:**

- Added a persistent knowledge base channel bound to the current vault.
- Added command templates: `/check`, `/maintain`, `/outputs`, `/journal`, and `/inbox`.
- Added WeChat, web page, and file capture entry points for Raw Sources.
- Added configurable knowledge base rules file. `LLM-WIKI.md` is the default; a custom Markdown file can replace it.
- That release added an external `codex-memory-lite` compatibility entry. Current releases include EchoInk Memory V2 and no longer require an external skill for long-term memory.
- Added OpenCode model selection and OpenCode Agent selection for OpenCode API mode.
- Added selected-text translation to English from the editor context menu.
- Improved the knowledge base settings page alignment, status copy, and rules-file picker.
- Kept the safety boundary: existing Raw files are not rewritten, deleted, or archived automatically.

**How to use:**

1. Open the `Knowledge` channel in the Agent sidebar.
2. In settings, choose `Codex CLI` or `OpenCode API` as the knowledge base backend.
3. For OpenCode mode, install OpenCode locally, then refresh and select a model and Agent.
4. For a new vault, type `/init` to preview the LLM Wiki setup; type `/init confirm` only after reviewing it.
5. Use the pinned health dashboard to check rules, Raw/Wiki/Inbox counts, risk reasons, folder updates, and recent `/check` history.
6. Type `/check broken links`, `/maintain new raw sources`, or `/outputs weekly notes` in the knowledge channel.
7. Use the capture shortcuts to collect WeChat articles, web pages, or files into Raw Sources.

### v0.3.0

**New feature:** Writing Context Harness for editor rewrite, expand, and continue.

**What changed:**

- Added `Fast`, `Quality`, and `Strict` writing quality modes.
- Added visible article understanding in the sidebar writing context panel.
- Added structured article understanding for theme, audience, purpose, structure, facts, style, fabrication boundaries, and local writing guidance.
- Added soft reuse for article understanding, so small continuous edits reuse existing understanding instead of re-running it every time.
- Added strict-mode review, which checks the generated candidate before showing it.
- Kept the inline candidate flow: `Enter` accepts, `Esc` cancels.
- Kept article understanding out of the normal chat history.

**How to use:**

1. Enable writing actions in the plugin settings.
2. Choose the default writing quality mode: `Fast`, `Quality`, or `Strict`.
3. Select text in the editor and run `Rewrite`, `Expand`, or `Continue`.
4. Click the `Writing` chip in the sidebar to inspect or refresh article understanding.
5. Press `Enter` to accept the gray candidate, or `Esc` to cancel.

### v0.2.0

**Bug fix:** fixed `spawn codex ENOENT` after Codex account re-login by detecting the Codex Desktop CLI path and adding a manual login refresh button.

**Experimental feature:** rewrite, expand, and continue selected editor text in place. This is still experimental, disabled by default, and not recommended for stable daily use.

**How to test:**

1. Enable writing actions in the plugin settings.
2. Select text in the editor and right-click `Rewrite`, `Expand`, or `Continue`.
3. Press `Enter` to accept the gray candidate, or `Esc` to cancel.
4. Test on non-critical notes first.

### v0.1.2

**New feature:** public releases now keep the GitHub repository focused on install and usage files only.

**How to use:**

1. Download the latest release package.
2. Install the `codex-echoink` plugin folder.
3. Use the plugin without browsing internal project documents.

### v0.1.1

**New feature:** paste WeChat or system screenshots directly into the Codex input box.

**How to use:**

1. Take a screenshot.
2. Click the Codex input box.
3. Press `Command+V`, then send.

## Install

1. Install and log in to Codex CLI for Codex CLI mode.
2. Optionally install OpenCode or Hermes if you want those local Agent backends.
3. Install `Codex EchoInk` from Obsidian Community Plugins when available.
4. For manual install, create this folder in your vault:

```text
<vault>/.obsidian/plugins/codex-echoink/
```

5. Download `main.js`, `manifest.json`, and `styles.css` from [the latest release](https://github.com/AKin-lvyifang/codex-echoink/releases/latest), then put all three files into that folder.
6. Restart Obsidian and enable `Codex EchoInk` in Community plugins.

The plugin folder should contain:

```text
codex-echoink/
  main.js
  manifest.json
  styles.css
```

## Quick Start

1. Open the EchoInk Agent sidebar from the ribbon icon or command palette.
2. Choose a folder as the workspace in an ordinary chat session.
3. Choose the default Agent backend in settings: Codex, OpenCode, or Hermes.
4. Ask the selected Agent to inspect, summarize, rewrite, or manage files in that workspace.
5. Attach notes, files, images, Skills, or imported MCP resources when needed; attachments are context only.
6. Review the process cards for commands, edits, context usage, and evidence. Codex has the richest timeline; OpenCode and Hermes use a simpler run state when richer events are not available.
7. Open the `Knowledge` channel when you want EchoInk to operate your vault knowledge base through the selected backend.
8. For a new vault, start with `/init`; for an existing structured vault, start with `/check`, then use `/ask`, `/maintain`, `/reingest`, `/calibrate raw`, or `/outputs` depending on whether you want an answer, four-step digest, redigest, status calibration, or structured knowledge output.

## Troubleshooting

### Windows WebSocket or `os error 10061`

If Codex CLI logs mention `responses_websocket`, `wss://chatgpt.com/backend-api/codex/responses`, `actively refused`, or `os error 10061`, the failure is usually in the Codex CLI ChatGPT-login WebSocket connection.

Try these steps:

1. Set the plugin default model to `Auto`, or choose a model other than `gpt-5.5`.
2. If your network requires a local proxy, enable the plugin proxy setting and enter a URL such as `http://127.0.0.1:7890`.
3. Reconnect Codex from the settings page, or restart Obsidian.
4. If it still fails, share the new detailed plugin error and the relevant Codex CLI log lines with account details removed.

## Privacy and permissions

- Codex EchoInk is desktop-only because it calls local command-line tools.
- EchoInk itself does not require payment or an EchoInk account. Individual Agent or model providers can require their own account, authorization, subscription, or usage charges; those provider terms and privacy policies apply.
- Codex CLI mode uses your local Codex CLI login and may send selected prompts, attachments, and chosen file context to the model provider configured in Codex.
- OpenCode API mode connects to a local or user-configured OpenCode server. The plugin can start or stop `opencode serve`, but it does not silently install OpenCode.
- Hermes mode calls your local Hermes CLI or configured Hermes API server. EchoInk can store the selected Hermes server URL, profile, provider, model, and optional API server key, but it does not silently rewrite your Hermes global provider setup.
- Custom API provider keys are stored in Obsidian plugin data on your local machine. Use them only on a trusted device. Hermes inference provider keys should normally stay in Hermes' own configuration.
- The plugin does not upload your whole vault by default. Ordinary chat requires choosing a workspace folder, and attached notes are turn context only.
- Knowledge management runs keep Raw source bodies read-only and only update indexes or trackers. In ordinary Agent chat, Raw file organization follows your explicit instruction and the active permission mode.
- Outside-vault access is used for workspaces and attachments you explicitly select, plus configuration, installation, temporary, and runtime paths required by configured local Agent tools. Agent sandbox modes may allow read access outside the selected workspace, and `Danger full access` removes filesystem restrictions; use that mode only with trusted prompts and tools. EchoInk does not silently scan unrelated system folders on its own.
- During a Codex-backed `/journal` run, EchoInk may instruct the selected Agent to read only the target dates under `~/.codex/sessions/YYYY/MM/DD/*.jsonl` as optional evidence for the requested daily journal. EchoInk does not preload those files or scan unrelated session dates.
- For WeChat Collection, EchoInk checks the fixed path `~/.codex/skills/wechat-article-to-obsidian-raw/scripts/wechat_capture.mjs` and runs that script with Node when it is present so the requested article can be archived. It does not search other Skill directories; if the script is unavailable or returns no note, EchoInk uses its built-in page capture.
- EchoInk passes the current process environment to selected Agent CLIs, Agent installer or service subprocesses, and user-configured stdio MCP commands so they can find `PATH`, `HOME`, proxy, provider, and command-specific settings. Configure only trusted local commands. EchoInk itself does not use hostname, user information, or environment variables for fingerprinting or telemetry.
- Setup network access is user-triggered: Codex and OpenCode setup use the npm registry configured on your machine. Hermes setup downloads a pinned Hermes revision from `github.com/NousResearch/hermes-agent` and a pinned `uv` archive from `github.com/astral-sh/uv`. It then runs `uv venv --python 3.11`, which may contact `api.github.com` and `github.com/astral-sh/python-build-standalone` to download a managed Python 3.11 runtime when none is available. The following `uv sync --locked` downloads the exact lockfile dependencies from Python package services, normally `pypi.org` and `files.pythonhosted.org`. These downloads are used only to install or repair Hermes.
- When you paste a public webpage or WeChat URL into Collection, EchoInk directly requests the supplied URL with Obsidian `requestUrl` to download and extract the page. For WeChat, the fixed capture script above is tried first when available and built-in `requestUrl` capture is the fallback. EchoInk does not bypass login, verification, or CAPTCHA pages.
- After you choose Nous authorization, EchoInk requests the recommended-model catalog from `portal.nousresearch.com`. Agent inference and MCP traffic goes only to the provider, API server, or MCP server you configured.
- EchoInk has no client-side or server-side telemetry service of its own. Remote Agent, model, API, and MCP providers may retain service logs under their own privacy policies.
- Vault-wide enumeration is reserved for explicit Knowledge search, dashboard, maintenance, initialization preview, and knowledge-rules file selection. Known file paths should be accessed directly instead of scanning the whole vault.
- Clipboard access happens only when you paste an attachment, click a copy action, or choose the installation fallback labeled `Open terminal and copy command`. EchoInk does not read or monitor the clipboard in the background.
- MCP and Skill resources are imported into an EchoInk vault-local registry. Per-scope switches affect EchoInk only and are not written back to Codex, OpenCode, or Hermes global configs. MCP tool calls that go through EchoInk's broker require explicit connection config, approval, and local logs.

## Screenshots

![Codex EchoInk v1.2.0 real Home workspace and Agent sidebar](docs/images/codex-echoink-v1.2.0-real-home.png)

![Codex EchoInk v1.2.0 Codex, OpenCode, and Hermes switcher](docs/images/codex-echoink-v1.2.0-real-agent-switcher.png)

![Codex EchoInk v1.2.0 Plan mode and rebuilt composer](docs/images/codex-echoink-v1.2.0-real-plan-composer.png)

![Codex EchoInk Home Dashboard](docs/images/codex-echoink-home-dashboard-v1.0.0.png)

![Codex EchoInk turn queue and composer menus](docs/images/codex-echoink-turn-queue-v0.7.2.png)

![Codex EchoInk Knowledge Safety](docs/images/codex-echoink-knowledge-safety-v0.8.0.png)

![Codex EchoInk knowledge base workflow](docs/images/codex-echoink-knowledge-usage-v0.5.0.png)

![Codex EchoInk sidebar demo](docs/images/codex-echoink-vault-answer.png)

## Development

```bash
npm install
npm run test
npm run typecheck
npm run build
```

Generate a local manual install package:

```bash
npm run package
```

Deploy to your own Obsidian vault:

```bash
OBSIDIAN_VAULT=/path/to/your/vault npm run deploy
```

## Requirements

- Codex CLI must be installed and available locally for Codex CLI mode.
- OpenCode must be installed locally for OpenCode API mode. The plugin can connect to or start the OpenCode server, but it does not silently install OpenCode.
- Hermes CLI must be installed locally for Hermes mode. Configure inference providers through Hermes, then point EchoInk at the CLI or API server.
- Custom API providers for Codex CLI mode must be compatible with the OpenAI Responses API, such as `/v1/responses`. Providers that only support `/v1/chat/completions` may not work.
- Custom API keys are stored in Obsidian plugin data, so use them only on a trusted local machine.
- Leave CLI paths empty to auto-detect from `PATH` and common install folders, or set paths manually in plugin settings.

## License

Codex EchoInk is open source under the [MIT License](LICENSE).

You may use, copy, modify, merge, publish, distribute, sublicense, and sell copies of this software as permitted by the MIT License, as long as the copyright and license notice are included. The software is provided "as is", without warranty of any kind.
