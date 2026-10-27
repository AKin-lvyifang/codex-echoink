import { animate, type AnimationPlaybackControlsWithThen } from "framer-motion";
import { Notice } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { WORKBENCH_ART, inlineWorkbenchArt } from "./workbench-artwork";
import { WORKBENCH_CHECKIN_ENABLED, workbenchCheckin, workbenchDate } from "./workbench-checkin";

export type WorkbenchWeather = "drizzle" | "overcast" | "breeze" | "fair" | "still";
const names: Record<WorkbenchWeather, [string, string]> = { drizzle: ["小雨", "Drizzle"], overcast: ["阴天", "Overcast"], breeze: ["起风了", "Breeze"], fair: ["晴", "Fair"], still: ["无风", "Still"] };

/** One scoped SVG owns its motion and pointer lifecycle; refreshes retain the stage. */
export class WorkbenchWeatherStage {
  readonly element: HTMLElement;
  private readonly text: HTMLButtonElement;
  private readonly stage: HTMLButtonElement | HTMLDivElement;
  private readonly svg: SVGSVGElement;
  private readonly feedback: HTMLElement;
  private readonly controls = new Set<AnimationPlaybackControlsWithThen>();
  private readonly cleanups: (() => void)[] = [];
  private blinkTimer?: number;
  private feedbackTimer?: number;
  private weather: WorkbenchWeather | null = null;
  private countLine = "";
  private active = true;
  private reduced = false;
  private dragging: { pointer: number; y: number; dy: number } | null = null;
  private signing = false;
  private disposed = false;
  private popover?: HTMLElement;
  private readonly media: MediaQueryList | undefined;
  private readonly win: Window;
  constructor(parent: HTMLElement, private readonly plugin: CodexForObsidianPlugin, private readonly jump: (weather: WorkbenchWeather) => void, private readonly layoutChanged: () => void = () => {}) {
    this.win = parent.ownerDocument.defaultView!;
    this.element = parent.createDiv({ cls: "wb-sky" });
    this.element.classList.toggle("is-checkin-disabled", !WORKBENCH_CHECKIN_ENABLED);
    this.text = this.element.createEl("button", { cls: "wb-weather-copy", attr: { type: "button", "aria-live": "polite" } });
    this.stage = WORKBENCH_CHECKIN_ENABLED
      ? this.element.createEl("button", { cls: "wb-weather-stage", attr: { type: "button", "aria-label": this.t("向下拉晴天娃娃签到，或按向下键", "Pull down to check in, or press Arrow Down") } })
      : this.element.createDiv({ cls: "wb-weather-stage", attr: { role: "img", "aria-label": this.t("工作天气晴天娃娃", "Work weather doll") } });
    this.svg = inlineWorkbenchArt(parent.ownerDocument, WORKBENCH_ART.weather); this.stage.append(this.svg);
    // Trim the unused tag area without changing the doll's scale or its pivots.
    if (!WORKBENCH_CHECKIN_ENABLED) this.svg.setAttribute("viewBox", "0 0 180 104");
    this.feedback = this.element.createDiv({ cls: "wb-sky-feedback", attr: { role: "status", "aria-live": "polite" } });
    this.media = this.win.matchMedia?.("(prefers-reduced-motion: reduce)"); this.reduced = this.media?.matches ?? false;
    const reduce = () => { this.reduced = this.media?.matches ?? false; this.restart(); };
    this.media?.addEventListener("change", reduce); this.cleanups.push(() => this.media?.removeEventListener("change", reduce));
    this.listen(this.text, "click", () => { if (this.weather) this.jump(this.weather); });
    if (WORKBENCH_CHECKIN_ENABLED) this.bindCheckin();
    this.update(null, "");
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
      this.dragging = null;
      if (drag.dy >= 10 && !this.signed()) void this.checkIn();
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
  private listen(target: EventTarget, name: string, listener: (event: any) => void): void {
    target.addEventListener(name, listener); this.cleanups.push(() => target.removeEventListener(name, listener));
  }
  private signed(): boolean { return workbenchCheckin(this.plugin).snapshot().signedDates.includes(workbenchDate()); }
  update(weather: WorkbenchWeather | null, line: string): void {
    this.countLine = line;
    this.text.hidden = weather === null; this.text.disabled = !weather || weather === "still";
    this.text.replaceChildren();
    if (weather) {
      const name = this.text.createSpan({ cls: "wb-weather-name" }); name.createSpan({ text: names[weather][0] }); name.createEl("em", { text: names[weather][1] });
      this.text.createSpan({ cls: "wb-weather-count", text: this.feedback.textContent || line });
      this.text.setAttribute("aria-label", `${names[weather][this.plugin.settings.settingsLanguage === "en" ? 1 : 0]} · ${line}`);
    }
    if (!this.signing) this.paintTag();
    this.renderPopover();
    if (weather !== this.weather) { this.weather = weather; this.restart(); }
    if (WORKBENCH_CHECKIN_ENABLED && this.active && weather !== null && workbenchCheckin(this.plugin).consumeAutoPresentation()) void this.celebrate(true);
  }
  setActive(active: boolean): void { if (active !== this.active) { this.active = active; this.closePopover(); this.restart(); } }
  private paintTag(): void {
    this.layer("tag").setAttribute("display", WORKBENCH_CHECKIN_ENABLED ? "inline" : "none");
    if (!WORKBENCH_CHECKIN_ENABLED) return;
    const days = workbenchCheckin(this.plugin).snapshot().signedDates.length;
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
  private say(text: string): void {
    if (!WORKBENCH_CHECKIN_ENABLED) return;
    this.feedback.textContent = text; this.element.classList.add("is-feedback");
    const line = this.text.querySelector(".wb-weather-count"); if (line) line.textContent = text;
    if (this.feedbackTimer !== undefined) this.win.clearTimeout(this.feedbackTimer);
    this.feedbackTimer = this.win.setTimeout(() => { this.clearFeedback(); }, 2600);
    this.layoutChanged();
  }
  private clearFeedback(): void {
    this.feedback.textContent = ""; this.element.classList.remove("is-feedback");
    const line = this.text.querySelector(".wb-weather-count"); if (line) line.textContent = this.countLine;
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
    let saved = false;
    try { await workbenchCheckin(this.plugin).record(); saved = true; }
    catch { if (!this.disposed) { this.say(this.t("签到未保存，请再试一次", "Check-in was not saved. Try again")); new Notice(this.feedback.textContent ?? ""); } }
    finally {
      this.signing = false;
      if (!this.disposed) { this.stage.removeAttribute("disabled"); this.paintTag(); this.restart(); }
    }
    // Animation cancellation (background/reduced motion) cannot retain a submitting state.
    if (saved && !this.disposed) void this.celebrate(false).then(() => { if (!this.disposed) this.restart(); });
  }
  private async celebrate(auto: boolean): Promise<void> {
    if (!WORKBENCH_CHECKIN_ENABLED) return;
    this.stop();
    const days = workbenchCheckin(this.plugin).snapshot().signedDates.length;
    this.say(auto ? this.t("今天聊过，已自动签到", "You chatted today. Checked in automatically") : this.t(`签到成功 · 第 ${days} 天`, `Checked in · Day ${days}`));
    if (!this.reduced && this.active) {
      this.layer("tag-text").textContent = this.t("签到", "Check in");
      const rebound = this.motion(16, 0, y => this.pull(y), { type: "spring", stiffness: 150, damping: 8 });
      await this.motion(1, 0, v => this.layer("tag-card").setAttribute("transform", `translate(181 45) scale(${v} 1) translate(-181 -45)`), { duration: .16 });
      if (this.disposed) return; this.paintTag();
      const flip = this.motion(0, 1, v => this.layer("tag-card").setAttribute("transform", `translate(181 45) scale(${v} 1) translate(-181 -45)`), { type: "spring", stiffness: 230, damping: 14 });
      this.sparkle();
      await Promise.all([rebound, flip]);
      if (auto && !this.disposed) this.restart();
    } else { this.pull(0); this.paintTag(); }
  }
  private sparkle(): void {
    const group = this.svg.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "g"); group.setAttribute("aria-hidden", "true"); this.svg.append(group);
    for (let i = 0; i < 10; i++) {
      const star = this.svg.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "path"); star.setAttribute("d", "M-2 0H2M0-2V2"); group.append(star);
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
    const data = workbenchCheckin(this.plugin).snapshot();
    this.popover.replaceChildren();
    this.popover.createDiv({ text: this.t(`累计签到 ${data.signedDates.length} 天`, `${data.signedDates.length} check-in days`) });
    this.popover.createDiv({ text: this.t(`用 Agent ${data.agentDates.length} 天`, `${data.agentDates.length} days with Agent`) });
  }
  private closePopover(): void { this.popover?.remove(); this.popover = undefined; if (WORKBENCH_CHECKIN_ENABLED) this.stage.setAttribute("aria-expanded", "false"); }
  dispose(): void { this.disposed = true; this.stop(); if (this.feedbackTimer !== undefined) this.win.clearTimeout(this.feedbackTimer); for (const cleanup of this.cleanups) cleanup(); this.element.remove(); }
}
