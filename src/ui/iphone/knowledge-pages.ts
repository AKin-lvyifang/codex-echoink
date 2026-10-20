import type { KnowledgePageSnapshot, KnowledgePageDirectory } from "../../home/knowledge-page-data";
import type { KnowledgeBaseMaintenanceHistoryEntry } from "../../settings/settings";
import type { KnowledgeMaintenanceRecord } from "../../knowledge-base/maintenance-record";
import { formatMobileDate, formatMobileDateTime } from "../../mobile/date-display";
import type { MobileShellPage } from "../mobile/shell-types";
import type { IPhonePageContext } from "./workbench-contract";
import { iphoneElement as el, iphoneButton, iphoneIcon, iphoneAvatar } from "./workbench-elements";

const t = (ctx: IPhonePageContext, zh: string, en: string): string => ctx.host.settings().settingsLanguage === "en" ? en : zh;
type Issue = "isolated" | "sources";
const message = (error: unknown): string => error !== null && typeof error === "object" && "message" in error && typeof error.message === "string" ? error.message : typeof error === "string" ? error : "读取失败";
const roleLabel = (ctx: IPhonePageContext, role: KnowledgePageDirectory["role"]): string => ({ raw: t(ctx, "资料来源", "Sources"), wiki: t(ctx, "知识成果", "Knowledge"), projects: t(ctx, "项目", "Projects"), inbox: t(ctx, "收件箱", "Inbox") })[role];

/** A retained iPhone reader. Navigation and display never execute maintenance. */
class KnowledgeReader {
  readonly content: HTMLElement;
  readonly body: HTMLFieldSetElement;
  readonly feedback: HTMLElement;
  readonly confirmation: HTMLElement;
  readonly page: MobileShellPage;
  alive = true;
  busy = false;
  onIdle: () => void = () => {};
  private generation = 0;
  private request?: AbortController;
  private readonly cleanups: (() => void)[] = [];
  constructor(readonly ctx: IPhonePageContext, id: string, title: string) {
    this.content = el(ctx.document, "div", "ip-knowledge-page"); this.body = el(ctx.document, "fieldset", "ip-knowledge-body"); this.feedback = el(ctx.document, "div", "ip-knowledge-feedback"); this.feedback.hidden = true; this.confirmation = el(ctx.document, "div", "ip-knowledge-confirmation"); this.content.append(this.body, this.feedback, this.confirmation);
    this.page = { id, title, content: this.content, canLeave: () => !this.busy, dispose: () => { this.alive = false; this.generation++; this.request?.abort(); this.cleanups.forEach(cleanup => cleanup()); } };
  }
  cleanup(cleanup: () => void): void { this.cleanups.push(cleanup); }
  async push(): Promise<void> { if (!await this.ctx.shell.push(this.page)) this.page.dispose?.(); }
  button(parent: HTMLElement, title: string, action: () => unknown, primary = false): HTMLButtonElement {
    const button = iphoneButton(this.ctx.document, title, () => { if (!button.disabled) void Promise.resolve().then(action).catch(error => this.error(error)); }, primary ? "is-primary" : ""); parent.append(button); return button;
  }
  row(parent: HTMLElement, title: string, detail: string, value: string, action: () => unknown, icon?: string, navigation = true): HTMLButtonElement {
    const row = el(this.ctx.document, "button", "ip-knowledge-row"); row.type = "button"; if (icon) row.append(iphoneIcon(this.ctx.document, icon)); const copy = el(this.ctx.document, "span", "ip-knowledge-copy"); copy.append(el(this.ctx.document, "span", "ip-knowledge-row-title", title)); if (detail) copy.append(el(this.ctx.document, "span", "ip-knowledge-sub", detail)); row.append(copy); if (value) row.append(el(this.ctx.document, "span", "ip-knowledge-number", value)); if (navigation) row.append(iphoneIcon(this.ctx.document, "chevron-right"));  row.addEventListener("click", () => { void Promise.resolve().then(action).catch(error => this.error(error)); }); parent.append(row); return row;
  }
  section(parent: HTMLElement, title: string, key: string): HTMLElement { const section = el(this.ctx.document, "section", `ip-knowledge-section ip-knowledge-${key}`), head = el(this.ctx.document, "div", "ip-knowledge-section-head"); head.append(el(this.ctx.document, "h2", "", title)); section.append(head); parent.append(section); return section; }
  group(parent: HTMLElement): HTMLElement { const group = el(this.ctx.document, "div", "ip-knowledge-group"); parent.append(group); return group; }
  empty(parent: HTMLElement, text: string): void { parent.append(el(this.ctx.document, "p", "ip-knowledge-empty", text)); }
  error(error?: unknown): void { if (!this.alive) return; this.feedback.setAttribute("role", "alert"); this.feedback.textContent = error === undefined ? "" : message(error); this.feedback.hidden = error === undefined; }
  region(parent: HTMLElement, error?: string): void { if (error) { const node = el(this.ctx.document, "p", "ip-knowledge-region-error", error); node.setAttribute("role", "alert"); parent.append(node); } }
  async read<T>(load: (signal: AbortSignal) => Promise<T>, render: (value: T) => void): Promise<void> {
    const ticket = ++this.generation; this.request?.abort(); this.feedback.setAttribute("role", "status"); this.feedback.textContent = t(this.ctx, "正在读取…", "Loading…"); this.feedback.hidden = false; const controller = new AbortController(); this.request = controller;
    try { const data = await load(controller.signal); if (this.alive && ticket === this.generation) { this.error(); render(data); } }
    catch (error) { if (this.alive && ticket === this.generation && !controller.signal.aborted) { this.error(t(this.ctx, "读取失败，当前内容未更新。", "Read failed. Displayed content has not been updated.") + " " + message(error)); this.feedback.append(this.makeRetry(() => this.read(load, render))); } }
  }
  private makeRetry(action: () => Promise<void>): HTMLButtonElement { const parent = el(this.ctx.document, "div", ""); return this.button(parent, t(this.ctx, "重新读取", "Reload"), action); }
  async run(action: () => Promise<void>): Promise<boolean> {
    if (!this.alive || this.busy) return false; this.busy = true; this.generation++; this.request?.abort(); this.body.disabled = true; this.content.setAttribute("aria-busy", "true"); this.error();
    try { await action(); return this.alive; } catch (error) { this.error(error); return false; } finally { this.busy = false; if (this.alive) { this.body.disabled = false; this.content.removeAttribute("aria-busy"); this.onIdle(); } }
  }
}

export async function openIPhoneKnowledge(ctx: IPhonePageContext): Promise<void> {
  const id = "iphone-module-knowledge"; if (ctx.shell.hasPage(id)) { await ctx.shell.backTo(id); return; }
  const view = new KnowledgeReader(ctx, id, t(ctx, "知识库", "Knowledge")), port = ctx.host.services.knowledgePage; let snapshot: KnowledgePageSnapshot | undefined;
  const actions = el(ctx.document, "div", "ip-knowledge-header-actions"); view.page.actions = actions;
  const ownerButton = view.button(actions, "", () => handoff(view, undefined, false, accept), true);
  const initialOwner = ctx.host.services.modules.owner("knowledge-base"); ownerButton.querySelector(".ip-button-visible")!.replaceChildren(iphoneAvatar(ctx.document, initialOwner), el(ctx.document, "span", "", t(ctx, `交给${initialOwner.name}`, `Ask ${initialOwner.name}`)));
  const accept = (next: KnowledgePageSnapshot) => { snapshot = next; render(); };
  const render = () => {
    if (!view.alive || !snapshot) return; const data = snapshot, owner = ctx.host.services.modules.owner("knowledge-base"); ownerButton.querySelector(".ip-button-visible")!.replaceChildren(iphoneAvatar(ctx.document, owner), el(ctx.document, "span", "", t(ctx, `交给${owner.name}`, `Ask ${owner.name}`))); view.body.replaceChildren();
    const stats = el(ctx.document, "div", "ip-knowledge-stats"), validHealth = data.health && !data.errors.health && !["unavailable", "uninitialized"].includes(data.health.assessment) && Number.isFinite(data.health.score);
    for (const [label, value] of [[t(ctx, "知识健康", "Knowledge health"), validHealth ? String(data.health!.score) : "—"], [t(ctx, "本周新增", "Added this week"), data.weekly.added === null || data.weekly.unknownCreatedAtCount > 0 ? "—" : t(ctx, `+${data.weekly.added} 篇`, `+${data.weekly.added} notes`)], [t(ctx, "本周整理", "Organized this week"), data.weekly.organized === null || data.errors.history ? "—" : t(ctx, `${data.weekly.organized} 次`, `${data.weekly.organized} times`)]]) { const stat = el(ctx.document, "div", "ip-knowledge-stat"); stat.append(el(ctx.document, "strong", "", value), el(ctx.document, "span", "", label)); stats.append(stat); } view.body.append(stats); view.region(stats, data.errors.health);
    const activity = view.section(view.body, t(ctx, "新增与整理", "Additions and organization"), "activity"); activity.querySelector(".ip-knowledge-section-head")!.append(el(ctx.document, "span", "ip-knowledge-sub", t(ctx, "近 20 周", "Past 20 weeks"))); renderActivity(view, activity, data, 140); view.region(activity, data.errors.activity); if (data.weekly.unknownCreatedAtCount) view.region(activity, t(ctx, "部分笔记创建时间无法核实。", "Some note creation dates could not be verified."));
    const directories = view.section(view.body, t(ctx, "目录", "Folders"), "directories"); view.button(directories.querySelector(".ip-knowledge-section-head")!, t(ctx, "图谱", "Graph"), () => view.run(() => port.openGraph())).classList.add("is-text"); const directoryRows = view.group(directories);
    for (const directory of data.directories) { const root = directory.roots.length === 1 ? directory.roots[0] : undefined; view.row(directoryRows, root?.path || roleLabel(ctx, directory.role), directoryState(ctx, directory), directory.count === null ? "—" : `${directory.count} ${directory.unit}`, () => openDirectory(view, directory), "folder", false); } view.region(directoryRows, data.errors.directories);
    const issues = view.section(view.body, t(ctx, "可以处理", "Ready to handle"), "issues"); const issueRows = view.group(issues); let found = 0;
    for (const issue of ["isolated", "sources"] as const) { const paths = issuePaths(data, issue); if (!paths.length) continue; found++; const row = el(ctx.document, "div", "ip-knowledge-issue-row"); view.row(row, issueTitle(ctx, issue, paths.length), "", "", () => openIssue(view, issue), undefined, false); view.button(row, t(ctx, `交给${owner.name}`, `Ask ${owner.name}`), () => handoff(view, issue, false, accept)); issueRows.append(row); }
    issues.querySelector(".ip-knowledge-section-head")!.append(el(ctx.document, "span", "ip-knowledge-sub", String(found)));
    view.region(issueRows, data.errors.links || (data.links.state !== "ready" ? data.links.reason || t(ctx, "链接还在解析。", "Links are still resolving.") : undefined)); view.region(issueRows, data.errors.sources || (data.sources.state !== "ready" ? t(ctx, "部分来源尚无法核实。", "Some sources could not be verified.") : undefined)); if (!found && data.links.state === "ready" && data.sources.state === "ready" && !data.errors.links && !data.errors.sources) view.empty(issueRows, t(ctx, "暂时没有可处理的问题", "No issues to handle right now"));
    const recent = view.section(view.body, t(ctx, "最近整理", "Recent organization"), "recent"); view.button(recent.querySelector(".ip-knowledge-section-head")!, t(ctx, "查看全部", "View all"), () => openHistory(view)); const recentRows = view.group(recent); renderHistoryRows(view, recentRows, sortedHistory(data).slice(0, 3), false); view.region(recentRows, data.errors.history); if (!data.maintenanceHistory.length && !data.errors.history) view.empty(recentRows, t(ctx, "暂无整理记录", "No organization records yet"));
  };
  let pending = false; const reload = () => { if (view.busy) { pending = true; return; } pending = false; void view.read(signal => port.read(signal), accept); }; view.onIdle = () => { if (pending) reload(); }; view.cleanup(port.subscribe(reload)); view.cleanup(ctx.host.workbench.subscribe(() => { if (snapshot) render(); })); await view.push(); reload();
}

function directoryState(ctx: IPhonePageContext, directory: KnowledgePageDirectory): string {
  const states = { disabled: t(ctx, "未启用", "Disabled"), unbound: t(ctx, "尚未绑定", "Not configured"), invalid: t(ctx, "位置失效", "Unavailable folder"), partial: t(ctx, "部分目录未读完", "Some folders could not be read"), unavailable: t(ctx, "目录暂时读不到", "Folders could not be read"), ready: "" };
  return states[directory.state] || (directory.latestMtime > 0 ? formatMobileDateTime(directory.latestMtime, Date.now(), ctx.host.settings().settingsLanguage) : "");
}
function renderActivity(view: KnowledgeReader, parent: HTMLElement, data: KnowledgePageSnapshot, days: number): void {
  const grid = el(view.ctx.document, "div", "ip-knowledge-heat-grid"), now = new Date(data.generatedAt), values = new Map(data.activityDays.map(day => [day.date, day])); grid.setAttribute("role", "img"); grid.setAttribute("aria-label", t(view.ctx, "新增与整理活动", "Knowledge activity"));
  const weekday = (now.getDay() + 6) % 7, weeks = days === 140 ? 20 : Math.ceil((days + 6 - weekday) / 7);
  for (let week = 0; week < weeks; week++) for (let row = 0; row < 7; row++) {
    const offset = week * 7 + weekday - row, date = new Date(now.getFullYear(), now.getMonth(), now.getDate() - offset, 12), key = formatMobileDate(date), activity = values.get(key), outside = offset < 0 || offset >= days, unknown = !!data.errors.activity || data.weekly.unknownCreatedAtCount > 0, value = activity?.total ?? 0;
    const cell = el(view.ctx.document, "span", `ip-knowledge-heat-cell ${outside ? "is-outside" : unknown ? "is-unknown" : `level-${Math.min(4, value)}`}`); cell.dataset.date = key;
    if (outside) cell.setAttribute("aria-hidden", "true");
    else { const label = unknown ? t(view.ctx, `${key} · 记录尚无法核实`, `${key} · Activity unverified`) : t(view.ctx, `${key} · 新增 ${activity?.added ?? 0} · 整理 ${activity?.organized ?? 0}`, `${key} · Added ${activity?.added ?? 0} · Organized ${activity?.organized ?? 0}`); cell.title = label; cell.setAttribute("aria-label", label); }
    grid.append(cell);
  } parent.append(grid);
}
function issuePaths(data: KnowledgePageSnapshot, issue: Issue): string[] { return issue === "isolated" ? data.links.state === "ready" && !data.errors.links ? data.links.isolatedPaths : [] : data.sources.state !== "unknown" && !data.errors.sources ? data.sources.missing.map(item => item.path) : []; }
function issueTitle(ctx: IPhonePageContext, issue: Issue, count: number): string { return issue === "isolated" ? t(ctx, `${count} 篇笔记没有任何链接`, `${count} notes have no links`) : t(ctx, `${count} 篇知识成果的来源文件找不到了`, `Source files are missing for ${count} knowledge notes`); }
async function handoff(view: KnowledgeReader, issue: Issue | undefined, replace: boolean, accept?: (snapshot: KnowledgePageSnapshot) => void): Promise<void> {
  const { ctx } = view; let result: { agentId: string; conflict: boolean } | undefined;
  const ok = await view.run(async () => { const latest = await ctx.host.services.knowledgePage.read(); if (!view.alive) return; accept?.(latest); const paths = issue ? issuePaths(latest, issue) : latest.directories.flatMap(directory => directory.roots.filter(root => root.state === "ready").map(root => root.path));
    if (issue && !paths.length) throw new Error(t(ctx, "问题范围已变化或暂时无法核实，请重新读取。", "The issue changed or could not be verified. Reload.")); const prompt = issue ? issue === "isolated" ? t(ctx, "帮我看看这些没有任何链接的笔记", "Help me review these notes with no links") : t(ctx, "帮我核对这些知识成果的来源文件", "Help me verify the source files of these knowledge notes") : t(ctx, "帮我看看当前知识库", "Help me review the current knowledge base"); const objects = paths.map(path => { const missing = issue === "sources" ? latest.sources.missing.find(item => item.path === path)?.sourcePaths ?? [] : []; return `- ${path}${missing.map(source => `\n  ${t(ctx, "原来源", "Original source")}：${source}`).join("")}`; }).join("\n"); result = await ctx.host.services.modules.handoff("knowledge-base", `${prompt}\n\n${objects}`, replace);
  }); if (!ok || !view.alive || !result) return;
  if (result.conflict) { const box = el(ctx.document, "div", "ip-knowledge-confirm", t(ctx, "这个 Agent 已有草稿，要替换吗？", "This Agent already has a draft. Replace it?")); view.button(box, t(ctx, "取消", "Cancel"), () => view.confirmation.replaceChildren()); view.button(box, t(ctx, "替换草稿", "Replace draft"), () => handoff(view, issue, true, accept), true); view.confirmation.replaceChildren(box); }
  else { view.confirmation.replaceChildren(); await ctx.navigate({ kind: "agent", agentId: result.agentId }); }
}

async function openDirectory(parent: KnowledgeReader, directory: KnowledgePageDirectory): Promise<void> {
  const { ctx } = parent; if (directory.roots.length === 1) return openFolder(ctx, directory.roots[0].path);
  const view = new KnowledgeReader(ctx, `iphone-knowledge-roots-${directory.role}`, roleLabel(ctx, directory.role)); const roots = view.group(view.body); for (const root of directory.roots) view.row(roots, root.path, root.error || (root.state === "ready" ? "" : directoryState(ctx, { ...directory, state: root.state })), root.count === null ? "—" : String(root.count), () => openFolder(ctx, root.path), "folder"); if (!directory.roots.length) view.empty(roots, directoryState(ctx, directory)); await view.push();
}
async function openFolder(ctx: IPhonePageContext, path: string): Promise<void> {
  const view = new KnowledgeReader(ctx, `iphone-knowledge-folder-${path}`, path), search = el(ctx.document, "input", "ip-knowledge-search"), list = el(ctx.document, "div", "ip-knowledge-list"), pagination = el(ctx.document, "div", "ip-knowledge-pagination"); search.type = "search"; search.setAttribute("aria-label", t(ctx, "搜索文件", "Search files")); view.body.append(search, list, pagination); let files: { path: string; title: string; mtime: number }[] | undefined, page = 1;
  const render = () => { if (!files || !view.alive) return; list.replaceChildren(); const filtered = files.filter(file => `${file.title} ${file.path}`.toLocaleLowerCase().includes(search.value.toLocaleLowerCase())), pages = Math.max(1, Math.ceil(filtered.length / 20)); page = Math.min(page, pages); for (const file of filtered.slice((page - 1) * 20, page * 20)) view.row(list, file.title, file.path, formatMobileDateTime(file.mtime, Date.now(), ctx.host.settings().settingsLanguage), () => ctx.host.openNote(file.path), "file-text"); if (!filtered.length) view.empty(list, t(ctx, "没有匹配的文件", "No matching files")); renderPagination(view, pagination, page, pages, value => { page = value; render(); }); };
  const reload = () => { void view.read(signal => ctx.host.services.knowledgePage.readFolder(path, signal), data => { files = data.files; render(); }); }; search.addEventListener("input", () => { page = 1; render(); }); view.cleanup(ctx.host.services.knowledgePage.subscribe(reload)); await view.push(); reload();
}
async function openIssue(parent: KnowledgeReader, issue: Issue): Promise<void> {
  const { ctx } = parent, view = new KnowledgeReader(ctx, `iphone-knowledge-issue-${issue}`, t(ctx, "可以处理", "Ready to handle")), list = el(ctx.document, "div", "ip-knowledge-list"), pagination = el(ctx.document, "div", "ip-knowledge-pagination"); view.body.append(list, pagination); let data: KnowledgePageSnapshot | undefined, page = 1;
  const render = () => { if (!data) return; list.replaceChildren(); const paths = issuePaths(data, issue), pages = Math.max(1, Math.ceil(paths.length / 20)); page = Math.min(page, pages); for (const path of paths.slice((page - 1) * 20, page * 20)) view.row(list, path, issue === "sources" ? data.sources.missing.find(item => item.path === path)?.sourcePaths.join(" · ") ?? "" : "", "", () => ctx.host.openNote(path)); if (!paths.length) view.empty(list, t(ctx, "问题范围已更新", "The issue scope has changed")); view.region(list, issue === "isolated" ? data.errors.links || (data.links.state !== "ready" ? data.links.reason : undefined) : data.errors.sources || (data.sources.state === "unknown" ? t(ctx, "来源尚无法核实", "Sources could not be verified") : undefined)); renderPagination(view, pagination, page, pages, value => { page = value; render(); }); };
  view.button(view.body, t(ctx, "交给负责人", "Ask the module owner"), () => handoff(view, issue, false, value => { data = value; render(); }), true); await view.push(); await view.read(signal => ctx.host.services.knowledgePage.read(signal), value => { data = value; render(); });
}
function sortedHistory(data: KnowledgePageSnapshot): KnowledgeBaseMaintenanceHistoryEntry[] { return [...data.maintenanceHistory].sort((a, b) => b.at - a.at); }
function resultLabel(ctx: IPhonePageContext, status: string): string { return ({ completed: t(ctx, "已完成", "Completed"), success: t(ctx, "已完成", "Completed"), partial: t(ctx, "部分完成", "Partially completed"), noop: t(ctx, "无变化", "No changes"), failed: t(ctx, "失败", "Failed"), canceled: t(ctx, "已取消", "Cancelled"), cancelled: t(ctx, "已取消", "Cancelled"), write_uncertain: t(ctx, "写入结果待核对", "Write result unconfirmed") } as Record<string, string>)[status] ?? t(ctx, "待核对", "Needs review"); }
function historyTitle(ctx: IPhonePageContext, item: KnowledgeBaseMaintenanceHistoryEntry): string { return ({ maintain: t(ctx, "知识库整理", "Knowledge organization"), reingest: t(ctx, "重新提炼", "Knowledge refresh"), inbox: t(ctx, "收件箱整理", "Inbox organization"), outputs: t(ctx, "成果整理", "Output organization"), lint: t(ctx, "知识库检查", "Knowledge check"), unknown: t(ctx, "整理记录", "Organization record") })[item.mode]; }
function renderHistoryRows(view: KnowledgeReader, parent: HTMLElement, entries: KnowledgeBaseMaintenanceHistoryEntry[], navigation = true): void { for (const item of entries) view.row(parent, historyTitle(view.ctx, item), resultLabel(view.ctx, item.resultStatus ?? (item.completion === "partial" ? "partial" : item.completion === "noop" ? "noop" : item.status)), formatMobileDateTime(item.at || item.date, Date.now(), view.ctx.host.settings().settingsLanguage), () => openRecord(view.ctx, item), "history", navigation); }
async function openHistory(parent: KnowledgeReader): Promise<void> {
  const { ctx } = parent, view = new KnowledgeReader(ctx, "iphone-knowledge-history", t(ctx, "整理记录", "Organization records")), list = el(ctx.document, "div", "ip-knowledge-list"), pagination = el(ctx.document, "div", "ip-knowledge-pagination"); view.body.append(list, pagination); let data: KnowledgePageSnapshot | undefined, page = 1;
  const render = () => { if (!data || !view.alive) return; list.replaceChildren(); const entries = sortedHistory(data), pages = Math.max(1, Math.ceil(entries.length / 20)); page = Math.min(page, pages); renderHistoryRows(view, list, entries.slice((page - 1) * 20, page * 20)); view.region(list, data.errors.history); if (!entries.length && !data.errors.history) view.empty(list, t(ctx, "暂无整理记录", "No organization records yet")); renderPagination(view, pagination, page, pages, value => { page = value; render(); }); };
  await view.push(); await view.read(signal => ctx.host.services.knowledgePage.read(signal), value => { data = value; render(); });
}
async function openRecord(ctx: IPhonePageContext, entry: KnowledgeBaseMaintenanceHistoryEntry): Promise<void> {
  const view = new KnowledgeReader(ctx, `iphone-knowledge-record-${entry.recordId ?? entry.runId ?? entry.at}`, historyTitle(ctx, entry)); view.body.append(el(ctx.document, "p", "ip-knowledge-record-status", resultLabel(ctx, entry.resultStatus ?? (entry.completion === "partial" ? "partial" : entry.completion === "noop" ? "noop" : entry.status))), el(ctx.document, "time", "ip-knowledge-sub", formatMobileDateTime(entry.at || entry.date, Date.now(), ctx.host.settings().settingsLanguage)));
  if (entry.reportPath) view.row(view.body, t(ctx, "打开整理报告", "Open organization report"), entry.reportPath, "", () => ctx.host.openNote(entry.reportPath), "file-text"); const detail = el(ctx.document, "div", "ip-knowledge-record-detail"); view.body.append(detail); await view.push();
  if (!entry.recordId) { view.empty(detail, t(ctx, "此记录未包含详细变更。", "This record has no detailed changes.")); return; }
  await view.read(() => ctx.host.services.knowledgePage.readRecord(entry.recordId!), record => renderRecord(view, detail, record));
}
function renderRecord(view: KnowledgeReader, parent: HTMLElement, record: KnowledgeMaintenanceRecord): void {
  const { ctx } = view; parent.replaceChildren(); const result = record.result; view.content.querySelector(".ip-knowledge-record-status")!.textContent = resultLabel(ctx, record.cancelled ? "cancelled" : result.status); if (record.summary) parent.append(el(ctx.document, "p", "", record.summary));
  const notes = view.section(parent, t(ctx, "整理结果", "Organization results"), "artifacts"); for (const note of result.notes) view.row(notes, note.title, `${t(ctx, note.operation === "created" ? "新建" : "更新", note.operation === "created" ? "Created" : "Updated")} · ${note.summary}`, note.path, () => ctx.host.openNote(note.path), "file-text"); if (!result.notes.length) view.empty(notes, t(ctx, "没有记录到产物变化", "No artifact changes were recorded")); for (const issue of result.issues) view.region(parent, [issue.path, issue.message].filter(Boolean).join(" · "));
  const sources = view.section(parent, t(ctx, "来源", "Sources"), "sources"); for (const source of record.sources) { view.row(sources, source.path, t(ctx, source.status === "processed" ? "已处理" : source.status === "failed" ? "读取失败" : "未读取", source.status === "processed" ? "Processed" : source.status === "failed" ? "Read failed" : "Not read"), "", () => ctx.host.openNote(source.path)); for (const path of source.evidencePaths) view.row(sources, path, t(ctx, "来源依据", "Source evidence"), "", () => ctx.host.openNote(path)); } if (!record.sources.length) view.empty(sources, t(ctx, "没有来源记录", "No sources recorded"));
  if (result.systemPaths.length || result.assessments.length) { const details = el(ctx.document, "details", "ip-knowledge-details"); details.append(el(ctx.document, "summary", "", t(ctx, "过程明细", "Process details"))); for (const path of result.systemPaths) view.row(details, path, "", "", () => ctx.host.openNote(path)); for (const assessment of result.assessments) { const item = el(ctx.document, "div", "ip-knowledge-assessment"); item.append(el(ctx.document, "p", "", assessment.claim), el(ctx.document, "p", "ip-knowledge-sub", `${assessment.asOf} · ${{ valid: t(ctx, "仍然有效", "Valid"), needs_supplement: t(ctx, "待补充", "Needs more evidence"), outdated: t(ctx, "已过时", "Outdated"), conflict: t(ctx, "有冲突", "Conflicting") }[assessment.status]} · ${assessment.verification === "unverified" ? t(ctx, "未验证", "Unverified") : assessment.verification === "local_verified" ? t(ctx, "本地已验证", "Locally verified") : t(ctx, "外部已验证", "Externally verified")}`)); for (const evidence of assessment.evidence) item.append(el(ctx.document, "p", "", evidence)); details.append(item); } parent.append(details); }
}
function renderPagination(view: KnowledgeReader, parent: HTMLElement, page: number, pages: number, change: (page: number) => void): void { parent.replaceChildren(); if (pages < 2) return; const previous = view.button(parent, t(view.ctx, "上一页", "Previous"), () => change(page - 1)), next = view.button(parent, t(view.ctx, "下一页", "Next"), () => change(page + 1)); previous.disabled = page === 1; next.disabled = page === pages; parent.replaceChildren(previous, el(view.ctx.document, "span", "", `${page}/${pages}`), next); }
