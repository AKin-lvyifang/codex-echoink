import { ownedEl } from "../owned-dom";
import { mobileScrollFrame, type MobileScrollFrame } from "./scroll-frame";

/** Retain completed rows while metadata and the live tail change. Page-local only. */
export class MobileTranscriptNodes {
  private nodes = new Map<string, { revision: string; element: HTMLElement }>();
  private used = new Set<string>();
  begin(): void { this.used.clear(); }
  get<T extends HTMLElement>(key: string, revision: string, create: () => T): T {
    this.used.add(key);
    const old = this.nodes.get(key);
    if (old?.revision === revision) return old.element as T;
    const element = create(); this.nodes.set(key, { revision, element }); return element;
  }
  commit(parent: HTMLElement, desired: HTMLElement[]): void {
    const wanted = new Set(desired);
    for (const node of Array.from(parent.children)) if (!wanted.has(node as HTMLElement)) node.remove();
    let cursor = parent.firstChild;
    for (const node of desired) {
      if (cursor === node) cursor = cursor.nextSibling;
      else parent.insertBefore(node, cursor);
    }
    for (const key of this.nodes.keys()) if (!this.used.has(key)) this.nodes.delete(key);
  }
  clear(): void { this.nodes.clear(); this.used.clear(); }
}

type Reasoning = { details: HTMLDetailsElement; body: HTMLElement; text: Text; label: HTMLElement;
  following: boolean; held: boolean; touched: boolean; scrollEvent: boolean; automatic?: number; dispose: () => void };

/** Streaming stays plain text; one owned text node survives every delta. */
export class MobileLiveTaskTranscript {
  private reasoning?: Reasoning;
  private article?: HTMLElement;
  private answer?: Text;
  private hadText = false;
  private disposed = false;
  private readonly frame: MobileScrollFrame;
  constructor(private root: HTMLElement, private prefix: "ip" | "pd", private makeReasoning: (open: boolean) => HTMLDetailsElement,
    private canFollow: () => boolean, private onRead: () => void, private onBottom: () => void) {
    this.frame = mobileScrollFrame(root.ownerDocument);
  }
  render(live?: { reasoning: string; text: string }): void {
    if (this.disposed) return;
    if (!live) { this.reset(); this.root.hidden = true; return; }
    this.root.hidden = false;
    if (live.reasoning) {
      if (!this.reasoning) this.createReasoning(!live.text);
      const r = this.reasoning!;
      this.updateText(r.text, live.reasoning);
      const label = live.text ? "思考过程" : "思考中…";
      if (r.label.textContent !== label) r.label.textContent = label;
      if (live.text && !this.hadText && !r.touched) r.details.open = false;
      this.scheduleReasoning();
    }
    if (live.text) {
      if (!this.article) {
        this.article = ownedEl(this.root.ownerDocument, "article");
        this.article.className = `${this.prefix}-task-answer ${this.prefix}-task-answer-live`;
        this.article.setAttribute("aria-label", "Agent 回复"); this.article.dataset.messageRole = "assistant";
        this.answer = this.root.ownerDocument.createTextNode(""); this.article.append(this.answer); this.root.append(this.article);
      }
      this.updateText(this.answer!, live.text);
    }
    this.hadText = !!live.text;
  }
  private updateText(node: Text, text: string): void {
    if (node.data === text) return;
    if (text.startsWith(node.data)) node.appendData(text.slice(node.length)); else node.replaceData(0, node.length, text);
  }
  private createReasoning(open: boolean): void {
    const details = this.makeReasoning(open), body = details.querySelector<HTMLElement>(`.${this.prefix}-task-reasoning-body`)!;
    const text = this.root.ownerDocument.createTextNode(""); body.replaceChildren(text);
    const label = details.querySelector<HTMLElement>("summary > span:last-child")!;
    const r: Reasoning = { details, body, text, label, following: true, held: false, touched: false, scrollEvent: false, dispose: () => {} };
    const read = () => { r.touched = true; r.following = false; this.onRead(); };
    const start = () => { r.held = true; read(); };
    const end = () => { r.held = false; r.scrollEvent = true; this.scheduleReasoning(); };
    const wheel = (event: WheelEvent) => { if (event.deltaY < 0) read(); };
    const scroll = () => { r.scrollEvent = true; this.scheduleReasoning(); };
    const summary = details.querySelector("summary")!;
    summary.addEventListener("pointerdown", read);
    body.addEventListener("touchstart", start, { passive: true });
    body.addEventListener("touchend", end, { passive: true });
    body.addEventListener("touchcancel", end, { passive: true });
    body.addEventListener("wheel", wheel, { passive: true }); body.addEventListener("scroll", scroll, { passive: true });
    r.dispose = () => {
      summary.removeEventListener("pointerdown", read); body.removeEventListener("touchstart", start);
      body.removeEventListener("touchend", end); body.removeEventListener("touchcancel", end);
      body.removeEventListener("wheel", wheel); body.removeEventListener("scroll", scroll);
    };
    this.reasoning = r; this.root.insertBefore(details, this.article ?? null);
  }
  private scheduleReasoning(): void {
    this.frame.request(this, () => {
      const r = this.reasoning;
      if (this.disposed || !r?.details.open || !r.body.isConnected) return;
      const top = r.body.scrollTop, maximum = Math.max(0, r.body.scrollHeight - r.body.clientHeight);
      if (r.scrollEvent && (r.touched || top !== r.automatic)) {
        r.following = maximum - top <= 2;
        if (r.following && !r.held) this.onBottom();
      }
      r.scrollEvent = false;
      return () => {
        if (this.disposed || this.reasoning !== r || !r.following || r.held || !this.canFollow() || Math.abs(top - maximum) < .5) return;
        r.body.scrollTop = maximum; r.automatic = r.body.scrollTop;
      };
    });
  }
  takeReasoning(text: string): HTMLDetailsElement | undefined {
    const r = this.reasoning;
    if (!r || r.text.data.trim() !== text.trim()) return;
    this.reasoning = undefined; r.dispose(); this.frame.cancel(this); return r.details;
  }
  private reset(): void {
    this.frame.cancel(this); this.reasoning?.dispose(); this.reasoning = undefined;
    if (this.root.childNodes.length) this.root.replaceChildren();
    this.article = undefined; this.answer = undefined; this.hadText = false;
  }
  dispose(): void { this.disposed = true; this.reset(); }
}
