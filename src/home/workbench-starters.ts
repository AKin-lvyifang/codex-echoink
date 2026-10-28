import { animate, type AnimationPlaybackControlsWithThen } from "framer-motion";
import { setIcon } from "obsidian";
import { createOriginButton, disposeOriginControls } from "../settings/origin-controls";
import { applyAmicroButton } from "../settings/amicro-buttons";
import { WORKBENCH_ART, avatarWheelArt, inlineWorkbenchArt } from "./workbench-artwork";

const cards = [
  ["给你的助手换个头像、起个名字", "Give your assistant a name and avatar", "去设置", "Settings", "avatar"],
  ["把这个仓库设成知识库", "Make this vault your knowledge base", "去设置", "Settings", "knowledge"],
  ["换一套外观看看", "Try a different appearance", "去看看", "Take a look", "appearance"],
  ["帮我开始写今天的日记", "Help me start today's journal", "开始写", "Start writing", "diary"],
  ["带我精读一篇笔记", "Read a note closely with me", "选一篇", "Choose a note", "reading"],
  ["用英文写今天的日记，帮我改错", "Write today's diary in English and help me improve it", "开始写", "Start writing", "english"],
  ["把一份 PDF 拆成精读笔记", "Turn a PDF into close-reading notes", "去看看", "Take a look", "pdf"]
] as const;
export class WorkbenchStarters {
  readonly element: HTMLElement;
  private readonly deck: HTMLElement;
  private readonly dots: HTMLButtonElement[] = [];
  private readonly nodes = new Map<number, HTMLElement>();
  private readonly animations = new Set<AnimationPlaybackControlsWithThen>();
  private index = 0;
  private targetIndex = 0;
  private moving = false;
  private locked: number | null = null;
  private drag: { id: number; x: number; dx: number } | null = null;
  private dragged = false;
  private signature = "";
  private readonly cleanups: (() => void)[] = [];
  constructor(parent: HTMLElement, private readonly options: {
    english(): boolean; hasPro(): boolean; avatar(): string; act(index: number): Promise<unknown>; upgrade(): Promise<unknown>; error(error: unknown): void;
  }) {
    this.element = parent.createEl("section", { cls: "wb-starters" }); this.element.createEl("h2", { text: this.t("从这里开始", "Start here") });
    this.deck = this.element.createDiv({ cls: "wb-deck", attr: { tabindex: "0", "aria-roledescription": this.t("轮播", "Carousel"), "aria-label": this.t("从这里开始", "Start here") } });
    const controls = this.element.createDiv({ cls: "wb-deck-controls" });
    const arrow = (direction: number) => {
      const button = this.button(controls, "", () => this.go(this.targetIndex + direction));
      button.classList.add("wb-deck-arrow", direction < 0 ? "is-prev" : "is-next");
      button.setAttribute("aria-label", direction < 0 ? this.t("上一张", "Previous card") : this.t("下一张", "Next card"));
      setIcon(button, direction < 0 ? "chevron-left" : "chevron-right");
    };
    arrow(-1);
    const dots = controls.createDiv({ cls: "wb-deck-dots" });
    cards.forEach((_, i) => { const dot = this.button(dots, "", () => this.go(i)); dot.setAttribute("aria-label", this.t(`第 ${i + 1} 张`, `Card ${i + 1}`)); this.dots.push(dot); });
    arrow(1);
    this.listen(this.element, "keydown", (e: KeyboardEvent) => { if (e.isComposing) return; if (e.key === "Escape" && this.locked !== null) { e.preventDefault(); this.closeLock(); return; } if (e.key === "ArrowLeft" || e.key === "ArrowRight") { e.preventDefault(); this.go(this.targetIndex + (e.key === "ArrowLeft" ? -1 : 1)); } });
    this.listen(this.deck, "pointerdown", (e: PointerEvent) => { if (e.button !== 0) return; this.dragged = false; if ((e.target as Element).closest("button")) return; this.drag = { id: e.pointerId, x: e.clientX, dx: 0 }; });
    this.listen(this.deck, "pointermove", (e: PointerEvent) => { if (this.drag?.id === e.pointerId) { this.drag.dx = e.clientX - this.drag.x; if (Math.abs(this.drag.dx) > 6 && !this.dragged) { this.dragged = true; this.deck.setPointerCapture?.(e.pointerId); } } });
    this.listen(this.deck, "pointerup", (e: PointerEvent) => { if (this.drag?.id !== e.pointerId) return; const dx = this.drag.dx; this.drag = null; if (Math.abs(dx) > 40) this.go(this.targetIndex + (dx < 0 ? 1 : -1)); });
    this.listen(this.deck, "pointercancel", () => { this.drag = null; this.dragged = false; });
    this.listen(this.deck, "lostpointercapture", () => { this.drag = null; });
    const Observer = parent.ownerDocument.defaultView?.ResizeObserver;
    if (Observer) { const observer = new Observer(() => this.layout(false)); observer.observe(this.deck); this.cleanups.push(() => observer.disconnect()); }
    this.update();
  }
  private t(zh: string, en: string): string { return this.options.english() ? en : zh; }
  private listen(target: EventTarget, event: string, action: EventListener): void { target.addEventListener(event, action); this.cleanups.push(() => target.removeEventListener(event, action)); }
  private button(parent: HTMLElement, text: string, action: () => unknown, primary = false): HTMLButtonElement {
    const button = createOriginButton(parent, { text, cls: `wb-button ${primary ? "is-primary" : "is-secondary"}`, attr: { type: "button" } }); applyAmicroButton(button, { variant: primary ? "primary" : "secondary" });
    button.onclick = e => { e.stopPropagation(); void Promise.resolve().then(action).catch(error => this.options.error(error)); }; return button;
  }
  update(): void {
    const signature = JSON.stringify([this.options.english(), this.options.hasPro(), this.options.avatar()]);
    if (signature !== this.signature) { this.signature = signature; if (this.options.hasPro()) this.locked = null; this.setActive(false); this.clearCards(); }
    if (!this.moving) this.layout(false);
  }
  private clearCards(): void { for (const node of this.nodes.values()) { disposeOriginControls(node); node.remove(); } this.nodes.clear(); }
  private go(index: number): void {
    const focusedCard = this.deck.ownerDocument.activeElement?.closest(".wb-starter-card");
    this.targetIndex = (index + cards.length) % cards.length; this.locked = null;
    if (!this.moving) this.advance();
    if (focusedCard) this.deck.focus({ preventScroll: true });
  }
  private advance(): void {
    if (this.targetIndex === this.index) { this.layout(false); return; }
    if (this.deck.ownerDocument.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      this.index = this.targetIndex; this.layout(false); return;
    }
    const direction = (this.targetIndex - this.index + cards.length) % cards.length <= 3 ? 1 : -1;
    const wrap = (i: number) => (i + cards.length) % cards.length;
    const start = this.index, next = wrap(start + direction), outgoing = wrap(start - direction * 2), incoming = wrap(start + direction * 3);
    const positions = new Map<number, number>();
    for (let d = -2; d <= 2; d++) positions.set(wrap(start + d), d);
    const step = this.cardStep();
    this.moving = true;
    this.nodes.forEach(node => node.querySelectorAll<HTMLButtonElement>("button").forEach(button => { button.disabled = true; }));
    let recycled = false;
    // Recycle the far card only while completely covered by its neighbours.
    // The four remaining cards share one progress value, so they cannot separate.
    const control = animate(0, 1, { duration: .42, ease: [.2, .8, .2, 1], onUpdate: progress => {
      if (progress >= .5 && !recycled) {
        const old = this.nodes.get(outgoing)!; disposeOriginControls(old); old.remove(); this.nodes.delete(outgoing);
        const node = this.card(incoming); node.querySelectorAll<HTMLButtonElement>("button").forEach(button => { button.disabled = true; });
        this.deck.append(node); this.nodes.set(incoming, node); recycled = true;
      }
      for (const [i, node] of this.nodes) {
        const recycling = i === outgoing || i === incoming;
        const distance = i === outgoing ? direction * (-2 + progress * 4)
          : i === incoming ? direction * (1 + progress) : positions.get(i)! - direction * progress;
        node.style.transform = `translateX(${distance * step}px)`;
        node.style.zIndex = recycling ? "1" : String(20 - Math.round(Math.abs(distance) * 4));
      }
    }, onComplete: () => {
      this.animations.delete(control); this.moving = false; this.index = next; this.layout(false); this.advance();
    } });
    this.animations.add(control);
  }
  private cardStep(): number {
    const width = Array.from(this.nodes.values())[0]?.offsetWidth || 280;
    return Math.max(12, Math.min(48, ((this.deck.clientWidth || width + 192) - width) / 4));
  }
  private closeLock(): void {
    this.locked = null; this.layout(false);
    this.nodes.get(this.index)?.querySelector<HTMLButtonElement>(".wb-starter-actions button")?.focus({ preventScroll: true });
  }
  private layout(_moving: boolean): void {
    if (this.moving) return;
    for (const animation of this.animations) animation.stop(); this.animations.clear();
    const desired = new Map<number, number>(); for (let d = -2; d <= 2; d++) desired.set((this.index + d + cards.length) % cards.length, d);
    for (const [i, node] of this.nodes) if (!desired.has(i)) { disposeOriginControls(node); node.remove(); this.nodes.delete(i); }
    for (const [i, distance] of desired) {
      let node = this.nodes.get(i);
      if (!node) { node = this.card(i); this.deck.append(node); this.nodes.set(i, node); }
      node.classList.toggle("is-current", distance === 0); node.style.zIndex = String(10 - Math.abs(distance)); node.style.setProperty("--wb-card-fade", distance === 0 ? "1" : Math.abs(distance) === 1 ? ".45" : ".2");
      const previousLock = node.querySelector<HTMLElement>(".wb-starter-lock");
      if (previousLock && this.locked !== i) { disposeOriginControls(previousLock); previousLock.remove(); }
      node.querySelectorAll<HTMLButtonElement>("button").forEach(button => {
        if (button.closest(".wb-starter-lock")) { button.tabIndex = distance === 0 ? 0 : -1; return; }
        button.disabled = this.locked === i; button.tabIndex = distance === 0 && this.locked !== i ? 0 : -1;
      });
      node.style.transform = `translateX(${distance * this.cardStep()}px)`;
      if (this.locked === i && !node.querySelector(".wb-starter-lock")) this.renderLock(node);
    }
    this.dots.forEach((dot, i) => { dot.classList.toggle("is-current", i === this.index); dot.setAttribute("aria-current", String(i === this.index)); });
  }
  private card(index: number): HTMLElement {
    const card = this.deck.ownerDocument.createElement("article"); card.className = "wb-starter-card"; card.dataset.starter = String(index);
    card.setAttribute("aria-label", `${index + 1} / ${cards.length}`);
    card.onclick = () => { if (this.dragged) { this.dragged = false; return; } if (index !== this.index || this.moving) this.go(index); };
    const data = cards[index]; const art = card.createDiv({ cls: "wb-starter-art" });
    art.append(index === 0 ? avatarWheelArt(card.ownerDocument, this.options.avatar()) : inlineWorkbenchArt(card.ownerDocument, WORKBENCH_ART[data[4]]));
    if (index >= 5 && !this.options.hasPro()) card.createSpan({ cls: "wb-starter-pro", text: "PRO" });
    card.createEl("h3", { text: data[this.options.english() ? 1 : 0] });
    const actions = card.createDiv({ cls: "wb-starter-actions" });
    const locked = index >= 5 && !this.options.hasPro();
    const button = this.button(actions, locked ? this.t("了解 PRO", "About PRO") : data[this.options.english() ? 3 : 2], () => {
      if (index !== this.index || this.moving) { this.go(index); return; }
      if (index >= 5 && !this.options.hasPro()) { this.locked = index; this.layout(false); return; }
      return this.options.act(index);
    }, true);
    const icon = locked ? "lock" : index < 2 ? "arrow-right" : undefined;
    if (icon) {
      const node = button.createSpan({ cls: "wb-button-icon", attr: { "aria-hidden": "true" } });
      setIcon(node, icon);
      if (locked) button.prepend(node);
    }
    return card;
  }
  private renderLock(card: HTMLElement): void {
    const lock = card.createDiv({ cls: "wb-starter-lock" }); lock.createEl("strong", { text: this.t("需要 PRO", "Requires PRO") });
    const actions = lock.createDiv({ cls: "wb-starter-actions" });
    const cancel = this.button(actions, this.t("以后再说", "Not now"), () => this.closeLock());
    this.button(actions, this.t("升级 PRO", "Upgrade to PRO"), () => this.options.upgrade(), true);
    cancel.focus({ preventScroll: true });
  }
  setActive(active: boolean): void { if (!active) { for (const control of this.animations) control.stop(); this.animations.clear(); this.moving = false; this.index = this.targetIndex; this.layout(false); } }
  dispose(): void { this.setActive(false); for (const cleanup of this.cleanups) cleanup(); this.clearCards(); disposeOriginControls(this.element); this.element.remove(); }
}
