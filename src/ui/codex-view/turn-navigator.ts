/**
 * turn-navigator.ts — in-conversation turn navigation: a micro tick column on
 * the right edge of the chat shell with hover magnification, a preview
 * popover, click-to-jump and scroll-linked current-turn tracking. One tick
 * per real user message; the paired reply is the first visible assistant
 * answer before the next user message.
 */
import type { ChatMessage, SettingsLanguage } from "../../settings/settings";
import { isAgentAnswerMessage } from "./agent-turn-process";
import type { CodexMessageHost } from "./message-controller";
import { conversationUiText } from "./ui-i18n";

export interface ConversationTurn {
  messageId: string;
  userLabel: string;
  replyLabel: string;
  replyState: "none" | "streaming" | "done";
}

const TURN_TICK_SLOT_PX = 12;
const TURN_TICK_BASE_WIDTH_PX = 9;
const TURN_TICK_CURRENT_WIDTH_PX = 15;
const TURN_TICK_MAX_WIDTH_PX = 26;
const TURN_MAGNIFY_SIGMA_PX = 30;
const TURN_MAGNIFY_RANGE_PX = 84;
const TURN_PREVIEW_HIDE_DELAY_MS = 180;
const TURN_JUMP_TOP_OFFSET_PX = 12;
const TURN_JUMP_DURATION_MS = 260;
const TURN_READ_LINE_OFFSET_PX = 28;
const TURN_PREVIEW_WIDTH_MAX_PX = 320;
const TURN_PREVIEW_WIDTH_MIN_PX = 180;
const TURN_TRACK_MIN_HEIGHT_PX = 96;
const TURN_TRACK_SHELL_RATIO = 0.62;
const TURN_COMPACT_SHELL_WIDTH_PX = 420;

export function conversationTurnVisibleText(message: ChatMessage): string {
  return collapseWhitespace(message.text) || collapseWhitespace(message.previewText);
}

export function buildConversationTurns(
  messages: readonly ChatMessage[],
  running: boolean,
  language: SettingsLanguage
): ConversationTurn[] {
  let lastUserIndex = -1;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") {
      lastUserIndex = index;
      break;
    }
  }
  const turns: ConversationTurn[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (message.role !== "user") continue;
    let replyLabel = "";
    for (let cursor = index + 1; cursor < messages.length; cursor += 1) {
      const candidate = messages[cursor];
      if (candidate.role === "user") break;
      if (!isAgentAnswerMessage(candidate)) continue;
      const text = conversationTurnVisibleText(candidate);
      if (!text) continue;
      replyLabel = text;
      break;
    }
    const streaming = running && index === lastUserIndex;
    turns.push({
      messageId: message.id,
      userLabel: conversationTurnVisibleText(message) || conversationTurnAttachmentLabel(message, language),
      replyLabel,
      replyState: streaming ? "streaming" : replyLabel ? "done" : "none"
    });
  }
  return turns;
}

function conversationTurnAttachmentLabel(message: ChatMessage, language: SettingsLanguage): string {
  const attachmentName = message.attachments?.[0]?.name?.trim();
  if (attachmentName) return attachmentName;
  if (message.images?.length) return conversationUiText(language, "图片消息", "Image message");
  if (message.attachments?.length) return conversationUiText(language, "附件消息", "Attachment message");
  return conversationUiText(language, "空消息", "Empty message");
}

function collapseWhitespace(text: string | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export class TurnNavigator {
  private readonly shellEl: HTMLElement;
  private readonly navEl: HTMLElement;
  private readonly trackEl: HTMLElement;
  private readonly previewEl: HTMLElement;
  private readonly previewUserEl: HTMLElement;
  private readonly previewReplyEl: HTMLElement;
  private readonly previewStatusEl: HTMLElement;

  private turns: ConversationTurn[] = [];
  private tickEls: HTMLElement[] = [];
  private ticksSignature = "";
  private currentIndex = -1;
  private hoverIndex = -1;
  private focusIndex = -1;
  private previewIndex = -1;
  private previewVisible = false;
  private hideTimer: number | null = null;
  private scrollFrame = 0;
  private scrollAnimation = 0;
  private userInterruptedScroll = false;
  private moveFrame = 0;
  private pendingMoveY = 0;
  private readonly magnifiedTicks = new Set<HTMLElement>();
  private readonly detachListeners: Array<() => void> = [];
  private resizeObserver: ResizeObserver | null = null;
  private modelSessionId = "";
  private modelFingerprint = "";
  private disposed = false;

  constructor(
    private readonly host: CodexMessageHost,
    private readonly mountEl: HTMLElement
  ) {
    this.shellEl = mountEl.parentElement ?? host.messagesEl.parentElement ?? mountEl;
    this.navEl = mountEl.createDiv({ cls: "codex-turn-nav" });
    this.navEl.setAttribute("tabindex", "0");
    this.navEl.setAttribute("role", "listbox");
    this.trackEl = this.navEl.createDiv({ cls: "codex-turn-nav-track" });
    this.previewEl = mountEl.createDiv({ cls: "codex-turn-nav-preview" });
    this.previewEl.setAttribute("role", "tooltip");
    this.previewUserEl = this.previewEl.createDiv({ cls: "codex-turn-nav-preview-user" });
    this.previewReplyEl = this.previewEl.createDiv({ cls: "codex-turn-nav-preview-reply" });
    this.previewStatusEl = this.previewEl.createDiv({ cls: "codex-turn-nav-preview-status" });

    this.on(this.navEl, "mouseenter", () => this.cancelHide());
    this.on(this.navEl, "mouseleave", () => {
      this.clearMagnify();
      this.scheduleHide();
    });
    this.on(this.navEl, "mousemove", (event) => {
      const rect = this.trackEl.getBoundingClientRect();
      this.scheduleMove(event.clientY - rect.top + this.trackEl.scrollTop);
    });
    this.on(this.navEl, "wheel", (event) => {
      if (this.trackEl.scrollHeight > this.trackEl.clientHeight + 4) {
        this.trackEl.scrollTop += event.deltaY;
      } else {
        this.host.messagesEl.scrollTop += event.deltaY;
      }
      event.preventDefault();
      event.stopPropagation();
    });
    this.on(this.navEl, "click", (event) => {
      const tick = (event.target as HTMLElement | null)?.closest<HTMLElement>(".codex-turn-nav-tick");
      const index = tick ? Number(tick.dataset.index) : NaN;
      if (Number.isInteger(index)) this.jumpToTurn(index);
    });
    this.on(this.navEl, "keydown", (event) => this.handleKeyDown(event));
    this.on(this.navEl, "focus", () => {
      if (this.turns.length < 2) return;
      this.cancelHide();
      this.focusIndex = this.currentIndex >= 0 ? this.currentIndex : 0;
      this.setHover(this.focusIndex);
      this.showPreview(this.focusIndex);
      this.ensureTickVisible(this.focusIndex);
    });
    this.on(this.navEl, "blur", () => {
      this.focusIndex = -1;
      this.clearMagnify();
      this.scheduleHide();
    });
    this.on(this.previewEl, "mouseenter", () => this.cancelHide());
    this.on(this.previewEl, "mouseleave", () => this.scheduleHide());
    this.on(this.previewEl, "click", () => {
      if (this.previewIndex >= 0) this.jumpToTurn(this.previewIndex);
    });
    this.on(this.previewEl, "wheel", (event) => {
      this.host.messagesEl.scrollTop += event.deltaY;
      event.preventDefault();
      event.stopPropagation();
    });
    const interruptJump = (): void => {
      this.userInterruptedScroll = true;
      if (this.scrollAnimation) {
        window.cancelAnimationFrame(this.scrollAnimation);
        this.scrollAnimation = 0;
      }
    };
    this.on(this.host.messagesEl, "wheel", interruptJump);
    this.on(this.host.messagesEl, "touchstart", interruptJump);

    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.layout());
      this.resizeObserver.observe(this.shellEl);
    }
    this.syncModel(true);
    this.layout();
    this.updateCurrent();
  }

  /** Called after every message list render: refresh turns, ticks and preview copy. */
  handleRender(): void {
    if (this.disposed) return;
    this.syncModel(false);
    this.layout();
    this.updateCurrent();
    if (this.previewVisible && this.previewIndex >= 0) this.showPreview(this.previewIndex);
  }

  /** Called on chat scroll: keep the current reading tick in sync. */
  handleScroll(): void {
    if (this.disposed || this.scrollFrame) return;
    this.scrollFrame = window.requestAnimationFrame(() => {
      this.scrollFrame = 0;
      this.updateCurrent();
    });
  }

  refreshLanguage(): void {
    if (this.disposed) return;
    this.navEl.setAttribute("aria-label", this.navAriaLabel());
    this.tickEls.forEach((tick, index) => tick.setAttribute("aria-label", this.tickAriaLabel(index)));
    if (this.previewVisible && this.previewIndex >= 0) this.showPreview(this.previewIndex);
  }

  dispose(): void {
    this.disposed = true;
    if (this.hideTimer !== null) window.clearTimeout(this.hideTimer);
    this.hideTimer = null;
    if (this.scrollFrame) window.cancelAnimationFrame(this.scrollFrame);
    if (this.scrollAnimation) window.cancelAnimationFrame(this.scrollAnimation);
    this.scrollFrame = 0;
    this.moveFrame = 0;
    this.scrollAnimation = 0;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    for (const detach of this.detachListeners) detach();
    this.detachListeners.length = 0;
    this.mountEl.empty();
  }

  // -------------------------------------------------------------------------
  // model
  // -------------------------------------------------------------------------

  private syncModel(force: boolean): void {
    const session = this.host.ensureSession();
    const messages = session.messages;
    const last = messages[messages.length - 1];
    const fingerprint = [
      session.id,
      messages.length,
      last?.id ?? "",
      last?.text.length ?? 0,
      this.host.running ? 1 : 0
    ].join("|");
    if (!force && fingerprint === this.modelFingerprint) return;
    const sessionChanged = session.id !== this.modelSessionId;
    this.modelFingerprint = fingerprint;
    this.modelSessionId = session.id;
    this.turns = buildConversationTurns(messages, this.host.running, this.language());
    if (sessionChanged) {
      this.currentIndex = -1;
      this.hoverIndex = -1;
      this.focusIndex = -1;
      this.hidePreview(true);
      this.clearMagnify();
      this.trackEl.scrollTop = 0;
    }
    this.syncTicks();
    const tooFew = this.turns.length < 2;
    this.mountEl.hidden = tooFew;
    if (tooFew) this.hidePreview(true);
  }

  private syncTicks(): void {
    const signature = this.turns.map((turn) => turn.messageId).join(",");
    if (signature !== this.ticksSignature) {
      this.ticksSignature = signature;
      this.trackEl.empty();
      this.tickEls = [];
      this.magnifiedTicks.clear();
      this.turns.forEach((_turn, index) => {
        const tick = this.trackEl.createDiv({ cls: "codex-turn-nav-tick" });
        tick.dataset.index = String(index);
        tick.setAttribute("role", "option");
        this.tickEls.push(tick);
      });
    }
    this.navEl.setAttribute("aria-label", this.navAriaLabel());
    this.tickEls.forEach((tick, index) => {
      tick.setAttribute("aria-label", this.tickAriaLabel(index));
      tick.setAttribute("aria-selected", String(index === this.currentIndex));
      tick.toggleClass("is-current", index === this.currentIndex);
    });
  }

  // -------------------------------------------------------------------------
  // layout & current turn
  // -------------------------------------------------------------------------

  private layout(): void {
    const shellHeight = this.shellEl.clientHeight;
    const shellWidth = this.shellEl.clientWidth;
    this.shellEl.toggleClass("is-compact", shellWidth > 0 && shellWidth < TURN_COMPACT_SHELL_WIDTH_PX);
    if (shellHeight > 0) {
      const trackMax = clamp(
        Math.round(shellHeight * TURN_TRACK_SHELL_RATIO),
        TURN_TRACK_MIN_HEIGHT_PX,
        Math.max(TURN_TRACK_MIN_HEIGHT_PX, this.turns.length * TURN_TICK_SLOT_PX)
      );
      this.trackEl.style.maxHeight = `${trackMax}px`;
    }
    if (shellWidth > 0) {
      const width = clamp(shellWidth - 72, TURN_PREVIEW_WIDTH_MIN_PX, TURN_PREVIEW_WIDTH_MAX_PX);
      this.previewEl.style.width = `${width}px`;
    }
    if (this.previewVisible && this.previewIndex >= 0) this.positionPreview(this.previewIndex);
    if (this.shellEl.clientHeight > 0) this.updateCurrent();
  }

  private updateCurrent(): void {
    if (this.turns.length < 2) {
      this.setCurrent(-1);
      return;
    }
    const messagesEl = this.host.messagesEl;
    let index: number;
    if (this.host.messageListRenderer.isNearBottom(messagesEl, this.host.virtualListEl)) {
      index = this.turns.length - 1;
    } else {
      const tops = this.host.messageListRenderer.rowTopsForRowIds(
        this.turns.map((turn) => `message:${turn.messageId}`)
      );
      const line = messagesEl.scrollTop + TURN_READ_LINE_OFFSET_PX;
      index = 0;
      for (let cursor = 0; cursor < this.turns.length; cursor += 1) {
        const top = tops.get(`message:${this.turns[cursor].messageId}`);
        if (top === undefined) continue;
        if (top <= line) index = cursor;
        else break;
      }
    }
    this.setCurrent(index);
  }

  private setCurrent(index: number): void {
    if (index === this.currentIndex) return;
    const previous = this.tickEls[this.currentIndex];
    if (previous) {
      previous.toggleClass("is-current", false);
      previous.setAttribute("aria-selected", "false");
    }
    this.currentIndex = index;
    const tick = this.tickEls[index];
    if (tick) {
      tick.toggleClass("is-current", true);
      tick.setAttribute("aria-selected", "true");
    }
    if (this.hoverIndex < 0 && index >= 0) this.centerTrackOn(index);
  }

  private centerTrackOn(index: number): void {
    const track = this.trackEl;
    if (track.scrollHeight <= track.clientHeight + 4) return;
    const center = index * TURN_TICK_SLOT_PX + TURN_TICK_SLOT_PX / 2;
    track.scrollTop = clamp(center - track.clientHeight / 2, 0, track.scrollHeight - track.clientHeight);
  }

  private ensureTickVisible(index: number): void {
    const track = this.trackEl;
    if (track.scrollHeight <= track.clientHeight + 4) return;
    const top = index * TURN_TICK_SLOT_PX;
    const bottom = top + TURN_TICK_SLOT_PX;
    if (top < track.scrollTop) track.scrollTop = top;
    else if (bottom > track.scrollTop + track.clientHeight) track.scrollTop = bottom - track.clientHeight;
  }

  // -------------------------------------------------------------------------
  // hover magnification
  // -------------------------------------------------------------------------

  private scheduleMove(y: number): void {
    this.pendingMoveY = y;
    if (this.moveFrame) return;
    this.moveFrame = window.requestAnimationFrame(() => {
      this.moveFrame = 0;
      this.applyMagnify(this.pendingMoveY);
    });
  }

  private applyMagnify(y: number): void {
    if (this.turns.length < 2) return;
    this.cancelHide();
    const index = clamp(Math.floor(y / TURN_TICK_SLOT_PX), 0, this.turns.length - 1);
    if (index !== this.hoverIndex) {
      this.setHover(index);
      this.showPreview(index);
    }
    this.tickEls.forEach((tick, tickIndex) => {
      const distance = Math.abs(tickIndex * TURN_TICK_SLOT_PX + TURN_TICK_SLOT_PX / 2 - y);
      if (distance > TURN_MAGNIFY_RANGE_PX) {
        if (this.magnifiedTicks.delete(tick)) {
          tick.style.removeProperty("--tick-w");
          tick.style.removeProperty("--tick-o");
        }
        return;
      }
      const falloff = Math.exp(-(distance * distance) / (2 * TURN_MAGNIFY_SIGMA_PX * TURN_MAGNIFY_SIGMA_PX));
      const base = tickIndex === this.currentIndex ? TURN_TICK_CURRENT_WIDTH_PX : TURN_TICK_BASE_WIDTH_PX;
      tick.style.setProperty("--tick-w", `${(base + (TURN_TICK_MAX_WIDTH_PX - base) * falloff).toFixed(1)}px`);
      tick.style.setProperty("--tick-o", `${(0.72 + 0.28 * falloff).toFixed(2)}`);
      this.magnifiedTicks.add(tick);
    });
  }

  private setHover(index: number): void {
    if (index === this.hoverIndex) return;
    const previous = this.tickEls[this.hoverIndex];
    if (previous) previous.toggleClass("is-hover", false);
    this.hoverIndex = index;
    const tick = this.tickEls[index];
    if (tick) tick.toggleClass("is-hover", true);
  }

  private clearMagnify(): void {
    for (const tick of this.magnifiedTicks) {
      tick.style.removeProperty("--tick-w");
      tick.style.removeProperty("--tick-o");
    }
    this.magnifiedTicks.clear();
    this.setHover(-1);
  }

  // -------------------------------------------------------------------------
  // preview popover
  // -------------------------------------------------------------------------

  private showPreview(index: number): void {
    const turn = this.turns[index];
    if (!turn) return;
    this.previewIndex = index;
    const language = this.language();
    this.previewUserEl.setText(turn.userLabel);
    if (turn.replyLabel) {
      this.previewReplyEl.setText(turn.replyLabel);
      this.previewReplyEl.hidden = false;
    } else {
      this.previewReplyEl.setText("");
      this.previewReplyEl.hidden = true;
    }
    if (turn.replyState === "streaming") {
      this.previewStatusEl.setText(conversationUiText(language, "生成中…", "Generating…"));
      this.previewStatusEl.hidden = false;
    } else if (turn.replyState === "none") {
      this.previewStatusEl.setText(conversationUiText(language, "尚无回复", "No reply yet"));
      this.previewStatusEl.hidden = false;
    } else {
      this.previewStatusEl.setText("");
      this.previewStatusEl.hidden = true;
    }
    this.previewVisible = true;
    this.previewEl.addClass("is-visible");
    this.positionPreview(index);
  }

  private positionPreview(index: number): void {
    const tick = this.tickEls[index];
    if (!tick) return;
    const shellRect = this.shellEl.getBoundingClientRect();
    const mountRect = this.mountEl.getBoundingClientRect();
    const tickRect = tick.getBoundingClientRect();
    const centerY = tickRect.top + tickRect.height / 2 - shellRect.top;
    const height = this.previewEl.offsetHeight || 64;
    const shellTop = clamp(centerY - height / 2, 8, Math.max(8, shellRect.height - height - 8));
    this.previewEl.style.top = `${shellTop - (mountRect.top - shellRect.top)}px`;
  }

  private scheduleHide(): void {
    this.cancelHide();
    this.hideTimer = window.setTimeout(() => {
      this.hideTimer = null;
      this.hidePreview(false);
    }, TURN_PREVIEW_HIDE_DELAY_MS);
  }

  private cancelHide(): void {
    if (this.hideTimer !== null) window.clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }

  private hidePreview(immediate: boolean): void {
    this.cancelHide();
    this.previewVisible = false;
    this.previewIndex = -1;
    this.previewEl.removeClass("is-visible");
    if (immediate) {
      this.previewUserEl.setText("");
      this.previewReplyEl.setText("");
      this.previewStatusEl.setText("");
    }
  }

  // -------------------------------------------------------------------------
  // jump & keyboard
  // -------------------------------------------------------------------------

  private jumpToTurn(index: number): void {
    const turn = this.turns[index];
    if (!turn) return;
    const top = this.host.messageListRenderer.rowTopForRowId(`message:${turn.messageId}`);
    if (top === null) {
      this.syncModel(true);
      return;
    }
    this.animateScrollTo(Math.max(0, top - TURN_JUMP_TOP_OFFSET_PX));
    this.setCurrent(index);
  }

  /**
   * Virtual-list renders restore scrollTop on every frame, which aborts native
   * smooth scrolling; drive the jump manually so it survives those restores.
   */
  private animateScrollTo(target: number): void {
    const messagesEl = this.host.messagesEl;
    if (this.scrollAnimation) window.cancelAnimationFrame(this.scrollAnimation);
    this.scrollAnimation = 0;
    this.userInterruptedScroll = false;
    const start = messagesEl.scrollTop;
    const delta = target - start;
    if (this.prefersReducedMotion() || Math.abs(delta) < 2) {
      messagesEl.scrollTop = target;
      return;
    }
    const startedAt = performance.now();
    const step = (now: number): void => {
      this.scrollAnimation = 0;
      if (this.userInterruptedScroll) return;
      const progress = clamp((now - startedAt) / TURN_JUMP_DURATION_MS, 0, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      messagesEl.scrollTop = start + delta * eased;
      if (progress < 1) this.scrollAnimation = window.requestAnimationFrame(step);
    };
    this.scrollAnimation = window.requestAnimationFrame(step);
  }

  private handleKeyDown(event: KeyboardEvent): void {
    if (this.turns.length < 2) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      const base = this.focusIndex >= 0 ? this.focusIndex : this.currentIndex >= 0 ? this.currentIndex : 0;
      const next = clamp(base + (event.key === "ArrowDown" ? 1 : -1), 0, this.turns.length - 1);
      this.focusIndex = next;
      this.cancelHide();
      this.setHover(next);
      this.showPreview(next);
      this.ensureTickVisible(next);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      const target = this.focusIndex >= 0 ? this.focusIndex : this.currentIndex;
      if (target >= 0) this.jumpToTurn(target);
      this.hidePreview(true);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      this.hidePreview(true);
    }
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  private language(): SettingsLanguage {
    return this.host.plugin.settings.settingsLanguage;
  }

  private navAriaLabel(): string {
    return conversationUiText(this.language(), "会话轮次导航", "Conversation turn navigation");
  }

  private tickAriaLabel(index: number): string {
    const turn = this.turns[index];
    if (!turn) return "";
    return conversationUiText(
      this.language(),
      `第 ${index + 1} 轮：${turn.userLabel}`,
      `Turn ${index + 1}: ${turn.userLabel}`
    );
  }

  private prefersReducedMotion(): boolean {
    return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  private on<K extends keyof HTMLElementEventMap>(
    target: HTMLElement,
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void
  ): void {
    target.addEventListener(type, handler);
    this.detachListeners.push(() => target.removeEventListener(type, handler));
  }
}
