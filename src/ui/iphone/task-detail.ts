import { messageRunIds } from "../../mobile/task-recovery";
import { mobileExpertEvents, mobileWorkspacePreviewPath } from "../mobile/expert-ui";
import { taskInterruptionExplanation, interruptionErrorDetail } from "../../agents/task-interruption-copy";
import { toolCallRecoveryGuidance } from "../../agents/tool-call-recovery";
import { toolCallTextFailureMessage } from "../../harness/tool-call-text";
import { mobileReportActions, openMobileRunReport } from "../../run-reports/mobile-ui";
import { formatMobileDateTime } from "../../mobile/date-display";
import { visibleReasoning } from "../../mobile/transport";
import { setIcon } from "obsidian";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { MobileShellPage } from "../mobile/shell-types";
import { shellElement } from "../mobile/shell-controls";
import type { IPhonePageContext } from "./workbench-contract";
import { createIPhoneComposer, createInlineQuestion, iPhoneAction } from "./composer";
import { iphoneCompany } from "./company-pages";
import { companyReminder, companyStartCard } from "../mobile/company-ui";

const toolNames: Record<string, string> = { company_roster: "员工名单", task_dispatch: "派活", task_message: "给员工带话", task_stop: "停止员工任务", task_status: "工作进度", project_propose: "开工提议", project_accept: "验收结项", report_to_router: "向总助汇报", approval_decide: "审批判断", vault_search: "查找笔记", note_read: "读取笔记", note_create: "保存文档", memory_search: "查找记忆", memory_read: "读取记忆", memory_write: "保存记忆", user_question: "询问", task_update: "更新任务", workspace_read: "读取工作区", workspace_create: "新建工作区文件", workspace_update: "修改工作区文件" };
const stages: Record<string, string> = { preparing: "准备上下文", context: "准备上下文", search: "检索资料", searching: "检索资料", summary: "整理历史", summarizing: "整理历史", model: "等待模型", tool: "执行工具", saving: "保存结果", question: "等待回应" };
const interruptionReasons = { app_backgrounded: "切到后台时中断", app_closed: "应用关闭时中断", plugin_disabled: "插件停用时中断", user_stopped: "已停止", run_failed: "运行出错时中断", process_unknown: "中断原因未确认", tool_loop_limit: "工具调用达到上限，已自动停止", watchdog: "运行未正常结束" };
const stageLabel = (stage?: string) => !stage ? "阶段未确认" : stages[stage] ?? (/[\u4e00-\u9fff]/u.test(stage) ? stage : "阶段未确认");
const messageText = (message: AgentMessage): string => {
  if (!("content" in message)) return "";
  return typeof message.content === "string" ? message.content : message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
};

export function createTaskPage(ctx: IPhonePageContext, taskId: string): MobileShellPage {
  const { host, document } = ctx;
  const content = shellElement(document, "div", "ip-task-detail"); content.dataset.taskId = taskId;
  const stream = shellElement(document, "div", "ip-task-stream");
  const tail = shellElement(document, "div", "ip-task-tail"); tail.setAttribute("aria-live", "polite");
  const errors = shellElement(document, "div", "ip-task-error"); errors.setAttribute("role", "alert");
  const liveBox = shellElement(document, "div", "ip-task-streaming"); liveBox.hidden = true;
  const question = createInlineQuestion(ctx, taskId), composer = createIPhoneComposer(ctx, { taskId });
  const companySlot = shellElement(document, "div", "ip-company-chat");
  content.append(stream, companySlot, liveBox, question.element, tail, errors);
  let companyKey = "";
  /** Start card and 等你定 reminder: the only company content in a router conversation. */
  const renderCompany = () => {
    const company = iphoneCompany(ctx), task = host.store.getSession(taskId);
    if (!company || !task) { companySlot.replaceChildren(); return; }
    const project = task.companyRole === "router" ? company.service.projectForRouter(taskId) : undefined;
    const readOnlyWorker = task.companyRole === "worker" && !!task.projectId;
    composer.element.hidden = readOnlyWorker; if (readOnlyWorker) question.element.hidden = true;
    const key = JSON.stringify([project, company.service.doc.dispatches.filter(d => d.routerConversationId === taskId || d.id === taskId).map(d => [d.id, d.status, d.report?.at, d.answer]),
      host.store.state.sessions.filter(item => item.companyRole === "worker").map(item => [item.id, item.interaction?.runId, item.interaction?.questionId, item.interaction?.status, host.runtime.isCompanyApprovalJudging?.(item.id)]), readOnlyWorker]);
    if (key === companyKey) return; companyKey = key;
    companySlot.replaceChildren();
    if (project) companySlot.append(companyStartCard(company, project));
    const reminder = task.companyRole === "router" ? companyReminder(company, taskId) : null;
    if (reminder) companySlot.append(reminder);
    if (readOnlyWorker) companySlot.append(shellElement(document, "div", "emc-hint", "这是项目里的员工对话，只读。要调整，回项目对话里跟总助说。"));
  };
  let disposed = false, messagesKey = "", lastRead = 0, liveOpen: boolean | undefined;
  const reasoningBlock = (parent: HTMLElement, key: string, label: string, text: string, open: boolean) => {
    const details = shellElement(document, "details", "ip-task-tool ip-task-reasoning"); details.dataset.toolId = key; details.open = open;
    const summary = shellElement(document, "summary", ""), icon = shellElement(document, "span", "ip-icon"); setIcon(icon, "brain"); icon.setAttribute("aria-hidden", "true");
    summary.append(icon, shellElement(document, "span", "", label));
    const body = shellElement(document, "div", "ip-task-tool-body ip-task-reasoning-body"); body.textContent = text;
    details.append(summary, body); parent.append(details); return details;
  };
  /** Plain text while streaming; the saved message renders Markdown once. */
  const renderLive = () => {
    const live = host.runtime.stateFor(taskId).live, scroller = content.closest<HTMLElement>(".eis-scroll");
    const pinned = !!scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    tail.querySelector<HTMLElement>(".ip-task-live")?.toggleAttribute("hidden", !!live);
    liveBox.replaceChildren(); liveBox.hidden = !live;
    if (!live) { liveOpen = undefined; return; }
    if (live.reasoning) {
      const details = reasoningBlock(liveBox, "reasoning:live", live.text ? "思考过程" : "思考中…", live.reasoning, liveOpen ?? !live.text);
      details.querySelector("summary")!.addEventListener("click", () => { liveOpen = !details.open; });
      const body = details.querySelector<HTMLElement>(".ip-task-reasoning-body")!; body.scrollTop = body.scrollHeight;
    }
    if (live.text) { const article = shellElement(document, "article", "ip-task-answer ip-task-answer-live"); article.setAttribute("aria-label", "Agent 回复"); article.textContent = live.text; liveBox.append(article); }
    if (pinned && scroller) scroller.scrollTop = scroller.scrollHeight;
  };
  const task = host.store.getSession(taskId);
  const page: MobileShellPage = { id: `task:${taskId}`, title: task?.title ?? "任务详情", content, footer: composer.element, canLeave: composer.canLeave };
  page.actions = mobileReportActions(ctx, taskId, "iphone");
  const markRead = () => {
    const task = host.store.getSession(taskId);
    if (!task?.unreadAnswerAt || task.unreadAnswerAt <= (task.lastReadAt ?? 0) || task.unreadAnswerAt <= lastRead) return;
    const boundary = task.unreadAnswerAt; lastRead = boundary;
    void host.store.updateSession(taskId, latest => { latest.lastReadAt = Math.max(latest.lastReadAt ?? 0, boundary); })
      .then(() => host.workbench.refreshTasks?.())
      .catch(error => { lastRead = 0; if (!disposed) ctx.error(error); });
  };
  const messages = (records: AgentMessage[]) => {
    const owner = host.store.getSession(taskId)?.agentId;
    const events = mobileExpertEvents(host.settings().agentRegistry.agents.find(agent => agent.id === owner), taskId);
    const key = JSON.stringify([records, host.runtime.stateFor(taskId).interaction?.status, events]); if (key === messagesKey) return; messagesKey = key;
    const openTools = new Set(Array.from(stream.querySelectorAll<HTMLDetailsElement>("details[open]")).map(node => node.dataset.toolId));
    stream.replaceChildren();
    let eventIndex = 0;
    const emitEvents = (through: number) => {
      while (eventIndex < events.length && events[eventIndex].at <= through) {
        const event = events[eventIndex++], line = shellElement(document, "div", "ip-expert-conversation-event", event.text); line.dataset.eventId = event.id; stream.append(line);
      }
    };
    const results = new Map(records.flatMap(message => message.role === "toolResult" ? [[message.toolCallId, message] as const] : []));
    const rendered = new Set<string>();
    const tool = (id: string, name: string, args: unknown, result?: AgentMessage) => {
      const details = shellElement(document, "details", "ip-task-tool"); details.dataset.toolId = id; details.open = openTools.has(id);
      const summary = shellElement(document, "summary", "");
      const icon = shellElement(document, "span", "ip-icon"); setIcon(icon, "wrench"); icon.setAttribute("aria-hidden", "true"); summary.append(icon, shellElement(document, "span", "", toolNames[name] ?? name));
      if (result && "isError" in result && result.isError) summary.append(shellElement(document, "span", "ip-tool-failed", "未完成"));
      else if (!result) summary.append(shellElement(document, "span", "ip-tool-pending", name === "user_question" && host.runtime.stateFor(taskId).interaction?.status === "pending" ? "等你回应" : "未记录结果"));
      const detail = shellElement(document, "div", "ip-task-tool-body");
      if (args !== undefined) { const input = shellElement(document, "pre", "ip-tool-input"); input.textContent = typeof args === "string" ? args : JSON.stringify(args, null, 2); detail.append(input); }
      if (result) { const output = shellElement(document, "div", "ip-tool-result markdown-rendered"); host.renderMarkdown(messageText(result), output, host.store.getSession(taskId)?.notePath); detail.append(output); }
      const previewPath = mobileWorkspacePreviewPath(result);
      if (previewPath && host.services.openWorkspacePreview) {
        const preview = shellElement(document, "button", "ip-workspace-preview", "预览"); preview.type = "button";
        preview.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); void host.services.openWorkspacePreview(previewPath).catch(ctx.error); }); summary.append(preview);
      }
      details.append(summary, detail); stream.append(details); rendered.add(id);
    };
    const ownerTask = host.store.getSession(taskId);
    const runIds = ownerTask?.companyRole === "router" ? messageRunIds(ownerTask) : new Map<number, string>();
    const runs = new Map(ownerTask?.runs?.map(run => [run.id, run]));
    for (const [index, message] of records.entries()) {
      const run = runs.get(runIds.get(index) ?? "");
      if (ownerTask?.companyRole === "router" && (run?.companyApproval || run?.companyProgrammatic && message.role === "user")) continue;
      emitEvents("timestamp" in message && typeof message.timestamp === "number" ? message.timestamp : Number.POSITIVE_INFINITY);
      if (message.role === "toolResult") { if (!rendered.has(message.toolCallId)) tool(message.toolCallId, message.toolName, undefined, message); continue; }
      const reasoning = message.role === "assistant" ? visibleReasoning(message) : "";
      if (reasoning) reasoningBlock(stream, `reasoning:${index}`, "思考过程", reasoning, openTools.has(`reasoning:${index}`));
      const text = messageText(message);
      if (text) {
        const article = shellElement(document, "article", message.role === "user" ? "ip-task-user" : "ip-task-answer markdown-rendered");
        article.setAttribute("aria-label", message.role === "user" ? "你的消息" : "Agent 回复");
        if (message.role === "user") article.textContent = text; else host.renderMarkdown(text, article, host.store.getSession(taskId)?.notePath);
        stream.append(article);
      }
      if (message.role === "assistant") for (const block of message.content) if (block.type === "toolCall") tool(block.id, block.name, block.arguments, results.get(block.id));
    }
    emitEvents(Number.POSITIVE_INFINITY);
    if (!records.length && !events.length) stream.append(shellElement(document, "p", "ip-task-empty", "这件事还没有消息。"));
  };
  const refresh = () => {
    if (disposed) return;
    const task = host.store.getSession(taskId), state = host.runtime.stateFor(taskId);
    if (!task) { stream.replaceChildren(shellElement(document, "p", "ip-task-empty", "任务已不存在。")); tail.replaceChildren(); composer.element.hidden = true; return; }
    const name = host.settings().agentRegistry.agents.find(agent => agent.id === task.agentId)?.name ?? "Agent";
    const status = task.taskStatus === "completed" ? `已完成${task.taskCompletedAt ? ` · ${formatMobileDateTime(task.taskCompletedAt)}` : ""}` : task.taskStatus === "interrupted" ? "已中断" : state.interaction?.status === "pending" ? "等你回应" : state.busy ? "进行中" : task.taskStatus === "waiting" ? "等你回应" : "";
    page.title = task.title; page.subtitle = [name, status].filter(Boolean).join(" · ");
    const panel = content.closest(".eis-page");
    const heading = panel?.querySelector<HTMLElement>(".eis-title"); if (heading) heading.textContent = page.title;
    const subtitle = panel?.querySelector<HTMLElement>(".eis-subtitle"); if (subtitle) subtitle.textContent = page.subtitle;
    messages(task.messages); tail.replaceChildren();
    const draft = task.draftContext;
    const selected = draft?.selectedProviderSettingsId && draft.selectedModel ? { providerSettingsId: draft.selectedProviderSettingsId, modelId: draft.selectedModel } : undefined;
    const recovery = toolCallRecoveryGuidance(state.interruption, host.settings().apiProviders, "iphone", selected);
    const explanation = recovery?.message ?? taskInterruptionExplanation(state.interruption, host.settings().settingsLanguage ?? "zh");
    const repeatedError = !!explanation && !!state.error && (interruptionErrorDetail(state.error) === state.interruption?.detail || !!recovery && state.error === toolCallTextFailureMessage(state.interruption?.toolCallTextFailure));
    errors.textContent = repeatedError ? "" : state.error; errors.hidden = repeatedError || !state.error;
    if (task.taskStatus === "interrupted" || state.interruption && !state.busy) {
      const box = shellElement(document, "section", "ip-task-stopbox"); box.setAttribute("aria-label", "任务中断记录");
      const line = shellElement(document, "div", "ip-task-interrupted"); const mark = shellElement(document, "span", "ip-icon"); setIcon(mark, "circle-pause"); mark.setAttribute("aria-hidden", "true"); line.append(mark);
      const at = state.interruption?.at ?? task.taskInterruptedAt;
      if (at !== undefined) { const time = shellElement(document, "time", "", `${formatMobileDateTime(at)} ${state.interruption ? interruptionReasons[state.interruption.reason] : "中断原因未确认"}`); time.dateTime = new Date(at).toISOString(); line.append(time); }
      else line.append(shellElement(document, "span", "", "已中断 · 时间未记录"));
      if (explanation) box.append(shellElement(document, "div", "ip-task-interrupted", explanation));
      else box.append(line, shellElement(document, "div", "ip-task-stage", `停在：${stageLabel(state.interruption?.stage ?? task.taskStage)}`));
      const actions = shellElement(document, "div", "ip-task-actions");
      const report = iPhoneAction(ctx, "上报问题", () => openMobileRunReport(host, taskId, "iphone", { document, open: config => ctx.shell.openSheet(config) }));
      report.dataset.action = "report-task"; actions.append(report);
      report.disabled = !!state.resuming || state.busy;
      const resume = iPhoneAction(ctx, state.resuming ? "准备中…" : recovery?.buttonLabel ?? "继续", () => { composer.element.dispatchEvent(new document.defaultView!.Event("ip-resume-task")); }, undefined, true);
      resume.dataset.action = "resume-task";
      resume.disabled = !!state.resuming || state.busy; actions.append(resume); box.append(actions); tail.append(box);
    } else if (state.busy && state.interaction?.status !== "pending") {
      const live = shellElement(document, "div", "ip-task-live"); const mark = shellElement(document, "span", "ip-icon"); setIcon(mark, "loader-circle"); mark.setAttribute("aria-hidden", "true"); live.append(mark, shellElement(document, "span", "", task.taskStage ? stageLabel(task.taskStage) : "正在进行")); tail.append(live);
    } else if (task.taskStatus === "waiting" && !state.busy) tail.append(shellElement(document, "div", "ip-task-stage", "当前问题已失效。"));
    renderLive(); renderCompany();
    if (ctx.shell.activePageId === page.id) markRead();
  };
  refresh();
  const unsubscribe = host.runtime.subscribe(id => { if (id === taskId) refresh(); });
  const unsubscribeLive = host.runtime.subscribeLive(id => { if (id === taskId && !disposed) renderLive(); });
  const unsubscribeWorkbench = host.workbench.subscribe(refresh);
  const unsubscribeCompany = host.company?.()?.subscribe(() => { if (!disposed) renderCompany(); }) ?? (() => {});
  const unsubscribeWorkers = host.runtime.subscribe(id => { if (id !== taskId && !disposed) renderCompany(); });
  page.dispose = () => { if (disposed) return; disposed = true; unsubscribe(); unsubscribeLive(); unsubscribeWorkbench(); unsubscribeCompany(); unsubscribeWorkers(); question.dispose(); composer.dispose(); };
  return page;
}
