import { Notice, setIcon } from "obsidian";
import type { WorkbenchNotices } from "../membership/workbench-notices";
import type { GiftNotice, GiftReceipt } from "../membership/types";
import { ownedEl } from "./owned-dom";
import type { MobileShellSheet } from "./mobile/shell-types";

type GiftSheet = { openSheet(sheet: MobileShellSheet): void; closeSheet(): boolean };

function giftCopy(gift: GiftNotice, english: boolean): { title: string; desc: string } {
  if (english && gift.title === "签到补发") return {
    title: "Check-in credit adjustment", desc: "Check-ins before 2.9 have been credited."
  };
  if (english && gift.title === "2.9.5 更新礼物") return {
    title: "2.9.5 update gift", desc: "Thank you for continuing to use EchoInk."
  };
  return gift;
}

export function giftTriggerLabel(language: string): string { return language === "en" ? "Claim gift" : "领取礼物"; }

export function mountWorkbenchGifts(
  trigger: HTMLButtonElement,
  notices: WorkbenchNotices,
  options: { language: () => string; visible: () => boolean; mobileSheet?: GiftSheet },
): { refresh(): void; dispose(): void } {
  const document = trigger.ownerDocument, win = document.defaultView!;
  const dot = trigger.createSpan({ cls: "echoink-gift-dot", attr: { "aria-hidden": "true" } });
  trigger.classList.add("echoink-gift-trigger");
  let disposed = false;
  let revision: number | undefined;
  let closeCard: (() => void) | undefined;
  let cancelConfetti: (() => void) | undefined;
  let content: HTMLElement | undefined;
  let accountContext: number | undefined;
  let observer: IntersectionObserver | undefined;

  const refresh = () => {
    if (disposed) return;
    sync();
    if (options.visible()) void notices.refreshNotices();
  };
  const sync = () => {
    if (revision !== undefined && !notices.giftSequenceCurrent(revision)) {
      revision = undefined;
      closeCard?.();
      cancelConfetti?.();
    }
    trigger.hidden = !notices.pendingGifts().length && revision === undefined;
    trigger.disabled = notices.giftSequenceActive();
    trigger.classList.toggle("is-opening", revision !== undefined);
    dot.hidden = trigger.hidden;
  };
  accountContext = notices.accountRevision();
  const unsubscribe = notices.subscribe(() => {
    if (accountContext !== notices.accountRevision()) {
      accountContext = notices.accountRevision();
      refresh();
    } else sync();
  });

  function showCard(gift: GiftNotice, receipt: GiftReceipt): void {
    const english = options.language() === "en";
    const copy = giftCopy(gift, english);
    const panel = ownedEl(document, "div"); panel.className = "echoink-gift-card";
    content = panel;
    const badge = panel.createDiv({ cls: "echoink-gift-card-badge", attr: { "aria-hidden": "true" } });
    setIcon(badge, "gift");
    if (!options.mobileSheet) {
      const close = panel.createEl("button", { cls: "echoink-gift-close", attr: { type: "button", "aria-label": english ? "Close" : "关闭" } });
      setIcon(close, "x");
      close.onclick = () => closeCard?.();
      panel.createDiv({ cls: "echoink-gift-title", text: copy.title });
    }
    const amount = panel.createDiv({ cls: "echoink-gift-amount" });
    amount.createEl("strong", { text: "+" + new Intl.NumberFormat(english ? "en" : "zh-CN").format(receipt.points) });
    amount.createSpan({ text: english ? "AI points" : "AI 点数" });
    panel.createDiv({ cls: "echoink-gift-description", text: copy.desc });
    const facts = panel.createDiv({ cls: "echoink-gift-facts" });
    for (const [label, value] of [
      [english ? "Balance" : "到账后余额", english ? `${receipt.balance} pts` : `${receipt.balance} 点`],
      [english ? "Expires on" : "有效期至", new Date(receipt.expiresAt).toLocaleDateString(english ? "en" : "zh-CN")]
    ]) {
      const row = facts.createDiv({ cls: "echoink-gift-fact" });
      row.createSpan({ text: label }); row.createEl("strong", { text: value });
    }
    const actions = panel.createDiv({ cls: "echoink-gift-actions" });
    const more = notices.pendingGifts().length;
    if (more) actions.createSpan({ text: english ? `${more} more` : `还有 ${more} 份` });
    const accept = actions.createEl("button", { cls: "mod-cta echoink-gift-accept", text: english ? "Done" : "收下", attr: { type: "button" } });
    accept.onclick = () => closeCard?.();

    const closed = () => {
      closeCard = undefined; content = undefined;
      if (revision !== undefined && notices.giftSequenceCurrent(revision)) void next();
    };
    const sheet = options.mobileSheet;
    if (sheet) {
      closeCard = () => { sheet.closeSheet(); };
      sheet.openSheet({ title: copy.title, content: panel, onClose: closed });
      panel.closest(".echoink-shell-sheet")?.classList.add("echoink-gift-sheet");
      return;
    }
    const dialog = ownedEl(document, "dialog");
    dialog.className = "echoink-gift-dialog";
    dialog.setAttribute("aria-label", copy.title);
    dialog.append(panel);
    document.body.append(dialog);
    const dismiss = () => {
      dialog.remove();
      closed();
    };
    dialog.addEventListener("close", dismiss, { once: true });
    dialog.addEventListener("click", event => { if (event.target === dialog) dialog.close(); });
    closeCard = () => dialog.close();
    try {
      dialog.showModal();
      accept.focus();
    } catch {
      dialog.remove();
      closeCard = undefined;
      content = undefined;
      finish(false);
    }
  }

  function finish(completed: boolean): void {
    const current = revision;
    revision = undefined;
    if (current !== undefined) notices.endGiftSequence(current, completed);
    sync();
    if (!trigger.hidden && trigger.isConnected) trigger.focus({ preventScroll: true });
  }

  async function next(animation = Promise.resolve()): Promise<void> {
    const current = revision;
    if (current === undefined || disposed || !notices.giftSequenceCurrent(current)) return;
    const gift = notices.pendingGifts()[0];
    if (!gift || !options.visible()) { finish(!gift); return; }
    try {
      const [receipt] = await Promise.all([notices.claimGift(gift, current), animation]);
      if (!receipt || disposed || !notices.giftSequenceCurrent(current)) return;
      if (!options.visible()) { finish(false); return; }
      showCard(gift, receipt);
    } catch {
      finish(false);
      if (options.visible()) new Notice(options.language() === "en" ? "Could not claim the gift. Select it to try again." : "礼物未能领取。请点击礼物重试。");
    }
  }
  const open = () => {
    if (disposed || !options.visible()) return;
    revision = notices.beginGiftSequence();
    if (revision === undefined) return;
    sync();
    const confetti = options.mobileSheet ? undefined : playGiftConfetti(trigger);
    cancelConfetti = confetti ? () => confetti.cancel() : undefined;
    void next(confetti?.ready);
  };
  trigger.addEventListener("click", open);
  if (options.mobileSheet && win.IntersectionObserver) {
    observer = new win.IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) refresh(); });
    observer.observe(trigger.parentElement!);
    win.addEventListener("focus", refresh);
  }
  refresh();
  return { refresh, dispose() {
    disposed = true;
    observer?.disconnect();
    win.removeEventListener("focus", refresh);
    unsubscribe();
    trigger.removeEventListener("click", open);
    cancelConfetti?.();
    const current = revision; revision = undefined;
    if (content?.isConnected) closeCard?.();
    if (current !== undefined) notices.endGiftSequence(current, false);
  } };
}

function playGiftConfetti(trigger: HTMLElement): { ready: Promise<void>; cancel(): void } | undefined {
  const document = trigger.ownerDocument, win = document.defaultView!;
  if (win.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const canvas = ownedEl(document, "canvas");
  const context = canvas.getContext("2d");
  if (!context) return;
  const rect = trigger.getBoundingClientRect();
  const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
  const width = win.innerWidth, height = win.innerHeight, ratio = Math.min(2, win.devicePixelRatio);
  canvas.className = "echoink-gift-confetti";
  canvas.setAttribute("aria-hidden", "true");
  canvas.width = width * ratio; canvas.height = height * ratio;
  context.scale(ratio, ratio);
  document.body.append(canvas);
  const colors = ["#f2b134", "#e8615a", "#5aa9e6", "#6cc39a", "#b68be8", "#f28ab2"];
  const pieces = Array.from({ length: 96 }, (_, index) => ({
    vx: (index % 2 ? 1 : -1) * (3 + Math.random() * 10), vy: -(2 + Math.random() * 10),
    x, y, angle: Math.random() * Math.PI, spin: (Math.random() - .5) * .35,
    width: 4 + Math.random() * 5, height: 6 + Math.random() * 7,
    color: colors[index % colors.length], dot: index % 4 === 0
  }));
  const started = win.performance.now(); let last = started, frame = 0;
  let resolve!: () => void;
  const ready = new Promise<void>(done => { resolve = done; });
  const cleanup = () => { win.cancelAnimationFrame(frame); canvas.remove(); resolve(); };
  function draw(time: number): void {
    const elapsed = time - started;
    if (elapsed >= 1450 || document.hidden) { cleanup(); return; }
    const step = Math.min(2, (time - last) / 16.7); last = time;
    context!.clearRect(0, 0, width, height);
    context!.globalAlpha = 1 - elapsed / 1450;
    for (const piece of pieces) {
      piece.vy += .32 * step; piece.vx *= 1 - .015 * step;
      piece.x += piece.vx * step; piece.y += piece.vy * step; piece.angle += piece.spin * step;
      context!.save(); context!.translate(piece.x, piece.y); context!.rotate(piece.angle); context!.fillStyle = piece.color;
      if (piece.dot) { context!.beginPath(); context!.arc(0, 0, piece.width / 2, 0, Math.PI * 2); context!.fill(); }
      else context!.fillRect(-piece.width / 2, -piece.height / 2, piece.width, piece.height);
      context!.restore();
    }
    if (elapsed >= 580) resolve();
    frame = win.requestAnimationFrame(draw);
  }
  frame = win.requestAnimationFrame(draw);
  return { ready, cancel: cleanup };
}
