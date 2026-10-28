import { mobileReportActions, openMobileRunReport } from "../../run-reports/mobile-ui";
import { formatMobileDateTime } from "../../mobile/date-display";
import { setIcon } from "obsidian";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { MobileShellPage } from "../mobile/shell-types";
import { shellElement } from "../mobile/shell-controls";
import type { IPadPageContext } from "./workbench-contract";
import { createIPadComposer, createInlineQuestion, iPadAction } from "./composer";

const toolNames: Record<string, string> = { vault_search: "查找笔记", note_read: "读取笔记", note_create: "保存文档", memory_search: "查找记忆", memory_read: "读取记忆", memory_write: "保存记忆", user_question: "询问", task_update: "更新任务" };
const stages: Record<string, string> = { preparing: "准备上下文", context: "准备上下文", search: "检索资料", searching: "检索资料", summary: "整理历史", summarizing: "整理历史", model: "等待模型", tool: "执行工具", saving: "保存结果", question: "等待回应" };
const interruptionReasons = { app_backgrounded: "切到后台时中断", app_closed: "应用关闭时中断", plugin_disabled: "插件停用时中断", user_stopped: "已停止", run_failed: "运行出错时中断", process_unknown: "中断原因未确认", watchdog: "运行未正常结束" };
const stageLabel = (stage?: string) => !stage ? "阶段未确认" : stages[stage] ?? (/[\u4e00-\u9fff]/u.test(stage) ? stage : "阶段未确认");
const messageText = (message: AgentMessage): string => {
  if (!("content" in message)) return "";
  return typeof message.content === "string" ? message.content : message.content.filter(block => block.type === "text").map(block => block.text).join("\n");
};

export function createTaskPage(ctx: IPadPageContext, taskId: string): MobileShellPage {
  const { host, document } = ctx;
  const content = shellElement(document, "div", "pd-task-detail"); content.dataset.taskId = taskId;
  const stream = shellElement(document, "div", "pd-task-stream");
  const tail = shellElement(document, "div", "pd-task-tail"); tail.setAttribute("aria-live", "polite");
  const errors = shellElement(document, "div", "pd-task-error"); errors.setAttribute("role", "alert");
  const question = createInlineQuestion(ctx, taskId), composer = createIPadComposer(ctx, { taskId });
  content.append(stream, question.element, tail, errors);
  let disposed = false, messagesKey = "", lastRead = 0;
  const task = host.store.getSession(taskId);
  const page: MobileShellPage = { id: `task:${taskId}`, title: task?.title ?? "任务详情", content, footer: composer.element, canLeave: composer.canLeave };
  page.actions = mobileReportActions(ctx, taskId, "ipad");
  const markRead = () => {
    const task = host.store.getSession(taskId);
    if (!task?.unreadAnswerAt || task.unreadAnswerAt <= (task.lastReadAt ?? 0) || task.unreadAnswerAt <= lastRead) return;
    const boundary = task.unreadAnswerAt; lastRead = boundary;
    void host.store.updateSession(taskId, latest => { latest.lastReadAt = Math.max(latest.lastReadAt ?? 0, boundary); })
      .then(() => host.workbench.refreshTasks?.())
      .catch(error => { lastRead = 0; if (!disposed) ctx.error(error); });
  };
  const messages = (records: AgentMessage[]) => {
    const key = JSON.stringify([records, host.runtime.stateFor(taskId).interaction?.status]); if (key === messagesKey) return; messagesKey = key;
    const openTools = new Set(Array.from(stream.querySelectorAll<HTMLDetailsElement>("details[open]")).map(node => node.dataset.toolId));
    stream.replaceChildren();
    const results = new Map<string, AgentMessage>(), pending = new Map<string, string>(), attached = new Set<number>();
    const callKey = (messageIndex: number, blockIndex: number, id: string) => `call:${messageIndex}:${blockIndex}:${id}`;
    records.forEach((message, messageIndex) => {
      if (message.role === "assistant") message.content.forEach((block, blockIndex) => {
        // A reused ID starts a new occurrence; it cannot consume an older call's receipt.
        if (block.type === "toolCall") pending.set(block.id, callKey(messageIndex, blockIndex, block.id));
      });
      else if (message.role === "toolResult") {
        const key = pending.get(message.toolCallId);
        if (key) { results.set(key, message); attached.add(messageIndex); pending.delete(message.toolCallId); }
      }
    });
    const tool = (key: string, id: string, name: string, args: unknown, result?: AgentMessage) => {
      const details = shellElement(document, "details", "pd-task-tool"); details.dataset.toolId = key; details.dataset.toolCallId = id; details.open = openTools.has(key);
      const summary = shellElement(document, "summary", "");
      const icon = shellElement(document, "span", "pd-icon"); setIcon(icon, "wrench"); icon.setAttribute("aria-hidden", "true"); summary.append(icon, shellElement(document, "span", "", toolNames[name] ?? name));
      if (result && "isError" in result && result.isError) summary.append(shellElement(document, "span", "pd-tool-failed", "未完成"));
      else if (!result) summary.append(shellElement(document, "span", "pd-tool-pending", name === "user_question" && host.runtime.stateFor(taskId).interaction?.status === "pending" ? "等你回应" : "未记录结果"));
      const detail = shellElement(document, "div", "pd-task-tool-body");
      if (args !== undefined) { const input = shellElement(document, "pre", "pd-tool-input"); input.textContent = typeof args === "string" ? args : JSON.stringify(args, null, 2); detail.append(input); }
      if (result) { const output = shellElement(document, "div", "pd-tool-result markdown-rendered"); host.renderMarkdown(messageText(result), output, host.store.getSession(taskId)?.notePath); detail.append(output); }
      details.append(summary, detail); stream.append(details);
    };
    for (const [messageIndex, message] of records.entries()) {
      if (message.role === "toolResult") { if (!attached.has(messageIndex)) tool(`result:${messageIndex}:${message.toolCallId}`, message.toolCallId, message.toolName, undefined, message); continue; }
      const text = messageText(message);
      if (text) {
        const article = shellElement(document, "article", message.role === "user" ? "pd-task-user" : "pd-task-answer markdown-rendered");
        article.setAttribute("aria-label", message.role === "user" ? "你的消息" : "Agent 回复");
        if (message.role === "user") article.textContent = text; else host.renderMarkdown(text, article, host.store.getSession(taskId)?.notePath);
        stream.append(article);
      }
      if (message.role === "assistant") for (const [blockIndex, block] of message.content.entries()) if (block.type === "toolCall") {
        const key = callKey(messageIndex, blockIndex, block.id); tool(key, block.id, block.name, block.arguments, results.get(key));
      }
    }
    if (!records.length) stream.append(shellElement(document, "p", "pd-task-empty", "这件事还没有消息。"));
  };
  const refresh = () => {
    if (disposed) return;
    const task = host.store.getSession(taskId), state = host.runtime.stateFor(taskId);
    if (!task) { stream.replaceChildren(shellElement(document, "p", "pd-task-empty", "任务已不存在。")); tail.replaceChildren(); composer.element.hidden = true; return; }
    const name = host.settings().agentRegistry.agents.find(agent => agent.id === task.agentId)?.name ?? "Agent";
    const status = task.taskStatus === "completed" ? `已完成 · ${formatMobileDateTime(task.taskCompletedAt ?? task.updatedAt)}` : task.taskStatus === "interrupted" ? "已中断" : state.interaction?.status === "pending" ? "等你回应" : state.busy ? "进行中" : task.taskStatus === "waiting" ? "等你回应" : "";
    page.title = task.title; page.subtitle = [name, status].filter(Boolean).join(" · ");
    const panel = content.closest(".echoink-ipad-page");
    const heading = panel?.querySelector<HTMLElement>(".echoink-ipad-title"); if (heading) heading.textContent = page.title;
    const subtitle = panel?.querySelector<HTMLElement>(".echoink-ipad-subtitle"); if (subtitle) subtitle.textContent = page.subtitle;
    messages(task.messages); tail.replaceChildren(); errors.textContent = state.error; errors.hidden = !state.error;
    if (task.taskStatus === "interrupted" || state.interruption && !state.busy) {
      const box = shellElement(document, "section", "pd-task-stopbox"); box.setAttribute("aria-label", "任务中断记录");
      const line = shellElement(document, "div", "pd-task-interrupted"); const mark = shellElement(document, "span", "pd-icon"); setIcon(mark, "circle-pause"); mark.setAttribute("aria-hidden", "true"); line.append(mark);
      const at = state.interruption?.at ?? task.taskInterruptedAt;
      if (at !== undefined) { const time = shellElement(document, "time", "", `${formatMobileDateTime(at)} ${state.interruption ? interruptionReasons[state.interruption.reason] : "中断原因未确认"}`); time.dateTime = new Date(at).toISOString(); line.append(time); }
      else line.append(shellElement(document, "span", "", "已中断 · 时间未记录"));
      box.append(line, shellElement(document, "div", "pd-task-stage", `停在：${stageLabel(state.interruption?.stage ?? task.taskStage)}`));
      const actions = shellElement(document, "div", "pd-task-actions");
      const report = iPadAction(ctx, "上报问题", () => openMobileRunReport(host, taskId, "ipad", { document, open: config => ctx.shell.openSheet(config) }));
      report.dataset.action = "report-task"; actions.append(report);
      const resume = iPadAction(ctx, state.resuming ? "准备中…" : "继续", () => { composer.element.dispatchEvent(new document.defaultView!.Event("pd-resume-task")); }, undefined, true);
      resume.dataset.action = "resume-task";
      resume.disabled = !!state.resuming || state.busy; actions.append(resume); box.append(actions); tail.append(box);
    } else if (state.busy && state.interaction?.status !== "pending") {
      const live = shellElement(document, "div", "pd-task-live"); const mark = shellElement(document, "span", "pd-icon"); setIcon(mark, "loader-circle"); mark.setAttribute("aria-hidden", "true"); live.append(mark, shellElement(document, "span", "", task.taskStage ? stageLabel(task.taskStage) : "正在进行")); tail.append(live);
    } else if (task.taskStatus === "waiting" && !state.busy) tail.append(shellElement(document, "div", "pd-task-stage", "当前问题已失效。"));
    if (ctx.shell.activePageId === page.id) markRead();
  };
  refresh();
  const unsubscribe = host.runtime.subscribe(id => { if (id === taskId) refresh(); });
  const unsubscribeWorkbench = host.workbench.subscribe(refresh);
  page.dispose = () => { if (disposed) return; disposed = true; unsubscribe(); unsubscribeWorkbench(); question.dispose(); composer.dispose(); };
  return page;
}
