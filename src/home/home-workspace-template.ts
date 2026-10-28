import type { SettingsLanguage } from "../settings/settings";

// Approved central workspace markup. Runtime data is added by EchoInkHomeView.
const markup = "  <div class=\"home-content\">\n    <header class=\"page-heading\">\n      <div class=\"page-identity\"><span class=\"logo\" data-icon=\"feather\"></span><div><div class=\"eyebrow\">ECHOINK</div><h1>个人知识工作台</h1></div></div>\n      <div class=\"heading-right\"><span class=\"date-caption\"></span><div class=\"inline-search\" data-home=\"header-search\"><div class=\"search-field\"><button class=\"icon-button search-trigger\" data-action=\"search\" aria-label=\"搜索笔记\" title=\"搜索笔记 ⌘ K\" aria-expanded=\"false\" aria-controls=\"search-suggestions\"><i data-icon=\"search\"></i></button><label class=\"sr-only\" for=\"search-input\">搜索笔记标题或内容</label><input data-home=\"search-input\" type=\"search\" placeholder=\"标题、内容、别名或标签…\" autocomplete=\"off\" role=\"combobox\" aria-autocomplete=\"list\" aria-expanded=\"false\" aria-controls=\"search-results\" tabindex=\"-1\"><button class=\"search-close icon-button\" data-action=\"close-search\" aria-label=\"收起搜索\" title=\"收起搜索 · Esc\" tabindex=\"-1\"><i data-icon=\"x\"></i></button></div><div class=\"search-suggestions\" data-home=\"search-suggestions\" hidden><div class=\"search-results-heading\" data-home=\"search-results-heading\">最近笔记</div><div data-home=\"search-results\" role=\"listbox\" aria-label=\"笔记联想结果\"></div><div class=\"search-empty\" data-home=\"search-empty\" hidden><strong>没有找到相关笔记</strong><span>试试另一个标题或关键词。</span></div><div class=\"search-results-footer\"><span data-home=\"search-results-hint\">↑ ↓ 选择 · Enter 打开</span><span>Esc 收起</span></div></div></div><button class=\"icon-button\" data-action=\"settings\" aria-label=\"插件设置\" title=\"插件设置\"><i data-icon=\"settings\"></i></button></div>\n    </header>\n\n    <section class=\"start-strip\" aria-label=\"快捷开始\">\n      <div class=\"start-actions\"><button class=\"button primary\" data-action=\"capture\" title=\"自己直接写，保存到 Inbox\"><i data-icon=\"plus\"></i>快速记录<kbd>⌘ J</kbd></button><button class=\"button quiet\" data-action=\"journal-chat\" title=\"和右侧 Agent 聊今天，再整理成日记\"><i data-icon=\"message-circle\"></i>对话写日记</button></div>\n    </section>\n\n    <section class=\"return-grid\" aria-label=\"继续笔记和回看记录\">\n      <div class=\"continuity\">\n        <section class=\"recent-section\" aria-labelledby=\"recent-title\">\n          <div class=\"section-head\"><div class=\"title-with-detail\"><h2 data-home=\"recent-title\">最近笔记</h2><span data-home=\"recent-subtitle\"></span></div><button class=\"text-button reset-date\" data-action=\"reset-date\" hidden>回到最近<i data-icon=\"x\"></i></button></div>\n          <div class=\"recent-notes\" data-home=\"recent-notes\"></div>\n        </section>\n        <section class=\"footprints\" aria-labelledby=\"footprint-title\">\n          <div class=\"footprint-heading\"><h2 data-home=\"footprint-title\">这一周，留下的足迹</h2><span class=\"week-range\">8.31 — 9.06</span><button class=\"icon-button tiny\" data-action=\"footprint-help\" aria-label=\"了解足迹记录\"><i data-icon=\"circle-help\"></i></button></div>\n          <div class=\"footprint-body\"><div class=\"footprint-numbers\"><strong data-home=\"trace-count\">0<span>次积累</span></strong><div class=\"trace-legend\"><span><b class=\"mark new\"></b>写下 <em data-home=\"new-count\">6</em></span><span><b class=\"mark edit\"></b>修改 <em>8</em></span><span><b class=\"mark revisit\"></b>重读 <em>4</em></span></div></div><div class=\"week-spines\" data-home=\"week-spines\" aria-label=\"按日期回看本周足迹\"></div></div>\n          <div class=\"footprint-caption\"><span><i data-icon=\"history\"></i><span data-home=\"trace-caption\"></span></span><button class=\"text-button\" data-action=\"week-review\">回看这一周<i data-icon=\"arrow-right\"></i></button></div>\n        </section>\n      </div>\n      <section class=\"calendar\" aria-labelledby=\"calendar-title\">\n        <div class=\"calendar-heading\"><h2 data-home=\"calendar-title\">日记与足迹</h2><button class=\"text-button today-button\" data-action=\"today\">今天</button></div>\n        <div class=\"month-navigation\"><strong data-home=\"month-label\"></strong><div><button class=\"icon-button tiny\" data-action=\"previous-month\" aria-label=\"上个月\"><i data-icon=\"chevron-left\"></i></button><button class=\"icon-button tiny\" data-action=\"next-month\" aria-label=\"下个月\"><i data-icon=\"chevron-right\"></i></button></div></div>\n        <div class=\"calendar-weekdays\" aria-hidden=\"true\"><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span><span>日</span></div>\n        <div class=\"calendar-days\" data-home=\"calendar-days\"></div>\n        <div class=\"calendar-key\"><span><b></b>有记录的日子</span><span data-home=\"month-record-count\"></span></div>\n        <button class=\"calendar-journal\" data-home=\"calendar-journal\" data-action=\"selected-journal\"><span class=\"journal-date-icon\"><i data-icon=\"book-text\"></i></span><span><strong data-home=\"journal-label\">今天的日记</strong><small data-home=\"journal-hint\"></small></span><i data-icon=\"arrow-up-right\"></i></button>\n      </section>\n    </section>\n\n    <section class=\"knowledge-section\" aria-labelledby=\"knowledge-title\">\n      <div class=\"section-head knowledge-heading\"><div class=\"title-with-detail\"><h2 data-home=\"knowledge-title\">知识</h2></div><button class=\"health\" data-action=\"knowledge-settings\"><b></b><i data-icon=\"chevron-right\"></i></button></div>\n      <div class=\"bento-grid\">\n        <button class=\"bento wiki\" aria-label=\"打开 Wiki 图谱\" data-native-graph=\"wiki\" title=\"打开 Wiki 的 Obsidian 原生图谱\"><span class=\"bento-top\"><span class=\"tile-icon\"><i data-icon=\"layers\"></i></span><span class=\"corner-arrow\"><i data-icon=\"arrow-up-right\"></i></span></span><span class=\"wiki-art\" aria-hidden=\"true\"><span class=\"index-sheet sheet-a\"><b></b><i></i><i></i><i></i></span><span class=\"index-sheet sheet-b\"><b></b><i></i><i></i><i></i></span><span class=\"index-sheet sheet-c\"><b></b><i></i><i></i><i></i></span></span><span class=\"bento-bottom\"><span class=\"bento-name\">Wiki<span>知识库</span></span><span class=\"wiki-count\"><span>篇笔记</span></span><span class=\"bento-meta\"><span class=\"mini-dot\"></span></span></span><span class=\"bento-action\" aria-hidden=\"true\"><span>打开 Wiki 图谱</span><i data-icon=\"arrow-right\"></i></span></button>\n        <button class=\"bento outputs\" aria-label=\"打开成果图谱\" data-native-graph=\"outputs\" title=\"打开 Outputs 的 Obsidian 原生图谱\"><span class=\"bento-top\"><span class=\"tile-icon\"><i data-icon=\"file-text\"></i></span></span><span class=\"bento-name\">Outputs<span>成果</span></span><span class=\"bento-line\"></span><span class=\"bento-meta\"><i class=\"inline-arrow\" data-icon=\"arrow-up-right\"></i></span><span class=\"bento-action\" aria-hidden=\"true\"><span>打开成果图谱</span><i data-icon=\"arrow-right\"></i></span></button>\n        <button class=\"bento projects\" aria-label=\"打开项目图谱\" data-native-graph=\"projects\" title=\"打开 Projects 的 Obsidian 原生图谱\"><span class=\"bento-top\"><span class=\"tile-icon\"><i data-icon=\"folder-kanban\"></i></span></span><span class=\"bento-name\">Projects<span>项目</span></span><span class=\"project-line\"></span><span class=\"bento-meta\"><i class=\"inline-arrow\" data-icon=\"arrow-up-right\"></i></span><span class=\"bento-action\" aria-hidden=\"true\"><span>打开项目图谱</span><i data-icon=\"arrow-right\"></i></span></button>\n        <button class=\"bento inbox\" aria-label=\"打开收件箱图谱\" data-native-graph=\"inbox\" title=\"打开 Inbox 的 Obsidian 原生图谱\"><span class=\"bento-top\"><span class=\"tile-icon\"><i data-icon=\"folders\"></i></span></span><span class=\"bento-name\">Inbox<span>收件箱</span></span><span class=\"inbox-bottom\"><strong data-home=\"inbox-count\">0</strong><span>条新想法，等你整理</span><i data-icon=\"arrow-up-right\"></i></span><span class=\"bento-action\" aria-hidden=\"true\"><span>打开收件箱图谱</span><i data-icon=\"arrow-right\"></i></span></button>\n        <button class=\"bento journal\" aria-label=\"选择日记模板\" data-action=\"journal-template\" title=\"选择日记模板\"><span class=\"bento-top\"><span class=\"tile-icon\"><i data-icon=\"calendar-days\"></i></span><span class=\"corner-arrow\"><i data-icon=\"arrow-up-right\"></i></span></span><span class=\"journal-art\" aria-hidden=\"true\"><span class=\"sun-disk\"></span><span class=\"horizon h1\"></span><span class=\"horizon h2\"></span><span class=\"horizon h3\"></span></span><span class=\"bento-bottom\"><span class=\"bento-name\">Journal<span>日记</span></span><span class=\"journal-date\"></span><span class=\"bento-meta\"></span></span><span class=\"bento-action\" aria-hidden=\"true\"><span>选择日记模板</span><i data-icon=\"arrow-right\"></i></span></button>\n        <button class=\"bento review\" aria-label=\"与 Agent 复盘\" data-action=\"review\" title=\"在右侧 Agent 开始复盘\"><span class=\"review-copy\"><span class=\"bento-name\">Review<span>回顾</span></span></span><span class=\"review-orbit\" aria-hidden=\"true\"><span></span><span></span><span></span><b></b><i></i></span><span class=\"review-score\"><strong>—</strong><span>知识库健康</span></span><span class=\"bento-action\" aria-hidden=\"true\"><span>与 Agent 复盘</span><i data-icon=\"arrow-right\"></i></span></button>\n      </div>\n    </section>\n\n    <section class=\"todo-section\" aria-labelledby=\"todo-title\">\n      <div class=\"section-head\"><div class=\"title-with-detail\"><h2 data-home=\"todo-title\">待办</h2><span data-home=\"todo-subtitle\"></span></div><button class=\"text-button\" data-action=\"todo-open-source\">打开源文件<i data-icon=\"file-text\"></i></button></div>\n      <div class=\"todo-toolbar\"><button class=\"button primary todo-add-button\" data-action=\"todo-new\"><i data-icon=\"plus\"></i>新增待办</button><div class=\"todo-filter-bar\" data-home=\"todo-filter-bar\" role=\"group\" aria-label=\"待办筛选\"></div></div>\n      <div class=\"todo-table-host\" data-home=\"todo-list\"></div>\n    </section>\n    <footer class=\"page-footer\" hidden></footer>\n  </div>";

export function homeWorkspaceMarkup(language: SettingsLanguage): string {
  if (language !== "en") return markup;
  let result = markup;
  for (const [zh, en] of Object.entries(english).sort((a, b) => b[0].length - a[0].length)) result = result.split(zh).join(en);
  return result;
}

const english: Record<string, string> = {
  "个人知识工作台": "Your knowledge workspace",
  "搜索笔记标题或内容": "Search note titles or content",
  "标题、内容、别名或标签…": "Titles, content, aliases or tags…",
  "搜索笔记": "Search notes",
  "收起搜索": "Close search",
  "笔记联想结果": "Suggested notes",
  "没有找到相关笔记": "No matching notes",
  "试试另一个标题或关键词。": "Try another name or keyword.",
  "↑ ↓ 选择 · Enter 打开": "↑ ↓ Select · Enter Open",
  "Esc 收起": "Esc Close",
  "插件设置": "Plugin settings",
  "快捷开始": "Quick start",
  "自己直接写，保存到 Inbox": "Create a blank note in Inbox",
  "快速记录": "Quick note",
  "和右侧 Agent 聊今天，再整理成日记": "Talk about today with your Agent",
  "对话写日记": "Journal with your Agent",
  "最近笔记": "Recent notes",
  "回到最近": "Back to recent",
  "这一周，留下的足迹": "What stayed with you this week",
  "了解足迹记录": "About activity",
  "条足迹": "activities",
  "写下": "Created",
  "修改": "Modified",
  "重读": "Reopened",
  "回看这一周": "View this week",
  "日记与足迹": "Journal & activity",
  "今天": "Today",
  "上个月": "Previous month",
  "下个月": "Next month",
  "有记录的日子": "Days with activity",
  "知识": "Knowledge",
  "打开 Wiki 图谱": "Open Wiki graph",
  "打开成果图谱": "Open Outputs graph",
  "打开项目图谱": "Open Projects graph",
  "打开收件箱图谱": "Open Inbox graph",
  "打开 Wiki 的 Obsidian 原生图谱": "Open the native Obsidian graph for Wiki",
  "打开 Outputs 的 Obsidian 原生图谱": "Open the native Obsidian graph for Outputs",
  "打开 Projects 的 Obsidian 原生图谱": "Open the native Obsidian graph for Projects",
  "打开 Inbox 的 Obsidian 原生图谱": "Open the native Obsidian graph for Inbox",
  "知识库健康": "Knowledge health",
  "知识库": "Knowledge",
  "篇笔记": "notes",
  "成果": "Outputs",
  "项目": "Projects",
  "收件箱": "Inbox",
  "条新想法，等你整理": "ideas to organize",
  "选择日记模板": "Choose journal template",
  "日记": "Journal",
  "在右侧 Agent 开始复盘": "Start a review with your Agent",
  "与 Agent 复盘": "Review with your Agent",
  "回顾": "Review",
};
