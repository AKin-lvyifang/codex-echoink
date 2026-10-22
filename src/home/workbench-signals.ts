import type { AgentModuleId } from "../agents/types";
import type { FinanceEntry, LifestyleData } from "../lifestyle/store-core";
import { effectiveFinanceBudget } from "../lifestyle/finance-budget";
import { effectiveFinanceEntries } from "../lifestyle/finance-domain";
import type { ParsedTodoRecord } from "./todo-markdown";
import type { PdfJob } from "../pdf-reading/types";
import type { WorkbenchJournalDay } from "./workbench-journal";
import { localWorkbenchDate, validWorkbenchDate, workbenchWeekKey } from "./workbench-source";
import type { WorkbenchSignal, WorkbenchSignalId } from "./workbench-types";
import type { MaintenanceActivity } from "../knowledge-base/maintenance-activity";

export interface WorkbenchSourceFile { path: string; fingerprint: string; enteredAt?: number }
export interface WorkbenchFacts {
  now: number;
  modules: readonly AgentModuleId[];
  tasks: readonly { conversationId?: string; businessKey?: string; taskStatus?: string; pendingResponse?: unknown; status?: string }[];
  maintenance?: readonly Readonly<Pick<MaintenanceActivity, "originConversationId" | "sourcePaths" | "status" | "updatedAt">>[];
  todos: readonly ParsedTodoRecord[];
  finance?: { entries: readonly FinanceEntry[]; data: Readonly<LifestyleData> };
  journals: readonly WorkbenchJournalDay[];
  englishMissing: boolean | null;
  inbox: readonly WorkbenchSourceFile[];
  inboxScope: string;
  raw: readonly WorkbenchSourceFile[];
  rawScope: string;
  pdfJobs: readonly PdfJob[];
  reviewComplete: boolean | null;
  isolated: readonly string[] | null;
  knowledgeScope: string;
  language?: "en" | "zh-CN";
}

/** Calendar arithmetic uses date components, never a 24-hour elapsed-day approximation. */
export function workbenchCalendarOrdinal(value: string): number | null {
  if (!validWorkbenchDate(value)) return null;
  const [year, month, day] = value.split("-").map(Number);
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

export function latestFailedPdfRequests(jobs: readonly PdfJob[]): PdfJob[] {
  const terminal = new Map<string, PdfJob>();
  for (const job of [...jobs].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))) {
    if (job.state === "running" || job.state === "cancelled") continue;
    // A source fingerprint plus the exact processing target is required for cross-job coverage.
    const target = JSON.stringify([job.options.engine, job.options.reading, job.options.translation,
      job.options.translation ? job.options.translationLanguage ?? "中文" : "", job.options.wiki]);
    const key = job.sourceFingerprint ? `${job.sourceFingerprint}:${target}` : `job:${job.id}`;
    if (!terminal.has(key)) terminal.set(key, job);
  }
  return [...terminal.values()].filter(job => job.state === "failed" || job.state === "partial");
}

export function calculateWorkbenchSignals(facts: WorkbenchFacts): WorkbenchSignal[] {
  const { now } = facts, date = new Date(now), today = localWorkbenchDate(date), month = today.slice(0, 7);
  const enabled = new Set(facts.modules), signals: WorkbenchSignal[] = [], english = facts.language === "en";
  const busyTasks = facts.tasks.filter(task => task.status !== "deleted" && (task.pendingResponse || task.taskStatus === "waiting" || task.taskStatus === "running"));
  const busy = new Set(busyTasks.map(task => task.businessKey).filter(Boolean));
  const maintenance = new Map<string, NonNullable<WorkbenchFacts["maintenance"]>[number]>();
  for (const activity of facts.maintenance ?? []) {
    const previous = maintenance.get(activity.originConversationId);
    if (!previous || activity.updatedAt > previous.updatedAt) maintenance.set(activity.originConversationId, activity);
  }
  const scopedMaintenance = new Set([...maintenance.values()].filter(activity => activity.status !== "completed"
    && activity.sourcePaths.length > 0 && activity.sourcePaths.every(path => typeof path === "string" && path.trim()))
    .map(activity => activity.originConversationId));
  // A known maintenance scope is subtracted by the view; unrelated busy work still owns its key.
  const rawBusy = new Set(busyTasks.filter(task => !scopedMaintenance.has(task.conversationId ?? "")).map(task => task.businessKey).filter(Boolean));
  const add = (id: WorkbenchSignalId, moduleId: AgentModuleId, scene: string, scope: string,
    icon: string, description: string, prompt: string, objects: readonly string[] = [], versions?: Record<string, string>) => {
    if (!enabled.has(moduleId)) return;
    const key = `workbench:${moduleId}:${scene}:${scope}`;
    if ((id === 7 ? rawBusy : busy).has(key)) return;
    signals.push({ id, key, moduleId, icon, description, prompt, source: {
      version: 1, signalId: id, businessKey: key, moduleId, objects: [...objects], ...(versions ? { versions } : {}), prompt, capturedAt: now
    } });
  };
  const due = facts.todos.filter(todo => !todo.done && validWorkbenchDate(todo.dueDate) && todo.dueDate <= today);
  if (due.length) {
    const overdue = due.filter(todo => todo.dueDate < today).length;
    add(1, "todos", "due", today, "list-todo", english ? `${due.length} to-dos due, ${overdue} overdue` : `${due.length} 项待办已到期${overdue ? `，其中 ${overdue} 项已逾期` : ""}`,
      `请帮我梳理截至 ${today} 已到期的 ${due.length} 项未完成待办，说明优先级。`, due.map(todo => todo.id || `line:${todo.lineStart}`));
  }
  const ordinal = workbenchCalendarOrdinal(today)!;
  const longOverdue = due.filter(todo => ordinal - workbenchCalendarOrdinal(todo.dueDate)! > 3);
  if (longOverdue.length) add(2, "todos", "long-overdue", today, "calendar-clock", english ? `${longOverdue.length} to-dos overdue by more than 3 days` : `${longOverdue.length} 项待办逾期超过 3 天`,
    `请帮我重新安排截至 ${today} 逾期超过 3 个日历日的待办。`, longOverdue.map(todo => todo.id || `line:${todo.lineStart}`));
  if (facts.finance && enabled.has("finance")) {
    const valid = effectiveFinanceEntries(facts.finance.entries, month, today), budget = effectiveFinanceBudget(facts.finance.data, month);
    const net = new Map<string, number>();
    for (const entry of valid) if (entry.kind === "expense" || entry.kind === "refund") net.set(entry.category,
      (net.get(entry.category) ?? 0) + (entry.kind === "expense" ? entry.amountCents : -entry.amountCents));
    for (const category of Object.keys(budget?.allocations ?? {}).sort((a, b) => a.localeCompare(b, "zh-CN"))) {
      const limit = budget!.allocations[category], spent = net.get(category) ?? 0;
      if (!Number.isFinite(limit) || limit <= 0 || spent / limit < 0.8) continue;
      const percent = Math.floor(spent / limit * 100);
      add(3, "finance", "category-budget", `${month}:${category}`, "wallet", english ? `${category}: ${percent}% of monthly budget used` : `${category}本月预算已用 ${percent}%`,
        `请帮我看看 ${month}「${category}」的分类预算与净支出，当前已用 ${percent}%。`, [month, category]);
    }
  }
  const threeEmpty = facts.journals.length === 3 && facts.journals.every(day => day.state === "empty");
  if (!threeEmpty && date.getHours() >= 18 && facts.journals[0]?.state === "empty") add(4, "journal", "today", today, "notebook-pen",
    english ? "Today's journal is still empty" : "今天还没写日记", `请陪我写 ${today} 的日记，先帮我回想今天值得记录的事。`, [facts.journals[0].path]);
  if (facts.journals[0]?.state === "body" && /[\p{Script=Han}]/u.test(facts.journals[0].text) && facts.englishMissing === true) add(5, "english-diary", "missing-english", today, "languages",
    english ? "Today's journal has no English draft" : "今天的日记还没有英文稿", `请把 ${today} 的日记整理成英文稿，沿用已有英文日记流程。`, [facts.journals[0].path]);
  const inbox = facts.inbox.filter(file => file.enteredAt !== undefined);
  if (inbox.length >= 3 || inbox.some(file => now - file.enteredAt! > 72 * 3_600_000)) add(6, "knowledge-base", "inbox", facts.inboxScope, "inbox",
    english ? `${inbox.length} new Inbox items to organize` : `Inbox 新增 ${inbox.length} 条待整理内容`, "请帮我逐条整理这些 Inbox 新增内容，保留不能确认完成的条目。", inbox.map(file => file.path), Object.fromEntries(inbox.map(file => [file.path, file.fingerprint])));
  if (facts.raw.length >= 3) add(7, "knowledge-base", "raw", facts.rawScope, "library", english ? `${facts.raw.length} sources to organize` : `${facts.raw.length} 份资料待整理`,
    "请整理当前版本尚未处理、已改版、失败或待校准的资料，沿用现有知识库维护流程。", facts.raw.map(file => file.path), Object.fromEntries(facts.raw.map(file => [file.path, file.fingerprint])));
  const pdf = latestFailedPdfRequests(facts.pdfJobs);
  if (pdf.length) add(8, "pdf-reading", "unfinished", "history", "file-warning", english ? `${pdf.length} PDF requests unfinished` : `${pdf.length} 份 PDF 处理未完成`,
    "请帮我检查这些 PDF 未完成的处理目标，沿原任务继续；原件缺失时先说明需要重新选择。", pdf.map(job => job.id));
  if ((date.getDay() === 5 && date.getHours() >= 18 || date.getDay() === 6 || date.getDay() === 0) && facts.reviewComplete === false) add(9, "review", "week", workbenchWeekKey(now), "calendar-check",
    english ? "This week's review is not saved yet" : "本周还没有完成复盘", `请帮我完成从 ${workbenchWeekKey(now)} 开始的本周正式复盘，并保存复盘成果。`, [workbenchWeekKey(now)]);
  if (threeEmpty) add(10, "journal", "three-days", today, "notebook-pen", english ? "No journal writing for 3 calendar days" : "已经连续 3 天没写日记", "请陪我回顾今天、昨天和前天，先从我愿意记录的一天开始。", facts.journals.map(day => day.path));
  if (facts.finance) {
    const pending = effectiveFinanceEntries(facts.finance.entries, month, today).filter(entry => entry.classificationPending === true);
    if (pending.length) add(11, "finance", "classification", month, "tags", english ? `${pending.length} transactions to categorize` : `${pending.length} 条账目待分类`,
      `请帮我为 ${month} 明确标记为待分类的账目提出分类并保存，保留我主动选定的分类。`, pending.map(entry => entry.id));
    const at = facts.finance.data.lastSuccessfulImportAt;
    if (typeof at === "number" && Number.isFinite(at) && at > 0 && at <= now && now - at > 720 * 3_600_000) add(13, "finance", "import-gap", "ledger", "file-input",
      english ? "More than 30 days since the last successful import" : "距离上次成功导入账单已超过 30 天", "请帮我检查账单导入情况，并引导我导入最近账单。", []);
  }
  if (facts.isolated && facts.isolated.length >= 5) add(14, "knowledge-base", "isolated", facts.knowledgeScope, "network", english ? `${facts.isolated.length} notes have no resolved links` : `${facts.isolated.length} 篇笔记缺少关联`,
    "请检查这些知识成果和项目笔记，依据真实内容补充合适的关联，不添加无依据的链接。", facts.isolated);
  return signals;
}

export function nextWorkbenchRefreshAt(facts: WorkbenchFacts): number {
  const now = new Date(facts.now), midnight = new Date(now);
  midnight.setDate(midnight.getDate() + 1); midnight.setHours(0, 0, 0, 0);
  const candidates = [midnight.getTime()], evening = new Date(now);
  evening.setHours(18, 0, 0, 0);
  if (evening.getTime() > facts.now) candidates.push(evening.getTime());
  if (facts.modules.includes("knowledge-base")) for (const file of facts.inbox) if (file.enteredAt !== undefined) candidates.push(file.enteredAt + 72 * 3_600_000 + 1);
  if (facts.modules.includes("finance") && facts.finance?.data.lastSuccessfulImportAt) candidates.push(facts.finance.data.lastSuccessfulImportAt + 720 * 3_600_000 + 1);
  return Math.min(...candidates.filter(at => at > facts.now));
}
