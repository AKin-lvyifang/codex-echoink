import { createOriginButton, disposeOriginControls } from "./origin-controls";
import { createSettingsPage, showSettingsInlineConfirmation } from "./settings-v2";
import type { AccountActions, AccountMembershipViewModel } from "./account-membership-model";
import { mountAccountMembership, type AccountMembershipPageOptions } from "./account-membership";

export interface AccountFormHandle { close(): void; afterClose?: () => void }
export interface DesktopAccountHooks {
  openForm(title: string, render: (body: HTMLElement, handle: AccountFormHandle) => void, keepDraft: boolean, closed: (preserve: boolean) => void): void;
  committed(): void;
  draftChanged(): void;
  redemptionClosed(): void;
}
export interface DesktopAccountMembershipHandle {
  mount(parent: HTMLElement): void;
  suspend(): void;
  dispose(): void;
  readonly hasDraft: boolean;
  readonly submitting: boolean;
  requestLeave(done: () => void): void;
}
interface Frame {
  title: string; page: HTMLElement; body: HTMLElement; handle: AccountFormHandle;
  closed: (preserve: boolean) => void; baseline: Map<HTMLInputElement, string>; extraDirty: boolean; committed: boolean;
  opener: FocusTarget;
}
interface FocusTarget { element: HTMLElement | null; key: string | null; label: string | null }
type Renderer = (parent: HTMLElement, options: AccountMembershipPageOptions) => { dispose(): void };

export function mountDesktopAccountMembership(parent: HTMLElement, options: AccountMembershipPageOptions): DesktopAccountMembershipHandle {
  const controller = new DesktopAccountMembershipController(options, mountAccountMembership);
  controller.mount(parent); return controller;
}

/** Desktop owns navigation/lifetime; the existing component still owns forms and actions. */
export class DesktopAccountMembershipController implements DesktopAccountMembershipHandle {
  private root: HTMLElement | null = null;
  private overview: HTMLElement | null = null;
  private detail: HTMLElement | null = null;
  private view: { dispose(): void } | null = null;
  private frames: Frame[] = [];
  private unsubscribe: (() => void) | undefined;
  private closed = false;
  private generation = 0;
  private holds = new Set<object>();
  private current: AccountMembershipViewModel;
  private rendered: AccountMembershipViewModel;
  private identity: string | null;
  private signature: string;
  private pending = false;
  private pendingLeave: (() => void) | null = null;
  private usageRange = "30";
  private usageOpen = false;
  private metricsOpen = false;
  private lastTrigger: HTMLElement | null = null;
  private pendingFocus: FocusTarget | null = null;
  constructor(private readonly options: AccountMembershipPageOptions, private readonly renderView: Renderer) {
    this.current = options.read?.() ?? options.viewModel;
    this.rendered = { ...this.current };
    this.identity = this.current.identity?.email ?? null;
    this.signature = JSON.stringify(this.current);
    this.unsubscribe = options.subscribe?.(() => this.refresh());
  }
  get submitting(): boolean { return this.holds.size > 0; }
  private dirty(frame: Frame): boolean { return frame.extraDirty || Array.from(frame.baseline).some(([input, value]) => input.value !== value); }
  get hasDraft(): boolean {
    return this.frames.some(frame => this.dirty(frame)) || !!this.root?.querySelector<HTMLInputElement>(".desktop-account-redemption input")?.value;
  }
  mount(parent: HTMLElement): void {
    if (this.closed) return;
    this.refresh();
    if (!this.root) {
      this.root = parent.ownerDocument.createElement("div"); this.root.className = "echoink-desktop-account-settings";
      this.overview = this.root.createDiv(); this.detail = this.root.createDiv({ cls: "desktop-account-detail" }); this.detail.hidden = true;
      this.root.addEventListener("click", event => {
        this.lastTrigger = (event.target as Element | null)?.closest<HTMLElement>("button, [role=button]") ?? null;
      }, true);
      this.root.addEventListener("keydown", event => {
        if (event.key !== "Escape" || event.isComposing || this.submitting) return;
        const frame = this.frames.at(-1);
        if (frame) { event.preventDefault(); event.stopPropagation(); this.closeFrame(frame); }
      });
      this.draw();
    }
    parent.appendChild(this.root);
    this.restorePendingFocus();
    if (this.pendingLeave) { const done = this.pendingLeave; this.pendingLeave = null; this.requestLeave(done); }
  }
  suspend(): void { this.root?.remove(); }
  dispose(): void {
    if (this.closed) return;
    this.closed = true; this.generation++; this.holds.clear(); this.unsubscribe?.(); this.unsubscribe = undefined;
    this.clearFrames(); this.view?.dispose(); this.view = null;
    if (this.root) { disposeOriginControls(this.root); this.root.remove(); }
    this.root = this.overview = this.detail = null; this.pendingLeave = null; this.lastTrigger = null; this.pendingFocus = null;
  }
  requestLeave(done: () => void): void {
    if (this.submitting) return;
    if (!this.hasDraft) { done(); return; }
    if (!this.root?.isConnected) { this.pendingLeave = done; return; }
    this.confirmDiscard(() => { this.clearFrames(); this.clearCode(); done(); });
  }
  private hold(): () => void {
    const token = {}; this.holds.add(token);
    return () => { if (this.holds.delete(token)) this.refresh(); };
  }
  private wrappedActions(): AccountActions {
    const wrapped: Record<string, unknown> = {};
    for (const [key, action] of Object.entries(this.options.actions ?? {})) {
      if (typeof action !== "function") continue;
      wrapped[key] = async (...args: unknown[]) => {
        if (this.closed) throw new Error("Account page closed");
        const generation = this.generation, release = this.hold();
        try {
          await (action as (...values: unknown[]) => Promise<void>)(...args);
          this.refresh();
          if (this.closed || generation !== this.generation) throw new Error("Account changed");
        } finally { release(); }
      };
    }
    return wrapped;
  }
  private refresh(): void {
    if (this.closed) return;
    const next = this.options.read?.() ?? this.current;
    const identity = next.identity?.email ?? null;
    const signature = JSON.stringify(next);
    if (identity !== this.identity) {
      this.generation++; this.identity = identity; this.holds.clear(); this.pendingLeave = null; this.lastTrigger = null; this.pendingFocus = null; this.clearFrames(); this.clearCode();
      this.current = next; this.signature = signature; this.pending = false;
      this.view?.dispose(); this.view = null;
      if (this.root) this.draw();
      return;
    }
    if (signature !== this.signature) { this.current = next; this.signature = signature; this.pending = true; Object.assign(this.rendered, next); this.frames.forEach(frame => this.updateFrameState(frame)); }
    if (this.pending && !this.submitting && !this.frames.length && !this.root?.querySelector(".desktop-account-redemption")) this.draw();
  }
  private draw(): void {
    if (!this.overview || this.closed) return;
    const range = this.overview.querySelector<HTMLButtonElement>("[data-usage-range][aria-pressed=true]"); if (range) this.usageRange = range.dataset.usageRange!;
    const usage = this.overview.querySelector<HTMLDetailsElement>(".desktop-account-more-usage"); if (usage) this.usageOpen = usage.open;
    const metrics = this.overview.querySelector<HTMLElement>(".desktop-account-statistics-notes"); if (metrics) this.metricsOpen = !metrics.hidden;
    this.view?.dispose(); this.overview.empty(); this.pending = false; this.rendered = { ...this.current };
    this.view = this.renderView(this.overview, { ...this.options, subscribe: undefined, viewModel: this.rendered, actions: this.wrappedActions(), beginAction: () => this.hold(),
      desktopHooks: {
        openForm: (title, render, keep, closed) => this.openForm(title, render, keep, closed),
        committed: () => { const frame = this.frames.at(-1); if (frame) frame.committed = true; },
        draftChanged: () => { const frame = this.frames.at(-1); if (frame) frame.extraDirty = true; },
        redemptionClosed: () => this.refresh()
      } });
    const selected = Array.from(this.overview.querySelectorAll<HTMLButtonElement>("[data-usage-range]")).find(button => button.dataset.usageRange === this.usageRange); selected?.click();
    const more = this.overview.querySelector<HTMLDetailsElement>(".desktop-account-more-usage"); if (more) more.open = this.usageOpen;
    const notes = this.overview.querySelector<HTMLElement>(".desktop-account-statistics-notes"); if (notes && this.metricsOpen) { notes.hidden = false; this.overview.querySelector("[data-account-statistics]")?.setAttribute("aria-expanded", "true"); }
    this.overview.hidden = this.frames.length > 0;
    this.restorePendingFocus();
  }
  private openForm(title: string, render: (body: HTMLElement, handle: AccountFormHandle) => void, keepDraft: boolean, closed: (preserve: boolean) => void): void {
    if (!this.detail || !this.overview || this.closed || this.submitting) return;
    const previous = this.frames.at(-1);
    if (keepDraft && this.frames.length > 1 && this.frames[this.frames.length - 2].title === title) { const child = this.frames.pop()!; this.destroyFrame(child, true); this.showFrame(this.frames.at(-1)!); this.pendingFocus = child.opener; this.restorePendingFocus(); return; }
    const trigger = this.lastTrigger && this.root?.contains(this.lastTrigger) ? this.lastTrigger : this.root?.ownerDocument.activeElement as HTMLElement | null;
    const opener: FocusTarget = { element: trigger, key: trigger?.getAttribute("data-echoink-focus-key") ?? null, label: trigger?.getAttribute("aria-label") ?? trigger?.textContent?.trim() ?? null };
    if (!keepDraft) this.clearFrames();
    else if (previous) previous.page.remove();
    const page = createSettingsPage(this.detail, { title, detail: true, backLabel: this.options.language === "en" ? "Back to account" : "返回账号与会员", onBack: () => this.closeFrame(frame) });
    const body = page.createDiv({ cls: "echoink-account desktop-account-form" });
    const frame: Frame = { title, page, body, handle: { close: () => this.closeFrame(frame) }, closed, baseline: new Map(), extraDirty: false, committed: false, opener };
    this.frames.push(frame);
    render(body, frame.handle);
    body.querySelectorAll<HTMLInputElement>("input").forEach(input => frame.baseline.set(input, input.value));
    this.overview.hidden = true; this.detail.hidden = false;
    body.querySelector<HTMLElement>("input:not([disabled]), button:not([disabled])")?.focus({ preventScroll: true });
  }
  private showFrame(frame: Frame): void {
    this.updateFrameState(frame);
    this.detail?.appendChild(frame.page); if (this.detail) this.detail.hidden = false;
    frame.body.querySelector<HTMLElement>("input:not([disabled]), button:not([disabled])")?.focus({ preventScroll: true });
  }
  private updateFrameState(frame: Frame): void {
    const state = frame.body.querySelector<HTMLElement>("[data-account-password-state]");
    const action = frame.body.querySelector<HTMLButtonElement>("[data-account-password-action]");
    const set = this.current.identity?.passwordSet, en = this.options.language === "en";
    if (state) state.textContent = set ? en ? "Set" : "已设置" : en ? "Not set" : "尚未设置";
    if (action) action.textContent = set ? en ? "Change password" : "修改密码" : en ? "Set password" : "设置密码";
  }
  private restorePendingFocus(): void {
    const target = this.pendingFocus;
    if (!target || !this.root?.isConnected || this.submitting && !this.frames.length) return;
    const scope = this.frames.at(-1)?.page ?? this.overview;
    if (!scope || scope.hidden) return;
    const original = target.element;
    const replacement = Array.from(scope.querySelectorAll<HTMLElement>("button, [role=button]")).find(node => target.key ? node.getAttribute("data-echoink-focus-key") === target.key : (node.getAttribute("aria-label") ?? node.textContent?.trim()) === target.label);
    const control = original && scope.contains(original) ? original : replacement;
    if (control) { control.focus({ preventScroll: true }); this.pendingFocus = null; }
  }
  private closeFrame(frame: Frame): void {
    if (this.frames.at(-1) !== frame || this.closed) return;
    if (!frame.committed && this.submitting) return;
    const close = () => {
      this.frames.pop(); this.destroyFrame(frame, this.frames.length > 0);
      this.pendingFocus = frame.opener;
      const previous = this.frames.at(-1);
      if (previous) this.showFrame(previous);
      else { if (this.detail) this.detail.hidden = true; if (this.overview) this.overview.hidden = false; if (!this.submitting) { if (this.pending) this.draw(); } else this.pending = true; }
      this.restorePendingFocus();
    };
    if (!frame.committed && this.dirty(frame)) this.confirmDiscard(close, frame.page); else close();
  }
  private confirmDiscard(done: () => void, parent = this.frames.at(-1)?.page ?? this.root!): void {
    const trigger = parent.querySelector<HTMLButtonElement>(".settings-back") ?? parent.querySelector<HTMLButtonElement>(".desktop-account-redemption button, button") ?? createOriginButton(parent, { text: this.options.language === "en" ? "Back" : "返回", cls: "text-button" });
    showSettingsInlineConfirmation(parent, trigger, { message: this.options.language === "en" ? "Discard unsaved changes?" : "还有未保存的内容，要放弃修改吗？", confirmLabel: this.options.language === "en" ? "Discard" : "放弃修改", cancelLabel: this.options.language === "en" ? "Keep editing" : "继续编辑", onConfirm: async () => done() });
    const reveal = () => parent.querySelector(".echoink-settings-inline-confirm")?.scrollIntoView?.({ block: "nearest" });
    const view = parent.ownerDocument.defaultView; if (view) view.requestAnimationFrame(reveal); else reveal();
  }
  private destroyFrame(frame: Frame, preserve: boolean): void {
    frame.body.querySelectorAll<HTMLInputElement>("input").forEach(input => { input.value = ""; input.oninput = input.onchange = null; });
    frame.body.querySelectorAll<HTMLElement>("*").forEach(element => { element.onclick = element.onkeydown = null; if (element.tagName === "FORM") (element as HTMLFormElement).onsubmit = null; });
    disposeOriginControls(frame.page); frame.page.remove(); frame.closed(preserve); frame.handle.afterClose?.();
  }
  private clearFrames(): void { for (const frame of this.frames.splice(0).reverse()) this.destroyFrame(frame, false); if (this.detail) this.detail.hidden = true; if (this.overview) this.overview.hidden = false; }
  private clearCode(): void { this.root?.querySelectorAll<HTMLInputElement>(".desktop-account-redemption input").forEach(input => { input.value = ""; }); }
}
