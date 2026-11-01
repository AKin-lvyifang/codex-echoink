import { ownedSvg } from "../ui/owned-dom";
import { attachNativeTooltip, type NativeTooltipHandle } from "../ui/native-tooltip";
import { animate, type AnimationPlaybackControlsWithThen } from "framer-motion";
import type CodexForObsidianPlugin from "../main";
import { MembershipApiError } from "../membership/account-service";
import { createOriginButton, disposeOriginControls } from "../settings/origin-controls";
import { WORKBENCH_ART, inlineWorkbenchArt } from "./workbench-artwork";
import { WORKBENCH_CHECKIN_ENABLED, workbenchCheckin, type WorkbenchCheckinService } from "./workbench-checkin";

import { dollPose, dollStringEndpoint, type DollPose, type WorkbenchAgentState } from "./workbench-doll-motion";
import { workbenchWeather, WEATHER_REFRESH_MS, type WorkbenchWeatherService } from "./weather-service";
import { normalizeWeatherCity, weatherLayer, type CurrentWeather, type WeatherLayer } from "./weather-types";
const weatherLayers = ["fair", "cloudy", "overcast", "drizzle", "thunder", "snow", "fog", "breeze", "unknown"] as const;

/** One scoped SVG owns its motion and pointer lifecycle; refreshes retain the stage. */
export class WorkbenchWeatherStage {
  readonly element: HTMLElement;
  private readonly text: HTMLButtonElement;
  private readonly count: HTMLButtonElement;
  private weatherTooltip?: NativeTooltipHandle;
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
  private weather: WeatherLayer = "still";
  private agent: WorkbenchAgentState | null = null;
  private line = "";
  private weatherCityId: string | null = null;
  private currentWeather: CurrentWeather | null = null;
  private weatherStatus: "none" | "loading" | "ready" | "unavailable" | "missing" = "none";
  private weatherTimer?: number;
  private weatherGeneration = 0;
  private weatherFlight?: Promise<void>;
  private weatherAttemptAt = 0;
  private active = false;
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
  constructor(parent: HTMLElement, private readonly plugin: CodexForObsidianPlugin, private readonly jump: (state: WorkbenchAgentState) => void, private readonly layoutChanged: () => void = () => {}, private readonly weatherService: WorkbenchWeatherService = workbenchWeather(plugin)) {
    this.win = parent.ownerDocument.defaultView!;
    this.checkins = workbenchCheckin(plugin);
    this.element = parent.createDiv({ cls: "wb-sky" });
    parent.classList.remove("has-weather-feedback");
    this.cleanups.push(() => parent.classList.remove("has-weather-feedback"));
    this.element.classList.toggle("is-checkin-disabled", !WORKBENCH_CHECKIN_ENABLED);
    const details = this.element.createDiv({ cls: "wb-weather-details" });
    this.text = details.createEl("button", { cls: "wb-weather-copy", attr: { type: "button" } });
    this.count = details.createEl("button", { cls: "wb-weather-count wb-weather-count-button", attr: { type: "button" } });
    this.cleanups.push(() => this.weatherTooltip?.dispose());
    this.stage = WORKBENCH_CHECKIN_ENABLED
      ? this.element.createEl("button", { cls: "wb-weather-stage", attr: { type: "button", "aria-label": this.t("向下拉晴天娃娃签到，或按向下键", "Pull down to check in, or press Arrow Down") } })
      : this.element.createDiv({ cls: "wb-weather-stage", attr: { role: "img", "aria-label": this.t("晴天娃娃", "Weather doll") } });
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
    this.listen(this.text, "click", () => { void this.plugin.openWorkbenchSetup("weather").catch(() => { this.text.textContent = this.t("设置未打开，请重试", "Settings did not open. Try again"); }); });
    this.listen(this.count, "click", () => { if (this.agent && this.agent !== "idle") this.jump(this.agent); });
    this.listen(this.win, "online", () => { void this.refreshWeather(true); });
    this.listen(this.win, "offline", () => { void this.refreshWeather(true); });
    this.listen(this.element.ownerDocument, "visibilitychange", () => {
      this.restart(); this.scheduleWeather(); if (this.visible()) void this.refreshWeather();
    });
    if (WORKBENCH_CHECKIN_ENABLED) this.bindCheckin();
    this.update(null, "");
    this.cleanups.push(this.checkins.subscribe(() => this.checkinChanged()));
    this.checkinChanged();
    this.refreshCheckin(true); void this.refreshWeather(true);
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
  update(agent: WorkbenchAgentState | null, line: string): void {
    this.line = line; const changed = agent !== this.agent; this.agent = agent;
    this.element.dataset.agentState = agent ?? "unknown";
    this.renderWeatherText(); if (!this.signing) this.paintTag(); this.renderPopover();
    if (changed) this.restart();
    this.refreshCheckin(); void this.refreshWeather();
  }
  private visible(): boolean { return this.active && !this.disposed && this.element.ownerDocument.visibilityState !== "hidden"; }
  private renderWeatherText(): void {
    const weather = this.currentWeather, en = this.plugin.settings.settingsLanguage === "en";
    const descriptions: Record<string, string> = { "晴": "Clear", "晴间多云": "Partly cloudy", "多云": "Cloudy", "阴": "Overcast", "小雨": "Light rain", "中雨": "Rain", "大雨": "Heavy rain", "阵雨": "Showers", "小雪": "Light snow", "中雪": "Snow", "大雪": "Heavy snow", "雾": "Fog", "大风": "Windy" };
    const categories = { clear: "Clear", cloudy: "Cloudy", rain: "Rain", thunder: "Thunderstorms", snow: "Snow", fog: "Fog", wind: "Windy", other: "Weather" };
    const label = this.weatherStatus === "none" ? this.t("选个城市看天气", "Choose a city for weather")
      : this.weatherStatus === "loading" ? this.t("正在取天气…", "Getting weather…")
      : this.weatherStatus === "missing" ? this.t("请重新选择城市", "Choose another city")
      : this.weatherStatus !== "ready" || !weather ? this.t("拿不到天气", "Weather unavailable")
      : `${weather.city.name} · ${weather.stale ? this.t("稍早 · ", "Earlier · ") : ""}${en ? descriptions[weather.description] ?? categories[weather.category] : weather.description} ${Math.round(weather.temperature)}°`;
    this.text.replaceChildren(); this.text.createSpan({ cls: "wb-weather-name", text: label });
    this.weatherTooltip?.dispose();
    this.text.setAttribute("aria-label", label);
    this.weatherTooltip = attachNativeTooltip(this.text, label, { preserveLabel: false });
    this.count.textContent = this.line; this.count.hidden = !this.line || this.agent === null; this.count.disabled = this.agent === "idle" || this.agent === null;
    this.layoutChanged();
  }
  private scheduleWeather(): void {
    if (this.weatherTimer !== undefined) this.win.clearTimeout(this.weatherTimer); this.weatherTimer = undefined;
    if (this.visible() && this.weatherCityId && this.weatherAttemptAt) this.weatherTimer = this.win.setTimeout(() => { this.weatherTimer = undefined; void this.refreshWeather(true); }, Math.max(1000, this.weatherAttemptAt + WEATHER_REFRESH_MS - Date.now()));
  }
  private refreshWeather(force = false): Promise<void> {
    const city = normalizeWeatherCity(this.plugin.settings.weatherCity);
    if ((city?.id ?? null) !== this.weatherCityId) {
      this.weatherGeneration++; this.weatherFlight = undefined; this.weatherCityId = city?.id ?? null;
      this.currentWeather = null; this.weatherStatus = city ? "loading" : "none"; this.weatherAttemptAt = 0;
      this.weather = "still"; this.paintWeather(); this.renderWeatherText(); this.restart();
    }
    if (!city) { const changed = this.weather !== "still"; this.weatherStatus = "none"; this.weather = "still"; this.renderWeatherText(); this.scheduleWeather(); this.paintWeather(); if (changed) this.restart(); return Promise.resolve(); }
    if (!this.visible()) return Promise.resolve();
    if (this.win.navigator.onLine === false) {
      const changed = this.weather !== "unknown" || this.weatherStatus !== "unavailable";
      this.weatherGeneration++; this.weatherFlight = undefined; this.weatherStatus = "unavailable"; this.weatherAttemptAt = Date.now(); this.weather = "unknown";
      this.renderWeatherText(); if (changed) this.restart(); this.scheduleWeather(); return Promise.resolve();
    }
    if (this.weatherFlight) return this.weatherFlight;
    if (!force && this.weatherAttemptAt && Date.now() - this.weatherAttemptAt < WEATHER_REFRESH_MS) { this.scheduleWeather(); return Promise.resolve(); }
    const generation = ++this.weatherGeneration; this.weatherAttemptAt = Date.now();
    if (!this.currentWeather) { this.weatherStatus = "loading"; this.renderWeatherText(); }
    const current = () => !this.disposed && generation === this.weatherGeneration && this.plugin.settings.weatherCity?.id === city.id;
    const flight = this.weatherService.current(city.id, true).then(weather => {
      if (!current()) return; this.currentWeather = weather; this.weatherStatus = "ready"; this.weather = weatherLayer(weather); this.renderWeatherText(); this.restart();
    }).catch(error => {
      if (!current()) return; this.weatherStatus = error instanceof MembershipApiError && error.code === "CITY_NOT_FOUND" ? "missing" : "unavailable";
      this.weather = "unknown"; this.renderWeatherText(); this.restart();
    }).finally(() => { if (current()) { this.weatherFlight = undefined; this.scheduleWeather(); } });
    this.weatherFlight = flight; return flight;
  }
  setActive(active: boolean): void {
    if (active !== this.active) { this.active = active; this.closePopover(); this.restart(); this.scheduleWeather(); if (active) { this.refreshCheckin(true); void this.refreshWeather(); } }
  }
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
  private applyPose(pose: DollPose): void {
    for (const face of ["happy", "sad", "curious", "laugh"]) this.layer(`face-${face}`).setAttribute("display", pose.face === face && pose.scaleX >= 0 ? "inline" : "none");
    this.layer("body").setAttribute("transform", `translate(0 ${pose.y}) rotate(${pose.angle} 118 26) translate(118 26) scale(${pose.scaleX} 1) translate(-118 -26)`);
    this.layer("head").setAttribute("transform", `rotate(${pose.head} 118 51)`);
    this.layer("skirt").setAttribute("transform", `rotate(${pose.skirt} 118 51)`);
    this.layer("bow-ribbon-left").setAttribute("transform", `rotate(${pose.left} 118 54)`);
    this.layer("bow-ribbon-right").setAttribute("transform", `rotate(${pose.right} 120 54)`);
    const end = dollStringEndpoint(pose);
    this.layer("string-line").setAttribute("d", `M118 8Q${(118 + end.x) / 2} ${17 + pose.y / 2} ${end.x} ${end.y}`);
  }
  private pull(y: number): void { this.applyPose({ ...dollPose(this.agent ?? "idle"), y }); }
  private paintWeather(): void {
    for (const name of weatherLayers) this.layer(`weather-${name}`).setAttribute("display", this.weather === name ? "inline" : "none");
    this.svg.dataset.weather = this.weather;
  }
  private restart(): void {
    this.stop(); this.paintWeather(); if (this.dragging) return;
    this.pull(0); if (!this.signing) this.paintTag();
    for (const name of ["doll-swing", "tag", "tag-card", "eyes-happy", "eyes-sad", "eyes-curious", "eyes-laugh", "rays", "cloudy-rays"]) this.layer(name).removeAttribute("transform");
    for (const name of ["weather-overcast", "cloudy-cloud", "thunder-lightning", ...Array.from({ length: 3 }, (_, i) => `wind-${i + 1}`), ...Array.from({ length: 6 }, (_, i) => `drop-${i + 1}`), ...Array.from({ length: 3 }, (_, i) => `thunder-drop-${i + 1}`), ...Array.from({ length: 4 }, (_, i) => `snowflake-${i + 1}`), ...Array.from({ length: 4 }, (_, i) => `fog-band-${i + 1}`)]) {
      const node = this.layer(name); node.removeAttribute("transform"); node.removeAttribute("opacity"); node.removeAttribute("stroke-dasharray"); node.removeAttribute("stroke-dashoffset");
    }
    if (!this.visible() || this.reduced || this.agent === null || this.signing) return;
    const rotate = (name: string, x: number, y: number) => (v: number) => this.layer(name).setAttribute("transform", `rotate(${v} ${x} ${y})`);
    const loop = { repeat: Infinity, repeatType: "reverse", ease: "easeInOut" };
    const agent = this.agent;
    this.motion(0, 24, time => { this.applyPose(dollPose(agent, time)); this.svg.dataset.workAction = agent === "working" ? ["dance", "spin", "twist"][Math.floor(time / 8) % 3] : agent; }, { repeat: Infinity, duration: 24, ease: "linear" });
    if (agent !== "idle" && WORKBENCH_CHECKIN_ENABLED) this.motion(-1, 1, rotate("tag", 181, 8), { ...loop, duration: 3.1 });
    if (this.weather === "fair") this.motion(0, 360, rotate("rays", 44, 59), { repeat: Infinity, ease: "linear", duration: 30 });
    if (this.weather === "cloudy") { this.motion(0, 360, rotate("cloudy-rays", 53, 39), { repeat: Infinity, ease: "linear", duration: 30 }); this.motion(-2, 2, x => this.layer("cloudy-cloud").setAttribute("transform", `translate(${x} 0)`), { ...loop, duration: 6 }); }
    if (this.weather === "overcast") this.motion(-3, 3, x => this.layer("weather-overcast").setAttribute("transform", `translate(${x} 0)`), { ...loop, duration: 6 });
    if (this.weather === "breeze") for (let i = 1; i <= 3; i++) {
      const wind = this.layer(`wind-${i}`); wind.setAttribute("stroke-dasharray", "14 6");
      this.motion(0, -40, v => wind.setAttribute("stroke-dashoffset", String(v)), { repeat: Infinity, ease: "linear", duration: 1 + i * .2 });
    }
    if (this.weather === "drizzle" || this.weather === "thunder") for (let i = 1; i <= (this.weather === "drizzle" ? 6 : 3); i++) {
      const drop = this.layer(`${this.weather === "thunder" ? "thunder-" : ""}drop-${i}`);
      this.motion(-8, 12, v => { drop.setAttribute("transform", `translate(0 ${v})`); drop.setAttribute("opacity", String(Math.max(0, 1 - Math.abs(v - 2) / 10))); }, { repeat: Infinity, duration: .9 + i * .08, delay: i * .17 });
    }
    if (this.weather === "thunder") this.motion(.3, .8, v => this.layer("thunder-lightning").setAttribute("opacity", String(v)), { ...loop, duration: 4 });
    if (this.weather === "snow") for (let i = 1; i <= 4; i++) this.motion(-3, 4, y => this.layer(`snowflake-${i}`).setAttribute("transform", `translate(0 ${y})`), { ...loop, duration: 2.5 + i * .3 });
    if (this.weather === "fog") for (let i = 1; i <= 4; i++) this.motion(-3, 3, x => this.layer(`fog-band-${i}`).setAttribute("transform", `translate(${x} 0)`), { ...loop, duration: 4 + i * .5 });
    const face = dollPose(agent).face, eyeY = { happy: 37, sad: 39, curious: 38, laugh: 36 }[face];
    const blink = () => { this.blinkTimer = this.win.setTimeout(() => {
      this.motion(1, [1, .12, 1], v => this.layer(`eyes-${face}`).setAttribute("transform", `translate(118 ${eyeY}) scale(1 ${v}) translate(-118 ${-eyeY})`), { duration: .2 }); blink();
    }, 2500 + Math.random() * 3000); };
    blink();
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
  dispose(): void { this.weatherGeneration++; if (this.weatherTimer !== undefined) this.win.clearTimeout(this.weatherTimer); this.disposed = true; this.submitGeneration++; this.stop(); if (this.feedbackTimer !== undefined) this.win.clearTimeout(this.feedbackTimer); for (const cleanup of this.cleanups) cleanup(); disposeOriginControls(this.element); this.element.remove(); }
}
