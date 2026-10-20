import type { MobileShellPage } from "../mobile/shell-types";
import type { MobileModuleId } from "../../mobile/module-contracts";
import type { IPadPageContext } from "./workbench-contract";
import { ipadElement as el, ipadIcon, ipadAvatar } from "./workbench-elements";

export { el };
export const moduleText = (ctx: IPadPageContext, zh: string, en = zh): string => ctx.host.settings().settingsLanguage === "en" ? en : zh;
export function moduleButton(ctx: IPadPageContext, label: string, action: () => void | Promise<unknown>, primary = false, icon?: string): HTMLButtonElement {
  const button = el(ctx.document, "button", `pd-module-button${primary ? " is-primary" : ""}`); button.type = "button";
  const visible = el(ctx.document, "span", "pd-module-button-visible"); if (icon) visible.append(ipadIcon(ctx.document, icon)); visible.append(el(ctx.document, "span", "", label)); button.append(visible);
  button.addEventListener("click", () => { if (!button.disabled) void Promise.resolve().then(action).catch(error => ctx.error(error)); }); return button;
}
export function moduleField(ctx: IPadPageContext, parent: HTMLElement, label: string, value: string, change: (value: string) => void, type = "text"): HTMLInputElement {
  const field = el(ctx.document, "label", "pd-module-field"), input = el(ctx.document, "input", "pd-module-input"); input.type = type; input.value = value; input.setAttribute("aria-label", label);
  input.addEventListener("input", () => change(input.value)); field.append(el(ctx.document, "span", "", label), input); parent.append(field); return input;
}
export function moduleSelect(ctx: IPadPageContext, parent: HTMLElement, label: string, options: readonly (readonly [string, string])[], value: string, change: (value: string) => void): HTMLSelectElement {
  const field = el(ctx.document, "label", "pd-module-field"), select = el(ctx.document, "select", "pd-module-input"); select.setAttribute("aria-label", label);
  for (const [id, name] of options) { const option = el(ctx.document, "option", "", name); option.value = id; select.append(option); } select.value = value;
  select.addEventListener("change", () => change(select.value)); field.append(el(ctx.document, "span", "", label), select); parent.append(field); return select;
}
export function moduleActions(ctx: IPadPageContext, parent: HTMLElement): HTMLElement { const row = el(ctx.document, "div", "pd-module-actions"); parent.append(row); return row; }
export function moduleEmpty(ctx: IPadPageContext, parent: HTMLElement, text: string): void { parent.append(el(ctx.document, "p", "pd-module-empty", text)); }
export function moduleConfirm(ctx: IPadPageContext, area: HTMLElement, message: string, apply: () => Promise<unknown>, label = "确认"): void {
  const box = el(ctx.document, "div", "pd-module-confirm", message), actions = moduleActions(ctx, box);
  actions.append(moduleButton(ctx, moduleText(ctx, "取消", "Cancel"), () => area.replaceChildren()), moduleButton(ctx, label, apply, true)); area.replaceChildren(box);
}
export function moduleSegments(ctx: IPadPageContext, options: readonly (readonly [string, string])[], value: string, change: (value: string) => void): HTMLElement {
  const track = el(ctx.document, "div", "pd-module-segments"), thumb = el(ctx.document, "span", "pd-module-segment-thumb"); track.setAttribute("role", "group"); track.append(thumb); track.style.setProperty("--pd-segments", String(options.length));
  const update = (selected: string) => selectModuleSegment(track, selected);
  for (const [id, label] of options) { const button = moduleButton(ctx, label, () => { update(id); change(id); }); button.dataset.value = id; track.append(button); } update(value); return track;
}
export function selectModuleSegment(track: HTMLElement, value: string): void {
  const buttons = Array.from(track.querySelectorAll<HTMLButtonElement>("button")), index = Math.max(0, buttons.findIndex(button => button.dataset.value === value));
  const thumb = track.querySelector<HTMLElement>(".pd-module-segment-thumb"); if (thumb) thumb.style.transform = `translateX(${index * 100}%)`;
  buttons.forEach(button => button.setAttribute("aria-pressed", String(button.dataset.value === value)));
}
export function moduleView(ctx: IPadPageContext, id: string, title: string, module?: MobileModuleId) {
  const content = el(ctx.document, "div", "pd-module-page"), header = el(ctx.document, "header", "pd-module-header"), fields = el(ctx.document, "fieldset", "pd-module-fields"), body = el(ctx.document, "div", "pd-module-body"), feedback = el(ctx.document, "div", "pd-module-status"), leaveArea = el(ctx.document, "div", "pd-module-leave"), handoffArea = el(ctx.document, "div", "pd-module-handoff");
  feedback.setAttribute("role", "status"); feedback.hidden = true; fields.append(header, handoffArea, body); content.append(fields, feedback, leaveArea);
  let busy = false, disposed = false, allowed = false, nested = false, generation = 0, pendingLeave: Promise<boolean> | undefined;
  const cleanup: (() => void)[] = [], page: MobileShellPage = { id, title, content, header: "content" };
  const view = { content, body, fields, feedback, page, get alive() { return !disposed; }, get busy() { return busy; }, dirty: () => false, discard: () => {}, onBusy: (_busy: boolean) => {},
    setTitle: (value: string) => { page.title = value; const own = header.querySelector("h1"); if (own) own.textContent = value; const panel = content.closest(".echoink-ipad-page"); panel?.setAttribute("aria-label", value); const shellTitle = panel?.querySelector(".echoink-ipad-title"); if (shellTitle) shellTitle.textContent = value; },
    changed: () => { feedback.hidden = true; allowed = false; }, allow: () => { allowed = true; },
    report: (error: unknown) => { if (!disposed) { const message = error && typeof error === "object" && "message" in error ? String(error.message) : String(error); feedback.hidden = false; feedback.setAttribute("role", "alert"); feedback.textContent = /finance_(?:version|readback)|todo_source_changed/u.test(message) ? moduleText(ctx, "内容已变化，请重新读取；输入已保留。", "Content changed. Reload; your draft is retained.") : message; } },
    status: (message: string) => { if (!disposed) { feedback.textContent = message; feedback.hidden = !message; feedback.setAttribute("role", "status"); } },
    cleanup: (dispose: () => void) => cleanup.push(dispose),
    async read<T>(load: () => Promise<T>, render: (value: T) => void): Promise<void> {
      const ticket = ++generation; if (!body.childElementCount) view.status(moduleText(ctx, "正在读取…", "Loading…"));
      try { const value = await load(); if (!disposed && ticket === generation) { view.status(""); render(value); } }
      catch (error) { if (!disposed && ticket === generation) { view.report(error); const retry = moduleButton(ctx, moduleText(ctx, "重试", "Retry"), () => view.read(load, render)); feedback.append(retry); } }
    },
    async run(action: () => Promise<unknown>): Promise<boolean> {
      if (busy || disposed) return false; busy = true; generation++; fields.disabled = true; content.setAttribute("aria-busy", "true"); feedback.hidden = true; view.onBusy(true);
      try { await action(); return !disposed; } catch (error) { view.report(error); return false; }
      finally { busy = false; if (!disposed) { fields.disabled = false; content.setAttribute("aria-busy", "false"); view.onBusy(false); } }
    },
    async push(child: MobileShellPage): Promise<void> { if (busy || disposed) { child.dispose?.(); return; } nested = true; try { if (!await ctx.shell.push(child)) child.dispose?.(); } finally { nested = false; } },
    finish(): MobileShellPage {
      page.canLeave = async () => {
        if (busy) return false; if (nested || allowed || !view.dirty()) return true;
        return pendingLeave ??= new Promise<boolean>(resolve => {
          const box = el(ctx.document, "div", "pd-module-confirm", moduleText(ctx, "还有未保存的修改。", "There are unsaved changes.")), actions = moduleActions(ctx, box);
          const done = (leave: boolean) => { if (leave) { view.discard(); allowed = true; } leaveArea.replaceChildren(); pendingLeave = undefined; resolve(leave); };
          actions.append(moduleButton(ctx, moduleText(ctx, "继续编辑", "Keep editing"), () => done(false)), moduleButton(ctx, moduleText(ctx, "放弃修改", "Discard"), () => done(true), true)); box.append(actions); leaveArea.replaceChildren(box); actions.querySelector<HTMLButtonElement>("button")?.focus();
        });
      };
      page.dispose = () => { if (disposed) return; disposed = true; generation++; cleanup.forEach(dispose => dispose()); }; return page;
    }
  };
  const back = moduleButton(ctx, "", () => ctx.shell.back(), false, "arrow-left"); back.setAttribute("aria-label", moduleText(ctx, "返回", "Back")); back.classList.add("is-icon"); header.append(back, el(ctx.document, "h1", "pd-module-title", title));
  if (module) {
    const handoff = moduleButton(ctx, "", async () => {
      if (busy) return; const prompts = { journal: moduleText(ctx, "聊聊今天", "Let's talk about today"), todos: moduleText(ctx, "帮我把今天和本周的待办排个顺序", "Help me prioritize my to-dos for today and this week"), finance: moduleText(ctx, "看看这个月餐饮为什么快超预算了", "Review why dining spending is close to this month's budget") };
      const send = async (replace = false) => { const result = await ctx.host.services.modules.handoff(module, prompts[module], replace); if (!view.alive) return;
        if (result.conflict) { moduleConfirm(ctx, handoffArea, moduleText(ctx, "这个 Agent 已有草稿，要替换吗？", "This Agent already has a draft. Replace it?"), () => view.run(() => send(true)), moduleText(ctx, "替换草稿", "Replace draft")); return; }
        handoffArea.replaceChildren(); await ctx.host.openAgent({ kind: "agent", agentId: result.agentId }); };
      await view.run(() => send());
    }, true); header.append(handoff);
    const refreshOwner = () => { if (!view.alive) return; const owner = ctx.host.services.modules.owner(module), visible = handoff.firstElementChild!; visible.replaceChildren(ipadAvatar(ctx.document, owner), el(ctx.document, "span", "", module === "journal" ? moduleText(ctx, `和${owner.name}聊今天`, `Talk with ${owner.name}`) : module === "todos" ? moduleText(ctx, `交给${owner.name}排一排`, `Plan with ${owner.name}`) : moduleText(ctx, `交给${owner.name}`, `Ask ${owner.name}`))); };
    refreshOwner(); cleanup.push(ctx.host.workbench.subscribe(refreshOwner));
  }
  return view;
}

export interface ModuleFormField { key: string; label: string; value: string; type?: string; options?: readonly (readonly [string, string])[]; segmented?: boolean; checkbox?: boolean; multiline?: boolean; picker?: (value: string, select: (value: string) => void) => MobileShellPage; renderChoice?: (parent: HTMLElement, value: string) => void }
interface ModuleFormOptions { change?: (key: string, values: Record<string, string>, previous: string) => void; remove?: { message: string; action: () => Promise<unknown> } }
export function createModuleForm(ctx: IPadPageContext, id: string, title: string, definitions: ModuleFormField[], save: (values: Record<string, string>) => Promise<unknown>, options: ModuleFormOptions = {}): MobileShellPage {
  const v = moduleView(ctx, id, title), values = Object.fromEntries(definitions.map(field => [field.key, field.value])), baseline = JSON.stringify(values);
  const controls = new Map<string, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(), redraw = new Map<string, () => void>();
  v.content.classList.add("pd-module-form");
  for (const definition of definitions) {
    const change = (value: string) => { const previous = values[definition.key]; values[definition.key] = value;
      try { options.change?.(definition.key, values, previous); v.changed(); } catch (error) { values[definition.key] = previous; v.report(error); }
      for (const [key, control] of controls) if (control.value !== values[key]) control.value = values[key];
      redraw.forEach(render => render());
    };
    if (definition.checkbox) { const field = el(ctx.document, "label", "pd-module-check-row"), input = el(ctx.document, "input", ""); input.type = "checkbox"; input.setAttribute("aria-label", definition.label); input.addEventListener("change", () => change(input.checked ? "yes" : "no")); field.append(el(ctx.document, "span", "", definition.label), input); v.body.append(field); const render = () => { input.checked = values[definition.key] === "yes"; }; redraw.set(definition.key, render); render(); }
    else if (definition.segmented && definition.options) { const field = el(ctx.document, "div", "pd-module-field"), track = moduleSegments(ctx, definition.options, definition.value, change); track.setAttribute("aria-label", definition.label); field.append(el(ctx.document, "span", "", definition.label), track); v.body.append(field); redraw.set(definition.key, () => selectModuleSegment(track, values[definition.key])); }
    else if (definition.picker) { const field = el(ctx.document, "div", "pd-module-field"), choice = moduleButton(ctx, definition.label, () => v.push(definition.picker!(values[definition.key], change))), art = el(ctx.document, "span", "pd-finance-icon-art"); choice.firstElementChild!.prepend(art); field.append(choice); v.body.append(field); const render = () => definition.renderChoice?.(art, values[definition.key]); redraw.set(definition.key, render); render(); }
    else if (definition.options) controls.set(definition.key, moduleSelect(ctx, v.body, definition.label, definition.options, definition.value, change));
    else if (definition.multiline) { const field = el(ctx.document, "label", "pd-module-field"), input = el(ctx.document, "textarea", "pd-module-input pd-module-editor"); input.value = definition.value; input.setAttribute("aria-label", definition.label); input.addEventListener("input", () => change(input.value)); field.append(el(ctx.document, "span", "", definition.label), input); v.body.append(field); controls.set(definition.key, input); }
    else controls.set(definition.key, moduleField(ctx, v.body, definition.label, definition.value, change, definition.type));
  }
  const footer = el(ctx.document, "div", "pd-module-actions"), cancel = moduleButton(ctx, moduleText(ctx, "取消", "Cancel"), () => ctx.shell.back()), submit = moduleButton(ctx, moduleText(ctx, "保存", "Save"), async () => {
    cancel.disabled = submit.disabled = true; const success = await v.run(() => save({ ...values })); if (!v.alive) return; cancel.disabled = submit.disabled = false; if (success) { v.allow(); await ctx.shell.back(); }
  }, true); footer.append(cancel, submit); v.page.footer = footer;
  v.onBusy = busy => { cancel.disabled = submit.disabled = busy; };
  if (options.remove) { const confirmation = el(ctx.document, "div", "pd-module-confirm-area"), remove = moduleButton(ctx, moduleText(ctx, "删除", "Delete"), () => moduleConfirm(ctx, confirmation, options.remove!.message, async () => { const saved = await v.run(options.remove!.action); if (saved) { v.allow(); await ctx.shell.back(); } }, moduleText(ctx, "删除", "Delete"))); remove.classList.add("is-danger"); v.body.append(remove, confirmation); }
  v.dirty = () => JSON.stringify(values) !== baseline; return v.finish();
}
