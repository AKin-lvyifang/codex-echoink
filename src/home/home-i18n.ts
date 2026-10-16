import type { SettingsLanguage } from "../settings/settings";
import type { HomeEntryId } from "./home-workbench-model";

export type HomeBuiltInTemplateId = "quick" | "morning" | "evening" | "blank";

export interface HomeCopy {
  readonly viewTitle: string;
  readonly knowledgeServiceUnavailable: string;
  readonly localKnowledgeLoadFailed: (error: string) => string;
  readonly maintenanceSnapshotUnavailable: (error: string) => string;
  readonly conversationHeading: string;
  readonly conversationNote: string;
  readonly entriesHeading: string;
  readonly entriesNote: string;
  readonly workbenchTitle: string;
  readonly refreshLocalData: string;
  readonly pluginSettings: string;
  readonly currentKnowledgeBase: string;
  readonly loadingLocalKnowledge: string;
  readonly localMode: string;
  readonly healthStatus: (status: string) => string;
  readonly entry: Readonly<{
    label: (id: HomeEntryId) => string;
    description: (id: HomeEntryId) => string;
    action: (id: HomeEntryId) => string;
    ariaLabel: (id: HomeEntryId) => string;
    wikiKnowledgeCount: (count: number) => string;
    wikiUpdatedToday: (count: number) => string;
    noLocalOutputs: string;
    updatedRecently: (time: string) => string;
    outputsAfterMaintenance: string;
    noProjectNotes: string;
    continueFromRecentProject: string;
    createProjectInProjects: string;
    recentInput: (title: string) => string;
    pendingOrganization: string;
    noPendingInputs: string;
    journalCreated: string;
    journalDefaultTemplate: string;
    journalContinueWithoutOverwrite: string;
    journalTemplateOption: string;
    waitingForMaintenanceSnapshot: string;
  }>;
  readonly heatmap: Readonly<{
    heading: string;
    note: (days: number) => string;
    caption: (year: number) => string;
    weekdays: readonly string[];
    weekdayTitle: (weekday: string) => string;
    dayDescription: (date: string, fileCount: number, checkCount: number) => string;
    less: string;
    more: string;
  }>;
  readonly calendar: Readonly<{
    heading: string;
    previousMonth: string;
    nextMonth: string;
    ariaLabel: string;
    dayDescription: (date: string, exists: boolean, activity: number) => string;
    dayTitle: (date: string, exists: boolean, activity: number) => string;
    summary: (count: number) => string;
    hasJournal: string;
    noJournal: string;
  }>;
  readonly conversation: Readonly<{
    dailyAccessibleName: string;
    dailyDescription: string;
    revisitAccessibleName: string;
    revisitDescription: string;
    dailySessionTitle: (date: string) => string;
    revisitSessionTitle: (date: string) => string;
    reviewSessionTitle: (date: string) => string;
    sidebarNotReady: string;
    cannotCreateSession: (error: string) => string;
    cannotCreateReviewSession: (error: string) => string;
  }>;
  readonly modal: Readonly<{
    title: string;
    introduction: string;
    close: string;
    closeTemplatePicker: string;
    builtInTemplates: string;
    systemDefault: string;
    myTemplates: string;
    templateCount: (count: number) => string;
    noImportedTemplates: string;
    importMarkdown: string;
    importDescription: string;
    reading: string;
    chooseMarkdownFile: string;
    cancel: string;
    creating: string;
    useTemplate: (name: string) => string;
    previewMeta: (lineCount: number, frontmatterCount: number) => string;
    blankTemplate: string;
    saving: string;
    saveToMyTemplates: string;
    keepAs: (name: string) => string;
    readingFile: (name: string) => string;
    importReadComplete: string;
    readFailed: (error: string) => string;
    savingLocalTemplate: string;
    duplicateTemplate: (path: string) => string;
    saved: (path: string) => string;
    saveFailed: (error: string) => string;
    creatingJournal: string;
    journalCreated: (path: string) => string;
    journalAlreadyExists: (path: string) => string;
    createFailed: (error: string) => string;
  }>;
  readonly template: Readonly<{
    display: (id: HomeBuiltInTemplateId) => Readonly<{ name: string; description: string }>;
    defaultTemplateUnavailable: string;
    unsupportedMarkdown: string;
    containsNullCharacter: string;
    invalidUtf8: string;
    safeCopyUnavailable: string;
    pathOccupiedByFolder: (path: string) => string;
    templateNotFound: (path: string) => string;
    folderOccupiedByFile: (path: string) => string;
  }>;
  readonly graph: Readonly<{
    cannotOpenGraph: string;
    folderFilterUnavailable: string;
    cannotOpenLocalGraph: string;
    missingVaultFile: (path: string) => string;
  }>;
}

const ZH_TEMPLATE_DISPLAY: Record<HomeBuiltInTemplateId, Readonly<{ name: string; description: string }>> = {
  quick: { name: "此刻速记", description: "一句话也可以，系统始终默认" },
  morning: { name: "晨间定向", description: "能量、脑内清空、今天最重要的一件事" },
  evening: { name: "晚间收束", description: "重要片段、完成事项和明早第一步" },
  blank: { name: "空白", description: "只创建日期标题" }
};

const EN_TEMPLATE_DISPLAY: Record<HomeBuiltInTemplateId, Readonly<{ name: string; description: string }>> = {
  quick: { name: "Quick note", description: "One sentence is enough; this is always the default" },
  morning: { name: "Morning orientation", description: "Energy, a clear mind, and the one thing that matters today" },
  evening: { name: "Evening wrap-up", description: "Important moments, completed work, and tomorrow's first step" },
  blank: { name: "Blank", description: "Create only a date heading" }
};

const ZH: HomeCopy = {
  viewTitle: "EchoInk 首页",
  knowledgeServiceUnavailable: "知识库管理器尚未准备好",
  localKnowledgeLoadFailed: (error) => `本地知识数据读取失败：${error}`,
  maintenanceSnapshotUnavailable: (error) => `维护快照暂不可用：${error}`,
  conversationHeading: "从一段对话开始",
  conversationNote: "先说出来，再决定要不要留下",
  entriesHeading: "知识工作入口",
  entriesNote: "从真实状态继续阅读、整理、写作与复盘",
  workbenchTitle: "个人知识工作台",
  refreshLocalData: "刷新本地数据",
  pluginSettings: "插件设置",
  currentKnowledgeBase: "当前知识库",
  loadingLocalKnowledge: "正在读取本地知识…",
  localMode: "本地模式",
  healthStatus: (status) => ({ healthy: "健康", risk: "风险", bad: "异常" }[status] ?? status),
  entry: {
    label: (id) => ({ wiki: "Wiki", outputs: "Outputs", projects: "Projects", inbox: "Inbox", journal: "Journal", review: "Review" }[id]),
    description: (id) => ({
      wiki: "结构化长期知识",
      outputs: "维护记录与生成成果",
      projects: "正在推进的项目知识",
      inbox: "等待归类的输入",
      journal: "日记、复盘与时间记录",
      review: "知识库复盘与报告"
    }[id]),
    action: (id) => ({ wiki: "打开 Wiki", outputs: "查看成果", projects: "继续项目", inbox: "处理输入", journal: "写日记", review: "开始复盘" }[id]),
    ariaLabel: (id) => `${({ wiki: "打开 Wiki", outputs: "查看成果", projects: "继续项目", inbox: "处理输入", journal: "写日记", review: "开始复盘" }[id])}：${({ wiki: "Wiki", outputs: "Outputs", projects: "Projects", inbox: "Inbox", journal: "Journal", review: "Review" }[id])}`,
    wikiKnowledgeCount: (count) => `${count} 篇知识`,
    wikiUpdatedToday: (count) => `今日更新 ${count}`,
    noLocalOutputs: "还没有本地成果",
    updatedRecently: (time) => `最近更新 ${time}`,
    outputsAfterMaintenance: "完成一次知识维护后会在这里出现",
    noProjectNotes: "还没有项目笔记",
    continueFromRecentProject: "从最近项目继续下一步",
    createProjectInProjects: "可在 Projects 目录建立项目",
    recentInput: (title) => `最近输入：${title}`,
    pendingOrganization: "待整理",
    noPendingInputs: "当前没有待整理输入",
    journalCreated: "今日日记已建立",
    journalDefaultTemplate: "默认使用“此刻速记”",
    journalContinueWithoutOverwrite: "继续打开，不覆盖已有内容",
    journalTemplateOption: "也可进入模板选择或导入 Markdown",
    waitingForMaintenanceSnapshot: "等待本地维护快照"
  },
  heatmap: {
    heading: "本地维护活动",
    note: (days) => `${days} 个活动日 · 文件最后修改时间 + 维护检查`,
    caption: (year) => `${year} 年本地 Markdown 修改与知识维护活动`,
    weekdays: ["日", "一", "二", "三", "四", "五", "六"],
    weekdayTitle: (weekday) => `星期${weekday}`,
    dayDescription: (date, fileCount, checkCount) => `${date}：${fileCount} 个文件最后修改，${checkCount} 次维护检查`,
    less: "少",
    more: "多"
  },
  calendar: {
    heading: "日记日历",
    previousMonth: "上个月",
    nextMonth: "下个月",
    ariaLabel: "日记月历",
    dayDescription: (date, exists, activity) => `${date}，${exists ? "已有日记" : "没有日记"}，${activity} 条更新`,
    dayTitle: (date, exists, activity) => `${date} · ${exists ? "已有日记" : "没有日记"} · ${activity} 条更新`,
    summary: (count) => `有日记 · ${count} 天`,
    hasJournal: "已有日记",
    noJournal: "没有日记"
  },
  conversation: {
    dailyAccessibleName: "写日记：新建会话并自动发送开场消息",
    dailyDescription: "把今天说出来，确认后再整理成日记",
    revisitAccessibleName: "未完想法：新建会话并寻找一件未完成的事",
    revisitDescription: "从长期记忆里，捡起一件还没说完的事",
    dailySessionTitle: (date) => `写日记 · ${date}`,
    revisitSessionTitle: (date) => `未完想法 · ${date}`,
    reviewSessionTitle: (date) => `知识复盘 · ${date}`,
    sidebarNotReady: "右侧会话视图尚未准备好",
    cannotCreateSession: (error) => `暂时无法新建会话：${error}`,
    cannotCreateReviewSession: (error) => `暂时无法新建复盘会话：${error}`
  },
  modal: {
    title: "今天想怎么写？",
    introduction: "模板只决定新日记的初始内容；每次打开都默认“此刻速记”。",
    close: "关闭",
    closeTemplatePicker: "关闭日记模板选择器",
    builtInTemplates: "内置模板",
    systemDefault: "系统默认",
    myTemplates: "我的模板",
    templateCount: (count) => `${count} 个`,
    noImportedTemplates: "尚未导入本地 Markdown 模板。",
    importMarkdown: "导入 Markdown",
    importDescription: "只读取本地 .md；源文件不修改、不上传。",
    reading: "读取中…",
    chooseMarkdownFile: "选择 .md 文件",
    cancel: "取消",
    creating: "创建中…",
    useTemplate: (name) => `使用「${name}」`,
    previewMeta: (lineCount, frontmatterCount) => `${lineCount} 行 · frontmatter ${frontmatterCount} 项`,
    blankTemplate: "（空白模板）",
    saving: "保存中…",
    saveToMyTemplates: "保存到“我的模板”",
    keepAs: (name) => `保留为 ${name}`,
    readingFile: (name) => `正在读取 ${name}…`,
    importReadComplete: "读取完成。未知 frontmatter、正文结构、代码块和占位符会原样保留。",
    readFailed: (error) => `读取失败：${error}`,
    savingLocalTemplate: "正在保存本地模板…",
    duplicateTemplate: (path) => `同名模板已存在，未覆盖：${path}`,
    saved: (path) => `已保存：${path}`,
    saveFailed: (error) => `保存失败：${error}`,
    creatingJournal: "正在创建日记…",
    journalCreated: (path) => `已创建日记：${path}`,
    journalAlreadyExists: (path) => `今日日记已存在，已直接打开：${path}`,
    createFailed: (error) => `创建失败：${error}`
  },
  template: {
    display: (id) => ZH_TEMPLATE_DISPLAY[id],
    defaultTemplateUnavailable: "默认日记模板不可用",
    unsupportedMarkdown: "只支持本地 .md 模板",
    containsNullCharacter: "模板包含无法保存的空字符",
    invalidUtf8: "模板不是有效的 UTF-8 Markdown 文本",
    safeCopyUnavailable: "无法为同名模板生成安全副本名",
    pathOccupiedByFolder: (path) => `日记路径已被文件夹占用：${path}`,
    templateNotFound: (path) => `没有找到模板：${path}`,
    folderOccupiedByFile: (path) => `无法创建目录，路径已被文件占用：${path}`
  },
  graph: {
    cannotOpenGraph: "暂时无法打开 Obsidian 原生图谱，请稍后重试。",
    folderFilterUnavailable: "目录筛选暂不可用，正在打开普通全局图谱并保留原有筛选。",
    cannotOpenLocalGraph: "暂时无法打开 Obsidian 原生局部图谱，请稍后重试。",
    missingVaultFile: (path) => `没有在当前 Vault 找到：${path}`
  }
};

const EN: HomeCopy = {
  viewTitle: "EchoInk Home",
  knowledgeServiceUnavailable: "The knowledge service is not ready",
  localKnowledgeLoadFailed: (error) => `Could not load local knowledge data: ${error}`,
  maintenanceSnapshotUnavailable: (error) => `The maintenance snapshot is unavailable: ${error}`,
  conversationHeading: "Start with a conversation",
  conversationNote: "Say it first, then decide whether to keep it",
  entriesHeading: "Knowledge workspace",
  entriesNote: "Continue reading, organizing, writing, and reviewing from the current state",
  workbenchTitle: "Personal knowledge workspace",
  refreshLocalData: "Refresh local data",
  pluginSettings: "Plugin settings",
  currentKnowledgeBase: "Current knowledge base",
  loadingLocalKnowledge: "Loading local knowledge…",
  localMode: "Local mode",
  healthStatus: (status) => ({ healthy: "Healthy", risk: "At risk", bad: "Needs attention" }[status] ?? status),
  entry: {
    label: (id) => ({ wiki: "Wiki", outputs: "Outputs", projects: "Projects", inbox: "Inbox", journal: "Journal", review: "Review" }[id]),
    description: (id) => ({
      wiki: "Structured long-term knowledge",
      outputs: "Maintenance records and generated work",
      projects: "Knowledge for work in progress",
      inbox: "Inputs waiting to be organized",
      journal: "Journal, review, and time-based records",
      review: "Knowledge-base review and reports"
    }[id]),
    action: (id) => ({ wiki: "Open Wiki", outputs: "View outputs", projects: "Continue project", inbox: "Process inputs", journal: "Write journal", review: "Start review" }[id]),
    ariaLabel: (id) => `${({ wiki: "Open Wiki", outputs: "View outputs", projects: "Continue project", inbox: "Process inputs", journal: "Write journal", review: "Start review" }[id])}: ${({ wiki: "Wiki", outputs: "Outputs", projects: "Projects", inbox: "Inbox", journal: "Journal", review: "Review" }[id])}`,
    wikiKnowledgeCount: (count) => `${count} ${count === 1 ? "note" : "notes"}`,
    wikiUpdatedToday: (count) => `${count} updated today`,
    noLocalOutputs: "No local outputs yet",
    updatedRecently: (time) => `Updated ${time}`,
    outputsAfterMaintenance: "It will appear here after one knowledge-maintenance run",
    noProjectNotes: "No project notes yet",
    continueFromRecentProject: "Continue with the most recent project",
    createProjectInProjects: "Create a project in the Projects folder",
    recentInput: (title) => `Latest input: ${title}`,
    pendingOrganization: "Needs organizing",
    noPendingInputs: "No inputs need organizing",
    journalCreated: "Today's journal already exists",
    journalDefaultTemplate: "Uses the Quick note template by default",
    journalContinueWithoutOverwrite: "Open it and keep the existing content",
    journalTemplateOption: "You can also choose or import a template",
    waitingForMaintenanceSnapshot: "Waiting for a local maintenance snapshot"
  },
  heatmap: {
    heading: "Local maintenance activity",
    note: (days) => `${days} active ${days === 1 ? "day" : "days"} · file updates + maintenance checks`,
    caption: (year) => `${year} local Markdown updates and knowledge-maintenance activity`,
    weekdays: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
    weekdayTitle: (weekday) => weekday,
    dayDescription: (date, fileCount, checkCount) => `${date}: ${fileCount} ${fileCount === 1 ? "file" : "files"} updated, ${checkCount} maintenance ${checkCount === 1 ? "check" : "checks"}`,
    less: "Less",
    more: "More"
  },
  calendar: {
    heading: "Journal calendar",
    previousMonth: "Previous month",
    nextMonth: "Next month",
    ariaLabel: "Journal month calendar",
    dayDescription: (date, exists, activity) => `${date}, ${exists ? "journal exists" : "no journal"}, ${activity} ${activity === 1 ? "update" : "updates"}`,
    dayTitle: (date, exists, activity) => `${date} · ${exists ? "journal exists" : "no journal"} · ${activity} ${activity === 1 ? "update" : "updates"}`,
    summary: (count) => `${count} ${count === 1 ? "day with a journal" : "days with journals"}`,
    hasJournal: "Journal exists",
    noJournal: "No journal"
  },
  conversation: {
    dailyAccessibleName: "Write journal: start a new conversation and send the opening message",
    dailyDescription: "Talk through today, then organize it into a journal when you confirm",
    revisitAccessibleName: "Open thought: start a new conversation and pick up an unfinished thought",
    revisitDescription: "Pick up one thing that has not been fully said from long-term memory",
    dailySessionTitle: (date) => `Journal · ${date}`,
    revisitSessionTitle: (date) => `Open thought · ${date}`,
    reviewSessionTitle: (date) => `Knowledge review · ${date}`,
    sidebarNotReady: "The sidebar conversation view is not ready",
    cannotCreateSession: (error) => `Could not create a new conversation: ${error}`,
    cannotCreateReviewSession: (error) => `Could not create a review conversation: ${error}`
  },
  modal: {
    title: "How would you like to write today?",
    introduction: "A template sets only the starting content for a new journal; Quick note is selected whenever this opens.",
    close: "Close",
    closeTemplatePicker: "Close the journal template picker",
    builtInTemplates: "Built-in templates",
    systemDefault: "System default",
    myTemplates: "My templates",
    templateCount: (count) => `${count} ${count === 1 ? "template" : "templates"}`,
    noImportedTemplates: "No local Markdown templates have been imported.",
    importMarkdown: "Import Markdown",
    importDescription: "Reads a local .md file only; the source file is not changed or uploaded.",
    reading: "Reading…",
    chooseMarkdownFile: "Choose a .md file",
    cancel: "Cancel",
    creating: "Creating…",
    useTemplate: (name) => `Use “${name}”`,
    previewMeta: (lineCount, frontmatterCount) => `${lineCount} ${lineCount === 1 ? "line" : "lines"} · ${frontmatterCount} frontmatter ${frontmatterCount === 1 ? "field" : "fields"}`,
    blankTemplate: "(Blank template)",
    saving: "Saving…",
    saveToMyTemplates: "Save to My templates",
    keepAs: (name) => `Keep as ${name}`,
    readingFile: (name) => `Reading ${name}…`,
    importReadComplete: "Read complete. Unknown frontmatter, body structure, code blocks, and placeholders are kept exactly as they are.",
    readFailed: (error) => `Could not read the file: ${error}`,
    savingLocalTemplate: "Saving the local template…",
    duplicateTemplate: (path) => `A template with this name already exists and was not overwritten: ${path}`,
    saved: (path) => `Saved: ${path}`,
    saveFailed: (error) => `Could not save the template: ${error}`,
    creatingJournal: "Creating the journal…",
    journalCreated: (path) => `Journal created: ${path}`,
    journalAlreadyExists: (path) => `Today's journal already exists and was opened: ${path}`,
    createFailed: (error) => `Could not create the journal: ${error}`
  },
  template: {
    display: (id) => EN_TEMPLATE_DISPLAY[id],
    defaultTemplateUnavailable: "The default journal template is unavailable",
    unsupportedMarkdown: "Only local .md templates are supported",
    containsNullCharacter: "The template contains a null character and cannot be saved",
    invalidUtf8: "The template is not valid UTF-8 Markdown text",
    safeCopyUnavailable: "Could not generate a safe copy name for the duplicate template",
    pathOccupiedByFolder: (path) => `A folder already occupies the journal path: ${path}`,
    templateNotFound: (path) => `Template not found: ${path}`,
    folderOccupiedByFile: (path) => `Could not create the folder because a file occupies this path: ${path}`
  },
  graph: {
    cannotOpenGraph: "Could not open Obsidian's native graph. Please try again.",
    folderFilterUnavailable: "Folder filtering is unavailable. Opening the global graph with your existing filters.",
    cannotOpenLocalGraph: "Could not open Obsidian's native local graph. Please try again.",
    missingVaultFile: (path) => `The current Vault does not contain: ${path}`
  }
};

export function homeCopy(language: SettingsLanguage): HomeCopy {
  return language === "en" ? EN : ZH;
}

export function homeLocale(language: SettingsLanguage): "zh-CN" | "en-US" {
  return language === "en" ? "en-US" : "zh-CN";
}

export function formatHomeRelativeTime(timestamp: number, language: SettingsLanguage, now = Date.now()): string {
  const delta = Math.max(0, now - timestamp);
  const minutes = Math.floor(delta / 60_000);
  if (language === "en") {
    if (minutes < 1) return "just now";
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours} hr ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days} days ago`;
    return new Date(timestamp).toLocaleDateString(homeLocale(language));
  }
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(timestamp).toLocaleDateString(homeLocale(language));
}

export function formatHomeFullDate(date: Date, language: SettingsLanguage): string {
  return date.toLocaleDateString(homeLocale(language), {
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short"
  });
}

export function formatHomeMonth(date: Date, language: SettingsLanguage): string {
  return date.toLocaleDateString(homeLocale(language), { year: "numeric", month: "long" });
}

export function homeContributionMonthLabel(monthIndex: number, language: SettingsLanguage): string {
  return new Date(2026, monthIndex, 1).toLocaleDateString(homeLocale(language), { month: "short" });
}
