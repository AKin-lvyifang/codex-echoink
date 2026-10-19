import { Platform, setIcon } from "obsidian";
import { applyDeleteButton } from "./amicro-buttons";
import { USER_PROFILE_SLOTS, USER_PROFILE_ITEM_HARD_MAX_CHARS, type UserProfileItem, type UserProfileControlSnapshot } from "../harness/memory/user-profile-state";
import { createOriginButton, disposeOriginControls } from "./origin-controls";
import { createSettingsPage, createSettingsSection, createSettingsState, showSettingsInlineConfirmation } from "./settings-v2";

/** The repository selects one eligible item per slot from a single revision. */
export type ProfileSnapshot = UserProfileControlSnapshot;
export interface UserProfileSettingsHost {
  read(): Promise<ProfileSnapshot>;
  update(input: { profileKey: string; text: string; expectedRevision: number }): Promise<{ revision: number }>;
  confirm(input: { profileKey: string; expectedRevision: number }): Promise<{ revision: number }>;
  remove(input: { profileKey: string; expectedRevision: number }): Promise<{ revision: number }>;
  back(): void;
}
interface ProfileDraft { text: string; original: string; revision: number; conflict: boolean; error: string }
const ENGLISH_SLOT_LABELS: Readonly<Record<string, string>> = {
  "identity.name": "Name", "identity.pronouns": "Pronouns", "identity.role": "Occupation and roles", "identity.organization": "Organization and team", "identity.location_timezone": "Location and time zone", "identity.background": "Long-term background",
  "preference.language": "Language", "preference.tone": "Tone", "preference.detail": "Level of detail", "preference.format": "Format", "preference.examples": "Examples", "preference.tools": "Tools", "preference.workflow": "Workflow", "preference.design": "Design", "preference.technology": "Technology", "preference.interests": "Long-term interests", "preference.avoidances": "Things to avoid", "preference.accessibility": "Accessibility",
  "collaboration.decision_style": "Decision making", "collaboration.autonomy": "Autonomy", "collaboration.confirmation": "Confirmation boundaries", "collaboration.feedback": "Feedback", "collaboration.quality_bar": "Quality standards", "collaboration.pace": "Collaboration pace"
};

/** Keeps edits outside the DOM so settings redraw/close can suspend safely. */
export class UserProfileSettingsController {
  private container: HTMLElement | null = null;
  private snapshot: ProfileSnapshot | null = null;
  private drafts = new Map<string, ProfileDraft>();
  private expanded = new Set<string>();
  private loading = false;
  private busy = false;
  private initialized = false;
  private disposed = false;
  private generation = 0;
  private readError = "";
  private feedback = "";
  private pendingLeave: (() => void) | null = null;
  private scroll = 0;
  private focusKey: string | null = null;
  constructor(private readonly host: UserProfileSettingsHost, private readonly language: "zh-CN" | "en" = "zh-CN") {}
  get hasDraft(): boolean { return [...this.drafts.values()].some(draft => draft.text !== draft.original); }
  get submitting(): boolean { return this.busy; }
  /** The settings shell calls this only when entering the page. */
  refreshWhenOpened(): void { this.initialized = false; this.feedback = ""; }
  private get zh(): boolean { return this.language !== "en"; }
  private item(key: string): UserProfileItem | undefined { return this.snapshot?.items.find(item => item.profileKey === key); }
  suspend(): void {
    if (this.container) {
      this.scroll = this.container.scrollTop;
      const focused = this.container.ownerDocument.activeElement;
      this.focusKey = focused && this.container.contains(focused) ? (focused as HTMLElement).dataset.profileFocus ?? null : null;
      disposeOriginControls(this.container);
    }
    this.container = null;
  }
  dispose(): void { this.suspend(); this.disposed = true; this.generation++; }
  render(container: HTMLElement): void {
    this.suspend(); this.container = container;
    this.draw();
    if (!this.initialized && !this.loading) { this.initialized = true; void this.reload(); }
  }
  requestLeave(done: () => void = () => this.host.back()): void {
    if (this.busy) return;
    if (!this.hasDraft) { done(); return; }
    this.pendingLeave = done;
    this.draw();
  }
  private async reload(): Promise<boolean> {
    const generation = ++this.generation;
    this.loading = true; this.draw();
    try {
      const value = await this.host.read();
      if (this.disposed || generation !== this.generation) return false;
      this.snapshot = value; this.readError = "";
      if (this.feedback === "已保存，画像暂时读不到，请重试。" || this.feedback === "Saved. The profile could not be refreshed; try again.") this.feedback = this.zh ? "已保存" : "Saved";
      for (const draft of this.drafts.values()) if (draft.revision !== value.revision) draft.conflict = true;
      return true;
    } catch {
      if (!this.disposed && generation === this.generation) this.readError = this.zh ? "画像暂时读不到" : "Profile unavailable";
      return false;
    } finally { if (generation === this.generation) { this.loading = false; this.draw(); } }
  }
  private button(parent: HTMLElement, text: string, action: () => void, key: string, cls = ""): HTMLButtonElement {
    const button = createOriginButton(parent, { text, cls, attr: { type: "button", "data-profile-focus": key } });
    button.disabled = this.busy; button.onclick = action; return button;
  }
  private draw(): void {
    const root = this.container;
    if (!root || this.disposed) return;
    const focused = root.ownerDocument.activeElement as HTMLTextAreaElement | null;
    const focus = focused && root.contains(focused) ? focused.dataset.profileFocus : this.focusKey;
    const selection = focused?.tagName === "TEXTAREA" ? [focused.selectionStart, focused.selectionEnd] : null;
    const scroll = root.scrollTop || this.scroll;
    disposeOriginControls(root); root.empty();
    const page = createSettingsPage(root, { title: this.zh ? "你的画像" : "Your profile", detail: true, backLabel: this.zh ? "返回" : "Back", onBack: () => this.requestLeave() });
    page.addClass("echoink-user-profile-settings");
    page.setAttribute("aria-busy", String(this.busy || this.loading));
    const back = page.querySelector<HTMLButtonElement>(".settings-back")!; back.dataset.profileFocus = "back"; back.disabled = this.busy;
    page.onkeydown = event => {
      if (event.key !== "Escape" || event.isComposing || this.busy) return;
      event.stopPropagation(); event.preventDefault();
      const row = (event.target as HTMLElement).closest<HTMLElement>("[data-profile-key]");
      if (row && this.drafts.has(row.dataset.profileKey!)) {
        const key = row.dataset.profileKey!;
        this.discardPrompt(page, () => { this.drafts.delete(key); this.draw(); }, back);
      } else this.requestLeave();
    };
    if (this.readError) createSettingsState(page, this.readError, "error", { label: this.zh ? "重试" : "Retry", onActivate: () => { if (!this.loading && !this.busy) void this.reload(); } });
    if (this.feedback) createSettingsState(page, this.feedback, "neutral");
    if (!this.snapshot) {
      if (this.loading || !this.initialized) createSettingsState(page, this.zh ? "正在读取画像…" : "Loading profile…");
    } else {
      const titles = { identity: this.zh ? "身份" : "Identity", preference: this.zh ? "偏好" : "Preferences", collaboration: this.zh ? "协作" : "Collaboration" };
      for (const section of ["identity", "preference", "collaboration"] as const) {
        const slots = USER_PROFILE_SLOTS.filter(slot => slot.section === section);
        const populated = slots.filter(slot => this.item(slot.profileKey));
        const group = createSettingsSection(page, { title: titles[section], surface: "flat" }); group.dataset.profileSection = section;
        group.querySelector("h3")!.createSpan({ cls: "echoink-profile-count", text: `${populated.length}/${slots.length}` });
        for (const slot of populated) this.renderSlot(group, slot.profileKey, this.zh ? slot.labelZh : ENGLISH_SLOT_LABELS[slot.profileKey] ?? slot.labelZh);
        const empty = slots.filter(slot => !this.item(slot.profileKey));
        if (empty.length) {
          const details = group.createEl("details", { cls: "echoink-profile-empty" });
          details.open = this.expanded.has(section) || empty.some(slot => this.drafts.has(slot.profileKey));
          details.ontoggle = () => { if (details.open) this.expanded.add(section); else this.expanded.delete(section); };
          details.createEl("summary", { text: this.zh ? `还有 ${empty.length} 项没填` : `${empty.length} unfilled items` });
          for (const slot of empty) this.renderSlot(details, slot.profileKey, this.zh ? slot.labelZh : ENGLISH_SLOT_LABELS[slot.profileKey] ?? slot.labelZh);
        }
      }
    }
    if (this.pendingLeave) { const done = this.pendingLeave; this.pendingLeave = null; this.discardPrompt(page, () => { this.drafts.clear(); done(); }, back); }
    root.scrollTop = scroll;
    const restore = Array.from(root.querySelectorAll<HTMLElement>("[data-profile-focus]")).find(element => element.dataset.profileFocus === focus);
    restore?.focus({ preventScroll: true });
    if (selection && restore?.tagName === "TEXTAREA") (restore as HTMLTextAreaElement).setSelectionRange(selection[0], selection[1]);
    this.focusKey = null;
  }
  private discardPrompt(page: HTMLElement, done: () => void, trigger: HTMLButtonElement): void {
    showSettingsInlineConfirmation(page, trigger, { message: this.zh ? "还有未保存的文字，要放弃修改吗？" : "Discard unsaved changes?", confirmLabel: this.zh ? "放弃修改" : "Discard", cancelLabel: this.zh ? "继续编辑" : "Keep editing", onConfirm: async () => done() });
    const panel = page.querySelector<HTMLElement>(".echoink-settings-inline-confirm");
    page.ownerDocument.defaultView?.requestAnimationFrame(() => { if (panel?.isConnected) panel.scrollIntoView?.({ block: "nearest" }); });
  }
  private renderSlot(parent: HTMLElement, key: string, label: string): void {
    const item = this.item(key), draft = this.drafts.get(key);
    const row = parent.createDiv({ cls: "echoink-profile-row", attr: { "data-profile-key": key } });
    const copy = row.createDiv({ cls: "echoink-profile-copy" });
    copy.createDiv({ cls: "echoink-profile-name", text: label });
    if (item) {
      copy.createDiv({ cls: "echoink-profile-value", text: item.text });
      copy.createDiv({ cls: "echoink-profile-source", text: item.basis === "observed_memory" ? (this.zh ? "系统观察 · 仅供参考" : "System observation · For reference") : (this.zh ? "你确认的" : "Confirmed by you") });
    }
    const actions = row.createDiv({ cls: "echoink-profile-actions" });
    if (!draft) {
      this.button(actions, item ? (this.zh ? "修改" : "Edit") : (this.zh ? "补写" : "Add"), () => {
        if (!this.snapshot) return;
        this.drafts.set(key, { text: item?.text ?? "", original: item?.text ?? "", revision: this.snapshot.revision, conflict: false, error: "" });
        this.focusKey = `${key}:input`; this.draw();
      }, `${key}:edit`);
      if (item?.basis === "observed_memory") this.button(actions, this.zh ? "确认" : "Confirm", () => void this.mutate("confirm", key), `${key}:confirm`);
      if (item) {
        const remove = this.button(actions, "", () => showSettingsInlineConfirmation(row, remove, { deleteAction: Platform.isDesktopApp, message: this.zh ? "只删除这项画像，原记忆会保留。" : "Only this profile item will be removed. The original memories remain.", confirmLabel: this.zh ? "删除" : "Delete", cancelLabel: this.zh ? "取消" : "Cancel", onConfirm: () => this.mutate("remove", key) }), `${key}:remove`, "is-icon is-danger");
        remove.setAttribute("aria-label", this.zh ? `删除${label}` : `Delete ${label}`);
        if (Platform.isDesktopApp) applyDeleteButton(remove, { iconOnly: true }); else setIcon(remove, "trash-2");
      }
      return;
    }
    const editor = row.createDiv({ cls: "echoink-profile-edit" });
    const input = editor.createEl("textarea", { attr: { rows: "3", "aria-label": label, "data-profile-focus": `${key}:input` } });
    input.value = draft.text; input.disabled = this.busy;
    input.oninput = () => { draft.text = input.value; draft.error = ""; };
    if (draft.error) createSettingsState(editor, draft.error, "error");
    const buttons = editor.createDiv({ cls: "echoink-profile-actions" });
    this.button(buttons, this.zh ? "取消" : "Cancel", () => { this.drafts.delete(key); this.focusKey = `${key}:edit`; this.draw(); }, `${key}:cancel`);
    if (draft.conflict) this.button(buttons, this.zh ? "重新核对" : "Review latest", () => {
      if (!this.snapshot || this.readError) { void this.reload(); return; }
      draft.revision = this.snapshot.revision; draft.original = this.item(key)?.text ?? ""; draft.conflict = false; draft.error = ""; this.draw();
    }, `${key}:review`);
    const save = this.button(buttons, this.zh ? "保存" : "Save", () => void this.mutate("update", key), `${key}:save`, "mod-cta");
    save.disabled = this.busy || draft.conflict;
    if (draft.conflict) createSettingsState(editor, this.zh ? "内容已变化，请重新核对；你的输入已保留。" : "Content changed. Review the latest value; your draft is retained.", "error");
  }
  private async mutate(operation: "update" | "confirm" | "remove", key: string): Promise<void> {
    if (this.busy || !this.snapshot || this.disposed) return;
    const draft = this.drafts.get(key);
    if (operation === "update" && (!draft || draft.conflict)) return;
    if (operation === "update" && (!draft!.text.trim() || draft!.text.trim().length > USER_PROFILE_ITEM_HARD_MAX_CHARS)) {
      draft!.error = !draft!.text.trim() ? (this.zh ? "请输入内容；删除请使用删除操作。" : "Enter content. Use Delete to remove this item.") : (this.zh ? `最多 ${USER_PROFILE_ITEM_HARD_MAX_CHARS} 个字。` : `Use at most ${USER_PROFILE_ITEM_HARD_MAX_CHARS} characters.`); this.draw(); return;
    }
    this.busy = true; this.feedback = this.zh ? (operation === "remove" ? "正在删除…" : operation === "confirm" ? "正在确认…" : "正在保存…") : "Saving…"; this.draw();
    try {
      const input = { profileKey: key, expectedRevision: draft?.revision ?? this.snapshot.revision };
      if (operation === "update") await this.host.update({ ...input, text: draft!.text.trim() });
      else await this.host[operation](input);
    } catch (error) {
      const conflict = !!error && typeof error === "object" && ((error as { code?: string }).code === "revision_conflict" || String((error as Error).message).includes("revision_conflict"));
      if (draft) { draft.conflict = conflict; draft.error = conflict ? "" : (this.zh ? "保存失败，你的输入已保留。" : "Save failed. Your draft is retained."); }
      this.feedback = conflict ? (this.zh ? "内容已变化，请重新核对。" : "Content changed. Review the latest value.") : (this.zh ? "操作未完成，请重试。" : "Operation failed. Try again.");
      if (conflict) await this.reload();
      this.busy = false; this.draw(); return;
    }
    this.drafts.delete(key);
    this.feedback = this.zh ? "已保存" : "Saved";
    const refreshed = await this.reload();
    if (!refreshed) this.feedback = this.zh ? "已保存，画像暂时读不到，请重试。" : "Saved. The profile could not be refreshed; try again.";
    this.busy = false; this.draw();
  }
}
