import { setIcon, type App } from "obsidian";
import { dispatchForPlanTask, projectMilestones } from "../company/logic";
import type { CompanyDocument, CompanyEventKind, CompanyProject } from "../company/types";
import { agentName, fileLabel, formatClock, formatDay, formatTime, latestDispatchOf, openOutput, outputExists, projectDispatches, projectOutputs,
  renderAvatar, renderDispatchStatus, renderMe, renderStatus, type AgentLookup, type ProjectOutput } from "./project-parts";

/** What the read-only tabs need; actions go back to the view. */
export interface ProjectTabContext {
  readonly app: App;
  readonly doc: CompanyDocument;
  readonly project: CompanyProject;
  readonly agent: AgentLookup;
  readonly expanded: string | null;
  openTask(taskId: string): void;
  openRouter(): void;
  toggleAgent(agentId: string): void;
}

const TAG: Partial<Record<CompanyEventKind, string>> = { goal: "目标", dispatch: "派活", report: "汇报", question: "提问", answer: "答", rework: "返工", close: "结项" };

function sectionHead(parent: HTMLElement, title: string, count?: string): void {
  const head = parent.createDiv({ cls: "echoink-project-section-head" });
  head.createEl("h2", { text: title });
  if (count) head.createSpan({ cls: "echoink-project-count", text: count });
}
/** "@name" in dispatch text stays bold so the reader sees who got the work. */
function mentionText(parent: HTMLElement, text: string): void {
  for (const part of text.split(/(@[^\s，。、]+)/u)) if (part) { if (part.startsWith("@")) parent.createEl("b", { text: part }); else parent.appendText(part); }
}

export function renderRecordTab(panel: HTMLElement, ctx: ProjectTabContext): void {
  const group = panel.createDiv({ cls: "echoink-project-group" });
  const feed = group.createDiv({ cls: "echoink-project-feed" });
  const events = ctx.doc.events.filter(e => e.projectId === ctx.project.id).sort((a, b) => a.at - b.at);
  if (!events.length) feed.createDiv({ cls: "echoink-project-muted", text: "还没有记录" });
  let lastDay = "";
  for (const event of events) {
    const day = formatDay(event.at);
    if (day !== lastDay) { feed.createDiv({ cls: "echoink-project-day", text: day }); lastDay = day; }
    if (event.kind === "system" || event.who === "system") {
      const line = feed.createDiv({ cls: "echoink-project-sys" });
      setIcon(line.createSpan({ cls: "echoink-project-sys-icon", attr: { "aria-hidden": "true" } }), "workflow");
      line.createSpan({ text: event.text });
      line.createSpan({ cls: "echoink-project-time", text: formatTime(event.at) });
      continue;
    }
    const me = event.who === "me";
    const msg = feed.createDiv({ cls: `echoink-project-msg${me ? " is-me" : ""}` });
    if (!me) renderAvatar(msg, ctx.agent(event.who));
    const body = msg.createDiv({ cls: "echoink-project-msg-body" });
    const name = body.createDiv({ cls: "echoink-project-msg-name" });
    if (!me) name.createEl("b", { text: agentName(ctx.agent, event.who) });
    const tag = TAG[event.kind];
    if (tag) name.createSpan({ cls: `echoink-project-tag${event.kind === "dispatch" || event.kind === "rework" ? " is-on" : ""}`, text: tag });
    name.createSpan({ cls: "echoink-project-time", text: formatTime(event.at) });
    const bubble = body.createDiv({ cls: "echoink-project-bubble" });
    mentionText(bubble, event.text);
    if (event.files?.length) {
      const files = bubble.createDiv({ cls: "echoink-project-files" });
      for (const path of event.files) {
        const button = files.createEl("button", { cls: "echoink-project-text-btn", attr: { type: "button" } });
        setIcon(button.createSpan({ cls: "echoink-project-btn-icon", attr: { "aria-hidden": "true" } }), "file-text");
        button.createSpan({ text: fileLabel(path) });
        button.onclick = () => openOutput(ctx.app, path, ctx.project.folder);
      }
    }
    if (me) renderMe(msg);
  }
  const foot = group.createDiv({ cls: "echoink-project-foot" });
  setIcon(foot.createSpan({ cls: "echoink-project-btn-icon", attr: { "aria-hidden": "true" } }), "message-circle");
  foot.createSpan({ text: "只读。要调整，就在这个项目的会话卡片里对总助说" });
  const open = foot.createEl("button", { cls: "echoink-project-text-btn", attr: { type: "button" } });
  setIcon(open.createSpan({ cls: "echoink-project-btn-icon", attr: { "aria-hidden": "true" } }), "arrow-right");
  open.createSpan({ text: "打开卡片" });
  open.onclick = () => ctx.openRouter();
}

export function renderTaskTab(panel: HTMLElement, ctx: ProjectTabContext): void {
  const { doc, project } = ctx;
  const rows = panel.createDiv({ cls: "echoink-project-rows" });
  const agentIds = [...new Set(project.plan.map(t => t.agentId))];
  if (!agentIds.length) rows.createDiv({ cls: "echoink-project-row echoink-project-muted", text: "开工卡里还没有任务" });
  const label = (id: string) => project.plan.find(t => t.id === id)?.label ?? id;
  for (const agentId of agentIds) {
    const tasks = project.plan.filter(t => t.agentId === agentId);
    const latest = latestDispatchOf(doc, project.id, agentId);
    const all = projectDispatches(doc, project.id).filter(d => d.agentId === agentId);
    const open = ctx.expanded === agentId;
    const row = rows.createEl("button", { cls: `echoink-project-row is-click${open ? " is-selected" : ""}`, attr: { type: "button", "aria-expanded": String(open) } });
    row.onclick = () => ctx.toggleAgent(agentId);
    renderAvatar(row, ctx.agent(agentId));
    const text = row.createSpan({ cls: "echoink-project-grow" });
    const head = text.createSpan({ cls: "echoink-project-ellip" });
    head.createEl("b", { text: agentName(ctx.agent, agentId) });
    head.appendText(` · ${project.roles[agentId] || tasks.map(t => t.label).join("、")}`);
    const waitingOn = tasks.flatMap(t => dispatchForPlanTask(doc, project.id, t.id) ? [] : t.dependsOn)
      .filter(dep => dispatchForPlanTask(doc, project.id, dep)?.status !== "done");
    const sub = text.createSpan({ cls: "echoink-project-sub echoink-project-ellip" });
    const output = latest?.status === "done" ? latest.report?.outputs[0] : undefined;
    if (output) { setIcon(sub.createSpan({ cls: "echoink-project-btn-icon", attr: { "aria-hidden": "true" } }), "file-text"); sub.appendText(fileLabel(output)); }
    else if (!latest && waitingOn.length) sub.setText(`等「${[...new Set(waitingOn)].map(label).join("」「")}」`);
    else sub.setText(latest?.report?.summary || tasks.map(t => t.brief).join("；"));
    row.createSpan({ cls: "echoink-project-count", text: `${all.length} 个任务会话` });
    renderDispatchStatus(row, latest?.status);
    setIcon(row.createSpan({ cls: "echoink-project-chevron", attr: { "aria-hidden": "true" } }), open ? "chevron-up" : "chevron-down");
    if (!open) continue;
    const list = rows.createDiv({ cls: "echoink-project-wlist" });
    if (!all.length) list.createDiv({ cls: "echoink-project-sub", text: waitingOn.length ? `还没派到，等「${[...new Set(waitingOn)].map(label).join("」「")}」` : "还没派到" });
    for (const d of all) {
      const item = list.createEl("button", { cls: "echoink-project-wrow", attr: { type: "button" } });
      item.onclick = () => ctx.openTask(d.id);
      setIcon(item.createSpan({ cls: "echoink-project-btn-icon", attr: { "aria-hidden": "true" } }), "message-square");
      item.createSpan({ cls: "echoink-project-grow echoink-project-ellip", text: d.brief.replace(/\s+/gu, " ") });
      renderDispatchStatus(item, d.status);
      item.createSpan({ cls: "echoink-project-time", text: formatClock(d.startedAt ?? d.createdAt) });
    }
  }
}

export function renderMilestoneTab(panel: HTMLElement, ctx: ProjectTabContext): void {
  const { project } = ctx;
  const steps = panel.createDiv({ cls: "echoink-project-steps" });
  const milestones = projectMilestones(ctx.doc, project, id => agentName(ctx.agent, id));
  milestones.forEach((m, index) => {
    const tone = m.state === "done" ? "is-done" : m.state === "todo" ? "is-todo" : "is-current";
    const step = steps.createDiv({ cls: `echoink-project-step ${tone}` });
    const rail = step.createDiv({ cls: "echoink-project-rail" });
    const node = rail.createSpan({ cls: "echoink-project-node" });
    if (m.state === "done") setIcon(node, "check"); else node.setText(String(index + 1));
    if (index < milestones.length - 1) rail.createEl("i", { cls: m.state === "done" ? "is-on" : "" });
    const body = step.createDiv({ cls: "echoink-project-step-body" });
    const head = body.createDiv({ cls: "echoink-project-step-head" });
    head.createEl("b", { text: m.title });
    const avatars = head.createSpan({ cls: "echoink-project-avatars" });
    for (const id of m.agentIds) renderAvatar(avatars, ctx.agent(id), true);
    // Same as the Demo: the filled node already says done, so the status is text only.
    if (m.state === "done") head.createSpan({ cls: "echoink-project-status", text: m.doneAt ? `已完成 · ${formatClock(m.doneAt)}` : "已完成" });
    else if (m.state === "waiting") renderStatus(head, "hand", "等你定", "wait");
    else if (m.state === "current") renderStatus(head, "loader-circle", "进行中", "run");
    else head.createSpan({ cls: "echoink-project-status", text: m.title === "验收结项" && project.dueLabel ? `计划 ${project.dueLabel}` : "计划" });
    const labels = m.taskIds.map(id => project.plan.find(t => t.id === id)?.label).filter(Boolean);
    if (labels.length) body.createDiv({ cls: "echoink-project-sub", text: labels.join("、") });
    if (m.handoff) {
      const handoff = body.createDiv({ cls: "echoink-project-handoff" });
      setIcon(handoff.createSpan({ cls: "echoink-project-btn-icon", attr: { "aria-hidden": "true" } }), "corner-down-right");
      handoff.createSpan({ text: m.handoff });
    }
  });
}

export function renderOutputTab(panel: HTMLElement, ctx: ProjectTabContext): void {
  const { deliverables, process } = projectOutputs(ctx.doc, ctx.project);
  const block = (title: string, items: ProjectOutput[], count: string, empty: string) => {
    const section = panel.createEl("section", { cls: "echoink-project-section" });
    sectionHead(section, title, count);
    const rows = section.createDiv({ cls: "echoink-project-rows" });
    if (!items.length) rows.createDiv({ cls: "echoink-project-row echoink-project-muted", text: empty });
    for (const item of items) {
      const exists = outputExists(ctx.app, item.path, ctx.project.folder);
      const row = rows.createEl("button", { cls: `echoink-project-row${exists ? " is-click" : ""}`, attr: { type: "button", "aria-label": `${fileLabel(item.path)} · ${item.path}` } });
      row.disabled = !exists;
      row.onclick = () => openOutput(ctx.app, item.path, ctx.project.folder);
      setIcon(row.createSpan({ cls: "echoink-project-lead", attr: { "aria-hidden": "true" } }), exists ? "file-text" : "file-x");
      row.createSpan({ cls: "echoink-project-grow echoink-project-ellip", text: fileLabel(item.path) });
      renderAvatar(row, ctx.agent(item.agentId), true);
      row.createSpan({ cls: "echoink-project-time", text: exists ? formatClock(item.at) : "文件不在了" });
    }
  };
  block("交付物", deliverables, String(deliverables.length), "最后一步交了才有交付物");
  block("过程文件", process, ctx.project.folder ? `${ctx.project.folder}/` : String(process.length), "还没有过程文件");
}
