# Changelog

## 2.3.1 - 2026-09-19

![EchoInk Agent 2.3.1](https://raw.githubusercontent.com/AKin-lvyifang/codex-echoink/2.3.1/assets/releases/echoink-agent-2.3.1-release.png)

### 中文

**目录看得懂，整理有交代。**

2.3.1 是一次日常体验优化，重点改进知识库整理、待办统计和操作反馈。

- **目录中英双语：** 初始化和维护使用中英文分类与文件夹名称。已有仓库可点击“优化名称”，将英文一级目录和 Wiki 分类目录实际改名，例如 `raw` 变为 `原始资料（raw）`；已有双语目录继续复用。
- **复原仓库：** 初始化前保存原始目录记录，之后可把记录中的文件移回原位置。保留最新文件内容和新增文件，同名冲突会保留并说明；这是目录位置恢复，不是内容版本回滚。
- **初始化更顺畅：** 已有目录直接复用，只补缺失项；单个文件的问题单独说明。Raw 属性或标签更新不再阻断分析，正文变化会重新读取。模型读完资料后认为无需新增知识，也属于正常结果；尚未读取的资料继续列为待处理。
- **进度和原因说清楚：** 分项显示“准备目录”“归档文件”“分析笔记”的动作、数量和单位。暂停、运行中断和具体错误分别说明，下一步对应实际按钮；初始化需要回答模型问题时，可在当前页面处理。
- **待办年度热力图：** 在待办设置中查看累计、今日和全年完成数，切换年份，指向格子查看当天数量。旧记录没有完成日期时只计入累计，不会被随意补到某一天。
- **细节修复：** 改善小窗口下的设置布局，统一新增目录操作卡片；修复 Windows 上部分头像与身份保存报错，以及自定义配置目录、弹出窗口消息测量和收藏失败后的提示与状态恢复。

#### 使用与升级

在 **设置 → EchoInk Agent → 知识库 → 目录管理** 中使用“优化名称”和“复原”；没有原始目录记录时，“复原”不可用。年度完成记录位于 **待办** 设置页。升级本身不要求重新初始化仓库。

在 Obsidian 社区插件页面检查更新，或下载本页的 **main.js、manifest.json、styles.css**，放入 Vault 的 `.obsidian/plugins/codex-echoink/` 后重新启用插件；保留自己的 `data.json`。

需要 **Obsidian Desktop 1.11.4 及以上**，暂不支持移动端。本轮新增目录改名与初始化反馈的完整实机复验尚未完成，Windows/Linux 的对应实机操作也尚未验证。主文件仍超过 Obsidian Sync Standard 的 5 MiB 单文件限制，使用该方案时请在各设备分别更新。头图为功能示意。

### English

**Readable folders. Clearer organization progress.**

2.3.1 focuses on everyday improvements to knowledge organization, to-do statistics, and action feedback.

- **Bilingual folder names:** Initialization and maintenance use Chinese and English category and folder names. In existing vaults, select **Optimize names** to rename English root folders and Wiki category folders on disk—for example, `raw` becomes `原始资料（raw）`. Existing bilingual folders are reused.
- **Restore vault:** Initialization saves a record of the original folder layout. Restore moves recorded files back to their original locations while keeping their latest content and new files. Conflicts are preserved and explained. This restores locations, not earlier versions of file content.
- **Smoother initialization:** Existing folders are reused and missing ones are added; individual file issues are reported separately. Raw property or tag updates no longer interrupt analysis, and changed note bodies are read again. A model review that reads the sources and finds no new knowledge to add is also a valid result; unread sources remain pending.
- **Clear progress and reasons:** Folder preparation, file organization, and note analysis are listed with explicit actions, counts, and units. Pauses, interruptions, and specific errors are distinguished, with next steps matching the available buttons. Questions from the model can be answered on the initialization page.
- **Yearly to-do heatmap:** View total, today, and annual completion counts in To-dos settings. Switch years and hover over a day for its count. Older completions without a known date count toward the total only; no date is invented.
- **Detail fixes:** Improved settings layouts in smaller windows and consistent cards for folder actions. Fixed some avatar and identity save errors on Windows, custom configuration-folder paths, message measurement in pop-out windows, and feedback and state recovery after a failed favorite save.

#### Use and upgrade

Open **Settings → EchoInk Agent → Knowledge → Folder management** for **Optimize names** and **Restore**. Restore is unavailable without an original layout record. Annual completion history is in **To-dos** settings. Upgrading does not require vault reinitialization.

Check for updates in Obsidian's Community plugins page, or download **main.js, manifest.json, and styles.css** from this release, place them in the vault's `.obsidian/plugins/codex-echoink/` folder, and re-enable the plugin. Keep your own `data.json`.

Requires **Obsidian Desktop 1.11.4 or later**. Mobile is not supported. Full real-app revalidation of the new folder-renaming and initialization-feedback flow remains pending, including corresponding Windows/Linux interaction. The main file still exceeds Obsidian Sync Standard's 5 MiB per-file limit; update each device separately if you use that plan. The cover is illustrative.

## 2.3.0 - 2026-09-13

![EchoInk Agent 2.3.0](https://raw.githubusercontent.com/AKin-lvyifang/codex-echoink/2.3.0/assets/releases/echoink-agent-2.3.0-release.png)

### 中文

**随时提问，接着完成。**

EchoInk Agent 2.3.0 新增快捷 AI 小窗与 Markdown 待办，并让设置和长对话更容易浏览。

#### 在当前工作旁边，打开一段对话

Obsidian 保持运行时，可以在其他应用中用全局快捷键唤起 AI 小窗，直接输入和提问。小窗可以拖动；关闭后，对话回到 Obsidian 右侧栏顶部，继续使用同一段会话。草稿、附件和已选择的笔记引用一起保留，正在生成的回答也能继续。

在 **设置 → EchoInk Agent → 基础设置 → 快捷 AI 小窗** 中开启并设置快捷键，默认是 macOS 的 **⌘⇧E**、Windows/Linux 的 **Ctrl+Shift+E**。再次按快捷键或按 Esc 可收起小窗；若组合已被占用，请换一个快捷键。

#### 待办留在你能直接编辑的笔记里

首页新增待办表格，支持事项、相关人员、截止日期、分类与完成状态。可以按分类和完成状态组合筛选，标题旁的进度条显示当前分类的完成情况。

点击首页的 **新增待办** 开始记录；在独立的 **待办** 设置页管理分类或打开源文件。内容保存在当前 Vault 的 **EchoInk/待办.md**，也可以直接用 Obsidian 编辑。保存失败时保留表单输入；在表格操作期间发生的源文件编辑会被保留。删除分类会把相关事项转为未分类，不会删除待办。

#### 小窗口里也能看清入口

一级设置导航改为书签式：未选中时只显示图标，选中后升起并展开名称，再衔接图标原有动画；悬停可以查看完整名称。**布局与外观** 独立成页，集中控制首页入口显示。长对话右侧新增轮次导航，可以预览并跳到需要回看的位置。

#### 下载与升级

- 已安装用户可在 Obsidian 社区插件页面检查更新。手动安装请下载本页的 **main.js、manifest.json、styles.css**，放入 Vault 的 `.obsidian/plugins/codex-echoink/` 后重新启用；保留自己的 `data.json`。
- 从 2.2.2 升级无需重新初始化知识库。已有会话、Provider 配置和长期记忆继续保留；若存在旧版待办配置，将迁入 Markdown 源文件并保留迁移备份。
- 支持 **Obsidian Desktop 1.11.4 及以上**，暂不支持移动端。快捷 AI 小窗已在 macOS 实机验证；Windows/Linux 的小窗交互尚未完成实机验证。
- 主文件仍超过 Obsidian Sync Standard 的 5 MiB 单文件限制，使用该方案时请在各设备分别更新。头图为功能示意，实际界面与数据以插件为准。

### English

**Ask when you need to. Pick up where you left off.**

EchoInk Agent 2.3.0 adds a quick AI window and Markdown to-dos, with easier navigation for settings and long conversations.

#### Open a conversation beside your work

While Obsidian is running, use a global shortcut from another application to open the AI window and start typing. Move it wherever you need it. Closing the window returns the same conversation to the top tab group in Obsidian's right sidebar, keeping drafts, attachments, selected note references, and any response still being generated.

Enable it under **Settings → EchoInk Agent → General → Quick AI window** and choose a shortcut. The default is **⌘⇧E** on macOS or **Ctrl+Shift+E** on Windows/Linux. Press the shortcut again or Esc to hide the window. Choose another combination if the shortcut is already occupied.

#### Keep to-dos in a note you can edit

The homepage now includes a to-do table with people, due dates, categories, and completion states. Combine category and completion filters; the compact progress bar shows completion for the current category.

Select **Add to-do** on the homepage. Manage categories or open the source file from the separate **To-dos** settings tab. Tasks live in **EchoInk/待办.md** in the current vault and can also be edited directly in Obsidian. Failed saves keep form input, and source-file edits made during table operations are preserved. Deleting a category moves its tasks to Uncategorized without deleting them.

#### Clearer navigation in a small window

Settings now use bookmark-style tabs: inactive tabs show an icon, while the selected tab rises and reveals its name before playing its existing icon animation. Hover for the full label. **Layout & appearance** has its own tab for homepage visibility controls. A new turn navigator along the right edge of long conversations lets you preview and jump to earlier turns.

#### Download and upgrade

- Check for updates in Obsidian's Community plugins page. For manual installation, download **main.js, manifest.json, and styles.css** from this release, place them in the vault's `.obsidian/plugins/codex-echoink/` folder, and re-enable the plugin. Keep your own `data.json`.
- Upgrading from 2.2.2 does not require vault reinitialization. Conversations, Provider settings, and long-term memory are retained. Existing legacy to-dos are migrated to the Markdown source with a migration backup.
- Requires **Obsidian Desktop 1.11.4 or later**. Mobile is not supported. The quick window has been verified on macOS; real-device quick-window interaction on Windows/Linux remains unverified.
- The main file still exceeds Obsidian Sync Standard's 5 MiB per-file limit; update each device separately if you use that plan. The cover is an illustration; the plugin is the source of truth for UI and data.

## 2.2.2 - 2026-09-09

![EchoInk Agent 2.2.0](https://raw.githubusercontent.com/AKin-lvyifang/codex-echoink/2.2.0/assets/releases/echoink-agent-2.2.0-release.png)

### 中文

修复了 Windows 上无法启用插件的问题。

**每次回来，都有一个继续的地方。**

昨天写到一半的想法，这周反复翻过的笔记，还有那条来不及整理的灵感，现在可以在同一个首页里接起来。EchoInk Agent 2.2.2 带来重新设计的个人知识工作台，以及从基础设置到知识库管理的完整界面更新。熟悉的 Obsidian 文件夹、笔记标签和右侧 Agent 依然各在其位，你与知识之间的路径变得更清楚了。

#### 打开首页，就能接上思路

“最近笔记”把新建和修改过的内容带回眼前；想找更早的内容，搜索就在页面内展开，结果随输入出现在下方。临时冒出的念头也有了顺手的入口：点击 **快速记录**，直接在 Inbox 新建一篇空白笔记，打开就能写。

点击最近笔记或搜索结果，会在 Obsidian 笔记标签中打开。首页本身也是工作区里的一个标签，需要时随时切回来，关闭后也能从左侧 EchoInk 入口重新打开。

#### 积累不只是一串数字，也是可以重返的日子

本周足迹把写下、修改和重读放在一起，让你看见知识是怎样一点点长出来的。日历把日记和活动串回具体日期，方便从“那天做了什么”找回一段思考。

点击某一天查看当天记录，或用 **回看这一周** 打开足迹列表，再从列表进入笔记。足迹从启用记录后开始积累，同一天对同一篇笔记的同类操作会合并，不会凭空补出旧历史。

#### 给知识一个去处，也给下一步一个入口

Wiki、Outputs、Projects、Inbox、Journal、Review 六张卡片，分别承接知识、成果、项目、灵感、日记与回顾。柔和的色彩和轻盈的悬停动作，让入口容易辨认；鼠标移上去，下一步的动作自然浮现。

- **Wiki / Outputs / Projects / Inbox：** 打开对应目录入口笔记的 Obsidian 原生局部图谱，沿着与它相连的笔记继续探索。
- **Journal：** 选择模板开始日记；想先聊聊今天，可以用首页上方的 **对话写日记**，和 Agent 一起梳理。
- **Review：** 在右侧开启一段新的知识复盘对话，沿着已有笔记逐步回看、连接和追问。是否写入笔记，仍由你确认。

#### 设置终于有了同一种节奏

五个设置页及其详情页统一了卡片、行距、按钮、开关、输入框和下拉选择。模型连接、资源管理、知识库状态与复盘各有清楚的位置；窗口缩小、放大或切换中英文时，内容会随可用空间调整。

在 **API Provider** 中按分组选择服务、启用模型并调整默认模型与参数；在 **Skills & MCP** 中搜索资源、查看详情或编辑配置。需要解释时，把鼠标放到标题旁的问号上即可，日常操作不必被长段说明打断。

知识库状态也更容易读懂：在 **知识库管理** 中查看本地结构评分、体检记录与维护进度。评分来自实际目录、索引文件和来源状态；它反映结构准备情况，不代表笔记内容质量，也不等于一次完整的全库诊断。

#### 整理已有笔记，先看清它们将去哪里

自定义初始化按目录展示，每个文件夹占一行。即使笔记很多，也不用在一张不断变长的分配表里来回寻找。

进入 **知识库管理 → 自定义方案**，点击目录右侧的添加入口，搜索标题或路径，批量选中笔记。你可以查看已分配内容、撤回选择，再检查整理预览。只有点击 **开始初始化** 后才真正执行整理，决定之前可以从容调整。

#### 第一次见面，有人带你走到入口

五步引导换上了与新首页一致的聚光提示和进度卡片，从左侧入口、设置、模型连接，一直带到知识库方案和 Agent 画像。每一步都对准实际界面，不需要对照说明猜按钮在哪。

用“下一步”继续，也可以返回、跳步或随时退出；完成页支持再看一遍。引导负责介绍位置，连接模型和整理笔记仍由你操作。

#### 让等待少打断一点工作

在 EchoInk 对话栏保持打开时，可以切到另一段会话继续工作，原会话仍会运行，完成后显示未读提示；需要时也能分别停止。首页、设置和对话栏补齐了英文界面，用户自己的笔记与聊天内容保留原语言。插件主文件从 2.1.0 的约 12.64 MiB 减至约 8.71 MiB，下载体积减少约 31%。

#### 下载与升级

- 从 **2.1.0** 可以直接升级，无需重新初始化知识库或重建会话、长期记忆；已有 Provider 与模型配置继续使用。
- 已安装用户可在 Obsidian 社区插件页面检查更新。手动安装请下载本页的 **main.js、manifest.json、styles.css**，放入 Vault 的 `.obsidian/plugins/codex-echoink/`，然后重新启用插件。不要覆盖自己的 `data.json`。
- 仍支持 **Obsidian Desktop 1.11.4 及以上**，暂不支持移动端。主文件仍超过 Obsidian Sync Standard 的 5 MiB 单文件上限，使用该方案时请在各设备分别更新。
- 头图展示的是首页示意内容；实际笔记、数量、足迹与状态来自你的知识库。

### English

Fixed an issue that prevented the plugin from being enabled on Windows.

**A place to pick up where you left off.**

An unfinished thought, a note you kept returning to this week, an idea you haven't sorted yet: EchoInk Agent 2.2.2 brings them together in a redesigned personal knowledge workspace. A complete settings refresh makes the rest of the plugin easier to navigate, while your familiar Obsidian folders, note tabs, and Agent sidebar stay in place.

#### Open your workspace and find your thread

Recent notes bring newly created and edited pages back into view. Search expands within the page, with suggestions appearing below as you type. For a passing idea, select **Quick note** to create and open a blank note in Inbox, ready to write.

Select a recent note or search result to open it in an Obsidian note tab. The workspace is a tab too: return whenever you need it, or reopen it from the left EchoInk entry if you close it.

#### See your progress as days you can return to

Weekly activity brings writing, editing, and rereading together. The calendar connects journals and activity to a date, giving you another way to recover a line of thought.

Select a day to see its records, or open **View this week** and follow an entry back to its note. Activity starts accumulating when tracking is enabled; matching actions on the same note and day are combined. Earlier activity is not invented or backfilled.

#### A home for your knowledge, a clear next step

Six cards—Wiki, Outputs, Projects, Inbox, Journal, and Review—connect knowledge, finished work, projects, ideas, daily writing, and reflection. Gentle colors distinguish the destinations, and a light hover animation reveals each action.

- **Wiki / Outputs / Projects / Inbox:** Open the native Obsidian local graph for that folder's index note and explore the notes connected to it.
- **Journal:** Choose a template to start writing. Prefer talking first? Use **Journal with your Agent** at the top of the workspace to reflect on your day with the Agent.
- **Review:** Start a fresh knowledge-review conversation in the right sidebar, revisiting notes and exploring connections one step at a time. Writing changes back to notes still requires your confirmation.

#### Settings with a consistent rhythm

All five settings tabs and their detail pages now share cards, spacing, buttons, switches, inputs, and selectors. Model connections, resources, knowledge status, and review tools each have a clear place. Layouts adapt to the available space as windows resize or the interface switches between Chinese and English.

Under **API Provider**, choose a service by group, enable models, and adjust defaults and parameters. Under **Skills & MCP**, search resources, open details, and edit configuration. Hover over a question mark beside a heading for an explanation when you need it.

Under **Knowledge**, inspect the local structure score, check history, and maintenance progress. The score uses actual directory, index-file, and source status. It describes structural readiness, not the quality of your writing or a comprehensive vault diagnosis.

#### Organize existing notes after seeing where they will go

Custom initialization gives each destination folder one row, so a large collection of notes no longer turns into a sprawling assignment table.

Open **Knowledge → Custom plan**, select the add action beside a folder, search by title or path, and choose multiple notes. Review assigned items, undo selections, and check the plan. Organization runs only after you select **Start initialization**, leaving room to adjust your choices first.

#### A clearer first meeting

The redesigned five-step guide uses focused highlights and progress cards that match the new workspace. It points to the actual left-side entry, settings, model connection, knowledge plan, and Agent profile.

Continue with Next, go back, jump between steps, or leave at any time. The completion screen lets you replay the guide. It shows you around; connecting a model and organizing notes remain your actions.

#### Keep working while another conversation finishes

While the EchoInk chat view remains open, switch to another conversation and continue working. The earlier conversation can keep running and shows an unread indicator when it finishes; runs can also be stopped individually. English now covers the workspace, settings, and chat sidebar, while your own notes and conversations keep their original language. The main plugin file has dropped from about 12.64 MiB in 2.1.0 to 8.71 MiB, a download-size reduction of roughly 31%.

#### Download and upgrade

- Upgrade directly from **2.1.0** without reinitializing Knowledge or rebuilding conversations and long-term memory. Existing Provider and model settings remain available.
- Check for updates in Obsidian's Community plugins page. For manual installation, download **main.js, manifest.json, and styles.css** from this release, place them in your vault's `.obsidian/plugins/codex-echoink/` folder, and re-enable the plugin. Keep your existing `data.json`.
- Requires **Obsidian Desktop 1.11.4 or later**; mobile is not supported. The main file still exceeds Obsidian Sync Standard's 5 MiB per-file limit, so update each device separately when using that plan.
- The cover uses illustrative homepage content. Your actual notes, counts, activity, and status come from your own vault.

[Full changes / 完整变更](https://github.com/AKin-lvyifang/codex-echoink/compare/2.1.0...2.2.2)

## 2.2.1 - 2026-09-08

![EchoInk Agent 2.2.1](https://raw.githubusercontent.com/AKin-lvyifang/codex-echoink/2.2.1/assets/releases/echoink-agent-2.2.1-release.png)

### 中文

**每次回来，都有一个继续的地方。**

昨天写到一半的想法，这周反复翻过的笔记，还有那条来不及整理的灵感，现在可以在同一个首页里接起来。EchoInk Agent 2.2.1 带来重新设计的个人知识工作台，以及从基础设置到知识库管理的完整界面更新。熟悉的 Obsidian 文件夹、笔记标签和右侧 Agent 依然各在其位，你与知识之间的路径变得更清楚了。

#### 打开首页，就能接上思路

“最近笔记”把新建和修改过的内容带回眼前；想找更早的内容，搜索就在页面内展开，结果随输入出现在下方。临时冒出的念头也有了顺手的入口：点击 **快速记录**，直接在 Inbox 新建一篇空白笔记，打开就能写。

点击最近笔记或搜索结果，会在 Obsidian 笔记标签中打开。首页本身也是工作区里的一个标签，需要时随时切回来，关闭后也能从左侧 EchoInk 入口重新打开。

#### 积累不只是一串数字，也是可以重返的日子

本周足迹把写下、修改和重读放在一起，让你看见知识是怎样一点点长出来的。日历把日记和活动串回具体日期，方便从“那天做了什么”找回一段思考。

点击某一天查看当天记录，或用 **回看这一周** 打开足迹列表，再从列表进入笔记。足迹从启用记录后开始积累，同一天对同一篇笔记的同类操作会合并，不会凭空补出旧历史。

#### 给知识一个去处，也给下一步一个入口

Wiki、Outputs、Projects、Inbox、Journal、Review 六张卡片，分别承接知识、成果、项目、灵感、日记与回顾。柔和的色彩和轻盈的悬停动作，让入口容易辨认；鼠标移上去，下一步的动作自然浮现。

- **Wiki / Outputs / Projects / Inbox：** 打开对应目录入口笔记的 Obsidian 原生局部图谱，沿着与它相连的笔记继续探索。
- **Journal：** 选择模板开始日记；想先聊聊今天，可以用首页上方的 **对话写日记**，和 Agent 一起梳理。
- **Review：** 在右侧开启一段新的知识复盘对话，沿着已有笔记逐步回看、连接和追问。是否写入笔记，仍由你确认。

#### 设置终于有了同一种节奏

五个设置页及其详情页统一了卡片、行距、按钮、开关、输入框和下拉选择。模型连接、资源管理、知识库状态与复盘各有清楚的位置；窗口缩小、放大或切换中英文时，内容会随可用空间调整。

在 **API Provider** 中按分组选择服务、启用模型并调整默认模型与参数；在 **Skills & MCP** 中搜索资源、查看详情或编辑配置。需要解释时，把鼠标放到标题旁的问号上即可，日常操作不必被长段说明打断。

知识库状态也更容易读懂：在 **知识库管理** 中查看本地结构评分、体检记录与维护进度。评分来自实际目录、索引文件和来源状态；它反映结构准备情况，不代表笔记内容质量，也不等于一次完整的全库诊断。

#### 整理已有笔记，先看清它们将去哪里

自定义初始化按目录展示，每个文件夹占一行。即使笔记很多，也不用在一张不断变长的分配表里来回寻找。

进入 **知识库管理 → 自定义方案**，点击目录右侧的添加入口，搜索标题或路径，批量选中笔记。你可以查看已分配内容、撤回选择，再检查整理预览。只有点击 **开始初始化** 后才真正执行整理，决定之前可以从容调整。

#### 第一次见面，有人带你走到入口

五步引导换上了与新首页一致的聚光提示和进度卡片，从左侧入口、设置、模型连接，一直带到知识库方案和 Agent 画像。每一步都对准实际界面，不需要对照说明猜按钮在哪。

用“下一步”继续，也可以返回、跳步或随时退出；完成页支持再看一遍。引导负责介绍位置，连接模型和整理笔记仍由你操作。

#### 让等待少打断一点工作

在 EchoInk 对话栏保持打开时，可以切到另一段会话继续工作，原会话仍会运行，完成后显示未读提示；需要时也能分别停止。首页、设置和对话栏补齐了英文界面，用户自己的笔记与聊天内容保留原语言。插件主文件从 2.1.0 的约 12.64 MiB 减至约 8.71 MiB，下载体积减少约 31%。

#### 下载与升级

- 从 **2.1.0** 可以直接升级，无需重新初始化知识库或重建会话、长期记忆；已有 Provider 与模型配置继续使用。
- 已安装用户可在 Obsidian 社区插件页面检查更新。手动安装请下载本页的 **main.js、manifest.json、styles.css**，放入 Vault 的 `.obsidian/plugins/codex-echoink/`，然后重新启用插件。不要覆盖自己的 `data.json`。
- 仍支持 **Obsidian Desktop 1.11.4 及以上**，暂不支持移动端。主文件仍超过 Obsidian Sync Standard 的 5 MiB 单文件上限，使用该方案时请在各设备分别更新。
- 头图展示的是首页示意内容；实际笔记、数量、足迹与状态来自你的知识库。

### English

**A place to pick up where you left off.**

An unfinished thought, a note you kept returning to this week, an idea you haven't sorted yet: EchoInk Agent 2.2.1 brings them together in a redesigned personal knowledge workspace. A complete settings refresh makes the rest of the plugin easier to navigate, while your familiar Obsidian folders, note tabs, and Agent sidebar stay in place.

#### Open your workspace and find your thread

Recent notes bring newly created and edited pages back into view. Search expands within the page, with suggestions appearing below as you type. For a passing idea, select **Quick note** to create and open a blank note in Inbox, ready to write.

Select a recent note or search result to open it in an Obsidian note tab. The workspace is a tab too: return whenever you need it, or reopen it from the left EchoInk entry if you close it.

#### See your progress as days you can return to

Weekly activity brings writing, editing, and rereading together. The calendar connects journals and activity to a date, giving you another way to recover a line of thought.

Select a day to see its records, or open **View this week** and follow an entry back to its note. Activity starts accumulating when tracking is enabled; matching actions on the same note and day are combined. Earlier activity is not invented or backfilled.

#### A home for your knowledge, a clear next step

Six cards—Wiki, Outputs, Projects, Inbox, Journal, and Review—connect knowledge, finished work, projects, ideas, daily writing, and reflection. Gentle colors distinguish the destinations, and a light hover animation reveals each action.

- **Wiki / Outputs / Projects / Inbox:** Open the native Obsidian local graph for that folder's index note and explore the notes connected to it.
- **Journal:** Choose a template to start writing. Prefer talking first? Use **Journal with your Agent** at the top of the workspace to reflect on your day with the Agent.
- **Review:** Start a fresh knowledge-review conversation in the right sidebar, revisiting notes and exploring connections one step at a time. Writing changes back to notes still requires your confirmation.

#### Settings with a consistent rhythm

All five settings tabs and their detail pages now share cards, spacing, buttons, switches, inputs, and selectors. Model connections, resources, knowledge status, and review tools each have a clear place. Layouts adapt to the available space as windows resize or the interface switches between Chinese and English.

Under **API Provider**, choose a service by group, enable models, and adjust defaults and parameters. Under **Skills & MCP**, search resources, open details, and edit configuration. Hover over a question mark beside a heading for an explanation when you need it.

Under **Knowledge**, inspect the local structure score, check history, and maintenance progress. The score uses actual directory, index-file, and source status. It describes structural readiness, not the quality of your writing or a comprehensive vault diagnosis.

#### Organize existing notes after seeing where they will go

Custom initialization gives each destination folder one row, so a large collection of notes no longer turns into a sprawling assignment table.

Open **Knowledge → Custom plan**, select the add action beside a folder, search by title or path, and choose multiple notes. Review assigned items, undo selections, and check the plan. Organization runs only after you select **Start initialization**, leaving room to adjust your choices first.

#### A clearer first meeting

The redesigned five-step guide uses focused highlights and progress cards that match the new workspace. It points to the actual left-side entry, settings, model connection, knowledge plan, and Agent profile.

Continue with Next, go back, jump between steps, or leave at any time. The completion screen lets you replay the guide. It shows you around; connecting a model and organizing notes remain your actions.

#### Keep working while another conversation finishes

While the EchoInk chat view remains open, switch to another conversation and continue working. The earlier conversation can keep running and shows an unread indicator when it finishes; runs can also be stopped individually. English now covers the workspace, settings, and chat sidebar, while your own notes and conversations keep their original language. The main plugin file has dropped from about 12.64 MiB in 2.1.0 to 8.71 MiB, a download-size reduction of roughly 31%.

#### Download and upgrade

- Upgrade directly from **2.1.0** without reinitializing Knowledge or rebuilding conversations and long-term memory. Existing Provider and model settings remain available.
- Check for updates in Obsidian's Community plugins page. For manual installation, download **main.js, manifest.json, and styles.css** from this release, place them in your vault's `.obsidian/plugins/codex-echoink/` folder, and re-enable the plugin. Keep your existing `data.json`.
- Requires **Obsidian Desktop 1.11.4 or later**; mobile is not supported. The main file still exceeds Obsidian Sync Standard's 5 MiB per-file limit, so update each device separately when using that plan.
- The cover uses illustrative homepage content. Your actual notes, counts, activity, and status come from your own vault.

[Full changes / 完整变更](https://github.com/AKin-lvyifang/codex-echoink/compare/2.1.0...2.2.1)

## 2.2.0 - 2026-09-08

![EchoInk Agent 2.2.0](https://raw.githubusercontent.com/AKin-lvyifang/codex-echoink/2.2.0/assets/releases/echoink-agent-2.2.0-release.png)

### 中文

**每次回来，都有一个继续的地方。**

昨天写到一半的想法，这周反复翻过的笔记，还有那条来不及整理的灵感，现在可以在同一个首页里接起来。EchoInk Agent 2.2.0 带来重新设计的个人知识工作台，以及从基础设置到知识库管理的完整界面更新。熟悉的 Obsidian 文件夹、笔记标签和右侧 Agent 依然各在其位，你与知识之间的路径变得更清楚了。

#### 打开首页，就能接上思路

“最近笔记”把新建和修改过的内容带回眼前；想找更早的内容，搜索就在页面内展开，结果随输入出现在下方。临时冒出的念头也有了顺手的入口：点击 **快速记录**，直接在 Inbox 新建一篇空白笔记，打开就能写。

点击最近笔记或搜索结果，会在 Obsidian 笔记标签中打开。首页本身也是工作区里的一个标签，需要时随时切回来，关闭后也能从左侧 EchoInk 入口重新打开。

#### 积累不只是一串数字，也是可以重返的日子

本周足迹把写下、修改和重读放在一起，让你看见知识是怎样一点点长出来的。日历把日记和活动串回具体日期，方便从“那天做了什么”找回一段思考。

点击某一天查看当天记录，或用 **回看这一周** 打开足迹列表，再从列表进入笔记。足迹从启用记录后开始积累，同一天对同一篇笔记的同类操作会合并，不会凭空补出旧历史。

#### 给知识一个去处，也给下一步一个入口

Wiki、Outputs、Projects、Inbox、Journal、Review 六张卡片，分别承接知识、成果、项目、灵感、日记与回顾。柔和的色彩和轻盈的悬停动作，让入口容易辨认；鼠标移上去，下一步的动作自然浮现。

- **Wiki / Outputs / Projects / Inbox：** 打开对应目录入口笔记的 Obsidian 原生局部图谱，沿着与它相连的笔记继续探索。
- **Journal：** 选择模板开始日记；想先聊聊今天，可以用首页上方的 **对话写日记**，和 Agent 一起梳理。
- **Review：** 在右侧开启一段新的知识复盘对话，沿着已有笔记逐步回看、连接和追问。是否写入笔记，仍由你确认。

#### 设置终于有了同一种节奏

五个设置页及其详情页统一了卡片、行距、按钮、开关、输入框和下拉选择。模型连接、资源管理、知识库状态与复盘各有清楚的位置；窗口缩小、放大或切换中英文时，内容会随可用空间调整。

在 **API Provider** 中按分组选择服务、启用模型并调整默认模型与参数；在 **Skills & MCP** 中搜索资源、查看详情或编辑配置。需要解释时，把鼠标放到标题旁的问号上即可，日常操作不必被长段说明打断。

知识库状态也更容易读懂：在 **知识库管理** 中查看本地结构评分、体检记录与维护进度。评分来自实际目录、索引文件和来源状态；它反映结构准备情况，不代表笔记内容质量，也不等于一次完整的全库诊断。

#### 整理已有笔记，先看清它们将去哪里

自定义初始化按目录展示，每个文件夹占一行。即使笔记很多，也不用在一张不断变长的分配表里来回寻找。

进入 **知识库管理 → 自定义方案**，点击目录右侧的添加入口，搜索标题或路径，批量选中笔记。你可以查看已分配内容、撤回选择，再检查整理预览。只有点击 **开始初始化** 后才真正执行整理，决定之前可以从容调整。

#### 第一次见面，有人带你走到入口

五步引导换上了与新首页一致的聚光提示和进度卡片，从左侧入口、设置、模型连接，一直带到知识库方案和 Agent 画像。每一步都对准实际界面，不需要对照说明猜按钮在哪。

用“下一步”继续，也可以返回、跳步或随时退出；完成页支持再看一遍。引导负责介绍位置，连接模型和整理笔记仍由你操作。

#### 让等待少打断一点工作

在 EchoInk 对话栏保持打开时，可以切到另一段会话继续工作，原会话仍会运行，完成后显示未读提示；需要时也能分别停止。首页、设置和对话栏补齐了英文界面，用户自己的笔记与聊天内容保留原语言。插件主文件从 2.1.0 的约 12.64 MiB 减至约 8.71 MiB，下载体积减少约 31%。

#### 下载与升级

- 从 **2.1.0** 可以直接升级，无需重新初始化知识库或重建会话、长期记忆；已有 Provider 与模型配置继续使用。
- 已安装用户可在 Obsidian 社区插件页面检查更新。手动安装请下载本页的 **main.js、manifest.json、styles.css**，放入 Vault 的 `.obsidian/plugins/codex-echoink/`，然后重新启用插件。不要覆盖自己的 `data.json`。
- 仍支持 **Obsidian Desktop 1.11.4 及以上**，暂不支持移动端。主文件仍超过 Obsidian Sync Standard 的 5 MiB 单文件上限，使用该方案时请在各设备分别更新。
- 头图展示的是首页示意内容；实际笔记、数量、足迹与状态来自你的知识库。

### English

**A place to pick up where you left off.**

An unfinished thought, a note you kept returning to this week, an idea you haven't sorted yet: EchoInk Agent 2.2.0 brings them together in a redesigned personal knowledge workspace. A complete settings refresh makes the rest of the plugin easier to navigate, while your familiar Obsidian folders, note tabs, and Agent sidebar stay in place.

#### Open your workspace and find your thread

Recent notes bring newly created and edited pages back into view. Search expands within the page, with suggestions appearing below as you type. For a passing idea, select **Quick note** to create and open a blank note in Inbox, ready to write.

Select a recent note or search result to open it in an Obsidian note tab. The workspace is a tab too: return whenever you need it, or reopen it from the left EchoInk entry if you close it.

#### See your progress as days you can return to

Weekly activity brings writing, editing, and rereading together. The calendar connects journals and activity to a date, giving you another way to recover a line of thought.

Select a day to see its records, or open **View this week** and follow an entry back to its note. Activity starts accumulating when tracking is enabled; matching actions on the same note and day are combined. Earlier activity is not invented or backfilled.

#### A home for your knowledge, a clear next step

Six cards—Wiki, Outputs, Projects, Inbox, Journal, and Review—connect knowledge, finished work, projects, ideas, daily writing, and reflection. Gentle colors distinguish the destinations, and a light hover animation reveals each action.

- **Wiki / Outputs / Projects / Inbox:** Open the native Obsidian local graph for that folder's index note and explore the notes connected to it.
- **Journal:** Choose a template to start writing. Prefer talking first? Use **Journal with your Agent** at the top of the workspace to reflect on your day with the Agent.
- **Review:** Start a fresh knowledge-review conversation in the right sidebar, revisiting notes and exploring connections one step at a time. Writing changes back to notes still requires your confirmation.

#### Settings with a consistent rhythm

All five settings tabs and their detail pages now share cards, spacing, buttons, switches, inputs, and selectors. Model connections, resources, knowledge status, and review tools each have a clear place. Layouts adapt to the available space as windows resize or the interface switches between Chinese and English.

Under **API Provider**, choose a service by group, enable models, and adjust defaults and parameters. Under **Skills & MCP**, search resources, open details, and edit configuration. Hover over a question mark beside a heading for an explanation when you need it.

Under **Knowledge**, inspect the local structure score, check history, and maintenance progress. The score uses actual directory, index-file, and source status. It describes structural readiness, not the quality of your writing or a comprehensive vault diagnosis.

#### Organize existing notes after seeing where they will go

Custom initialization gives each destination folder one row, so a large collection of notes no longer turns into a sprawling assignment table.

Open **Knowledge → Custom plan**, select the add action beside a folder, search by title or path, and choose multiple notes. Review assigned items, undo selections, and check the plan. Organization runs only after you select **Start initialization**, leaving room to adjust your choices first.

#### A clearer first meeting

The redesigned five-step guide uses focused highlights and progress cards that match the new workspace. It points to the actual left-side entry, settings, model connection, knowledge plan, and Agent profile.

Continue with Next, go back, jump between steps, or leave at any time. The completion screen lets you replay the guide. It shows you around; connecting a model and organizing notes remain your actions.

#### Keep working while another conversation finishes

While the EchoInk chat view remains open, switch to another conversation and continue working. The earlier conversation can keep running and shows an unread indicator when it finishes; runs can also be stopped individually. English now covers the workspace, settings, and chat sidebar, while your own notes and conversations keep their original language. The main plugin file has dropped from about 12.64 MiB in 2.1.0 to 8.71 MiB, a download-size reduction of roughly 31%.

#### Download and upgrade

- Upgrade directly from **2.1.0** without reinitializing Knowledge or rebuilding conversations and long-term memory. Existing Provider and model settings remain available.
- Check for updates in Obsidian's Community plugins page. For manual installation, download **main.js, manifest.json, and styles.css** from this release, place them in your vault's `.obsidian/plugins/codex-echoink/` folder, and re-enable the plugin. Keep your existing `data.json`.
- Requires **Obsidian Desktop 1.11.4 or later**; mobile is not supported. The main file still exceeds Obsidian Sync Standard's 5 MiB per-file limit, so update each device separately when using that plan.
- The cover uses illustrative homepage content. Your actual notes, counts, activity, and status come from your own vault.

[Full changes / 完整变更](https://github.com/AKin-lvyifang/codex-echoink/compare/2.1.0...2.2.0)

## 2.1.0 - 2026-08-30

![EchoInk Agent 2.1.0](https://raw.githubusercontent.com/AKin-lvyifang/codex-echoink/2.1.0/assets/releases/echoink-agent-2.1.0-release.png)

### 中文

#### 一个有名字、会成长的个人 Agent

1. 新增 8 种起始风格、15 个内置头像和自定义 SVG 头像。完成新版引导后，可以为 Agent 设置名称和头像；以后修改身份不会清空它的长期记忆或相处习惯。
2. 长期记忆现在会在对话中自主新增和更新，不必每次手动要求“记住”。Agent 也会定时做离线记忆整理，把分散的经历连起来，逐步更新它对你的理解和长期相处方式。
3. 在 **设置 → EchoInk Agent → 基础设置 → 长期记忆 / 身份与用户画像** 中，可以查看 Agent 画像和用户画像，选择新的起始风格，并调整离线整理开关与每天 1–6 次的频率。关闭离线整理不会关闭普通的记忆写入和召回；关闭长期记忆后，名称、头像和基础风格仍会保留。

#### 图片、文档和 Vault 笔记可以直接进入对话

1. 输入区现在支持粘贴或拖入图片，也可以通过 `+` 添加图片和文件。图片会根据当前模型能力发送；BMP、HEIC、HEIF 和 SVG 会在可转换时转为 PNG。
2. 支持 PDF、Word、Markdown 和 HTML 文档。每轮最多 8 个文件，单文件不超过 20 MiB，合计不超过 50 MiB；加密、损坏或超出模型上下文的文档会在发送前明确提示。扫描版 PDF 暂不支持 OCR。
3. 输入 `@` 可以按文件名、路径、别名、拼音或首字母搜索当前 Vault 的 Markdown 笔记，并把选中的笔记作为本轮背景。发送后的图片和文件会保留为可打开的缩略图或文件卡片。

#### 对话过程更清楚

1. 模型思考可以实时展开，工具进度、授权请求、任务计划、文件变化和最终回答会在同一条时间线中显示。手动上滚思考区时，界面不会强行拉回底部。
2. 需要分步骤处理复杂任务时，可从输入区 `+` 打开 **计划模式**。工具需要权限时，可以直接在对话中批准或拒绝。
3. Knowledge、Memory、笔记和文档来源会随本轮结果显示，便于分辨回答用了哪些背景。

#### Provider 与模型设置

1. 新增 **OpenAI Codex Beta** 浏览器登录。进入 **设置 → EchoInk Agent → API Provider → 新增 API Provider → 登录账户**，选择 OpenAI Codex Beta 后点击 **使用 OpenAI 登录**；浏览器没有自动返回时，也可以粘贴回调地址或授权码完成登录。
2. 通义千问 API 与通义千问 Token Plan 现在使用各自清楚的入口，并修复 Token Plan 传输和断流问题。
3. 同一种 Provider 可以保存多个实例；每个实例可启用多个模型、选择默认模型、获取模型列表或手动添加 Model ID。深度思考选项会按当前模型实际能力显示。

#### 首次使用与知识库初始化

1. 新增一次性的五步引导：打开 Agent 侧栏、进入设置、连接模型、建立知识库、选择 Agent 风格。引导可以随时关闭，也可以从设置重新开始。
2. 知识库初始化会先显示将要进行的整理预览，再由你确认执行。缺少固定目录时，可以只补齐目录，不会移动、删除或重写已有笔记；设置页也加入了图解指南。

#### 可靠性修复

1. 修复部分 Provider 在短句追问，或请求带有 Memory、Knowledge、笔记、文档背景时反复思考、重复回答，以及回答已经完成却仍显示失败的问题。新请求现在会按稳定顺序组织当前问题和相关背景，并能在没有知识引用时正常结束。
2. 失败或中断的模型输出不再写入后续对话历史；工具完成状态、正常流结束、长会话恢复、连续记忆写入和思考区滚动也更稳定。

#### 升级说明

- 可以从 2.0.3 直接升级到 2.1.0，无需重建会话、知识库或长期记忆；已保存的 Provider 和模型配置会自动升级。
- 2.1.0 不会改写已经保存的旧会话内容。如果某个旧会话已经留下重复回答或失败记录，升级后建议新建会话继续。
- 2.1.0 的 `main.js` 约为 12.64 MiB，超过 Obsidian Sync Standard 的 5 MiB 单文件上限。本地安装和社区下载不受影响，但需要在每台设备上分别更新，或使用支持更大文件的同步方式。
- 仍需 Obsidian Desktop 1.11.4 或更高版本，暂不支持移动端。

### English

#### A personal Agent with an identity that grows over time

1. Choose from eight starting styles, 15 built-in avatars, or a custom SVG avatar. The updated guide lets you name the Agent and choose its avatar; changing either later does not clear long-term memory or learned habits.
2. Long-term memory can now add and update useful records during ordinary conversations without requiring a repeated “remember this” instruction. Scheduled offline memory organization connects related experiences and gradually updates how the Agent understands and works with you.
3. Open **Settings → EchoInk Agent → General → Long-term memory / Identity and user profile** to view Agent and user profiles, choose another starting style, and set offline organization from one to six times per day. Turning off offline organization leaves normal memory writes and recall available. Turning off long-term memory keeps the Agent's name, avatar, and base style.

#### Images, documents, and vault notes in conversation

1. Paste or drag images into the composer, or use `+` to add images and files. Images are sent only when the current model supports them; BMP, HEIC, HEIF, and SVG are converted to PNG when possible.
2. Attach PDF, Word, Markdown, and HTML documents. A turn accepts up to eight files, 20 MiB per file and 50 MiB in total. Encrypted, damaged, or over-context documents are rejected with a clear message before sending. OCR for scanned PDFs is not included yet.
3. Type `@` to find Markdown notes in the current vault by file name, path, alias, Pinyin, or initials and add a selected note to the current turn. Sent images and documents remain available as openable thumbnails or file cards.

#### A clearer conversation process

1. Expand live reasoning while the model works. Tool progress, approval requests, task plans, file changes, and the final answer share one timeline. Manually scrolling up no longer forces the reasoning view back to the bottom.
2. For complex work, open **Plan mode** from the composer's `+` menu. Approve or reject requested tool access directly inside the conversation.
3. Knowledge, Memory, note, and document sources are shown with the turn so you can see which background informed the answer.

#### Providers and models

1. Added **OpenAI Codex Beta** browser sign-in. Open **Settings → EchoInk Agent → API Provider → Add API Provider → Sign in**, choose OpenAI Codex Beta, and select **Sign in with OpenAI**. If the browser cannot return automatically, paste the callback URL or authorization code to finish.
2. Qwen API and Qwen Token Plan now have separate, clearly named entries, with fixes for Token Plan transport and stream completion.
3. Save multiple instances of the same Provider, enable several models per instance, choose a default, discover available models, or add a Model ID manually. Deep-reasoning controls appear only when the selected model supports them.

#### Setup and Knowledge initialization

1. A one-time five-step guide now covers opening the Agent sidebar, entering settings, connecting a model, setting up Knowledge, and choosing an Agent style. Dismiss it at any time or restart it from settings.
2. Knowledge setup shows a preview before organizing anything. Missing standard folders can be restored without moving, deleting, or rewriting existing notes, and a visual guide is available in settings.

#### Reliability fixes

1. Fixed cases where some Providers could keep reasoning or repeat an answer after a short follow-up, especially when Memory, Knowledge, notes, or documents were included. Current questions and relevant background are now ordered consistently, and a turn can finish normally even when no Knowledge reference is found.
2. Failed or interrupted model output no longer leaks into later conversation history. Tool completion, clean stream endings, long-conversation recovery, consecutive memory writes, and reasoning-panel scrolling are also more reliable.

#### Upgrade notes

- Upgrade directly from 2.0.3 to 2.1.0 without rebuilding conversations, Knowledge, or long-term memory. Saved Provider and model settings are upgraded automatically.
- 2.1.0 does not rewrite content already stored in old conversations. If an older conversation already contains repeated answers or failed turns, create a new conversation after upgrading.
- `main.js` in 2.1.0 is about 12.64 MiB, above the 5 MiB per-file limit of Obsidian Sync Standard. Local installation and Community downloads still work, but update the plugin separately on each device or use a sync method that supports larger files.
- Obsidian Desktop 1.11.4 or later is still required. Mobile is not supported.

## 2.0.3 - 2026-08-16

![EchoInk Agent 2.0.3](https://raw.githubusercontent.com/AKin-lvyifang/codex-echoink/2.0.3/assets/releases/echoink-agent-2.0.1-release.png)

### 中文

1. 修复 Obsidian Community 审核标记的标题与静态样式 Error：设置页标题与分组标题改用 Obsidian Setting API 的 `setHeading()`，弹窗预格式化正文的静态样式移入 `styles.css`。
2. 补强本地审核门禁：所有 `obsidianmd/*` 的 error 级问题现在一律硬性失败，不再被 baseline 放行。
3. 修复 OpenAI 和 Anthropic 兼容 Provider 无法发出请求的问题，云端对话恢复可用。
4. 已知限制：`main.js` 约为 5.71 MiB，超过 Obsidian Sync Standard 的 5 MiB 单文件上限；本地安装与社区下载不受影响，但 Standard Sync 无法同步该文件。

### English

1. Fixed the heading and static-style errors flagged by the Obsidian Community review: the settings page and section headings now use the Obsidian Setting API `setHeading()`, and the modal preformatted body styles moved into `styles.css`.
2. Strengthened the local review gate: every `obsidianmd/*` error now fails hard instead of being allowed by the baseline.
3. Fixed OpenAI- and Anthropic-compatible Providers failing before requests were sent, restoring cloud conversations.
4. Known limitation: `main.js` is about 5.71 MiB, above the 5 MiB per-file limit of Obsidian Sync Standard. Local installation and Community downloads still work, but Standard Sync cannot synchronize this file.

## 2.0.2 - 2026-08-16

![EchoInk Agent 2.0.2](https://raw.githubusercontent.com/AKin-lvyifang/codex-echoink/2.0.2/assets/releases/echoink-agent-2.0.1-release.png)

### 中文

1. 大幅减小插件包体（`main.js`），恢复 Obsidian Sync Standard 计划的同步兼容。
2. 移除了 EchoInk 未使用的 Pi CLI、工具下载安装器和自更新相关代码。
3. 修正社区目录 Manifest 描述，去除冗余单词。

### English

1. Significantly reduced the plugin bundle (`main.js`) to restore compatibility with the Obsidian Sync Standard plan.
2. Removed the unused Pi CLI, tool download installer, and self-update code that EchoInk does not use.
3. Fixed the community directory Manifest description by removing a redundant word.

## 2.0.1 - 2026-08-15

![EchoInk Agent 2.0.1](https://raw.githubusercontent.com/AKin-lvyifang/codex-echoink/2.0.1/assets/releases/echoink-agent-2.0.1-release.png)

### 中文

#### EchoInk Agent

1. 插件对外名称正式变更为 `EchoInk Agent`，不再使用 `Codex EchoInk` 作为产品名称。
2. 公开介绍改为个人知识 Agent：帮助整理和维护 Obsidian 知识，沉淀可查看、可修正的长期记忆，并随着使用逐渐理解用户的关注点和正在推进的事情。
3. 插件 ID 和 GitHub 仓库地址保持不变，现有用户可以直接升级，不需要迁移会话、知识或记忆。

#### 更直接的 Provider 接入

1. 普通安装不需要 Codex CLI。在 Provider 设置中填入 OpenAI 或兼容服务的 API URL、API Key 和模型即可开始使用。
2. 会话、知识维护、长期记忆、记忆修正和复盘功能保持不变。

### English

#### EchoInk Agent

1. The public plugin name is now `EchoInk Agent`; `Codex EchoInk` is no longer used as the product name.
2. The public description now presents EchoInk Agent as a personal knowledge agent that organizes and maintains Obsidian knowledge, builds visible and correctable long-term memory, and gradually learns what matters to the user.
3. The plugin ID and GitHub repository remain unchanged, so existing users can upgrade in place without migrating conversations, knowledge, or memory.

#### Direct Provider setup

1. Normal installation does not require Codex CLI. Add the API URL, API key, and model for OpenAI or a compatible service in Provider settings to get started.
2. Conversations, knowledge maintenance, long-term memory, memory correction, and review continue to work as before.

## 2.0.0 - 2026-08-15

![EchoInk 2.0](https://raw.githubusercontent.com/AKin-lvyifang/codex-echoink/2.0.0/assets/releases/echoink-2.0.0-release.png)

### 中文

#### 统一的会话与 Agent

1. 对话主链统一为 Pi-native AgentSession。打开或切换会话时，本地历史恢复与 AgentSession 激活同时进行，可以直接继续聊天。
2. 会话支持新建、重命名、归档、恢复和软删除。已归档会话从聊天弹窗移到 **设置 → EchoInk → 复盘**，原始 Pi Session JSONL 保留。
3. 对话栏、消息操作与输入工具条重新整理；发送按钮尺寸收敛，低价值的 Agent 状态胶囊和知识库健康模块已移除。

#### 可查看、可修正的长期记忆

1. 当前 Memory 按事实、观点、决定、进行中和经历五类展示，每条记录包含标题、内容和召回情境，不暴露内部文件路径或 revision。
2. 修正弹窗同时保留灰色原记忆、输入内容和浅青色修正后预览。生成预览时可以停止，且不会写入原记忆。
3. 只有点击保存才创建新版本。输入变化会立即使旧预览失效；关闭、停止、生成失败、迟到结果和版本冲突都不会覆盖当前记忆。

#### 更直接的知识维护与复盘

1. `/maintain` 不带参数时执行全局维护；通过输入区 `+` 选择一篇 Raw 笔记时只维护该笔记；尾随名称时会模糊搜索相关 Raw 笔记。
2. 已提炼且没有新变化的内容会以无写入结果结束。维护候选与目标版本绑定，生成期间目标发生变化时不会覆盖新内容。
3. 周报生成与输出设置合并在复盘页，可选择 Agent 或知识库、统计周期、Vault 内输出文件夹，以及生成后是否打开 HTML；不再维护“最近报告”列表。

#### Provider 与升级说明

1. Provider 设置现在直接保存 API Key，不再要求额外的 Credential 配置步骤。升级后如果旧配置只有 Credential 引用，需要重新输入一次 API Key。
2. 2.0 不读取或迁移已经退役的 Codex、OpenCode、Hermes 会话，以及旧 Cognitive、Reflection 或 Memory 数据，也不会主动删除这些旧文件。
3. 最低 Obsidian 版本为 1.11.4，仅支持桌面端。升级前建议按自己的 Vault 备份习惯保留快照。

### English

#### One conversation and Agent path

1. Conversations now use one Pi-native AgentSession path. Opening or switching a conversation restores local history while activating its AgentSession, so it is ready to continue.
2. Conversations can be created, renamed, archived, restored, and soft-deleted. Archived conversations moved from the chat dialog to **Settings → EchoInk → Review**, while the original Pi Session JSONL remains intact.
3. The conversation header, message actions, and composer toolbar were rebuilt. The send button is smaller, and low-value Agent status and knowledge-health widgets were removed.

#### Visible, correctable long-term memory

1. Current Memory is grouped into Facts, Views, Decisions, Active, and Episodes. Each record shows its title, content, and recall context without exposing internal paths or revisions.
2. The correction dialog keeps the original memory, correction input, and cyan corrected preview visible together. Preview generation can be stopped and never writes the original record.
3. Only Save creates a new version. Editing the input immediately invalidates an old preview; closing, stopping, failure, late results, and revision conflicts cannot overwrite current Memory.

#### Direct knowledge maintenance and review

1. `/maintain` without arguments runs globally. Selecting one Raw note with the composer's `+` targets that note, while trailing text fuzzy-searches related Raw notes.
2. Already-refined content with no changes settles without another write. Candidates are bound to target revisions, preventing a generated result from overwriting newer content.
3. Report generation and destination settings now share one Review page. Choose Agent or knowledge-base reports, the date range, any vault folder, and whether to open the generated HTML. The recent-report list has been removed.

#### Providers and upgrade notes

1. Provider setup now stores API keys directly and no longer requires a separate Credential step. Existing configurations that contain only a retired Credential reference require the API key to be entered once.
2. EchoInk 2.0 does not read or migrate retired Codex, OpenCode, or Hermes conversations, or retired Cognitive, Reflection, and Memory data. It does not proactively delete those old files.
3. Obsidian 1.11.4 or later is required, and EchoInk remains desktop-only. Keep a vault snapshot before upgrading, following your normal backup practice.

## v1.4.0 - 2026-07-23

版本号：`v1.4.0`

### 中文

#### 可靠对话与自动迁移

1. Conversation V2 成为普通对话和知识库对话的本地历史真源，插件重载、上下文切换或更换 Agent 后仍可恢复连续对话。
2. 旧会话会自动迁移并保留消息、工作区边界和后端连接信息；新建空白对话也可以正常保存和继续。
3. 对话线程、单轮执行和 Agent 原生会话使用明确身份，避免恢复时把不同运行记录误判为同一个会话。

#### 更安全的知识维护

1. `/maintain` 默认使用启动时选中的 Agent；只有失败尝试已安全隔离且没有可提交成果时，才尝试备用 Agent。
2. 维护成果先在隔离环境中验证，再通过可恢复提交写入 Vault；超时、重载或部分失败不会重复提交同一成果。
3. 大文件、无变化来源和恢复中的任务会得到准确状态，不再被误标为已提炼或普通失败。
4. 修复维护报告在界面保留执行详情后，被误判为“实时对话与持久记录不一致”的问题；执行详情仍可查看，但不会再阻断下一轮正常对话。
5. 后台定时维护不再向交互对话追加消息；只有明确可重试的失败才会再次运行，并限制为当天最多 3 次，间隔 5 分钟和 15 分钟。
6. EchoInk 启动的 Codex 进程会关闭全局 Hook 和全局 Memory 注入，避免维护 Shadow 被外部记忆系统改写；插件自带的 `.echoink/memory` 保持不变。
7. 修复 Obsidian 自动更新 `updated` 元数据恰好发生在事务安装窗口时，合法硬链接被误判为外部篡改、导致维护恢复受阻的问题；真正的额外硬链接仍会被严格拦截。

#### 记录治理与界面改进

1. 对话历史、工作流运行、业务成果和 Agent 原生会话使用独立的保留、恢复与清理规则。
2. 新增紧凑会话选择器，支持搜索、键盘导航和批量管理，并保护知识库频道与运行中会话。
3. 修复知识库报告无法稳定展开/收起的问题，报告中的 Vault 笔记现在可以直接点击打开。

升级说明：从 `v1.3.0` 直接覆盖安装 `main.js`、`manifest.json`、`styles.css` 即可。现有 Vault 笔记和 EchoInk 会话会自动升级，不需要手动迁移或重置会话。

### English

#### Durable conversations and automatic migration

1. Conversation V2 now provides the local history of record for Chat and Knowledge conversations, preserving continuity across plugin reloads, context changes, and Agent switches.
2. Existing sessions migrate automatically while preserving messages, workspace boundaries, and backend bindings. New blank chats can also be saved and continued normally.
3. Conversation threads, individual turns, and native Agent sessions now use distinct identities so recovery does not confuse separate execution records.

#### Safer Knowledge maintenance

1. `/maintain` starts with the selected Agent and tries a fallback only when the failed attempt is safely isolated and contains no committable result.
2. Maintenance output is validated in isolation before a recoverable commit reaches the Vault. Timeouts, reloads, and partial failures do not commit the same result twice.
3. Oversized sources, unchanged inputs, and recovering tasks now receive accurate states instead of being marked as processed or reduced to generic failures.
4. Fixed maintenance execution details being mistaken for a divergence between the live conversation and its durable record. Diagnostics remain visible without blocking the next turn.
5. Scheduled maintenance no longer appends background messages to the interactive conversation. Only explicitly retryable failures run again, with at most three daily attempts after 5- and 15-minute delays.
6. Codex processes launched by EchoInk disable global hooks and global memory injection so maintenance Shadows cannot be rewritten by an external memory layer. EchoInk's own `.echoink/memory` remains unchanged.
7. Fixed recovery being blocked when Obsidian updated `updated` metadata during the transactional install window and the expected hardlink was mistaken for external tampering. A genuine additional hardlink remains strictly blocked.

#### Record governance and interface improvements

1. Conversation history, workflow runs, business artifacts, and native Agent sessions now follow separate retention, recovery, and cleanup rules.
2. A compact session picker adds search, keyboard navigation, and batch management while protecting the Knowledge channel and running sessions.
3. Knowledge reports now expand and collapse reliably, and referenced Vault notes open directly from the report.

Upgrade: replace `main.js`, `manifest.json`, and `styles.css` from `v1.4.0`. Existing Vault notes and EchoInk conversations upgrade automatically; no manual migration or session reset is required.

## v1.3.0 - 2026-07-17

版本号：`v1.3.0`

### 中文

#### 多 Agent 运行时

1. 新增 Codex、OpenCode、Hermes 统一安装与连接面板，集中处理安装、修复、重新检测和运行状态。
2. 三个后端统一展示公开推理、工具调用、处理时长和最终回答；切换后端不再改变对话结构。
3. 加强 OpenCode 会话恢复、Hermes 工具终态和中断处理，避免断流后重复执行任务。

#### Memory V2 与知识规则

1. 新增 EchoInk Memory V2，在本地保存跨会话、跨后端可复用的信息，同时保留各 Agent 原生记忆。
2. 知识库任务每轮都会重新读取并校验指定的 Markdown 规则文件，异常时在 Agent 启动前停止。
3. 知识规则不再依赖或合并 `AGENTS.md`，默认继续使用 `LLM-WIKI.md`。

#### 提示词增强

1. 提示词增强拥有独立 Agent 后端与模型设置，不改动普通聊天主模型。
2. 增强模型改为下拉列表，并支持通过“新增模型”加入自定义模型 ID。
3. Codex 默认使用 `gpt-5.6-terra`、中等思考和快速响应；OpenCode 与 Hermes 只显示实际支持的选项。

#### 修复

1. 修复中断 Memory 事务可能留下不完整状态的问题。
2. 修复提示词增强切换后端后残留不兼容模型、Agent 或 Profile 的问题。
3. 修复部分后端仍显示不支持的思考强度或快速档位控件的问题。

升级说明：从 `v1.2.2` 直接覆盖安装 `main.js`、`manifest.json`、`styles.css` 即可。现有 Vault 文件和 EchoInk 会话无需迁移。

### English

#### Multi-Agent runtime

1. Added a unified setup and connection dashboard for Codex, OpenCode, and Hermes, covering installation, repair, rechecks, and runtime status.
2. All three backends now share one presentation for public reasoning, tool calls, processing time, and final answers.
3. Hardened OpenCode session recovery, Hermes tool terminal states, and interrupted runs to prevent duplicate execution after a dropped stream.

#### Memory V2 and Knowledge rules

1. Added EchoInk Memory V2 for locally curated recall across sessions and backends while preserving native Agent memory.
2. Every Knowledge run now reloads and validates its configured Markdown rules file before the Agent starts.
3. Knowledge rules no longer depend on or merge `AGENTS.md`; `LLM-WIKI.md` remains the default.

#### Prompt enhancement

1. Prompt enhancement now has its own Agent backend and model settings without changing the main chat model.
2. Enhancer models now use a selectable list with an **Add model** action for custom model IDs.
3. Codex defaults to `gpt-5.6-terra`, medium reasoning, and fast responses. OpenCode and Hermes show only supported controls.

#### Fixes

1. Fixed interrupted Memory transactions leaving incomplete state.
2. Fixed incompatible model, Agent, or Profile selections carrying across prompt-enhancer backends.
3. Fixed unsupported reasoning or fast-response controls appearing for some backends.

Upgrade: replace `main.js`, `manifest.json`, and `styles.css` from `v1.3.0`. Existing Vault files and EchoInk sessions do not require migration.

## v1.2.2 - 2026-07-16

版本号：`v1.2.2`

### 中文

#### 审核兼容修复

1. 修复 Agent 参数菜单使用直接样式赋值导致 Obsidian 自动审核失败的问题。
2. 保持菜单的定位、显隐和交互行为不变，并扩大源码防回归检查范围，覆盖全部 Agent 侧栏模块。

升级说明：从 `v1.2.1` 直接覆盖安装 `main.js`、`manifest.json`、`styles.css` 即可，不需要迁移 Vault 文件或重建会话。

### English

#### Review compatibility fix

1. Fixed the direct style assignments in Agent parameter menus that caused Obsidian's automated source review to fail.
2. Preserved menu positioning, visibility, and interaction behavior while extending regression coverage across all Agent sidebar modules.

Upgrade: replace `main.js`, `manifest.json`, and `styles.css` from `v1.2.2`. No Vault migration or session reset is required.

## v1.2.1 - 2026-07-15

版本号：`v1.2.1`

### 中文

#### 知识库命令菜单优化

1. 重新设计知识库频道输入 `/` 后的命令菜单：移除厚重卡片和粉色文字，默认使用透明列表、黑色命令名与灰色说明，仅当前项显示浅灰选中背景。
2. 支持 `↑` / `↓` 循环选择命令，并在长列表中自动滚动到当前项。
3. `Enter` 将当前命令填入输入框但不自动发送，`Esc` 关闭菜单，避免误触发知识库任务。

升级说明：从 `v1.2.0` 直接覆盖安装 `main.js`、`manifest.json`、`styles.css` 即可，不需要迁移 Vault 文件或重建会话。

### English

#### Knowledge command menu polish

1. Redesigned the `/` command menu in the Knowledge channel with a transparent list, neutral text and icons, concise descriptions, and a light-gray background only for the active item.
2. Added wraparound `ArrowUp` / `ArrowDown` navigation with automatic scrolling for long command lists.
3. `Enter` now fills the selected command without sending it, while `Escape` closes the menu to prevent accidental Knowledge runs.

Upgrade: replace `main.js`, `manifest.json`, and `styles.css` from `v1.2.1`. No Vault migration or session reset is required.

## v1.2.0 - 2026-07-15

版本号：`v1.2.0`

### 中文

#### 后端大改版：统一 Agent Harness

1. 普通对话、知识库、编辑区写作和提示词增强统一进入 EchoInk Harness，不再由各功能分别拼接 Agent 后端。
2. Codex、OpenCode、Hermes 通过统一 Adapter 接入，共用运行状态、事件、上下文、原生会话租约和停止/超时口径。
3. 切换 Agent 后，下一轮立即使用新后端，不清空当前 EchoInk 会话；能力设置中明确固定的后端仍保持优先。
4. 后端差异由 Adapter 吸收，EchoInk 负责统一对话过程和最终结果展示，后续增加新的 Agent 后端不需要重写整套侧栏。

#### UI 完全重构

1. 对话区默认突出最终回答；思考、命令、文件编辑和工具过程收进可展开的处理时间线，并保留本轮 token 和上下文占用。
2. 输入区将工作区放到左上角，Plan 模式显示“计划”标记；收藏、Skill、提示词增强、权限、模型、推理和速度改为轻量、响应式控件。
3. 顶部“活跃”状态改为 Codex / OpenCode / Hermes 切换器；MCP 和设置按钮改为透明图标样式。
4. 模型、推理和速度菜单会根据侧栏空间自动调整位置，避免浮层越界或被遮挡。

#### 新增小功能

1. 新增独立提示词增强：可单独选择 Agent 后端、Provider、API 路径和模型，内置 WorkBuddy Meta-Prompt，并支持一键“还原”原输入。
2. 改写、扩写、续写和提示词增强作为独立轻量任务调用模型，不再改动主 Agent 聊天模型；未指定时优先使用对应后端的快速模型。
3. 公众号和公开网页合并为一个“收藏”入口，插件根据链接自动选择采集路径。

#### 修复

1. 修复消息区上滑后被新内容强制吸回底部的问题。
2. 修复知识库任务状态、报告卡片和滚动抖动，并统一失败、中断、取消和超时显示。
3. 修复部分升级路径仍显示旧输入区、缺少独立提示词增强设置或继续使用旧提示词模板的问题。
4. 修复窄侧栏下工作区名称、Plan 标记和参数菜单的溢出问题。

升级说明：从 `v1.1.0` 直接覆盖安装 `main.js`、`manifest.json`、`styles.css` 即可，不需要迁移 Vault 文件或重建会话。

### English

#### Backend redesign: one Agent Harness

1. Chat, Knowledge, editor writing, and prompt enhancement now enter the EchoInk Harness instead of assembling backend-specific flows independently.
2. Codex, OpenCode, and Hermes connect through shared adapters and use the same run states, events, context rules, native-session leases, stop behavior, and timeout semantics.
3. Switching the main Agent applies to the next turn without clearing the current EchoInk session. Explicit per-capability backend overrides still take priority.
4. Backend differences are absorbed by adapters while EchoInk owns the conversation projection, making future Agent backends easier to add without rebuilding the sidebar.

#### Complete UI rebuild

1. Final answers stay prominent while reasoning, commands, file edits, and tool activity live in an expandable processing timeline with per-turn tokens and context usage.
2. The composer moves workspace selection to the upper-left and shows a Plan marker when needed. Bookmark, Skill, prompt enhancement, permissions, model, reasoning, and speed controls now use lightweight responsive controls.
3. The old active-state pill is now a Codex / OpenCode / Hermes switcher. MCP and Settings use transparent icon buttons.
4. Model, reasoning, and speed menus reposition themselves within narrow sidebars so popovers stay visible.

#### Smaller additions

1. Prompt enhancement is now an independent capability with its own Agent backend, provider, API path, and model. It uses the built-in WorkBuddy Meta-Prompt and includes a concise Restore action.
2. Rewrite, expand, continue, and prompt enhancement run as lightweight utility tasks without changing the main chat model. Automatic routing favors the fast model for each backend.
3. WeChat articles and public web pages now share one Bookmark entry that routes each URL automatically.

#### Fixes

1. Fixed message lists snapping back to the bottom after the user scrolls upward.
2. Stabilized Knowledge task states, report cards, and scrolling, with consistent failed, interrupted, canceled, and timed-out states.
3. Fixed upgrade paths that could still show the old composer, omit the independent prompt-enhancer settings, or keep an outdated prompt template.
4. Fixed workspace-name, Plan-marker, and parameter-menu overflow in narrow sidebars.

Upgrade: replace `main.js`, `manifest.json`, and `styles.css` from `v1.2.0`. No Vault migration or session reset is required.

## v1.1.0 - 2026-07-10

版本号：`v1.1.0`

Agent 工具和知识提炼更新：

1. 新增工具代理基础层：vault 资源、MCP 工具、Skills 和工具包有更清楚的开关和作用范围。
2. Agent 过程时间线更清楚：搜索、文件处理、工具调用和完成状态更容易看懂。
3. 知识库提炼流程更严格：先读懂 Raw，再拆出知识，写入 Wiki / Projects，最后确认来源证据后才标记 Raw。
4. 新增 Hermes 后端的第一阶段入口；Hermes 的模型和 provider 仍由 Hermes 自己配置。
5. 将大型 Agent 侧栏拆成更小的界面模块，后续维护和审核更稳。

使用说明：

1. 安装 `v1.1.0` 后，在 Obsidian 中打开 EchoInk，选择你正在使用的 Agent 后端。
2. 在知识库频道使用 `/check`、`/maintain` 或 `/reingest` 检查和提炼 Raw 笔记。
3. 到设置里检查聊天、知识库、写作三个场景的资源开关。

## v1.0.3 - 2026-07-02

版本号：`v1.0.3`

审核样式修复版：

1. 将 Codex 侧栏里的直接样式赋值改为 Obsidian 推荐的 `setCssStyles` / `setCssProps`。
2. 保持知识库健康分 tooltip、年度热力图、虚拟消息列表和上下文用量环的显示逻辑不变。
3. 增加源码扫描测试，避免后续再次引入不符合官方审核规则的直接样式赋值。

使用说明：

1. 安装 `v1.0.3` 后正常使用 EchoInk 首页和 Codex 侧栏即可。
2. 这是审核兼容修复版，没有新增大功能，也没有更换头图。

## v1.0.2 - 2026-07-02

版本号：`v1.0.2`

审核兼容修复版：

1. 调整 Obsidian 视图注册方式，避免在插件实例上缓存 view，降低视图生命周期误用风险。
2. 卸载插件时不再强制关闭 EchoInk 相关面板，避免重载插件后打乱用户工作区布局。
3. 移除对较新 Obsidian API 的依赖，继续兼容声明的 `minAppVersion`。

使用说明：

1. 安装 `v1.0.2` 后正常打开 EchoInk 首页、Codex 侧栏或复盘预览即可。
2. 如果之前看到社区审核失败提示，请等待 Obsidian 后台重新检查最新 Release。

## v1.0.1 - 2026-07-01

版本号：`v1.0.1`

小功能修复版：

1. 首页日历支持切换上个月、下个月，并可一键回到本月，避免日历按钮只是静态展示。
2. 知识库维护会预检 Wiki 里的数字后缀冲突副本，例如 `标题 2.md`、`标题 3.md`，并转移到 `outputs/maintenance/conflict-duplicates-*`，避免同一知识页继续分叉。
3. 知识库维护提示词明确禁止用数字后缀绕开同名 Wiki；同标题页面已存在时，必须更新正式页或在报告里说明冲突。
4. Dashboard、Raw discovery 和 `/ask` 增加文件读取预算，大 PDF、图片和超大 Markdown 不再被完整读入，降低 Obsidian 卡顿和内存暴涨风险。
5. 超出读取预算的 Raw 会被列为未纳入本轮来源，不写 tracker、不标记 processed，避免把未处理资料误判为已消化。

使用说明：

1. 安装 `v1.0.1` 后，如果 Wiki 里已有数字后缀冲突副本，运行 `/maintain` 会先做预检转移。
2. 转移记录会写入本轮维护报告，备份目录位于 `outputs/maintenance/conflict-duplicates-*`。
3. 大文件 Raw 如未纳入本轮，可按报告提示拆分或下次单独处理。

## v1.0.0 - 2026-06-29

版本号：`v1.0.0`

知识库首页工作台更新：

1. 新增 EchoInk 首页：可在设置里开启默认打开，标签页可关闭，并可通过 Obsidian 命令重新打开。
2. Ribbon 图标会同时打开 EchoInk 对话侧栏和首页，减少在知识库管理和对话之间来回切换。
3. 首页展示知识库状态：Wiki 状态、Raw 待提炼、年度体检热力图、日历、健康分数和关键统计。
4. 新增知识卡片流：默认优先显示最近 Wiki 更新；如果没有 Wiki 更新，会自动切到猜你想看。
5. 卡片流支持按标签、更新时间、相关度和一级文件夹筛选，窗口变小时会自动减少列数和展示密度。
6. 卡片更多菜单支持复制 Obsidian 内链、相对路径和 Markdown 链接。

使用说明：

1. 打开 Obsidian 后，首页可作为知识库工作台查看整体状态。
2. 在首页上方切换筛选和排序，快速定位最近更新、待提炼或指定文件夹里的笔记。
3. 点击卡片更多菜单，复制内链、相对路径或 Markdown 链接。

## v0.8.0 - 2026-06-04

版本号：`v0.8.0`

知识库安全与历史治理更新：

1. Raw 原始资料保护升级：知识库维护、体检和校准会更严格保护 Raw 正文、路径、权限和来源证据，避免任务失败时留下半提交状态。
2. 知识库历史改为插件本地历史优先：旧记录可继续通过 `/history` 按天查看和恢复到页面，不依赖 Codex Desktop 已归档会话。
3. 知识库命令和自动维护产生的后台 Codex 会话会在任务结束后归档，减少对 Codex Desktop 侧边栏 recent / active 会话池的污染。
4. `/check`、`/maintain`、`/calibrate raw` 的取消、超时、重试、报告恢复和状态保存更稳定，失败原因更容易在面板和历史里看懂。
5. 知识库 dashboard 的 Raw 统计改为素材源口径，不再把 `.assets/` 图片附件算成 Raw 笔记。

使用说明：

1. 用 `/check` 做只读体检，确认 Raw/Wiki/Inbox 和健康状态。
2. 用 `/maintain` 处理待提炼 Raw；如果本轮还有剩余 Raw，会留到下一次维护。
3. 用 `/history` 查看本地历史；删除 Codex 已归档会话不会删除插件历史。

## v0.7.2 - 2026-05-27

版本号：`v0.7.2`

任务队列和输入菜单稳定性补丁：

1. 点击输入区里非 Skill 菜单、非知识库命令菜单的位置时，会收起输入菜单。
2. 点击 Skill 菜单或知识库命令菜单本身时，不会误关闭菜单。
3. 补充输入菜单收起逻辑的单元测试，降低后续队列入口交互回归风险。

## v0.7.1 - 2026-05-26

版本号：`v0.7.1`

任务队列稳定性补丁：

1. 队列成功、失败和手动停止后的结算更明确：成功才继续下一条，失败或停止会暂停并保留剩余任务。
2. 普通任务、知识库任务或队列启动中时，不会并发启动下一条排队任务。
3. 队列拖拽事件不会冒泡到输入区附件拖放逻辑，降低误触发风险。

## v0.7.0 - 2026-05-26

版本号：`v0.7.0`

新增侧栏任务队列：

1. 普通会话和知识库频道的输入型任务都可以排队，每个会话独立排队。
2. 当前任务运行中，如果输入框有内容，主按钮会变成 `入队发送`，新任务会等当前任务结束后再执行。
3. 当前任务运行中，如果输入框为空，主按钮仍然是停止当前任务。
4. 队列项会锁定入队时的文本、附件、Skill、模型、权限、模式和工作区，后续切换设置不会改掉已排队任务。
5. 任务成功后自动执行下一条；失败或手动停止后队列暂停，保留未执行任务，用户可以手动继续。

优化知识库频道串行：

1. `/ask`、`/maintain`、`/journal` 等输入型知识库任务会按队列逐条执行，避免并发污染知识库上下文。
2. `/clear`、`/history` 这类本地界面命令不会排队；运行中会提示任务结束后再操作。
3. 队列只保存在本次插件运行内，Obsidian 或插件重启后自动清空。

使用说明：

1. 当前任务还在运行时，继续在输入框写下一条任务，点击 `入队发送`。
2. 在输入框上方查看队列，可以删除未执行任务，也可以拖动调整顺序。
3. 如果停止了当前任务，点击 `继续队列` 恢复后续任务。

## v0.6.0 - 2026-05-21

版本号：`v0.6.0`

新增首次启动向导：

1. 设置页顶部会先检测 Codex CLI、Codex 登录态、OpenCode CLI、OpenCode server、OpenCode 模型和 Agent。
2. 缺少必要环境时，隐藏普通状态摘要，改为显示缺失项、安装命令、复制命令和官方文档入口。
3. 用户安装或登录后，可以点击 `重新检测`，插件会重新探测 CLI、刷新 Codex 登录态，并在需要时连接或启动 OpenCode。
4. 全部通过后显示 `Start`；点击后只写入 setup 状态并打开 EchoInk 侧栏，不自动发送消息，不自动跑知识库任务。
5. V1 不做静默安装，避免插件擅自改用户机器环境。

优化知识库历史：

1. 知识库频道只保留最近有记录的一天，旧日期消息按天归档到插件 `history/` 目录。
2. `/history` 改为按天查看知识库历史，可筛选用户、回复、过程和失败记录。
3. 设置页新增历史存储统计、重建索引、导出历史和压缩旧过程记录。

优化知识库维护：

1. `/maintain` 收敛为 `Ingest + Structure Normalize + Lint`，维护后会整理 wiki、outputs、inbox、projects 结构并输出报告。
2. 知识库维护不再直接给 Agent 整个 `raw/` 写权限；raw 整文件完整性由插件做确定性校验。
3. raw 路径归一只写入报告风险，维护任务不自动移动或重命名 raw 文件、来源目录和附件目录。
4. 维护报告、dashboard、历史入口和过程渲染补齐了更多可见状态，排查失败更直接。

修复：

1. Codex CLI 和 OpenCode CLI 自动探测补充 Windows 常见安装路径。
2. 知识库历史入口位置和按天恢复逻辑修复，避免当天新输入覆盖最近历史日。
3. 知识库回复里的本地路径渲染更稳定，能直接打开对应 Vault 文件。

使用说明：

1. 新用户安装后，先打开插件设置，按顶部向导补齐环境。
2. 已安装用户可以直接点 `重新检测` 刷新状态；环境通过后点 `Start` 进入侧栏。
3. 知识库维护继续使用 `/maintain`，只读问答继续显式使用 `/ask`。

## v0.5.2 - 2026-05-19

版本号：`v0.5.2`

新增复盘周报：

1. 设置页新增 `复盘`，可分别启用知识库周报和 Agent 对话周报。
2. 默认每周日 21:00 自动生成，错过后下次打开 Obsidian 补跑。
3. 周报写入 `outputs/obsidian-weekly-review/`，同时生成 Markdown 和同名 HTML。
4. HTML 固定复用 `Codex 使用效率周复盘` 看板模板，只替换数据。
5. EchoInk 内置 HTML 预览，不依赖 Obsidian 官方 Web viewer 打开本地 HTML。

优化知识库日记：

1. `/journal` 按当前 `journal/` 体系写入 daily 月份目录，例如 `journal/daily/YYYY-MM/YYYY-MM-DD-周X.md`。
2. 新 vault 首次写日记时自动创建 `journal/daily`、weekly、monthly、quarterly、yearly 目录。
3. 写日记默认走 Codex 工作日记提示词，参考最近日记格式，只增量更新目标日记。
4. 当天记录窗口固定为目标日 `00:00` 到次日 `06:00` 前；Codex CLI 后端读取 Codex sessions，OpenCode API 后端读取 OpenCode 聊天记录。

优化知识库频道过程展示：

1. Codex CLI 知识库任务会复用普通 Agent 对话栏的过程卡片，展示思考、命令、文件改动、工具调用和最终结果。
2. 知识库任务的最终结果会移动到本轮过程之后，方便先看执行链路，再看产物路径和结论。

优化知识库问答引用：

1. `/ask` 的本地检索范围从 `wiki/` 扩展到 `wiki/`、`journal/` 和 `outputs/`。
2. 问答上下文会带上来源集合、标题、引用片段、证据强度和命中原因。
3. 回答规则明确区分 Wiki 稳定依据与 Journal / Outputs 背景依据，降低把过程记录误当结论的概率。

优化设置页：

1. 设置页新增中文 / English 显示语言切换，只影响设置页文案，不改 Prompt 和用户内容。
2. 连接状态、Provider、OpenCode、知识库和复盘设置文案统一收敛，便于排查配置问题。

修复 Codex 连接诊断：

1. 默认模型改为 `自动`，旧的 `gpt-5.5` 默认设置会迁移为自动。
2. Windows WebSocket、代理拒绝、CLI 缺失、超时和 app-server 退出会显示具体原因、当前上下文、建议处理和原始错误。
3. README 增加 Windows `responses_websocket` / `os error 10061` 排障说明。

同版本补充修复：

1. 知识库频道里的普通输入默认改回普通 Agent 对话；只有显式 `/ask`、`/query`、`/问`、`/查询` 才进入知识库只读问答。
2. 知识库频道里的普通 Agent 对话运行中，主按钮会停止当前对话，不再误触发知识库任务取消。
3. 知识库频道输入框文案改为区分普通对话、`/ask` 查询和 `/check` / `/maintain` 管理命令。
4. 知识库任务失败时保留更完整的 app-server、JSON-RPC、OpenCode 和 turn 错误信息，便于定位断流、超时和后端失败。
5. 知识库回复里的本地笔记路径和报告路径会渲染成可点击链接，方便直接打开对应 Vault 文件。
6. 知识库规则里的 raw 权限边界改为只约束知识库管理任务；普通 Agent 对话中，如果用户明确要求整理 raw 文件，可以按当前权限移动、删除、合并或重命名。
7. 知识库规则里的 Query 边界同步改为只在 `/ask` 或明确要求查询本地依据时生效，避免普通对话被规则文件误导成知识库问答。

## v0.5.1 - 2026-05-17

版本号：`v0.5.1`

社区审核修复版：修正自动检查指出的 manifest 描述问题。

更新内容：

1. `manifest.json` 描述移除冗余的 `Obsidian` 字样，满足社区自动检查要求。
2. `manifest.json` 移除新社区 schema 不再接受的 `main` 字段；Release 仍保留 `main.js` 资产。
3. 保持 `main.js`、`manifest.json`、`styles.css` 和 zip 资产完整发布。

使用说明：

1. 在最新 Release 下载 `codex-echoink-0.5.1.zip`，或等待 Obsidian 社区审核通过后从社区插件安装。
2. 手动安装路径仍为 `<vault>/.obsidian/plugins/codex-echoink/`。

## v0.5.0 - 2026-05-17

版本号：`v0.5.0`

社区上架准备版：插件正式更名为 `Codex EchoInk`，社区插件 id 改为 `codex-echoink`。

更新内容：

1. 插件名称从 `Codex for Obsidian` 改为 `Codex EchoInk`。
2. 插件 id 从 `obsidian-codex` 改为 `codex-echoink`，避开 Obsidian 官方命名限制。
3. README、README_CN、安装路径、Release 链接和打包产物统一切换到 `codex-echoink`。
4. 兼容旧手动安装版放在 `.obsidian/plugins/obsidian-codex/raw` 下的大型原文缓存。
5. 新增隐私与权限说明，明确 Codex CLI、OpenCode、模型服务、自定义 API key 和知识库写入边界。
6. Release 资产准备为社区下载格式：`main.js`、`manifest.json`、`styles.css` 和 `codex-echoink-0.5.0.zip`。

使用说明：

1. 在最新 Release 下载 `codex-echoink-0.5.0.zip`，或等待 Obsidian 社区审核通过后从社区插件安装。
2. 手动安装路径为 `<vault>/.obsidian/plugins/codex-echoink/`。
3. 如果从旧手动安装版迁移，保留旧 `.obsidian/plugins/obsidian-codex/` 目录可让大型原文缓存继续兜底读取。

## v0.4.1 - 2026-05-17

版本号：`v0.4.1`

新功能：知识库频道增强，让提问、体检可视化和能力开关更好用。

更新内容：

1. 新增 `/ask` 只读问答：先检索 `wiki/` 里的相关笔记，再回答问题，并区分 Vault 依据和补充信息。
2. 当时支持自然问题自动进入问答流程；`0.5.2` 已改为只有显式 `/ask` 才进入知识库问答。
3. LLM Wiki 初始化向导改为默认生成 `LLM-WIKI.md`；`AGENTS.md` 只保留 Codex/OpenCode 运行层背景。
4. `/init` 只生成预览，`/init confirm` 才创建目录和规则文件；初始化不删除、不覆盖、不移动已有笔记。
5. 知识库频道顶部状态面板升级为健康仪表盘：默认展示规则文件、Raw/Wiki/Inbox 数量和健康状态；展开后展示健康分、目录表、Raw/Inbox 表和年度体检热力图。
6. 体检热力图升级为 GitHub 风格年度视图，展示月份、星期、成功和失败状态。
7. 健康分改为读取真实 `outputs/.ingest-tracker.md` 和最新维护报告；外部 Agent 已完成的体检/消化也会被识别。
8. 设置页新增知识库指南“检查并修复”，可在规则文件缺失时创建默认 `LLM-WIKI.md`，或补齐用户指定 Markdown 的最小运行规则。
9. 知识库健康和体检新鲜度拆成两条进度；体检新鲜度会随未体检天数下降，但不拉低知识库健康分。
10. Codex CLI 模式下，知识库频道底部可以直接选择模型和思考强度，知识库任务不再固定使用同一个强度。
11. 普通会话新增工作区选择器；未选择文件夹前不能发送，附加笔记只作为上下文，不再默认把当前 Vault 当工作区。
12. 当前 vault 的能力管理页新增搜索栏，`插件`、`MCP`、`Skills` 三个标签都可以搜索名称、id/路径、元信息和描述。
13. 修复 Skills 等长文本把列表撑太宽的问题：写不下时用省略号，右侧勾选框保持可见可点。
14. 设置页新增 `codex-memory-lite` 可选推荐；插件不打包记忆 Skills，也不会自动修改用户的 `AGENTS.md`。

使用说明：

1. 打开 Codex 侧栏里的 `知识库` 频道。
2. 新 vault 先输入 `/init` 预览初始化方案，确认无误后输入 `/init confirm`。
3. 已有结构的 vault 先用 `/check` 体检，再按需要用 `/ask` 提问、`/maintain` 维护，或用 `/outputs` 整理长期价值内容。
4. 使用 Codex CLI 模式时，在知识库输入框右下角选择模型和思考强度。
5. 展开知识库健康仪表盘，查看年度体检热力图和风险原因。
6. 进入插件设置的当前 vault 能力管理，在 `插件`、`MCP` 或 `Skills` 标签下搜索后再勾选。

## v0.4.0 - 2026-05-15

版本号：`v0.4.0`

新功能：知识库自动化运维，用来在 Obsidian 里维护当前 vault。

更新内容：

1. 新增绑定当前 vault 的常驻知识库频道。
2. 新增命令模板：`/check`、`/maintain`、`/outputs`、`/journal`、`/inbox`。
3. 新增公众号、网页和文件收藏入口，把资料先收进 Raw Sources。
4. 新增知识库操作指南文件设置，默认读取 `LLM-WIKI.md`，也可以改成自定义 Markdown 文件。
5. 新增 OpenCode 模型选择和 OpenCode Agent 选择。
6. 新增编辑区选中文字翻译成英文。
7. 优化知识库设置页对齐、运行状态说明和规则文件选择。
8. 保留安全边界：不自动改写、删除或归档已有 Raw 正文。

使用说明：

1. 打开 Codex 侧栏里的 `知识库` 频道。
2. 在设置页选择知识库后端：`Codex CLI` 或 `OpenCode API`。
3. 如果使用 OpenCode 模式，先在本机安装 OpenCode，再刷新并选择模型和 Agent。
4. 在知识库频道输入 `/check 断链检查`、`/maintain 处理新增 raw`、`/outputs 整理本周输出`。
5. 用快捷入口收藏公众号、网页或文件资料。

## v0.3.0 - 2026-05-10

版本号：`v0.3.0`

新功能：写作上下文 Harness，用于编辑区改写、扩写和续写。

更新内容：

1. 新增 `快速`、`质量`、`严格` 三档写作质量模式。
2. 新增侧栏可见的写作上下文面板，展示当前文件、模型、理解状态和结构化文章理解。
3. 新增结构化文章理解：主题、受众、写作目的、文章结构、关键事实、风格特征、禁止编造、局部写作建议。
4. 新增文章理解软复用：小幅连续改写、扩写、续写会复用已有理解，不再每次重新理解全文。
5. 新增严格模式审校：候选生成后再检查事实、风格、衔接、重复和 Markdown。
6. 保留灰色候选闭环：`Enter` 确认，`Esc` 取消。
7. 文章理解不会进入普通聊天记录。

使用说明：

1. 在插件设置里开启写作操作。
2. 选择默认写作质量：`快速`、`质量` 或 `严格`。
3. 在编辑区选中文字，运行 `改写`、`扩写` 或 `续写`。
4. 点击侧栏顶部 `写作` 状态，查看或刷新文章理解。
5. 按 `Enter` 接受灰色候选，或按 `Esc` 取消。

## v0.2.0 - 2026-05-08

版本号：`v0.2.0`

Bug 修复：修复 Codex 账号重新登录后，插件因为找不到 Codex Desktop 内置 CLI 而报 `spawn codex ENOENT` 的问题；设置页新增“刷新登录状态”按钮。

实验功能：编辑区选中文字后可执行改写、扩写、续写，并在原地显示候选。该功能仍处于实验阶段，默认关闭，不成熟，不建议日常稳定使用。

测试方法：

1. 在插件设置里开启写作操作。
2. 在编辑区选中文字，右键选择 `改写`、`扩写` 或 `续写`。
3. 按 `Enter` 接受灰色候选，或按 `Esc` 取消。
4. 先在非关键笔记里测试。

## v0.1.2 - 2026-04-30

版本号：`v0.1.2`

新功能：公开发布内容保护，GitHub 仓库只保留安装和使用必要内容。

使用说明：

1. 下载最新 Release 安装包。
2. 安装 `codex-echoink` 插件文件夹。
3. 直接使用插件，不需要阅读内部项目文档。

## v0.1.1 - 2026-04-29

版本号：`v0.1.1`

新功能：在 Codex 输入框里直接粘贴微信截图或系统截图。

使用说明：

1. 截图。
2. 点击 Codex 输入框。
3. 按 `Command+V`，然后发送。

## v0.1.0 - 2026-04-27

- 首个公开版本。
- 支持在 Obsidian 侧栏中使用 Codex 管理当前 vault。
