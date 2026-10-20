import type { MobileModuleId } from "../../mobile/module-contracts";
import type { MobileShellPage } from "../mobile/shell-types";
import type { IPhonePageContext } from "./workbench-contract";
import { iphoneAvatar, iphoneButton, iphoneElement as el, iphoneIcon } from "./workbench-elements";
import { settingsButton, settingsError, settingsField, settingsGroup, pushSettingsPage } from "./settings-elements";
import { settingsMessage, settingsText } from "./settings-language";
import { formatMobileDate } from "../../mobile/date-display";

export const moduleText = (ctx: IPhonePageContext, zh: string, en?: string): string => ctx.host.settings().settingsLanguage === "en" ? en ?? settingsText(ctx, zh) : zh;
export const moduleDate = formatMobileDate;
export const moduleMonth = (date: Date): string => moduleDate(date).slice(0, 7);
export const moduleParseDate = (date: string): Date => { const [year, month, day] = date.split("-").map(Number); return new Date(year, month - 1, day || 1, 12); };

/** A retained iPhone page. Requests may finish after navigation without changing detached DOM. */
export class IPhoneModulePage {
  readonly content: HTMLElement;
  readonly body: HTMLFieldSetElement;
  readonly footer: HTMLElement;
  readonly error: ReturnType<typeof settingsError>;
  readonly page: MobileShellPage;
  alive = true;
  busy = false;
  dirty: () => boolean = () => false;
  beforeLeave: () => void | Promise<void> = () => {};
  private allowLeave = false;
  private nested = false;
  private leaveResolve?: (accepted: boolean) => void;
  private readonly cleanups: (() => void)[] = [];
  constructor(readonly ctx: IPhonePageContext, id: string, title: string, module?: MobileModuleId, prompt = "") {
    this.content = el(ctx.document, "div", "ip-settings ip-module-page"); this.body = el(ctx.document, "fieldset", "ip-module-body"); this.footer = el(ctx.document, "div", "ip-settings-actions ip-module-footer");
    this.content.append(this.body); this.error = settingsError(ctx, this.content);
    this.page = { id, title, content: this.content, footer: this.footer, canLeave: () => this.canLeave(), dispose: () => this.dispose() };
    if (module) {
      const actions = el(ctx.document, "div", "ip-module-header-actions"), owner = ctx.host.services.modules.owner(module);
      const label = module === "journal" ? moduleText(ctx, `和${owner.name.trim()}聊今天`, `Talk with ${owner.name}`) : moduleText(ctx, `交给${owner.name.trim()}`, `Ask ${owner.name}`);
      const button = iphoneButton(ctx.document, label, () => { void handoff(false); }, "is-primary"); button.querySelector(".ip-button-visible")?.prepend(iphoneAvatar(ctx.document, owner)); actions.append(button); this.page.actions = actions;
      const handoff = async (replaceDraft: boolean) => {
        await this.run(async () => {
          const result = await ctx.host.services.modules.handoff(module, prompt, replaceDraft); if (!this.alive) return;
          if (result.conflict) this.confirm(this.content, "已有未发送的内容，是否替换？", "替换草稿", async () => { await handoff(true); });
          else { this.allow(); this.busy = false; await ctx.navigate({ kind: "agent", agentId: result.agentId }); }
        });
      };
    }
  }
  async push(): Promise<void> { if (!this.footer.childElementCount) this.page.footer = undefined; await pushSettingsPage(this.ctx, this.page); }
  cleanup(dispose: () => void): void { this.cleanups.push(dispose); }
  allow(): void { this.allowLeave = true; }
  changed(): void { this.allowLeave = false; this.error.show(); }
  async child(open: () => Promise<void>): Promise<void> { this.nested = true; try { await open(); } finally { this.nested = false; } }
  async run(action: () => Promise<void>): Promise<boolean> {
    if (!this.alive || this.busy) return false; this.busy = true; this.body.disabled = true; this.content.setAttribute("aria-busy", "true"); this.error.show();
    const controls = [...Array.from(this.footer.querySelectorAll("button")), ...Array.from(this.page.actions?.querySelectorAll("button") ?? [])].map(button => ({ button, disabled: button.disabled }));
    for (const { button } of controls) if (button.dataset.moduleStop !== "true") button.disabled = true;
    try { await action(); return this.alive; }
    catch (failure) { if (this.alive) this.error.show(failure); return false; }
    finally { this.busy = false; if (this.alive) { this.body.disabled = false; this.content.setAttribute("aria-busy", "false"); for (const { button, disabled } of controls) button.disabled = disabled; } }
  }
  button(parent: HTMLElement, label: string, action: () => void | Promise<void>, primary = false): HTMLButtonElement {
    const button = settingsButton(this.ctx, label, () => { if (!button.disabled) void Promise.resolve().then(action).catch(error => this.ctx.error(error)); }, primary ? "is-primary" : ""); parent.append(button); return button;
  }
  field(parent: HTMLElement, label: string, value: string, change: (value: string) => void, type = "text"): HTMLInputElement { return settingsField(this.ctx, parent, label, value, next => { change(next); this.changed(); }, type); }
  select(parent: HTMLElement, label: string, values: readonly (readonly [string, string])[], value: string, change: (value: string) => void): HTMLSelectElement {
    const field = el(this.ctx.document, "label", "ip-settings-field"); field.append(settingsMessage(this.ctx, el(this.ctx.document, "span", "ip-settings-field-label"), label));
    const select = el(this.ctx.document, "select", "ip-settings-input"); select.setAttribute("aria-label", settingsText(this.ctx, label));
    for (const [key, text] of values) { const option = el(this.ctx.document, "option", "", text); option.value = key; select.append(option); } select.value = value;
    select.addEventListener("change", () => { change(select.value); this.changed(); }); field.append(select); parent.append(field); return select;
  }
  textarea(parent: HTMLElement, label: string, value: string, change: (value: string) => void): HTMLTextAreaElement {
    const field = el(this.ctx.document, "label", "ip-settings-field"); field.append(settingsMessage(this.ctx, el(this.ctx.document, "span", "ip-settings-field-label"), label)); const input = el(this.ctx.document, "textarea", "ip-module-editor"); input.value = value; input.setAttribute("aria-label", settingsText(this.ctx, label)); input.addEventListener("input", () => { change(input.value); this.changed(); }); field.append(input); parent.append(field); return input;
  }
  group(title?: string, parent = this.body): HTMLElement { return settingsGroup(this.ctx, parent, title); }
  empty(parent: HTMLElement, text: string): void { parent.append(settingsMessage(this.ctx, el(this.ctx.document, "div", "ip-module-empty"), text)); }
  heading(parent: HTMLElement, text: string): HTMLElement { const head = el(this.ctx.document, "div", "ip-module-section-head"); head.append(settingsMessage(this.ctx, el(this.ctx.document, "h2", ""), text)); parent.append(head); return head; }
  confirm(parent: HTMLElement, message: string, label: string, execute: () => Promise<void>, danger = false): void {
    if (parent.querySelector(":scope > .ip-settings-confirm")) return;
    const box = el(this.ctx.document, "div", "ip-settings-confirm"); box.append(settingsMessage(this.ctx, el(this.ctx.document, "p", ""), message)); const actions = el(this.ctx.document, "div", "ip-settings-actions");
    this.button(actions, "取消", () => box.remove()); const confirm = this.button(actions, label, async () => { if (this.busy) return; confirm.disabled = true; try { await execute(); box.remove(); } finally { if (this.alive) confirm.disabled = false; } }); if (danger) confirm.classList.add("is-danger"); box.append(actions); parent.append(box); box.scrollIntoView({ block: "nearest" });
  }
  private async canLeave(): Promise<boolean> {
    if (this.busy) return false;
    if (!this.nested && !this.allowLeave && this.dirty()) {
      if (this.leaveResolve) return false;
      const accepted = await new Promise<boolean>(resolve => {
        this.leaveResolve = resolve; const box = el(this.ctx.document, "div", "ip-settings-confirm"); box.append(settingsMessage(this.ctx, el(this.ctx.document, "p", ""), "还有未保存的修改。")); const actions = el(this.ctx.document, "div", "ip-settings-actions");
        const decide = (value: boolean) => { this.leaveResolve = undefined; box.remove(); resolve(value); };
        this.button(actions, "继续编辑", () => decide(false)); this.button(actions, "放弃修改", () => decide(true), true); box.append(actions); this.content.append(box); box.scrollIntoView({ block: "nearest" });
      });
      if (!accepted) return false;
    }
    await this.beforeLeave(); return true;
  }
  private dispose(): void { if (!this.alive) return; this.alive = false; this.leaveResolve?.(false); this.leaveResolve = undefined; for (const cleanup of this.cleanups) cleanup(); }
}

export function moduleSegments(view: IPhoneModulePage, parent: HTMLElement, label: string, values: readonly (readonly [string, string])[], selected: string, change: (value: string) => void): HTMLElement {
  const track = el(view.ctx.document, "div", "ip-module-segments"); track.setAttribute("role", "group"); track.setAttribute("aria-label", settingsText(view.ctx, label));
  const slider = el(view.ctx.document, "span", "ip-module-segment-slider"); slider.style.width = `${100 / values.length}%`; slider.style.transform = `translateX(${Math.max(0, values.findIndex(([id]) => id === selected)) * 100}%)`; track.append(slider);
  for (const [id, text] of values) { const button = view.button(track, text, () => { slider.style.transform = `translateX(${Math.max(0, values.findIndex(([key]) => key === id)) * 100}%)`; for (const [index, control] of Array.from(track.querySelectorAll("button")).entries()) control.setAttribute("aria-pressed", String(values[index][0] === id)); change(id); }); button.classList.add("ip-module-segment"); button.setAttribute("aria-pressed", String(id === selected)); } parent.append(track); return track;
}
export function moduleStat(view: IPhoneModulePage, parent: HTMLElement, label: string, value: string): void { const card = el(view.ctx.document, "div", "ip-module-stat"); card.append(el(view.ctx.document, "strong", "", value), settingsMessage(view.ctx, el(view.ctx.document, "span", ""), label)); parent.append(card); }
export function moduleIconButton(view: IPhoneModulePage, parent: HTMLElement, label: string, icon: string, action: () => void): HTMLButtonElement { const button = view.button(parent, label, action); button.replaceChildren(iphoneIcon(view.ctx.document, icon)); button.setAttribute("aria-label", settingsText(view.ctx, label)); button.classList.add("ip-module-icon-button"); return button; }
