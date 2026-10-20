import { Notice, Platform, TFile, normalizePath, setIcon, type App } from "obsidian";
import type { KnowledgeMaintenanceRecord } from "../knowledge-base/maintenance-record";
import type { KnowledgeBaseMaintenanceHistoryEntry } from "./settings";
import { OriginSetting } from "./origin-setting";
import { createOriginInput, createOriginButton, createOriginPagination, disposeOriginControls } from "./origin-controls";
import { applySettingsRow, createSettingsPage, createSettingsGroup, createSettingsSection } from "./settings-v2";

export interface KnowledgeMaintenanceHistoryState {
  date: string;
  page: number;
  listScroll: number;
}

export interface KnowledgeMaintenanceHistoryListOptions {
  zh: boolean;
  entries: readonly KnowledgeBaseMaintenanceHistoryEntry[];
  records: readonly KnowledgeMaintenanceRecord[];
  /** Owned by the host so detail navigation and refresh retain the current list. */
  state: KnowledgeMaintenanceHistoryState;
  loading?: boolean;
  error?: string;
  onBack: () => void;
  onChange: () => void;
  onSelectRecord: (record: KnowledgeMaintenanceRecord) => void;
  onOpenPath: (path: string) => void | Promise<void>;
  onUnavailable: () => void;
  onClearFocus?: () => void;
}

export { mergeKnowledgeMaintenanceHistory } from "../knowledge-base/maintenance-history-core";

/** Render the existing Origin list; call the disposer before replacing its container. */
export function renderKnowledgeMaintenanceHistoryList(container: HTMLElement, options: KnowledgeMaintenanceHistoryListOptions): () => void {
  const { zh, state } = options;
  const restoreSurface = alignDesktopMaintenanceSurface(container);
  let listCleanup: (() => void) | undefined;
  const cleanup = () => { listCleanup?.(); disposeOriginControls(page); restoreSurface(); };
  const page = createSettingsPage(container, {
    title: zh ? "维护记录" : "Maintenance records",
    description: zh
      ? "按日期查看来源、知识成果与未完成项。"
      : "View sources, knowledge notes, and unfinished items by date.",
    detail: true,
    backLabel: zh ? "返回知识库" : "Back to Knowledge",
    onBack: options.onBack
  });
  page.addClass("echoink-maintenance-history-page");
  const selectedDate = state.date;
  const filter = page.createDiv({ cls: "history-filter" });
  const filterLabel = zh ? "维护日志日期筛选" : "Maintenance log date filter";
  filter.createSpan({ text: zh ? "按日期筛选" : "Filter by date" });
  const date = createOriginInput(filter, { attr: {
    type: "date", "aria-label": filterLabel,
    "data-echoink-focus-key": "knowledge:maintenance-history:date"
  } });
  date.value = selectedDate;
  date.onchange = () => {
    state.date = date.value;
    state.page = 1;
    state.listScroll = 0;
    options.onChange();
  };
  const clear = createOriginButton(filter, { cls: "text-button", text: zh ? "清除" : "Clear", attr: {
    type: "button", "aria-label": zh ? "清除日期筛选" : "Clear date filter",
    "data-echoink-focus-key": "knowledge:maintenance-history:clear"
  } });
  clear.disabled = !selectedDate;
  clear.onclick = () => {
    state.date = "";
    state.page = 1;
    state.listScroll = 0;
    options.onClearFocus?.();
    options.onChange();
  };
  const group = createSettingsGroup(page);
  if (options.loading) {
    group.createDiv({ text: zh ? "正在读取维护记录" : "Loading maintenance records", attr: { role: "status" } });
    return cleanup;
  }
  if (options.error) group.createDiv({ text: options.error, cls: "settings-error" });
  const allEntries = options.entries;
  if (!allEntries.length && options.error) return cleanup;
  if (!allEntries.length) {
    filter.createSpan({ cls: "history-count", text: zh ? "0 条记录" : "0 records" });
    renderHistoryEmpty(group, zh ? "还没有知识库维护记录" : "No Knowledge maintenance runs yet", zh ? "完成维护后，记录会显示在这里。" : "Records will appear here after maintenance.");
    return cleanup;
  }
  const entries = selectedDate
    ? allEntries.filter((entry) => entry.date === selectedDate)
    : allEntries;
  filter.createSpan({ cls: "history-count", text: zh ? `${entries.length} 条记录` : `${entries.length} records` });
  if (!entries.length) {
    renderHistoryEmpty(group, zh ? "所选日期没有维护记录" : "No maintenance runs on this date", zh ? "选择另一个日期，或清除筛选查看全部记录。" : "Choose another date or clear the filter to see all records.");
    return cleanup;
  }
  const pageSize = 20;
  const pages = Math.ceil(entries.length / pageSize);
  const currentPage = Math.max(1, Math.min(pages, state.page));
  state.page = currentPage;
  group.addClass("echoink-maintenance-record-list");
  group.setAttr("aria-label", zh ? "维护记录列表" : "Maintenance record list");
  group.onscroll = () => { state.listScroll = group.scrollTop; };
  for (const entry of entries.slice((currentPage - 1) * pageSize, currentPage * pageSize)) {
    const row = new OriginSetting(group)
      .setName(knowledgeMaintenanceHistoryTitle(entry, zh))
      .setDesc(knowledgeMaintenanceHistoryDescription(entry, zh));
    if (entry.reportPath || entry.recordId) {
      row.addOriginButton((button) => {
        const label = zh ? "查看明细" : "View details";
        button
          .setButtonText(label)
          .onClick(() => {
            if (!entry.recordId) { void options.onOpenPath(entry.reportPath); return; }
            const record = options.records.find((item) => item.recordId === entry.recordId);
            if (!record) {
              if (entry.reportPath) void options.onOpenPath(entry.reportPath);
              else options.onUnavailable();
              return;
            }
            options.onSelectRecord(record);
          });
        button.buttonEl.setAttr(
          "aria-label",
          `${label} ${knowledgeMaintenanceHistoryTitle(entry, zh)}`
        );
      });
    }
    applySettingsRow(row);
  }
  const footer = page.createDiv({ cls: "echoink-maintenance-pagination" });
  footer.createSpan({ text: zh ? `${currentPage} / ${pages} 页 · 每页 ${pageSize} 条` : `${currentPage} / ${pages} pages · ${pageSize} per page`, attr: { role: "status" } });
  createOriginPagination(footer, currentPage, pages, (nextPage) => {
    state.page = nextPage;
    state.listScroll = 0;
    options.onChange();
  });
  const win = page.ownerDocument.defaultView;
  if (win) {
    const scrollTop = state.listScroll;
    const fit = () => {
      if (!group.isConnected) return;
      const available = win.innerHeight - group.getBoundingClientRect().top - footer.getBoundingClientRect().height - 18;
      group.style.maxHeight = `${Math.floor(Math.max(144, Math.min(560, win.innerHeight * .65, available)))}px`;
    };
    const frame = win.requestAnimationFrame(() => { fit(); group.scrollTop = scrollTop; });
    win.addEventListener("resize", fit);
    listCleanup = () => { win.cancelAnimationFrame(frame); win.removeEventListener("resize", fit); };
  }
  return cleanup;
}

export interface KnowledgeMaintenanceRecordDetailOptions {
  zh: boolean;
  record: KnowledgeMaintenanceRecord;
  onBack: () => void;
  onOpenPath: (path: string) => void | Promise<void>;
}

export function renderKnowledgeMaintenanceRecordDetail(container: HTMLElement, options: KnowledgeMaintenanceRecordDetailOptions): () => void {
  const { zh, record } = options;
  const restoreSurface = alignDesktopMaintenanceSurface(container);
  const page = createSettingsPage(container, { title: zh ? "维护详情" : "Maintenance details", detail: true, backLabel: zh ? "返回维护记录" : "Back to records", onBack: options.onBack });
  const overview = createSettingsGroup(page);
  new OriginSetting(overview).setName(knowledgeMaintenanceHistoryStatus({ status: record.cancelled ? "canceled" : "success", resultStatus: record.cancelled ? "cancelled" : record.result.status } as KnowledgeBaseMaintenanceHistoryEntry, zh)).setDesc(record.summary);
  const sources = createSettingsGroup(createSettingsSection(page, { title: zh ? "来源" : "Sources", surface: "flat" }));
  for (const source of record.sources) applySettingsRow(new OriginSetting(sources).setName(source.path).setDesc(zh ? { processed: "已处理", failed: "待处理：本轮未全部完成", unread: "未读，保留待处理" }[source.status] : source.status));
  if (!record.sources.length) sources.createDiv({ text: zh ? "本轮没有选中来源" : "No sources selected" });
  const notes = createSettingsGroup(createSettingsSection(page, { title: zh ? "知识成果" : "Knowledge notes", surface: "flat" }));
  for (const note of record.result.notes) applySettingsRow(new OriginSetting(notes).setName(note.title).setDesc(`${zh ? (note.operation === "created" ? "新增" : "更新") : note.operation} · ${note.summary}\n${note.path}`).addOriginButton((button) => button.setButtonText(zh ? "打开笔记" : "Open note").onClick(() => void options.onOpenPath(note.path))));
  if (!record.result.notes.length) notes.createDiv({ text: zh ? "本轮没有新增或更新知识笔记" : "No notes created or updated" });
  if (record.result.assessments.length) {
    const assessments = createSettingsGroup(createSettingsSection(page, { title: zh ? "知识判断" : "Assessments", surface: "flat" }));
    const statuses = { valid: "仍有效", needs_supplement: "需补充", outdated: "已过时", conflict: "存在冲突" };
    const verification = { local_verified: "本地证据已核对", external_verified: "外部证据已核对", unverified: "未核验" };
    for (const assessment of record.result.assessments) new OriginSetting(assessments).setName(assessment.claim).setDesc(`${zh ? statuses[assessment.status] : assessment.status} · ${assessment.asOf} · ${zh ? verification[assessment.verification] : assessment.verification}\n${assessment.evidence.join("、")}`);
  }
  if (record.result.issues.length) {
    const issues = createSettingsGroup(createSettingsSection(page, { title: zh ? "问题与未完成项" : "Issues", surface: "flat" }));
    for (const issue of record.result.issues) applySettingsRow(new OriginSetting(issues).setName(issue.path ?? issue.code).setDesc(issue.message));
  }
  return () => { disposeOriginControls(page); restoreSurface(); };
}

/** The data page reuses these settings rows without the desktop settings shell. */
function alignDesktopMaintenanceSurface(container: HTMLElement): () => void {
  const surface = Platform.isDesktopApp ? container.closest<HTMLElement>(".echoink-settings-demo") : null;
  const added = Boolean(surface && !surface.classList.contains("echoink-settings-aligned"));
  if (added) surface!.addClass("echoink-settings-aligned");
  return () => { if (added) surface!.removeClass("echoink-settings-aligned"); };
}

function renderHistoryEmpty(container: HTMLElement, title: string, description: string): void {
  const empty = container.createDiv({ cls: "settings-empty history-empty" });
  setIcon(empty.createSpan({ cls: "history-empty-icon" }), "history");
  empty.createDiv({ cls: "settings-empty-title", text: title, attr: { role: "heading", "aria-level": "3" } });
  empty.createEl("p", { text: description });
}

/** Open the original note/report locally; missing files are explicit failures. */
export async function openKnowledgeMaintenancePath(app: App, relativePath: string, zh: boolean): Promise<void> {
  const file = app.vault.getAbstractFileByPath(normalizePath(relativePath));
  if (file instanceof TFile) {
    await app.workspace.getLeaf("tab").openFile(file, { active: true });
    return;
  }
  new Notice(zh ? `当前 Vault 中没有找到维护报告：${relativePath}` : `The report was not found in this Vault: ${relativePath}`);
}

export function knowledgeMaintenanceHistoryTitle(
  entry: Readonly<KnowledgeBaseMaintenanceHistoryEntry>,
  zh: boolean
): string {
  const modeLabels = zh
    ? {
        maintain: "知识提炼",
        lint: "知识体检",
        reingest: "重新提炼",
        outputs: "输出整理",
        inbox: "Inbox 整理",
        unknown: "知识维护"
      }
    : {
        maintain: "Knowledge refinement",
        lint: "Knowledge check",
        reingest: "Re-refinement",
        outputs: "Output organization",
        inbox: "Inbox organization",
        unknown: "Knowledge maintenance"
      };
  return `${formatKnowledgeMaintenanceTime(entry.at, entry.date, zh)} · ${modeLabels[entry.mode]}`;
}

export function knowledgeMaintenanceHistoryDescription(
  entry: Readonly<KnowledgeBaseMaintenanceHistoryEntry>,
  zh: boolean
): string {
  const status = knowledgeMaintenanceHistoryStatus(entry, zh);
  const pending = entry.pendingSources?.length
    ? (zh
      ? `${entry.pendingSources.length} 项待处理`
      : `${entry.pendingSources.length} pending`)
    : "";
  const warnings = entry.warnings?.length
    ? (zh
      ? `${entry.warnings.length} 条提醒`
      : `${entry.warnings.length} warnings`)
    : "";
  return [status, pending, warnings, entry.reportPath].filter(Boolean).join(" · ");
}

export function knowledgeMaintenanceHistoryStatus(
  entry: Readonly<KnowledgeBaseMaintenanceHistoryEntry>,
  zh: boolean
): string {
  if (entry.resultStatus) {
    const labels = zh ? { completed: "已完成", partial: "部分完成", noop: "已检查，无需新增", failed: "失败", write_uncertain: "写入状态待核对", cancelled: "已取消" } : { completed: "Completed", partial: "Partially completed", noop: "Checked, no new content", failed: "Failed", write_uncertain: "Write needs verification", cancelled: "Cancelled" };
    return labels[entry.resultStatus];
  }
  if (entry.status === "failed") return zh ? "失败" : "Failed";
  if (entry.status === "canceled") return zh ? "已取消" : "Canceled";
  if (entry.completion === "partial") return zh ? "部分完成" : "Partially completed";
  if (entry.completion === "recovered") return zh ? "恢复后完成" : "Completed after recovery";
  if (entry.completion === "noop") return zh ? "已检查，无新内容" : "Checked, no new content";
  return zh ? "已完成" : "Completed";
}

function formatKnowledgeMaintenanceTime(at: number, date: string, zh: boolean): string {
  if (!Number.isFinite(at) || at <= 0) return date;
  return new Date(at).toLocaleString(zh ? "zh-CN" : "en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}
