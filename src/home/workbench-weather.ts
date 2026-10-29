import { ownedSvg } from "../ui/owned-dom";
import { animate, type AnimationPlaybackControlsWithThen } from "framer-motion";
import type CodexForObsidianPlugin from "../main";
import { MembershipApiError } from "../membership/account-service";
import { createOriginButton, disposeOriginControls } from "../settings/origin-controls";
import { WORKBENCH_ART, inlineWorkbenchArt } from "./workbench-artwork";
import { WORKBENCH_CHECKIN_ENABLED, workbenchCheckin, type WorkbenchCheckinService } from "./workbench-checkin";

export type WorkbenchWeather = "drizzle" | "overcast" | "breeze" | "fair" | "still";
const names: Record<WorkbenchWeather, [string, string]> = { drizzle: ["小雨", "Drizzle"], overcast: ["阴天", "Overcast"], breeze: ["起风了", "Breeze"], fair: ["晴", "Fair"], still: ["无风", "Still"] };

/** One scoped SVG owns its motion and pointer lifecycle; refreshes retain the stage. */
export class WorkbenchWeatherStage {
  readonly element: HTMLElement;
  private readonly text: HTMLButtonElement;
  private readonly stage: HTMLButtonElement | HTMLDivElement;
  private readonly svg: SVGSVGElement;
  private readonly feedback: HTMLElement;
  private readonly feedbackText: HTMLElement;
  private readonly login: HTMLButtonElement;
  private readonly checkins: WorkbenchCheckinService;
  private readonly controls = new Set<AnimationPlaybackControlsWithThen>();
  private readonly cleanups: (() => void)[] = [];
  private blinkTimer?: number;
  private feedbackTimer?: number;
  private weather: WorkbenchWeather | null = null;
  private active = true;
  private reduced = false;
  private dragging: { pointer: number; y: number; dy: number } | null = null;
  private signing = false;
  private submitGeneration = 0;
  private checkinContext = -1;
  private errorVersion = -1;
  private disposed = false;
  private popover?: HTMLElement;
  private readonly media: MediaQueryList | undefined;
  private readonly win: Window;
  constructor(parent: HTMLElement, private readonly plugin: CodexForObsidianPlugin, private readonly jump: (weather: WorkbenchWeather) => void, private readonly layoutChanged: () => void = () => {}) {
    this.win = parent.ownerDocument.defaultView!;
    this.checkins = workbenchCheckin(plugin);
    this.element = parent.createDiv({ cls: "wb-sky" });
    parent.classList.remove("has-weather-feedback");
    this.cleanups.push(() => parent.classList.remove("has-weather-feedback"));
    this.element.classList.toggle("is-checkin-disabled", !WORKBENCH_CHECKIN_ENABLED);
    const details = this.element.createDiv({ cls: "wb-weather-details" });
    this.text = details.createEl("button", { cls: "wb-weather-copy", attr: { type: "button" } });
    this.stage = WORKBENCH_CHECKIN_ENABLED
      ? this.element.createEl("button", { cls: "wb-weather-stage", attr: { type: "button", "aria-label": this.t("向下拉晴天娃娃签到，或按向下键", "Pull down to check in, or press Arrow Down") } })
      : this.element.createDiv({ cls: "wb-weather-stage", attr: { role: "img", "aria-label": this.t("工作天气晴天娃娃", "Work weather doll") } });
    this.svg = inlineWorkbenchArt(parent.ownerDocument, WORKBENCH_ART.weather); this.stage.append(this.svg);
    // Trim the unused tag area without changing the doll's scale or its pivots.
    if (!WORKBENCH_CHECKIN_ENABLED) this.svg.setAttribute("viewBox", "0 0 180 104");
    this.feedback = details.createDiv({ cls: "wb-sky-feedback", attr: { role: "status", "aria-live": "polite" } });
    this.feedbackText = this.feedback.createSpan({ cls: "wb-checkin-message" });
    this.login = createOriginButton(this.feedback, { cls: "wb-button is-tertiary wb-checkin-login", text: this.t("去登录", "Sign in") }); this.login.hidden = true;
    this.listen(this.login, "click", () => { void this.plugin.openEchoInkAccountSettings("login").catch(() => this.say(this.t("账号设置未打开，请重试", "Account settings did not open. Try again"))); });
    this.media = this.win.matchMedia?.("(prefers-reduced-motion: reduce)"); this.reduced = this.media?.matches ?? false;
    const reduce = () => { this.reduced = this.media?.matches ?? false; this.restart(); };
    this.media?.addEventListener("change", reduce); this.cleanups.push(() => this.media?.removeEventListener("change", reduce));
    this.listen(this.text, "click", () => { if (this.weather) this.jump(this.weather); });
    if (WORKBENCH_CHECKIN_ENABLED) this.bindCheckin();
    this.update(null, "");
    this.cleanups.push(this.checkins.subscribe(() => this.checkinChanged()));
    this.checkinChanged();
    this.refreshCheckin(true);
  }
  private bindCheckin(): void {
    this.listen(this.stage, "pointerdown", (e: PointerEvent) => {
      if (e.button !== 0 || this.signing) return;
      this.dragging = { pointer: e.pointerId, y: e.clientY, dy: 0 }; this.stop(); this.stage.setPointerCapture?.(e.pointerId);
    });
    this.listen(this.stage, "pointermove", (e: PointerEvent) => {
      if (!this.dragging || e.pointerId !== this.dragging.pointer) return;
      this.dragging.dy = Math.max(0, e.clientY - this.dragging.y);
      if (!this.reduced) this.pull(Math.min(24, this.dragging.dy * 104 / this.stage.getBoundingClientRect().height));
    });
    this.listen(this.stage, "pointerup", (e: PointerEvent) => {
      const drag = this.dragging; if (!drag || drag.pointer !== e.pointerId) return;
      drag.dy = Math.max(0, e.clientY - drag.y);
      this.dragging = null;
      if (drag.dy >= 10) { if (!this.signed()) void this.checkIn(); else this.restart(); }
      else if (this.signed() && drag.dy < 10) { this.restart(); this.togglePopover(); }
      else this.hint();
    });
    const cancel = () => { this.dragging = null; this.restart(); };
    this.listen(this.stage, "pointercancel", cancel); this.listen(this.stage, "lostpointercapture", () => { if (this.dragging) cancel(); });
    this.listen(this.stage, "keydown", (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") { e.preventDefault(); if (!this.signed()) void this.checkIn(); }
      else if (e.key === "Escape") this.closePopover();
    });
    this.listen(this.stage, "click", (e: MouseEvent) => { if (e.detail === 0) this.signed() ? this.togglePopover() : this.hint(); });
    this.listen(this.element.ownerDocument, "pointerdown", (e: PointerEvent) => { if (!this.element.contains(e.target as Node)) this.closePopover(); });
  }
  private t(zh: string, en: string): string { return this.plugin.settings.settingsLanguage === "en" ? en : zh; }
  private layer(name: string): SVGElement { return this.svg.querySelector<SVGElement>(`[data-layer="${name}"]`)!; }
  private listen(target: EventTarget, name: string, listener: EventListener): void {
    target.addEventListener(name, listener); this.cleanups.push(() => target.removeEventListener(name, listener));
  }
  private signed(): boolean { return this.checkins.snapshot().checkedIn; }
  private refreshCheckin(force = false): void {
    if (WORKBENCH_CHECKIN_ENABLED && this.active && this.win.navigator.onLine !== false) void this.checkins.refresh(force).catch(() => undefined);
  }
  private checkinChanged(): void {
    if (this.disposed) return;
    const state = this.checkins.snapshot();
    if (state.context !== this.checkinContext) {
      this.checkinContext = state.context; this.submitGeneration++; this.signing = false; this.dragging = null;
      this.stage.removeAttribute("disabled"); this.clearFeedback(); this.closePopover(); this.restart(); this.refreshCheckin();
      this.stage.removeAttribute("aria-busy");
    }
    if (!this.signing) this.paintTag(); this.renderPopover();
    if (state.errorVersion !== this.errorVersion) { this.errorVersion = state.errorVersion; if (state.error) this.failure(state.error); }
  }
  update(weather: WorkbenchWeather | null, line: string): void {
    this.text.hidden = weather === null; this.text.disabled = !weather || weather === "still";
    this.text.replaceChildren();
    if (weather) {
      const name = this.text.createSpan({ cls: "wb-weather-name" }); name.setText(names[weather][this.plugin.settings.settingsLanguage === "en" ? 1 : 0]);
      this.text.createSpan({ cls: "wb-weather-count", text: line });
      this.text.setAttribute("aria-label", `${names[weather][this.plugin.settings.settingsLanguage === "en" ? 1 : 0]} · ${line}`);
    }
    if (!this.signing) this.paintTag();
    this.renderPopover();
    if (weather !== this.weather) { this.weather = weather; this.restart(); }
    this.refreshCheckin();
  }
  setActive(active: boolean): void { if (active !== this.active) { this.active = active; this.closePopover(); this.restart(); if (active) this.refreshCheckin(true); } }
  private paintTag(): void {
    this.layer("tag").setAttribute("display", WORKBENCH_CHECKIN_ENABLED ? "inline" : "none");
    if (!WORKBENCH_CHECKIN_ENABLED) return;
    const days = this.checkins.snapshot().total ?? 0;
    this.layer("tag-text").textContent = this.signed() ? this.t(`${days} 天`, `${days} d`) : this.t("签到", "Check in");
    this.stage.setAttribute("aria-label", this.signed() ? this.t(`已签到，累计 ${days} 天，查看统计`, `Checked in, ${days} days. View totals`) : this.t("向下拉晴天娃娃签到，或按向下键", "Pull down to check in, or press Arrow Down"));
  }
  private motion(from: number, to: number | number[], update: (value: number) => void, options: Record<string, unknown> = {}): AnimationPlaybackControlsWithThen {
    let control: AnimationPlaybackControlsWithThen;
    control = animate(from, to, { duration: 1, ...options, onUpdate: update, onComplete: () => this.controls.delete(control) });
    this.controls.add(control); return control;
  }
  private stop(): void {
    for (const control of this.controls) control.stop(); this.controls.clear();
    if (this.blinkTimer !== undefined) this.win.clearTimeout(this.blinkTimer); this.blinkTimer = undefined;
  }
  private pull(y: number): void { this.layer("body").setAttribute("transform", `translate(0 ${y})`); this.layer("string-line").setAttribute("d", `M118 8Q117.7 17 118 ${25.4 + y}`); }
  private restart(): void {
    this.stop(); this.pull(0); if (!this.signing) this.paintTag();
    for (const name of ["doll-swing", "skirt", "tag", "tag-card", "eyes-happy", "eyes-sad", "rays"]) this.layer(name).removeAttribute("transform");
    for (const name of ["weather-overcast", "wind-1", "wind-2", "wind-3", "drop-1", "drop-2", "drop-3", "drop-4", "drop-5", "drop-6"]) { const node = this.layer(name); node.removeAttribute("transform"); node.removeAttribute("opacity"); node.removeAttribute("stroke-dasharray"); node.removeAttribute("stroke-dashoffset"); }
    for (const name of ["breeze", "overcast", "drizzle", "fair"]) this.layer(`weather-${name}`).setAttribute("display", this.weather === name ? "inline" : "none");
    const sad = this.weather === "drizzle" || this.weather === "overcast";
    this.layer("face-happy").setAttribute("display", sad ? "none" : "inline"); this.layer("face-sad").setAttribute("display", sad ? "inline" : "none");
    this.layer("head").setAttribute("transform", this.weather === "overcast" ? "rotate(7 118 51)" : "rotate(0 118 51)");
    if (this.weather === "overcast") this.layer("string-line").setAttribute("d", "M118 8Q118 17 121.1 25.6");
    if (this.disposed || !this.active || this.reduced || !this.weather || this.signing) return;
    const rotate = (name: string, x: number, y: number) => (v: number) => this.layer(name).setAttribute("transform", `rotate(${v} ${x} ${y})`);
    const loop = { repeat: Infinity, repeatType: "reverse", ease: "easeInOut" };
    const amp = this.weather === "breeze" ? 9 : this.weather === "drizzle" ? 2 : 1.4;
    if (this.weather !== "still") {
      this.motion(-amp, amp, rotate("doll-swing", 118, 8), { ...loop, duration: this.weather === "breeze" ? 1.5 : 3 });
      this.motion(amp / 2, -amp / 2, rotate("skirt", 118, 51), { ...loop, duration: 2.7, delay: .25 });
      if (WORKBENCH_CHECKIN_ENABLED) this.motion(amp * .6, -amp * .6, rotate("tag", 181, 8), { ...loop, duration: 3.1, delay: .4 });
    }
    if (this.weather === "fair") {
      this.motion(0, 360, rotate("rays", 44, 59), { repeat: Infinity, ease: "linear", duration: 30 });
      this.motion(0, -2, y => this.pull(y), { ...loop, duration: 1.8 });
    }
    if (this.weather === "still") this.motion(0, 1.2, y => this.layer("body").setAttribute("transform", `translate(0 ${y})`), { ...loop, duration: 3 });
    if (this.weather === "overcast") this.motion(-3, 6, x => this.layer("weather-overcast").setAttribute("transform", `translate(${x} 0)`), { ...loop, duration: 6 });
    if (this.weather === "breeze") for (let i = 1; i <= 3; i++) {
      const wind = this.layer(`wind-${i}`); wind.setAttribute("stroke-dasharray", "14 6");
      this.motion(0, -40, v => wind.setAttribute("stroke-dashoffset", String(v)), { repeat: Infinity, ease: "linear", duration: 1 + i * .2 });
    }
    if (this.weather === "drizzle") for (let i = 1; i <= 6; i++) this.motion(-8, 12, v => {
      const drop = this.layer(`drop-${i}`); drop.setAttribute("transform", `translate(0 ${v})`); drop.setAttribute("opacity", String(Math.max(0, 1 - Math.abs(v - 2) / 10)));
    }, { repeat: Infinity, duration: .9 + i * .08, delay: i * .17 });
    const blink = () => { this.blinkTimer = this.win.setTimeout(() => {
      this.motion(1, [1, .12, 1], v => this.layer(sad ? "eyes-sad" : "eyes-happy").setAttribute("transform", `translate(118 ${sad ? 39 : 37}) scale(1 ${v}) translate(-118 ${sad ? -39 : -37})`), { duration: .2 }); blink();
    }, 2500 + Math.random() * 3000); };
    if (this.weather !== "still") blink();
  }
  private say(text: string, login = false): void {
    if (!WORKBENCH_CHECKIN_ENABLED) return;
    this.feedbackText.textContent = text; this.login.hidden = !login; this.element.classList.add("is-feedback"); this.element.parentElement?.classList.add("has-weather-feedback");
    if (this.feedbackTimer !== undefined) this.win.clearTimeout(this.feedbackTimer);
    this.feedbackTimer = this.win.setTimeout(() => { this.clearFeedback(); }, 4500);
    this.layoutChanged();
  }
  private clearFeedback(): void {
    this.feedbackText.textContent = ""; this.login.hidden = true; this.element.classList.remove("is-feedback"); this.element.parentElement?.classList.remove("has-weather-feedback");
    this.layoutChanged();
  }
  private hint(): void {
    if (!WORKBENCH_CHECKIN_ENABLED) return;
    this.say(this.t("向下拉一下，或按 ↓ 签到", "Pull down, or press ↓ to check in"));
    if (!this.reduced && this.active) { this.stop(); void this.motion(7, 0, y => this.pull(y), { type: "spring", stiffness: 160, damping: 9 }).then(() => this.restart()); this.motion(0, [0, 8, -6, 0], v => this.layer("tag").setAttribute("transform", `rotate(${v} 181 8)`), { duration: .7 }); }
    else this.restart();
  }
  private async checkIn(): Promise<void> {
    if (!WORKBENCH_CHECKIN_ENABLED || this.signing || this.signed()) return; this.signing = true; this.stage.setAttribute("disabled", "");
    this.stage.setAttribute("aria-busy", "true"); this.layer("tag-text").textContent = this.t("签到中", "…");
    const generation = ++this.submitGeneration;
    let celebrate = false;
    try {
      if (this.win.navigator.onLine === false) this.failure(new Error("offline"));
      else celebrate = !(await this.checkins.record()).alreadyCheckedIn;
    } catch { /* The shared service publishes only errors for the current account. */ }
    finally {
      if (!this.disposed && generation === this.submitGeneration) { this.signing = false; this.stage.removeAttribute("disabled"); this.stage.removeAttribute("aria-busy"); this.paintTag(); this.restart(); }
    }
    if (celebrate && !this.disposed && generation === this.submitGeneration) void this.celebrate(generation).then(() => { if (!this.disposed && generation === this.submitGeneration) this.restart(); });
  }
  private failure(error: unknown): void {
    const code = error instanceof MembershipApiError ? error.code : "NETWORK";
    if (code === "OPERATION_CANCELLED") return;
    const copy = code === "AUTH_REQUIRED" ? ["登录后才能签到", "Sign in to check in"]
      : code === "RATE_LIMITED" ? ["签得太快了，稍后再试", "Too many check-ins. Try again later"]
      : code === "CHECKIN_DATE_OUT_OF_RANGE" ? ["设备时间不对，签不了", "Device date or timezone is incorrect"]
      : code === "ACCOUNT_DISABLED" ? ["账号已停用，暂时无法签到", "This account is disabled. Check-in is unavailable"]
      : ["INVALID_INPUT", "BODY_TOO_LARGE", "ORIGIN_DENIED", "ORIGIN_REQUIRED", "CHECKIN_RESPONSE_INVALID"].includes(code) ? ["签到请求异常，请稍后再试", "Check-in request failed. Try again later"]
      : ["没联网，签不了", "No connection. Cannot check in"];
    this.say(this.t(copy[0], copy[1]), code === "AUTH_REQUIRED");
  }
  private async celebrate(generation: number): Promise<void> {
    if (!WORKBENCH_CHECKIN_ENABLED) return;
    this.stop();
    const days = this.checkins.snapshot().total ?? 0;
    this.say(this.t(`签到成功 · 第 ${days} 天`, `Checked in · Day ${days}`));
    if (!this.reduced && this.active) {
      this.layer("tag-text").textContent = this.t("签到", "Check in");
      const rebound = this.motion(16, 0, y => this.pull(y), { type: "spring", stiffness: 150, damping: 8 });
      await this.motion(1, 0, v => this.layer("tag-card").setAttribute("transform", `translate(181 45) scale(${v} 1) translate(-181 -45)`), { duration: .16 });
      if (this.disposed || generation !== this.submitGeneration) return; this.paintTag();
      const flip = this.motion(0, 1, v => this.layer("tag-card").setAttribute("transform", `translate(181 45) scale(${v} 1) translate(-181 -45)`), { type: "spring", stiffness: 230, damping: 14 });
      this.sparkle();
      await Promise.all([rebound, flip]);
    } else { this.pull(0); this.paintTag(); }
  }
  private sparkle(): void {
    const group = ownedSvg(this.svg.ownerDocument, "g"); group.setAttribute("aria-hidden", "true"); this.svg.append(group);
    for (let i = 0; i < 10; i++) {
      const star = ownedSvg(this.svg.ownerDocument, "path"); star.setAttribute("d", "M-2 0H2M0-2V2"); group.append(star);
      const a = i * Math.PI / 5;
      this.motion(0, 1, v => { star.setAttribute("transform", `translate(${181 + Math.cos(a) * v * 30} ${45 + Math.sin(a) * v * 26})`); star.setAttribute("opacity", String(1 - v)); }, { duration: .75 });
    }
    this.win.setTimeout(() => group.remove(), 800);
  }
  private togglePopover(): void {
    if (!WORKBENCH_CHECKIN_ENABLED) return;
    if (this.popover) { this.closePopover(); return; }
    this.clearFeedback();
    this.popover = this.element.createDiv({ cls: "wb-checkin-popover", attr: { role: "status" } });
    this.renderPopover();
    this.stage.setAttribute("aria-expanded", "true");
  }
  private renderPopover(): void {
    if (!this.popover) return;
    const total = this.checkins.snapshot().total;
    if (total === null) { this.closePopover(); return; }
    this.popover.replaceChildren();
    this.popover.createDiv({ text: this.t(`累计签到 ${total} 天`, `${total} check-in days`) });
  }
  private closePopover(): void { this.popover?.remove(); this.popover = undefined; if (WORKBENCH_CHECKIN_ENABLED) this.stage.setAttribute("aria-expanded", "false"); }
  dispose(): void { this.disposed = true; this.submitGeneration++; this.stop(); if (this.feedbackTimer !== undefined) this.win.clearTimeout(this.feedbackTimer); for (const cleanup of this.cleanups) cleanup(); disposeOriginControls(this.element); this.element.remove(); }
}
