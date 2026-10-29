import { Notice, setIcon } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import type { DiaryActionOptions, DiaryActionResult, DiaryItem } from "../diary-organizer/types";
import { createOriginButton, createOriginInput, createOriginSelect, disposeOriginControls } from "../settings/origin-controls";
import { applyAmicroButton, setAmicroButtonPending } from "../settings/amicro-buttons";
import { diaryHomeSummary } from "./diary-organizer-summary";

let nextDiaryListId = 0;

/** One quiet expandable result list, composed from existing workbench rows and controls. */
export function renderDiaryOrganizerBanner(host: HTMLElement, plugin: CodexForObsidianPlugin): void {
  const service = plugin.diaryOrganizer;
  if (!service) { host.empty(); return; }
  const state = service.engine.getState(), summary = diaryHomeSummary(state.items);
  const enabled = plugin.settings.diaryOrganizerEnabled;
  const hasDiary = service.hasJournals;
  const signature = JSON.stringify([state.items, summary.items.map(item => item.id), enabled, plugin.settings.diaryOrganizerPromptDismissed, hasDiary, plugin.settings.settingsLanguage]);
  if (host.dataset.diarySignature === signature) return;
  const expanded = host.querySelector<HTMLElement>(".diary-organizer-results")?.dataset.expanded === "true";
  disposeOriginControls(host); host.empty(); host.dataset.diarySignature = signature;
  const zh = plugin.settings.settingsLanguage !== "en", t = (a: string, b: string) => zh ? a : b;
  const button = (parent: HTMLElement, text: string, action: (button: HTMLButtonElement) => Promise<unknown>, primary = false) => {
    const node = createOriginButton(parent, { text, cls: `wb-button is-${primary ? "primary" : "secondary"}` });
    applyAmicroButton(node, { variant: primary ? "primary" : "secondary" });
    node.onclick = () => {
      if (node.disabled) return;
      node.disabled = true; setAmicroButtonPending(node, true);
      void action(node).catch(error => new Notice(error instanceof Error ? error.message : String(error))).finally(() => {
        node.disabled = false; setAmicroButtonPending(node, false);
      });
    };
    return node;
  };
  if (!enabled) {
    if (plugin.settings.diaryOrganizerPromptDismissed || !hasDiary) return;
    const row = host.createDiv({ cls: "diary-organizer-invitation" });
    row.createSpan({ text: t("从日记自动整理待办和账单？", "Organize to-dos and finances from your journals?") });
    row.createEl("p", { text: t("日记内容会发给你当前配置的模型服务，并消耗它的额度。", "Journal content is sent to your configured model service and uses its quota.") });
    const actions = row.createDiv({ cls: "diary-organizer-actions" });
    button(actions, t("暂不开启", "Not now"), async () => { plugin.settings.diaryOrganizerPromptDismissed = true; await plugin.saveSettings(); plugin.notifyHomeSurfacesChanged(); });
    button(actions, t("开启", "Enable"), () => service.setEnabled(true), true);
    return;
  }
  const visible = summary.items;
  if (!visible.length) return;
  const section = host.createEl("section", { cls: "wb-section diary-organizer-results" });
  const heading = section.createDiv({ cls: "wb-section-heading" });
  const writtenCopy = [summary.writtenFinance ? t(`${summary.writtenFinance} 笔账`, `${summary.writtenFinance} transactions`) : "",
    summary.writtenTodos ? t(`${summary.writtenTodos} 个待办`, `${summary.writtenTodos} to-dos`) : ""].filter(Boolean).join(t("、", ", "));
  heading.createEl("h2", { text: [writtenCopy ? t(`近7天记了 ${writtenCopy}`, `From journals in the last 7 days: ${writtenCopy}`) : "",
    summary.review ? t(`${summary.review} 条待你看一眼`, `${summary.review} to review`) : ""].filter(Boolean).join(" · ") });
  const toggle = createOriginButton(heading, { cls: "wb-button is-tertiary", attr: { "aria-label": t("展开或收起日记整理记录", "Expand or collapse journal results") } });
  applyAmicroButton(toggle, { variant: "tertiary" });
  const listId = host.dataset.diaryListId ??= `echoink-diary-list-${++nextDiaryListId}`;
  const list = section.createDiv({ cls: "wb-rows diary-organizer-list", attr: { id: listId } });
  const setExpanded = (value: boolean) => {
    section.dataset.expanded = String(value); section.toggleClass("is-collapsed", !value);
    list.hidden = !value; toggle.textContent = value ? t("收起", "Collapse") : t("展开", "Expand");
    toggle.setAttribute("aria-expanded", String(value)); toggle.setAttribute("aria-controls", listId);
  };
  setExpanded(expanded);
  toggle.onclick = () => setExpanded(section.dataset.expanded !== "true");
  const runAction = async (row: HTMLElement, item: DiaryItem, action: "confirm" | "ignore" | "undo", options: DiaryActionOptions = {}): Promise<void> => {
    const result: DiaryActionResult = action === "ignore" ? await service.engine.ignore(item.id)
      : action === "undo" ? await service.engine.undo(item.id, options) : await service.engine.confirm(item.id, options);
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
    host.dataset.diarySignature = ""; renderDiaryOrganizerBanner(host, plugin);
  };
  for (const item of [...visible].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const candidate = item.candidate;
    const row = list.createDiv({ cls: "wb-row diary-organizer-row", attr: { "data-diary-item": item.id } });
    setIcon(row.createSpan({ cls: "wb-lead", attr: { "aria-hidden": "true" } }), candidate.type === "todo" ? "list-todo" : "wallet");
    const copy = row.createDiv({ cls: "wb-grow" });
    copy.createDiv({ text: candidate.type === "todo" ? candidate.text : `${candidate.merchant || t("收支", "Transaction")} · ${candidate.currency} ${(candidate.amountCents / 100).toFixed(2)}` });
    const document = state.documents.find(document => document.id === item.documentId);
    if (document) {
      const link = copy.createEl("a", { text: t("AI 从日记记的", "AI from journal"), href: document.path });
      link.onclick = event => { event.preventDefault(); void plugin.app.workspace.openLinkText(document.path, ""); };
    }
    const actions = row.createDiv({ cls: "diary-organizer-actions" });
    if (item.status === "written") button(actions, t("撤销", "Undo"), () => runAction(row, item, "undo", { expectedRevision: item.revision }));
    else {
      copy.createEl("p", { text: item.reasons.map(reason => reason.replace(/\bcategory\b/gu, "分类")).join("；"), cls: "diary-organizer-reason" });
      copy.createEl("blockquote", { text: candidate.quote });
      const reviewed = structuredClone(candidate);
      const fields = copy.createDiv({ cls: "diary-organizer-fields" });
      const field = (label: string, value: string, type = "text") => {
        const row = fields.createEl("label", { cls: "diary-organizer-field" }); row.createSpan({ text: label });
        return createOriginInput(row, { type, value, attr: { "aria-label": label } });
      };
      if (candidate.type === "finance") {
        const merchant = field(t("交易对象", "Counterparty"), candidate.merchant);
        merchant.oninput = () => { if (reviewed.type === "finance") reviewed.merchant = merchant.value; };
        const amount = field(t("金额", "Amount"), (candidate.amountCents / 100).toFixed(2), "number");
        amount.min = "0.01"; amount.step = "0.01";
        amount.oninput = () => { if (reviewed.type === "finance") reviewed.amountCents = Math.round(Number(amount.value) * 100); };
        const currency = field(t("币种", "Currency"), candidate.currency);
        currency.oninput = () => { if (reviewed.type === "finance") reviewed.currency = currency.value.trim().toUpperCase(); };
        const date = field(t("日期", "Date"), candidate.date, "date");
        date.oninput = () => { if (reviewed.type === "finance") reviewed.date = date.value; };
        const kind = createOriginSelect(fields, { attr: { "aria-label": t("收支类型", "Transaction type") } },
          [ ["expense",t("支出","Expense")], ["income",t("收入","Income")], ["refund",t("退款","Refund")], ["transfer",t("转账","Transfer")] ].map(([value,label])=>({value,label})), candidate.kind, plugin.app).element;
        kind.onchange = () => { if (reviewed.type === "finance") reviewed.kind = kind.value as typeof reviewed.kind; };
        const categories = plugin.settings.lifestyle.finance.categories.filter(category => category.active);
        const select = createOriginSelect(fields, { attr: { "aria-label": t("分类", "Category") } }, [{ value: "", label: t("选择分类", "Choose category") }, ...categories.map(category => ({ value: category.name, label: category.name }))], candidate.category, plugin.app).element;
        select.onchange = () => { if (reviewed.type === "finance") reviewed.category = select.value; };
      } else {
        const title = field(t("待办", "To-do"), candidate.text);
        title.oninput = () => { if (reviewed.type === "todo") reviewed.text = title.value; };
        const date = field(t("截止日期", "Due date"), candidate.dueDate ?? "", "date");
        date.oninput = () => { if (reviewed.type === "todo") reviewed.dueDate = date.value || null; };
      }
      button(actions, t("忽略", "Ignore"), () => runAction(row, item, "ignore", { expectedRevision: item.revision }));
      button(actions, t("确认", "Confirm"), () => runAction(row, item, "confirm", { expectedRevision: item.revision, candidate: reviewed }), true);
    }
  }
}
