import { Modal, Notice, TFile, normalizePath, setIcon, type App } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { createDecisionFetch, membershipApiUrl } from "../membership/transport";
import { confirmModal } from "../ui/modals";
import { prefillWorkbenchModule } from "./module-navigation";
import {
  PERSONA_MIN_ENTRIES, PERSONA_PAIRS, acceptPersonaResult, eligibleEntries, isMonthOpen, monthKey, monthNumber, pairName, personaDelta, personaErrorCode,
  personaErrorText, personaMarkdown, personaRequestBody, previousMonthKey, type PersonaEntry, type PersonaErrorCode, type PersonaResult
} from "./diary-persona-core";

type ButtonFactory = (parent: HTMLElement, text: string, action: () => void | Promise<unknown>, cls?: string) => HTMLButtonElement;
export interface PersonaPageHost {
  plugin: CodexForObsidianPlugin;
  zh(): boolean;
  button: ButtonFactory;
  iconButton(parent: HTMLElement, icon: string, label: string, action: () => void | Promise<unknown>): HTMLButtonElement;
  openPath(path: string): Promise<void>;
  /** 该月日记（含正文），由日记页缓存。 */
  monthEntries(month: string): Promise<PersonaEntry[]>;
  /** 该月被识别为日记的文件数，先用它粗筛，避免为不可能够数的月份读文件。 */
  monthFileCount(month: string): number;
  /** 隐藏日记页主体，显示本二级页。 */
  show(): void;
  /** 回到日记页，并把日历切到指定月份。 */
  close(month?: string): void;
}
interface Quota { month: { remaining: number } | null; period: { remaining: number; resetAt: string }; daily: { open: boolean; resetAt: string } }
interface PersonaError { code: PersonaErrorCode; resetAt?: string | null }

const LAND_MS = 420;

/** 日记页里的「N 月人格」二级页：揭晓与结果。只有用户点击才请求云端。 */
export class DiaryPersonaPanel {
  private month = "";
  private phase: "reveal" | "result" = "result";
  private landed = 0;
  private fresh = false;
  private busy = false;
  private error: PersonaError | null = null;
  private entries: PersonaEntry[] = [];
  private quota: Quota | null = null;
  private fly: string[] = [];
  private flyIndex = 0;
  private timers: number[] = [];
  private generation = 0;
  private readonly yearEligible = new Map<string, boolean>();

  constructor(private readonly host: PersonaPageHost, private readonly root: HTMLElement) { root.hidden = true; }

  private get app(): App { return this.host.plugin.app; }
  private get zh(): boolean { return this.host.zh(); }
  private t(zh: string, en: string): string { return this.zh ? zh : en; }
  /** 设置缺这一项时（旧数据、测试替身）就地补齐。 */
  private get state() { const settings = this.host.plugin.settings; settings.diaryPersona ??= { results: {}, seen: [] }; return settings.diaryPersona; }
  private get results(): Record<string, PersonaResult> { return this.state.results; }
  private title(month: string): string {
    return this.zh ? `${monthNumber(month)} 月人格` : `${new Date(Number(month.slice(0, 4)), monthNumber(month) - 1, 1).toLocaleString("en", { month: "long" })} persona`;
  }
  isOpen(): boolean { return !this.root.hidden; }
  resultFor(month: string): PersonaResult | null { return this.results[month] ?? null; }

  /** 月份标题旁的入口：不够数时什么都不放；第一次出现时弹一下。 */
  renderEgg(slot: HTMLElement, month: string, eligible: boolean): void {
    slot.empty();
    if (!eligible) return;
    const result = this.resultFor(month);
    const button = slot.createEl("button", { cls: `journal-persona-egg${result ? " is-done" : ""}`, attr: { type: "button", "aria-label": this.title(month) } });
    if (result) button.setText(result.type);
    else { setIcon(button.createSpan({ attr: { "aria-hidden": "true" } }), "sparkles"); button.createSpan({ text: this.title(month) }); }
    const state = this.state;
    if (!state.seen.includes(month)) {
      button.addClass("is-arriving");
      state.seen = [...state.seen, month].slice(-120);
      void this.host.plugin.saveSettings();
    }
    button.onclick = () => { void this.open(month, !result); };
  }

  async open(month: string, generate: boolean): Promise<void> {
    this.clearTimers(); this.generation++;
    this.month = month; this.error = null; this.quota = null; this.yearEligible.clear();
    this.root.hidden = false; this.host.show();
    this.entries = await this.host.monthEntries(month);
    this.fly = sentences(eligibleEntries(this.entries));
    if (generate || !this.resultFor(month)) { await this.generate(); return; }
    this.phase = "result"; this.fresh = true; this.render();
    void this.refreshQuota();
  }
  close(): void { this.clearTimers(); this.generation++; this.root.hidden = true; disposeChildren(this.root); }
  dispose(): void { this.close(); }

  private clearTimers(): void { for (const timer of this.timers) window.clearTimeout(timer); this.timers = []; }
  private later(ms: number, run: () => void): void { this.timers.push(window.setTimeout(run, ms)); }
  private token(): string | null { return this.host.plugin.accountService?.apiToken() ?? null; }

  private async refreshQuota(): Promise<void> {
    const token = this.token(), generation = this.generation;
    if (!token || !membershipApiUrl || !isMonthOpen(this.month)) return;
    try {
      const response = await createDecisionFetch(membershipApiUrl)(`/api/diary-persona/status?month=${this.month}`, "GET", undefined, token);
      if (response.status !== 200 || generation !== this.generation) return;
      this.quota = (response.json as { quota: Quota }).quota;
      if (this.phase === "result") this.renderFoot();
    } catch { /* 次数只影响「重新生成」是否可点，读不到时按可点处理，由服务端兜底。 */ }
  }

  private async generate(): Promise<void> {
    const generation = ++this.generation, month = this.month;
    this.clearTimers();
    this.phase = "reveal"; this.landed = 0; this.error = null; this.busy = true; this.flyIndex = 0;
    this.render(); this.rotateFly(generation);
    const finish = (error: PersonaError) => { if (generation !== this.generation) return; this.busy = false; this.error = error; this.clearTimers(); this.render(); };
    const token = this.token();
    if (!token) { finish({ code: "SIGN_IN" }); return; }
    if (!membershipApiUrl) { finish({ code: "UNAVAILABLE" }); return; }
    const body = personaRequestBody(month, this.zh ? "zh" : "en", this.entries, this.resultFor(previousMonthKey(month)));
    if (body.entries.length < PERSONA_MIN_ENTRIES) { finish({ code: "NOT_ENOUGH_ENTRIES" }); return; }
    let response: { status: number; json: unknown };
    try { response = await createDecisionFetch(membershipApiUrl)("/api/diary-persona", "POST", body, token); }
    catch { finish({ code: "NETWORK" }); return; }
    const json = response.json as { result?: unknown; quota?: Quota; resetAt?: string } | null;
    if (response.status !== 200) { finish({ code: personaErrorCode(response.status, json), resetAt: json?.resetAt ?? json?.quota?.period?.resetAt }); return; }
    const result = acceptPersonaResult(json?.result);
    if (!result || result.month !== month) { finish({ code: "UNAVAILABLE" }); return; }
    // 结果先落盘：用户中途离开也不白花一次。
    this.state.results = { ...this.results, [month]: result };
    await this.host.plugin.saveSettings();
    if (generation !== this.generation) return;
    this.busy = false; this.quota = json?.quota ?? null; this.clearTimers();
    for (let index = 1; index <= 4; index++) this.later(index * LAND_MS, () => { this.landed = index; this.renderReveal(); });
    this.later(4 * LAND_MS + 700, () => { this.phase = "result"; this.fresh = true; this.render(); });
  }
  private rotateFly(generation: number): void {
    if (!this.fly.length) return;
    this.later(2600, () => {
      if (generation !== this.generation || !this.busy) return;
      this.flyIndex = (this.flyIndex + 1) % this.fly.length;
      const fly = this.root.querySelector<HTMLElement>(".journal-persona-fly");
      if (fly) { fly.setText(this.fly[this.flyIndex]); fly.removeClass("is-entering"); void fly.offsetWidth; fly.addClass("is-entering"); }
      this.rotateFly(generation);
    });
  }

  private render(): void {
    disposeChildren(this.root); this.root.removeClass("is-filled");
    const head = this.root.createDiv({ cls: "journal-header" });
    const title = head.createDiv({ cls: "journal-title" });
    this.host.iconButton(title, "arrow-left", this.t("返回日记", "Back to journal"), () => {
      if (this.phase === "reveal" && this.error && this.resultFor(this.month)) { this.phase = "result"; this.error = null; this.render(); return; }
      this.host.close(this.month);
    });
    title.createEl("h1", { text: this.title(this.month) });
    if (this.phase === "result") this.renderResult(head);
    else this.root.createDiv({ cls: "journal-persona-reveal" });
    if (this.phase === "reveal") this.renderReveal();
  }

  private renderReveal(): void {
    const host = this.root.querySelector<HTMLElement>(".journal-persona-reveal");
    if (!host) return;
    disposeChildren(host);
    const result = this.resultFor(this.month), slots = host.createDiv({ cls: "journal-persona-slots" });
    PERSONA_PAIRS.forEach((pair, index) => {
      const slot = slots.createDiv({ cls: "journal-persona-slot" });
      if (index < this.landed && result) {
        slot.addClass("is-landed");
        slot.createSpan({ cls: "journal-persona-slot-letter", text: result.dims[index].letter });
        slot.createSpan({ cls: "journal-persona-slot-name", text: pairName(index, result.dims[index].letter, this.zh) });
      } else {
        if (this.busy) slot.addClass("is-waiting");
        const letters = slot.createDiv({ cls: "journal-persona-slot-pair" });
        letters.createSpan({ text: pair[0] }); letters.createSpan({ text: pair[1] });
      }
    });
    const status = host.createDiv({ cls: "journal-persona-status", attr: { role: "status", "aria-live": "polite" } });
    if (this.error) {
      status.addClass("is-error");
      status.createSpan({ text: personaErrorText(this.error.code, this.zh, this.error.resetAt) });
      const actions = host.createDiv({ cls: "journal-persona-actions" });
      const retryable = !["PERSONA_MONTH_LIMIT", "PERSONA_PERIOD_LIMIT", "PERSONA_DAILY_CAP", "NOT_ENOUGH_ENTRIES"].includes(this.error.code);
      this.host.button(actions, this.t("返回", "Back"), () => {
        if (this.resultFor(this.month)) { this.phase = "result"; this.error = null; this.render(); } else this.host.close(this.month);
      });
      if (retryable) this.host.button(actions, this.t("重试", "Retry"), () => this.generate(), "is-primary");
      return;
    }
    if (this.busy) {
      setIcon(status.createSpan({ cls: "journal-persona-spinner", attr: { "aria-hidden": "true" } }), "loader-circle");
      status.createSpan({ text: this.t(`正在读 ${monthNumber(this.month)} 月的 ${eligibleEntries(this.entries).length} 篇日记`, `Reading ${eligibleEntries(this.entries).length} entries`) });
      if (this.fly.length) host.createDiv({ cls: "journal-persona-fly is-entering", text: this.fly[this.flyIndex % this.fly.length] });
    }
  }

  private renderResult(head: HTMLElement): void {
    const result = this.resultFor(this.month);
    if (!result) { this.host.close(this.month); return; }
    const actions = head.createDiv({ cls: "journal-persona-head-actions" });
    this.host.iconButton(actions, "share", this.t("分享卡片", "Share card"), () => this.share(result));
    this.host.button(actions, this.t("存入笔记", "Save as note"), () => this.saveNote(result));
    this.host.button(actions, this.t("聊聊这个结果", "Talk about it"), () => this.talk(result), "is-primary");

    const previous = this.resultFor(previousMonthKey(this.month)), deltas = personaDelta(result, previous);
    const hero = this.root.createDiv({ cls: "journal-persona-hero" });
    const type = hero.createDiv({ cls: `journal-persona-type${this.fresh ? " is-fresh" : ""}`, attr: { "aria-label": result.type } });
    [...result.type].forEach((letter, index) => { const span = type.createSpan({ text: letter, attr: { "aria-hidden": "true" } }); span.style.setProperty("--persona-delay", `${index * 80}ms`); });
    const copy = hero.createDiv({ cls: "journal-persona-hero-copy" });
    copy.createEl("strong", { text: result.name });
    copy.createSpan({ cls: "journal-persona-keywords", text: result.keywords.join(" · ") });
    const generated = new Date(result.generatedAt), m = monthNumber(this.month);
    const span = isMonthOpen(this.month) ? this.t(`截至 ${generated.getMonth() + 1} 月 ${generated.getDate()} 日`, `as of ${generated.toLocaleDateString("en", { month: "short", day: "numeric" })}`) : this.t(`${m} 月`, this.month);
    const change = previous ? this.t(` · 较 ${monthNumber(previous.month)} 月 ${previous.type} → ${result.type}`, ` · ${previous.type} → ${result.type}`) : "";
    copy.createSpan({ cls: "journal-persona-meta", text: this.t(`依据 ${result.entries} 篇日记 · `, `Based on ${result.entries} entries · `) + span + change });
    this.root.createEl("p", { cls: "journal-persona-summary", text: result.summary });

    const dims = this.root.createDiv({ cls: "journal-persona-dims" });
    result.dims.forEach((dim, index) => {
      const pair = PERSONA_PAIRS[index], leftWins = dim.letter === pair[0], strength = dim.percent - 50;
      const row = dims.createDiv({ cls: "journal-persona-dim" }), bar = row.createDiv({ cls: "journal-persona-dim-bar" });
      for (const [side, letter] of [["left", pair[0]], ["right", pair[1]]] as const) {
        const label = bar.createDiv({ cls: `journal-persona-side is-${side}${letter === dim.letter ? " is-winner" : ""}` });
        label.createEl("b", { text: letter }); label.createSpan({ text: pairName(index, letter, this.zh) });
        if (side === "left") {
          const middle = bar.createDiv({ cls: "journal-persona-track-wrap" });
          const track = middle.createDiv({ cls: "journal-persona-track" }); track.createSpan({ cls: "journal-persona-mid" });
          const fill = track.createSpan({ cls: `journal-persona-fill ${leftWins ? "to-left" : "to-right"}` });
          fill.style.setProperty("--persona-width", `${strength}%`);
          const pct = middle.createDiv({ cls: "journal-persona-pct", text: `${dim.letter} ${dim.percent}%` });
          const delta = deltas?.[index];
          if (delta?.flipFrom) pct.createSpan({ cls: "journal-persona-flip", text: this.t(` · 由 ${delta.flipFrom} 转来`, ` · from ${delta.flipFrom}`) });
          else if (delta?.delta) pct.createSpan({ cls: "journal-persona-delta", text: ` ${delta.delta > 0 ? "↑" : "↓"}${Math.abs(delta.delta)}` });
        }
      }
      if (dim.quotes.length) {
        const quotes = row.createDiv({ cls: "journal-persona-quotes" });
        for (const quote of dim.quotes) {
          const line = quotes.createDiv({ cls: "journal-persona-quote" });
          const date = line.createEl("button", { cls: "journal-persona-quote-date", text: quote.date.slice(5).replace("-", "/"), attr: { type: "button", "aria-label": this.t(`打开 ${quote.date} 的日记`, `Open ${quote.date}`) } });
          date.onclick = () => { const entry = this.entries.find(item => item.date === quote.date); if (entry) void this.host.openPath(entry.path); else new Notice(this.t("这篇日记已移动或不存在", "This journal moved or no longer exists")); };
          line.createSpan({ text: quote.text });
        }
      }
    });
    if (this.fresh) window.requestAnimationFrame(() => window.requestAnimationFrame(() => { this.root.addClass("is-filled"); this.fresh = false; }));
    else this.root.addClass("is-filled");

    const year = this.root.createEl("section", { cls: "journal-persona-year" });
    year.createEl("h2", { text: this.t(`${this.month.slice(0, 4)} 年`, this.month.slice(0, 4)) });
    year.createDiv({ cls: "journal-persona-year-grid" });
    this.renderYear();
    this.root.createDiv({ cls: "journal-persona-foot" });
    this.renderFoot();
  }

  private renderYear(): void {
    const grid = this.root.querySelector<HTMLElement>(".journal-persona-year-grid");
    if (!grid) return;
    disposeChildren(grid);
    const year = Number(this.month.slice(0, 4)), now = monthKey(new Date());
    for (let m = 1; m <= 12; m++) {
      const key = `${year}-${String(m).padStart(2, "0")}`, result = this.resultFor(key), label = this.zh ? `${m}月` : new Date(year, m - 1, 1).toLocaleString("en", { month: "short" });
      const eligible = !result && key <= now ? this.eligibility(key) : false;
      const clickable = key <= now && (!!result || eligible);
      const cell = clickable ? grid.createEl("button", { attr: { type: "button" } }) : grid.createDiv();
      cell.addClass("journal-persona-month"); if (key === this.month) cell.addClass("is-current");
      cell.createSpan({ cls: "journal-persona-month-label", text: label });
      const value = cell.createSpan({ cls: "journal-persona-month-value" });
      if (key > now) value.setText("");
      else if (result) value.setText(result.type);
      else if (eligible) { setIcon(value, "sparkles"); cell.setAttribute("aria-label", this.title(key)); }
      else { value.setText("—"); value.addClass("is-empty"); }
      if (clickable && cell instanceof HTMLButtonElement) cell.onclick = () => { void this.open(key, !result); };
    }
  }
  /** 年度格子的 ✦：文件数够了才读正文判断，结果缓存在本次打开期间。 */
  private eligibility(month: string): boolean {
    if (this.yearEligible.has(month)) return this.yearEligible.get(month)!;
    if (this.host.monthFileCount(month) < PERSONA_MIN_ENTRIES) { this.yearEligible.set(month, false); return false; }
    this.yearEligible.set(month, false);
    const generation = this.generation;
    void this.host.monthEntries(month).then(entries => {
      if (generation !== this.generation) return;
      const ok = eligibleEntries(entries).length >= PERSONA_MIN_ENTRIES;
      this.yearEligible.set(month, ok);
      if (ok) this.renderYear();
    });
    return false;
  }

  private renderFoot(): void {
    const foot = this.root.querySelector<HTMLElement>(".journal-persona-foot");
    if (!foot) return;
    disposeChildren(foot);
    if (!isMonthOpen(this.month)) return;
    const quota = this.quota;
    const blocked: PersonaError | null = !quota ? null : !quota.daily.open ? { code: "PERSONA_DAILY_CAP" } : quota.month && quota.month.remaining <= 0 ? { code: "PERSONA_MONTH_LIMIT" }
      : quota.period.remaining <= 0 ? { code: "PERSONA_PERIOD_LIMIT", resetAt: quota.period.resetAt } : null;
    const button = this.host.button(foot, this.t("重新生成", "Regenerate"), () => this.generate(), "journal-persona-regenerate");
    setIcon(button.createSpan({ attr: { "aria-hidden": "true" } }), "rotate-ccw"); button.prepend(button.lastChild!);
    if (blocked) { button.disabled = true; foot.createSpan({ cls: "journal-persona-foot-note", text: personaErrorText(blocked.code, this.zh, blocked.resetAt) }); }
  }

  private outputsFolder(): string {
    const role = (this.host.plugin.settings.knowledgeBase?.folderBindings as { roles?: Record<string, { enabled?: boolean; writePath?: string | null }> } | null | undefined)?.roles?.outputs;
    const base = role?.enabled && role.writePath ? role.writePath : "outputs";
    return normalizePath(`${base}/${this.t("日记人格", "Diary persona")}`);
  }
  private async ensureFolder(path: string): Promise<void> {
    let current = "";
    for (const part of path.split("/")) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) { try { await this.app.vault.createFolder(current); } catch { /* 并发创建时已存在即可。 */ } }
    }
  }

  private async saveNote(result: PersonaResult): Promise<void> {
    const folder = this.outputsFolder(), path = normalizePath(`${folder}/${result.month}.md`);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing && !(await confirmModal(this.app, this.t("覆盖已有笔记？", "Replace the existing note?"), this.t(`${path} 已存在，将替换为最新结果。`, `${path} already exists and will be replaced with the latest result.`), this.t("覆盖", "Replace"), this.t("取消", "Cancel")))) return;
    const markdown = personaMarkdown(result, date => {
      const entry = this.entries.find(item => item.date === date), file = entry ? this.app.vault.getAbstractFileByPath(entry.path) : null;
      return file instanceof TFile ? this.app.metadataCache.fileToLinktext(file, path) : null;
    }, this.zh, this.resultFor(previousMonthKey(result.month)));
    try {
      await this.ensureFolder(folder);
      const file = existing instanceof TFile ? existing : null;
      if (file) await this.app.vault.modify(file, markdown); else await this.app.vault.create(path, markdown);
      new Notice(this.t(`已存入 ${path}`, `Saved to ${path}`));
      await this.host.openPath(path);
    } catch (error) {
      new Notice(this.t("保存失败：", "Could not save: ") + (error instanceof Error ? error.message : String(error)));
    }
  }

  private async talk(result: PersonaResult): Promise<void> {
    const m = monthNumber(result.month);
    const text = this.t(`聊聊我 ${m} 月的日记人格：${result.type}「${result.name}」。${result.summary}`, `Let's talk about my ${result.month} diary persona: ${result.type} — "${result.name}". ${result.summary}`);
    await prefillWorkbenchModule(this.host.plugin, "journal", text);
  }

  private share(result: PersonaResult): void {
    new PersonaShareModal(this.app, result, readColors(this.root), this.zh, this.outputsFolder(), folder => this.ensureFolder(folder)).open();
  }
}

function disposeChildren(element: HTMLElement): void { element.empty(); }

/** 揭晓等待时滚动的本地原句：只在本机挑选，不额外发送任何内容。 */
function sentences(entries: readonly PersonaEntry[]): string[] {
  const pool: string[] = [];
  for (const entry of entries) for (const part of entry.text.split(/[。！？!?\n]+/u)) {
    const text = part.trim();
    if (text.length >= 8 && text.length <= 32) { pool.push(`“${text}”`); break; }
  }
  return pool.slice(0, 12);
}

interface CardColors { bg: string; card: string; text: string; secondary: string; muted: string; accent: string; mark: string; font: string }
function readColors(element: HTMLElement): CardColors {
  const style = getComputedStyle(element), value = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return { bg: value("--bg", "#ffffff"), card: value("--soft", "#f4f4f5"), text: value("--text", "#18181b"), secondary: value("--secondary", "#52525b"), muted: value("--muted", "#71717a"),
    accent: value("--persona-bar", "#18181b"), mark: value("--persona-mark", "#e4e4e7"), font: style.fontFamily || "sans-serif" };
}

/** 分享卡：只画字母、描述、关键词和四维比例，不带任何日记原文。 */
export function drawPersonaCard(result: PersonaResult, colors: CardColors, zh: boolean): HTMLCanvasElement {
  const scale = 3, width = 360, height = 380, pad = 32;
  const canvas = createEl("canvas"); canvas.width = width * scale; canvas.height = height * scale;
  const ctx = canvas.getContext("2d")!; ctx.scale(scale, scale);
  const round = (x: number, y: number, w: number, h: number, r: number) => { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); };
  ctx.fillStyle = colors.card; round(0, 0, width, height, 24); ctx.fill();
  const font = (size: number, weight = 400) => `${weight} ${size}px ${colors.font}`;
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = colors.muted; ctx.font = font(12);
  ctx.fillText(zh ? `${result.month.slice(0, 4)} · ${monthNumber(result.month)} 月` : result.month, pad, 52);
  ctx.font = font(64, 700); const typeWidth = ctx.measureText(result.type).width;
  ctx.fillStyle = colors.mark; round(pad - 4, 118, typeWidth + 8, 16, 3); ctx.fill();
  ctx.fillStyle = colors.text; ctx.fillText(result.type, pad, 132);
  ctx.font = font(18, 600); ctx.fillText(result.name, pad, 182, width - pad * 2);
  ctx.fillStyle = colors.secondary; ctx.font = font(13); ctx.fillText(result.keywords.join(" · "), pad, 208, width - pad * 2);
  const column = (width - pad * 2 - 24) / 4;
  result.dims.forEach((dim, index) => {
    const x = pad + index * (column + 8);
    ctx.fillStyle = colors.muted; ctx.font = font(12); ctx.fillText(`${dim.letter} ${dim.percent}%`, x, 262);
    ctx.fillStyle = colors.bg; round(x, 272, column, 6, 3); ctx.fill();
    ctx.fillStyle = colors.accent; round(x, 272, column * dim.percent / 100, 6, 3); ctx.fill();
  });
  ctx.fillStyle = colors.muted; ctx.font = font(12); ctx.fillText(zh ? "EchoInk · 日记人格" : "EchoInk · Diary persona", pad, height - 30);
  return canvas;
}

class PersonaShareModal extends Modal {
  private blob: Blob | null = null;
  constructor(app: App, private readonly result: PersonaResult, private readonly colors: CardColors, private readonly zh: boolean, private readonly folder: string,
    private readonly ensureFolder: (folder: string) => Promise<void>) { super(app); }
  private t(zh: string, en: string): string { return this.zh ? zh : en; }
  onOpen(): void {
    this.modalEl.addClass("echoink-persona-share-modal");
    this.titleEl.setText(this.t("分享卡片", "Share card"));
    const canvas = drawPersonaCard(this.result, this.colors, this.zh);
    const image = this.contentEl.createEl("img", { cls: "echoink-persona-share-image", attr: { alt: `${this.result.type} · ${this.result.name}` } });
    canvas.toBlob(blob => { if (!blob) return; this.blob = blob; image.src = URL.createObjectURL(blob); }, "image/png");
    const actions = this.contentEl.createDiv({ cls: "modal-button-container" });
    const copy = actions.createEl("button", { text: this.t("复制图片", "Copy image") });
    copy.onclick = async () => {
      try { if (!this.blob) throw new Error("empty"); await navigator.clipboard.write([new ClipboardItem({ "image/png": this.blob })]); new Notice(this.t("已复制到剪贴板", "Copied to clipboard")); }
      catch { new Notice(this.t("复制失败，请改用保存图片。", "Copy failed. Save the image instead.")); }
    };
    const save = actions.createEl("button", { cls: "mod-cta", text: this.t("保存图片", "Save image") });
    save.onclick = async () => {
      if (!this.blob) return;
      const path = normalizePath(`${this.folder}/${this.result.month}.png`);
      try {
        await this.ensureFolder(this.folder);
        const data = await this.blob.arrayBuffer(), existing = this.app.vault.getAbstractFileByPath(path);
        if (existing instanceof TFile) await this.app.vault.modifyBinary(existing, data); else await this.app.vault.createBinary(path, data);
        new Notice(this.t(`已保存到 ${path}`, `Saved to ${path}`)); this.close();
      } catch (error) { new Notice(this.t("保存失败：", "Could not save: ") + (error instanceof Error ? error.message : String(error))); }
    };
  }
  onClose(): void {
    const image = this.contentEl.querySelector("img");
    if (image?.src.startsWith("blob:")) URL.revokeObjectURL(image.src);
    this.contentEl.empty();
  }
}
