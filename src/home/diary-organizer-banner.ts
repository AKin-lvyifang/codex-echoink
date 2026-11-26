import { NEXT, failureText } from "../core/error-copy";
import { Notice, setIcon } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import type { DiaryActionOptions, DiaryActionResult, DiaryCandidate, DiaryItem } from "../diary-organizer/types";
import { createOriginButton, createOriginInput, createOriginSelect, disposeOriginControls } from "../settings/origin-controls";
import { applyAmicroButton, setAmicroButtonPending } from "../settings/amicro-buttons";
import { diaryHomeSummary } from "./diary-organizer-summary";
import { diaryReviewFinanceAmount, diaryReviewFinanceTitle, diaryReviewReason } from "./diary-review-presentation";

let nextDiaryListId = 0;
const reviewDrafts = new WeakMap<HTMLElement, Map<string, { revision: number; candidate: DiaryCandidate; expanded: boolean }>>();

export interface DiaryOrganizerInvitation {
  readonly text: string;
  readonly note: string;
  dismiss(): Promise<void>;
  enable(): Promise<void>;
}

/** The opt-in offer, shown in the workbench reminders while organizing is off and journals exist. */
export function diaryOrganizerInvitation(plugin: CodexForObsidianPlugin): DiaryOrganizerInvitation | null {
  const service = plugin.diaryOrganizer;
  if (!service || plugin.settings.diaryOrganizerEnabled || plugin.settings.diaryOrganizerPromptDismissed || !service.hasJournals) return null;
  const zh = plugin.settings.settingsLanguage !== "en";
  return {
    text: zh ? "从日记自动整理待办与账目" : "Auto-organize to-dos and finances from journals",
    note: zh ? "日记内容将发送至当前配置的模型服务，并消耗相应额度。" : "Journal content is sent to the configured model service and uses its quota.",
    async dismiss() { plugin.settings.diaryOrganizerPromptDismissed = true; await plugin.saveSettings(); plugin.notifyHomeSurfacesChanged(); },
    async enable() { await service.setEnabled(true); }
  };
}

/** Items the organizer could not write on its own; they wait for the user's check. */
export function diaryReviewItems(plugin: CodexForObsidianPlugin, now = Date.now()): DiaryItem[] {
  const service = plugin.diaryOrganizer;
  if (!service || !plugin.settings.diaryOrganizerEnabled) return [];
  return diaryHomeSummary(service.engine.getState().items, now).items.filter(item => item.status === "review").sort((a, b) => b.updatedAt - a.updatedAt);
}

/** One-line title of a review item, as its row shows it. */
export function diaryReviewTitle(item: DiaryItem): string {
  const candidate = item.candidate;
  return candidate.type === "todo" ? candidate.text : [diaryReviewFinanceTitle(candidate), diaryReviewFinanceAmount(candidate)].filter(Boolean).join(" ");
}

/**
 * Confirms each review item as extracted, newest first. Stops at the first item that needs a closer look
 * and reports it, so nothing is written past an unresolved question.
 */
export async function confirmAllDiaryReviews(plugin: CodexForObsidianPlugin): Promise<{ confirmed: number; stoppedAt?: string; reason?: string }> {
  const service = plugin.diaryOrganizer;
  let confirmed = 0;
  if (!service) return { confirmed };
  for (const item of diaryReviewItems(plugin)) {
    const result = await service.engine.confirm(item.id, { expectedRevision: item.revision, candidate: item.candidate });
    if (result.status === "blocked") return { confirmed, stoppedAt: item.id, reason: result.reason };
    if (result.status === "needs_confirmation") return { confirmed, stoppedAt: item.id };
    confirmed++;
  }
  return { confirmed };
}

/** The review rows; the workbench's “待确认” card toggles this list. */
export function renderDiaryReviewList(host: HTMLElement, plugin: CodexForObsidianPlugin): void {
  const service = plugin.diaryOrganizer;
  if (!service) { disposeOriginControls(host); host.empty(); return; }
  const state = service.engine.getState(), visible = diaryReviewItems(plugin);
  const signature = JSON.stringify([visible, plugin.settings.settingsLanguage]);
  if (host.dataset.diarySignature === signature) return;
  disposeOriginControls(host); host.empty(); host.dataset.diarySignature = signature;
  const zh = plugin.settings.settingsLanguage !== "en", t = (a: string, b: string) => zh ? a : b;
  const button = (parent: HTMLElement, text: string, action: (button: HTMLButtonElement) => Promise<unknown>, primary = false) => {
    const node = createOriginButton(parent, { text, cls: `wb-button is-${primary ? "primary" : "secondary"}` });
    applyAmicroButton(node, { variant: primary ? "primary" : "secondary" });
    node.onclick = () => {
      if (node.disabled) return;
      node.disabled = true; setAmicroButtonPending(node, true);
      void action(node).catch(error => new Notice(failureText(error, ["日记整理未能完成，原日记已保留。", "Diary organizing could not be completed. Your diary is unchanged."], NEXT.retryLater, plugin.settings.settingsLanguage))).finally(() => {
        node.disabled = false; setAmicroButtonPending(node, false);
      });
    };
    return node;
  };
  if (!visible.length) return;
  let drafts = reviewDrafts.get(host);
  if (!drafts) { drafts = new Map(); reviewDrafts.set(host, drafts); }
  for (const id of drafts.keys()) if (!visible.some(item => item.id === id)) drafts.delete(id);
  const listId = host.dataset.diaryListId ??= `echoink-diary-list-${++nextDiaryListId}`;
  const list = host.createDiv({ cls: "wb-rows diary-organizer-list", attr: { id: `${listId}-rows` } });
  const runAction = async (row: HTMLElement, item: DiaryItem, action: "confirm" | "ignore", options: DiaryActionOptions = {}): Promise<void> => {
    const result: DiaryActionResult = action === "ignore" ? await service.engine.ignore(item.id) : await service.engine.confirm(item.id, options);
    if (result.status === "blocked") { new Notice(result.reason); return; }
    if (result.status === "needs_confirmation") {
      row.querySelector(".diary-organizer-confirmation")?.remove();
      const confirmation = row.createDiv({ cls: "diary-organizer-confirmation" });
      confirmation.createEl("p", { text: result.changes.join("；") });
      if (result.current) confirmation.createEl("p", { text: result.current.summary });
      const actions = confirmation.createDiv({ cls: "diary-organizer-actions" });
      button(actions, t("取消", "Cancel"), async () => { confirmation.remove(); });
      button(actions, t("确认", "Confirm"), () => runAction(row, item, action, { ...options, acknowledgedRevision: result.item.revision }), true);
      return;
    }
    host.dataset.diarySignature = ""; renderDiaryReviewList(host, plugin);
    plugin.notifyHomeSurfacesChanged?.();
  };
  for (const item of visible) {
    const candidate = item.candidate;
    const row = list.createDiv({ cls: "wb-row diary-organizer-row", attr: { "data-diary-item": item.id } });
    setIcon(row.createSpan({ cls: "wb-lead", attr: { "aria-hidden": "true" } }), candidate.type === "todo" ? "list-todo" : "wallet");
    const copy = row.createDiv({ cls: "wb-grow" });
    const document = state.documents.find(document => document.id === item.documentId);
    const actions = row.createDiv({ cls: "diary-organizer-actions" });
    row.addClass("diary-organizer-review"); copy.addClass("diary-organizer-review-copy");
    const title = candidate.type === "todo" ? candidate.text : diaryReviewFinanceTitle(candidate);
    if (title) copy.createSpan({ text: title, cls: "diary-organizer-title" });
    if (candidate.type === "finance") copy.createSpan({ text: diaryReviewFinanceAmount(candidate), cls: "diary-organizer-amount" });
    copy.createSpan({ text: diaryReviewReason(item.reasons, zh), cls: "diary-organizer-reason" });
    const quote = copy.createEl(document ? "a" : "span", { text: candidate.quote, cls: "diary-organizer-quote" });
    if (document) {
      quote.setAttribute("href", document.path);
      quote.onclick = event => { event.preventDefault(); void plugin.app.workspace.openLinkText(document.path, ""); };
    }
    let draft = drafts.get(item.id);
    if (!draft || draft.revision !== item.revision) { draft = { revision: item.revision, candidate: structuredClone(candidate), expanded: false }; drafts.set(item.id, draft); }
    const reviewed = draft.candidate;
    const editorId = `${listId}-editor-${item.id}`;
    const editor = row.createDiv({ cls: "diary-organizer-editor", attr: { id: editorId } });
    let fields: HTMLElement | undefined;
    const renderFields = () => {
      if (fields) return;
      fields = editor.createDiv({ cls: "diary-organizer-fields" });
      const fieldContainer = (label: string) => {
        const row = fields!.createEl("label", { cls: "diary-organizer-field" }); row.createSpan({ text: label });
        return row;
      };
      const field = (label: string, value: string, type = "text") => {
        return createOriginInput(fieldContainer(label), { type, value, attr: { "aria-label": label } });
      };
      if (reviewed.type === "finance") {
        const merchant = field(t("交易对象", "Counterparty"), reviewed.merchant);
        merchant.oninput = () => { if (reviewed.type === "finance") reviewed.merchant = merchant.value; };
        const amount = field(t("金额", "Amount"), (reviewed.amountCents / 100).toFixed(2), "number");
        amount.min = "0.01"; amount.step = "0.01";
        amount.oninput = () => { if (reviewed.type === "finance") reviewed.amountCents = Math.round(Number(amount.value) * 100); };
        const currency = field(t("币种", "Currency"), reviewed.currency);
        currency.oninput = () => { if (reviewed.type === "finance") reviewed.currency = currency.value.trim().toUpperCase(); };
        const date = field(t("日期", "Date"), reviewed.date, "date");
        date.oninput = () => { if (reviewed.type === "finance") reviewed.date = date.value; };
        const kind = createOriginSelect(fieldContainer(t("类型", "Type")), { attr: { "aria-label": t("收支类型", "Transaction type") } },
          [ ["expense",t("支出","Expense")], ["income",t("收入","Income")], ["refund",t("退款","Refund")], ["transfer",t("转账","Transfer")] ].map(([value,label])=>({value,label})), reviewed.kind, plugin.app).element;
        kind.onchange = () => { if (reviewed.type === "finance") reviewed.kind = kind.value as typeof reviewed.kind; };
        const categories = plugin.settings.lifestyle.finance.categories.filter(category => category.active);
        const select = createOriginSelect(fieldContainer(t("分类", "Category")), { attr: { "aria-label": t("分类", "Category") } }, [{ value: "", label: t("选择分类", "Choose category") }, ...categories.map(category => ({ value: category.name, label: category.name }))], reviewed.category, plugin.app).element;
        select.onchange = () => { if (reviewed.type === "finance") reviewed.category = select.value; };
      } else {
        const title = field(t("待办", "To-do"), reviewed.text);
        title.oninput = () => { if (reviewed.type === "todo") reviewed.text = title.value; };
        const date = field(t("截止日期", "Due date"), reviewed.dueDate ?? "", "date");
        date.oninput = () => { if (reviewed.type === "todo") reviewed.dueDate = date.value || null; };
      }
    };
    const edit = createOriginButton(actions, { text: t("修改", "Edit"), cls: "wb-button is-tertiary" });
    applyAmicroButton(edit, { variant: "tertiary" });
    const setEditing = (expanded: boolean) => {
      draft.expanded = expanded; editor.hidden = !expanded;
      list.toggleClass("has-editor", Array.from(list.children).some(row => row.querySelector<HTMLElement>(".diary-organizer-editor")?.hidden === false));
      edit.textContent = expanded ? t("收起", "Collapse") : t("修改", "Edit");
      edit.setAttribute("aria-expanded", String(expanded)); edit.setAttribute("aria-controls", editorId);
      if (expanded) renderFields();
    };
    setEditing(draft.expanded); edit.onclick = () => setEditing(!draft.expanded);
    button(actions, t("忽略", "Ignore"), () => runAction(row, item, "ignore", { expectedRevision: item.revision }));
    button(actions, t("确认", "Confirm"), () => runAction(row, item, "confirm", { expectedRevision: item.revision, candidate: reviewed }), true);
  }
}
