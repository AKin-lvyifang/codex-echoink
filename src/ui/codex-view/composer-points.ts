import { setIcon } from "obsidian";
import { pointsAmount, type PointsFeedback, type WorkbenchNotices } from "../../membership/workbench-notices";

type PanelOptions = { enabled: boolean; language: string; sessionId: string; estimate?: string };
const mounted = new WeakMap<HTMLElement, ReturnType<typeof mount>>();

export function updateComposerPoints(input: HTMLElement, notices: WorkbenchNotices, options: PanelOptions): void {
  const host = input.closest<HTMLElement>(".codex-input-wrap");
  if (!host) return;
  let panel = mounted.get(host);
  if (!panel && options.enabled) {
    panel = mount(host, notices);
    mounted.set(host, panel);
  }
  panel?.update(options);
}

export function disposeComposerPoints(input?: HTMLElement): void {
  const host = input?.closest<HTMLElement>(".codex-input-wrap");
  if (!host) return;
  mounted.get(host)?.dispose();
  mounted.delete(host);
}

function mount(host: HTMLElement, notices: WorkbenchNotices) {
  const win = host.ownerDocument.defaultView!;
  const root = host.createDiv({ cls: "echoink-composer-points" });
  host.prepend(root);
  const heading = root.createEl("button", { cls: "echoink-points-heading", attr: { type: "button", "aria-expanded": "false" } });
  const label = heading.createSpan();
  const delta = heading.createSpan({ cls: "echoink-points-delta" }); delta.hidden = true;
  const summary = heading.createSpan({ cls: "echoink-points-summary" });
  const remaining = summary.createSpan();
  const balance = summary.createEl("strong");
  const total = summary.createSpan();
  const chevron = heading.createSpan({ cls: "echoink-points-chevron", attr: { "aria-hidden": "true" } }); setIcon(chevron, "chevron-up");
  const details = root.createDiv({ cls: "echoink-points-details" }); details.hidden = true;
  const track = details.createDiv({ cls: "echoink-points-track", attr: { "aria-hidden": "true" } });
  const fill = track.createSpan({ cls: "echoink-points-fill" });
  const segment = track.createSpan({ cls: "echoink-points-segment" });
  const foot = details.createDiv({ cls: "echoink-points-foot" });
  const status = foot.createSpan({ attr: { role: "status" } });
  const expiry = foot.createSpan();
  let options: PanelOptions = { enabled: false, sessionId: "", language: "" };
  let open = false, hovering = false, automatic = false, wasSettling = false;
  let seen: PointsFeedback | undefined;
  let timer: number | undefined, rollFrame: number | undefined;
  let initialRequestContext: number | undefined;

  function scheduleClose(): void {
    win.clearTimeout(timer); timer = undefined;
    if (!automatic || hovering || root.contains(host.ownerDocument.activeElement)) return;
    timer = win.setTimeout(() => {
      timer = undefined;
      automatic = false; open = false;
      if (seen) notices.clearPointsFeedback(seen);
      paint();
    }, seen?.kind === "gift" ? 3200 : 2800);
  }
  function paint(): void {
    const english = options.language === "en";
    const lang = english ? "en" : "zh-CN";
    const format = (value: number) => new Intl.NumberFormat(lang, { maximumFractionDigits: 3 }).format(value);
    const summaryValue = notices.points();
    const numeric = notices.visibleBalance();
    const activeTotal = pointsAmount(summaryValue?.activeTotal);
    const scale = activeTotal && numeric !== undefined ? activeTotal : undefined;
    root.hidden = !options.enabled || !notices.signedIn();
    if (root.hidden) return;
    const feedback = notices.pointsFeedback(options.sessionId);
    const settling = feedback?.kind === "settling";
    if (settling && !wasSettling) {
      win.clearTimeout(timer); timer = undefined; automatic = true; open = true; seen = undefined;
    } else if (!settling && (wasSettling || (feedback && feedback !== seen))) {
      seen = feedback; automatic = true; open = true; scheduleClose();
      if (feedback?.kind === "gift" && feedback.before !== undefined && numeric !== undefined
        && !win.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        win.cancelAnimationFrame(rollFrame ?? 0);
        const before = feedback.before, started = win.performance.now();
        const roll = (now: number) => {
          const progress = Math.min(1, (now - started) / 650);
          balance.textContent = format(before + (numeric - before) * (1 - (1 - progress) ** 3));
          rollFrame = progress < 1 ? win.requestAnimationFrame(roll) : undefined;
        };
        rollFrame = win.requestAnimationFrame(roll);
      }
    }
    wasSettling = settling;
    label.textContent = english ? "AI points" : "AI 点数";
    remaining.textContent = english ? "Remaining" : "剩余";
    if (rollFrame === undefined) balance.textContent = numeric !== undefined ? format(numeric) : "—";
    total.textContent = scale ? "/ " + format(scale) : "";
    heading.setAttribute("aria-expanded", String(open));
    root.classList.toggle("is-open", open);
    details.hidden = !open;
    const gift = feedback?.kind === "gift" ? feedback : undefined;
    const spent = feedback?.kind === "spent" ? feedback : undefined;
    delta.hidden = !gift;
    delta.textContent = gift ? "+" + format(gift.amount) : "";
    track.hidden = !scale;
    if (scale && numeric !== undefined) {
      const pct = (value: number) => Math.min(100, Math.max(0, value / scale * 100));
      const base = pct(numeric - (gift?.amount ?? 0));
      const segmentEnd = pct(numeric + (spent?.amount ?? 0));
      fill.style.width = base + "%";
      segment.style.left = base + "%";
      segment.style.width = Math.max(0, segmentEnd - base) + "%";
      segment.classList.toggle("is-added", !!gift);
    }
    status.textContent = settling ? (english ? "Settling points…" : "结算中")
      : spent ? (english ? `Used ${format(spent.amount)} pts` : `本次已用 ${format(spent.amount)} 点`)
      : options.estimate ? (english ? `Current model ${options.estimate}` : `当前模型 ${options.estimate}`) : "";
    const date = summaryValue?.nextExpiry?.at;
    expiry.textContent = date ? (english ? "Next expiry " : "最近到期 ") + new Date(date).toLocaleDateString(lang) : "";
  }
  heading.onclick = () => {
    open = !open; automatic = false; win.clearTimeout(timer); timer = undefined; paint();
  };
  root.onmouseenter = () => { hovering = true; win.clearTimeout(timer); timer = undefined; };
  root.onmouseleave = () => { hovering = false; if (!wasSettling) scheduleClose(); };
  root.addEventListener("focusout", () => win.queueMicrotask(() => { if (!wasSettling) scheduleClose(); }));
  const unsubscribe = notices.subscribe(() => {
    paint();
    if (options.enabled && initialRequestContext !== notices.accountRevision()) {
      initialRequestContext = notices.accountRevision();
      void notices.refreshPoints();
    }
  });
  return { update(next: PanelOptions) {
    if (next.sessionId !== options.sessionId || next.enabled !== options.enabled) {
      open = automatic = wasSettling = false; seen = undefined;
      win.clearTimeout(timer); timer = undefined;
      win.cancelAnimationFrame(rollFrame ?? 0); rollFrame = undefined;
      if (next.enabled) {
        initialRequestContext = notices.accountRevision();
        void notices.refreshPoints();
      }
    }
    options = next;
    paint();
  }, dispose() {
    unsubscribe(); win.clearTimeout(timer); win.cancelAnimationFrame(rollFrame ?? 0); root.remove();
  } };
}
