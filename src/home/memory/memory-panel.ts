import { setIcon } from "obsidian";
import { createOriginButton, createOriginInput, disposeOriginControls } from "../../settings/origin-controls";
import { applyDeleteButton } from "../../settings/amicro-buttons";
import { profileSlotDefinition } from "../../harness/memory/user-profile-core";
import type { MemoryLayer } from "../../harness/memory/memory-relevance";
import { MEMORY_CATEGORIES, MEMORY_LAYERS, type MemoryCategory, type MemoryPageSnapshot, type MemorySource, type MemoryStar, type MemoryCorrectionView } from "./memory-page-types";
export interface MemoryPanelState {
  mode: "overview" | "list" | "detail" | "profile" | "search" | "receipt";
  id?: string;
  layer?: MemoryLayer;
  category?: MemoryCategory;
  editing?: boolean;
  title?: string;
  content?: string;
  profileKey?: string;
  profileText?: string;
  confirmForget?: boolean;
  confirmProfileDelete?: boolean;
}
export interface MemoryPanelActions {
  undoCorrection?: (id: string) => void;
  originalQuote?: (source: string) => Promise<string>;
  overview: () => void;
  select: (id: string) => void;
  layer: (layer: MemoryLayer) => void;
  profile: (key?: string) => void;
  edit: () => void;
  cancelEdit: () => void;
  draft: (field: "title" | "content" | "profileText", value: string) => void;
  save: () => void;
  pin: () => void;
  restore: () => void;
  confirmForget: (confirm: boolean) => void;
  forget: () => void;
  saveProfile: () => void;
  deleteProfile: () => void;
  confirmProfileDelete: (confirm: boolean) => void;
  source: (source: MemorySource) => void;
}
/** All panel states render the same query snapshot; commands belong to the controller. */
export function renderMemoryPanel(host: HTMLElement, snapshot: MemoryPageSnapshot, state: MemoryPanelState, actions: MemoryPanelActions, busy: boolean, language: string): void {
  const expandedCorrections = new Set(Array.from(host.querySelectorAll("details.memory-correction[open]"))
    .map(details => details.getAttribute("data-correction-id")));
  disposeOriginControls(host);
  host.empty();
  if (!snapshot.stars.length && !snapshot.corrections?.length && state.mode === "overview")
    return;
  const t = (zh: string, en: string) => language === "en" ? en : zh;
  const button = (parent: HTMLElement, text: string, action: () => void, variant = "tertiary", icon?: string) => {
    const element = createOriginButton(parent, { text, cls: `memory-button is-${variant}` });
    if (icon) {
      const slot = element.createSpan({ cls: "memory-button-icon" });
      setIcon(slot, icon);
      element.prepend(slot);
    }
    element.disabled = busy;
    element.onclick = action;
    return element;
  };
  const heading = (text: string) => host.createDiv({ cls: "memory-panel-heading", text });
  const section = (text: string) => {
    host.createDiv({ cls: "memory-section-heading", text });
    return host.createDiv({ cls: "memory-section" });
  };
  const rows = (stars: readonly MemoryStar[], descriptions?: ReadonlyMap<string, string>, recent = false) => {
    const group = host.createDiv({ cls: "memory-list" });
    for (const star of stars) {
      const row = button(group, "", () => actions.select(star.id));
      row.addClass("memory-list-row");
      row.dataset.memoryId = star.id;
      const body = row.createSpan({ cls: "memory-list-label" });
      body.createSpan({ text: state.mode === "search" && recent ? `○ ${star.title}` : star.title });
      const description = descriptions?.get(star.id);
      if (description)
        (recent ? row : body).createSpan({ cls: recent ? "memory-recent-age" : "memory-muted", text: description });
      if (!recent && state.mode !== "search")
        row.createSpan({ cls: "memory-chevron", text: "›" });
    }
    if (!stars.length)
      group.createDiv({ cls: "memory-list-empty", text: t("没有相关记忆", "No matching memories") });
    return group;
  };
  const sourceRow = (parent: HTMLElement, source: MemorySource) => {
    if (source.conversationId && source.entryId)
      button(parent, source.text, () => actions.source(source), "tertiary", "message-square").addClass("memory-source-link");
    else
      parent.createDiv({ cls: "memory-muted", text: source.text });
  };
  const age = (at?: number) => at === undefined ? t("还未想起", "Not recalled yet") : relativeMemoryTime(at, snapshot.now, language);
  const quoteDetails = (details: HTMLDetailsElement, body: HTMLElement, source: string) => {
    body.createDiv({ cls: "memory-section-heading", text: t("依据原话", "Your statement") });
    const quote = body.createDiv({ cls: "memory-muted", text: t("正在读取…", "Loading…") });
    let loaded = false;
    details.ontoggle = () => {
      if (!details.open || loaded) return;
      loaded = true;
      void (actions.originalQuote?.(source) ?? Promise.resolve(t("依据原话已不可用", "Original statement unavailable")))
        .then(text => { quote.textContent = text; }).catch(() => { quote.textContent = t("依据原话已不可用", "Original statement unavailable"); });
    };
  };
  const correctionRow = (event: MemoryCorrectionView, parent: HTMLElement = host) => {
    const details = parent.createEl("details", { cls: "memory-correction" });
    details.dataset.correctionId = event.id;
    const date = new Date(event.at).toLocaleDateString(language === "en" ? "en-US" : "zh-CN", { month: "long", day: "numeric" });
    details.createEl("summary", { cls: "memory-muted", text: event.undoneAt !== undefined ? t("已撤销这次更新", "Update undone")
      : event.action === "obsolete" ? t(`已按 ${date} 你的说法关闭`, `Closed after your statement on ${date}`) : t(`已按 ${date} 你的说法更新`, `Updated after your statement on ${date}`) });
    const body = details.createDiv({ cls: "memory-correction-body" });
    if (event.before) { body.createDiv({ cls: "memory-section-heading", text: t("改前", "Before") }); body.createDiv({ cls: "memory-history-body", text: `${event.before.title}\n${event.before.content}` }); }
    if (event.after) { body.createDiv({ cls: "memory-section-heading", text: t("改后", "After") }); body.createDiv({ cls: "memory-history-body", text: `${event.after.title}\n${event.after.content}` }); }
    quoteDetails(details, body, event.source);
    if (event.undoneAt === undefined) {
      if (event.canUndo) button(body, t("撤销", "Undo"), () => actions.undoCorrection?.(event.id), "secondary");
      else body.createDiv({ cls: "memory-muted", text: t("这条之后又更新过", "This memory was updated again") });
    }
    details.open = expandedCorrections.has(event.id);
  };
  if (!["overview", "search", "receipt"].includes(state.mode))
    button(host, t("返回", "Back"), actions.overview, "tertiary", "arrow-left").addClass("memory-panel-back");
  if (state.mode === "overview") {
    const group = host.createDiv({ cls: "memory-list" });
    for (const layer of MEMORY_LAYERS) {
      const row = button(group, "", () => actions.layer(layer.id));
      row.addClass("memory-list-row");
      row.dataset.memoryLayer = layer.id;
      row.createSpan({ cls: `memory-layer-dot is-${layer.id}`, attr: { "aria-hidden": "true" } });
      row.createSpan({ cls: "memory-list-label", text: t(layer.zh, layer.en) });
      row.createSpan({ cls: "memory-count", text: String(snapshot.stars.filter(star => star.layer === layer.id).length) });
    }
    section(t("最近想起", "Recently recalled"));
    const recent = snapshot.stars.filter(star => star.lastRecalledAt !== undefined).sort((a, b) => b.lastRecalledAt! - a.lastRecalledAt!).slice(0, 6);
    rows(recent, new Map(recent.map(star => [star.id, age(star.lastRecalledAt)])), true);
    const closed = snapshot.corrections?.filter(event => event.action === "obsolete" && event.undoneAt === undefined && event.before?.status === "closed") ?? [];
    if (closed.length) {
      const group = section(t("已自动关闭", "Automatically closed"));
      for (const event of closed) { group.createDiv({ text: event.before!.title }); correctionRow(event, group); }
    }
  }
  else if (state.mode === "list") {
    const layer = MEMORY_LAYERS.find(item => item.id === state.layer);
    const category = MEMORY_CATEGORIES.find(item => item.id === state.category);
    heading(layer ? t(layer.zh, layer.en) : category ? t(category.zh, category.en) : "");
    rows(snapshot.stars.filter(star => layer ? star.layer === layer.id : star.category === category?.id));
  }
  else if (state.mode === "detail") {
    const star = snapshot.stars.find(item => item.id === state.id);
    if (!star) {
      host.createDiv({ cls: "memory-muted", text: t("这条记忆已被替换或忘记。", "This memory was replaced or forgotten.") });
      return;
    }
    const category = MEMORY_CATEGORIES.find(item => item.id === star.category)!;
    const layer = MEMORY_LAYERS.find(item => item.id === star.layer)!;
    const kinds: Record<string, string[]> = { fact: ["事实", "Fact"], view: ["观点", "View"], decision: ["决定", "Decision"], goal: ["目标", "Goal"], task: ["任务", "Task"], open_loop: ["未决", "Open question"], episode: ["经历", "Experience"] };
    host.createDiv({ cls: "memory-meta", text: `${kinds[star.kind]?.[language === "en" ? 1 : 0] ?? t(category.zh, category.en)} · ${t(layer.zh, layer.en)}` });
    if (state.editing) {
      const title = createOriginInput(host, { value: state.title ?? star.title, cls: "memory-edit-title", attr: { "aria-label": t("记忆标题", "Memory title") } });
      title.disabled = busy;
      title.oninput = () => actions.draft("title", title.value);
      const content = host.createEl("textarea", { cls: "memory-editor", attr: { "aria-label": t("记忆正文", "Memory content") } });
      content.value = state.content ?? star.content;
      content.disabled = busy;
      content.oninput = () => actions.draft("content", content.value);
      const controls = host.createDiv({ cls: "memory-actions" });
      button(controls, t("取消", "Cancel"), actions.cancelEdit, "secondary");
      button(controls, t("保存", "Save"), actions.save, "primary");
    }
    else {
      host.createDiv({ cls: "memory-detail-title", text: star.title });
      host.createDiv({ cls: "memory-detail-body", text: star.content });
    }
    for (const event of snapshot.corrections?.filter(event => event.afterId === star.id || event.beforeId === star.id) ?? []) correctionRow(event);
    const fields = host.createDiv({ cls: "memory-fields" });
    const field = (label: string, value: string) => {
      const row = fields.createDiv({ cls: "memory-field" });
      row.createSpan({ cls: "memory-field-label", text: label });
      row.createSpan({ text: value });
    };
    field(t("上次想起", "Recalled"), age(star.lastRecalledAt));
    field(t("想起次数", "Times"), `${star.recallCount}${t(" 次", "")}`);
    field(t("记下于", "Recorded"), star.date);
    if (star.due)
      field(t("到期", "Due"), star.due);
    if (star.scope?.startsWith("project:"))
      field(t("所属项目", "Project"), star.scope.slice("project:".length));
    if (!state.editing) {
      const controls = host.createDiv({ cls: "memory-actions" });
      const forget = button(controls, "", () => actions.confirmForget(true), "icon");
      forget.setAttribute("aria-label", t("忘记这条记忆", "Forget this memory"));
      applyDeleteButton(forget, { iconOnly: true });
      button(controls, t("修正", "Correct"), actions.edit, "secondary");
      if (star.layer === "faded")
        button(controls, t("恢复", "Restore"), actions.restore, "primary");
      else
        button(controls, star.pinned ? t("取消固定", "Unpin") : t("固定到核心", "Pin to core"), actions.pin, "primary");
    }
    if (state.confirmForget) {
      const confirm = host.createDiv({ cls: "memory-confirm" });
      confirm.createDiv({ text: t("忘记这条记忆？", "Forget this memory?") });
      const controls = confirm.createDiv({ cls: "memory-actions" });
      button(controls, t("取消", "Cancel"), () => actions.confirmForget(false), "secondary");
      applyDeleteButton(button(controls, t("忘记", "Forget"), actions.forget, "danger"));
    }
    sourceRow(section(t("来源", "Source")), star.sourceView);
    if (star.basis === "inferred" && star.reason)
      section(t("依据", "Basis")).createDiv({ cls: "memory-muted", text: memoryCorrectionReason(star.reason, language) });
    if (star.profiles.length) {
      const group = section(t("支撑画像", "Profile supported"));
      for (const item of star.profiles)
        button(group, item.text, () => actions.profile(item.profileKey));
    }
    if (star.clues.length) {
      const group = section(t("联想", "Associations"));
      for (const clue of star.clues)
        group.createDiv({ cls: "memory-muted", text: clue.content });
    }
    if (star.history.length) {
      const group = section(t("之前", "Earlier"));
      for (const previous of star.history) {
        const row = group.createDiv({ cls: "memory-history" });
        row.createDiv({ text: `${previous.title}（${previous.date}）` });
        row.createDiv({ cls: "memory-history-body", text: previous.content });
        if (previous.reason)
          row.createDiv({ cls: "memory-muted", text: memoryCorrectionReason(previous.reason, language) });
      }
    }
  }
  else if (state.mode === "profile") {
    heading(t("你的画像", "Your profile"));
    for (const [id, zh, en] of [["identity", "身份", "Identity"], ["preference", "偏好", "Preferences"], ["collaboration", "合作方式", "Collaboration"]]) {
      const items = snapshot.profile.filter(item => item.section === id);
      if (!items.length)
        continue;
      host.createDiv({ cls: "memory-section-heading memory-profile-group-heading", text: t(zh, en) });
      const group = host.createDiv({ cls: "memory-list" });
      for (const item of items) {
        const expanded = state.profileKey === item.profileKey;
        const row = button(group, "", () => actions.profile(expanded ? undefined : item.profileKey));
        row.addClass("memory-list-row");
        row.toggleClass("is-expanded", expanded);
        row.dataset.profileKey = item.profileKey;
        row.setAttribute("aria-expanded", String(expanded));
        const label = language === "en" ? "" : profileSlotDefinition(item.profileKey)?.labelZh;
        row.createSpan({ cls: "memory-list-label", text: `${label ? `${label}：` : ""}${item.text}` });
        row.createSpan({ cls: "memory-profile-count", text: item.userEdited ? t("手动", "Edited") : `${item.sourceMemoryIds.length}${t(" 条", " sources")}` });
        row.createSpan({ cls: "memory-chevron", text: expanded ? "⌄" : "›" });
        if (!expanded)
          continue;
        const body = group.createDiv({ cls: "memory-profile-expanded" });
        const editor = body.createEl("textarea", { cls: "memory-editor", attr: { rows: "1", "aria-label": profileSlotDefinition(item.profileKey)?.labelZh ?? t("画像内容", "Profile text") } });
        editor.value = state.profileText ?? item.text;
        editor.disabled = busy;
        editor.oninput = () => actions.draft("profileText", editor.value);
        const sources = body.createDiv({ cls: "memory-profile-sources" });
        for (const id of item.sourceMemoryIds) {
          const star = snapshot.stars.find(star => star.id === id);
          if (star)
            button(sources, star.title, () => actions.select(star.id), "tertiary");
        }
        const controls = body.createDiv({ cls: "memory-actions" });
        const remove = button(controls, "", () => actions.confirmProfileDelete(true), "icon");
        remove.setAttribute("aria-label", t("删除这条画像", "Delete profile item"));
        applyDeleteButton(remove, { iconOnly: true });
        button(controls, t("保存", "Save"), actions.saveProfile, "primary");
        if (state.confirmProfileDelete) {
          const confirm = body.createDiv({ cls: "memory-confirm" });
          confirm.createDiv({ text: t("删除这条画像？相关记忆会保留。", "Delete this profile item? Its memories will remain.") });
          const buttons = confirm.createDiv({ cls: "memory-actions" });
          button(buttons, t("取消", "Cancel"), () => actions.confirmProfileDelete(false), "secondary");
          applyDeleteButton(button(buttons, t("删除", "Delete"), actions.deleteProfile, "danger"));
        }
      }
    }
    if (!snapshot.profile.length)
      host.createDiv({ cls: "memory-muted", text: t("还没有画像", "No profile yet") });
  }
  else if (state.mode === "search") {
    heading(t("会想起", "Would recall"));
    const preview = snapshot.preview;
    const recalled = (preview?.recalled ?? []).flatMap(id => snapshot.stars.filter(star => star.id === id));
    rows(recalled, new Map(recalled.map(star => [star.id, memoryRecallReason(preview?.reasons?.[star.id], language, preview?.relatedFrom?.[star.id])])));
    section(t("不会自动想起", "Not recalled automatically"));
    const faded = (preview?.faded ?? []).flatMap(id => snapshot.stars.filter(star => star.id === id));
    rows(faded, new Map(faded.map(star => [star.id, age(star.lastRecalledAt)])), true);
  }
  else if (state.mode === "receipt") {
    heading(t("这一轮想起的", "Recalled this turn"));
    const group = host.createDiv({ cls: "memory-list" });
    for (const source of snapshot.receipt?.sources ?? []) {
      const exists = snapshot.stars.some(star => star.id === source.id);
      const row = button(group, "", () => actions.select(source.id));
      row.addClass("memory-list-row");
      row.disabled = busy || !exists;
      const body = row.createSpan({ cls: "memory-list-label" });
      body.createSpan({ text: source.title });
      if (source.reason)
        body.createSpan({ cls: "memory-muted", text: memoryRecallReason(source.reason, language, source.relatedFrom) });
    }
  }
}
export function memoryRecallReason(reason: string | undefined, language: string, relatedFrom?: { id: string; title: string }): string {
  const english = language === "en";
  switch (reason) {
    case "related": return relatedFrom ? english ? `Linked from ${relatedFrom.title}` : `由「${relatedFrom.title}」带出` : english ? "Linked memory" : "关联带出";
    case "pinned": return english ? "Always included" : "每轮必带";
    case "tool_read": return english ? "Read by assistant" : "主动读取";
    case "title_or_trigger": return english ? "Directly related to this message" : "和这句话直接相关";
    default: return english ? "Related content" : "内容有关联";
  }
}
export function relativeMemoryTime(at: number, now: number, language: string): string {
  const days = Math.max(0, Math.floor((now - at) / 86400000));
  if (days === 0)
    return language === "en" ? "Today" : "今天";
  return language === "en" ? `${days} days ago` : `${days} 天前`;
}

/** Localize known system reasons without rewriting history or user-authored text. */
export function memoryCorrectionReason(reason: string, language: string): string {
  const english = language === "en";
  switch (reason) {
    case "Dream 已按用户原话核对":
    case "已按你的原话核对":
      return english ? "Checked against your own words" : "已按你的原话核对";
    case "用户撤销 Dream 纠错":
    case "你已撤销这次纠错":
      return english ? "You undid this correction" : "你已撤销这次纠错";
    default:
      return reason;
  }
}
