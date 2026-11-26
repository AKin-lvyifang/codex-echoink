import type { AccountService } from "./account-service";
import type { GiftNotice, GiftReceipt, PointsSummary } from "./types";
import { readDeviceSettings, writeDeviceSettings, type DeviceSettingsPort } from "../sync/device-settings";

const DAY = 86_400_000;
export const STAR_PREFERENCE_KEY = "echoink-workbench-star";
export const GITHUB_STAR_URL = "https://github.com/AKin-lvyifang/codex-echoink";

type NoticeAccount = Pick<AccountService, "noticeAccountId" | "checkInSession" | "subscribe" | "getNotices" | "claimGift" | "getPoints">;
type PromptState = {
  firstSeenAt: number; upgraded: boolean; eligible: boolean; shown: boolean;
  laterCount: number; nextAt: number; clicked: boolean;
  turns: string[]; producedTasks: string[];
};
type Turn = { before: number | undefined; comparable: boolean };
export type PointsFeedback =
  | { kind: "settling"; conversationId: string }
  | { kind: "spent"; conversationId: string; amount: number }
  | { kind: "gift"; amount: number; before?: number };

export function pointsAmount(value: unknown): number | undefined {
  if (typeof value === "string" && /^\d[\d,]*(\.\d+)?$/u.test(value)) value = Number(value.replace(/,/g, ""));
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** One account lane for all workbench views and the desktop composer. */
export class WorkbenchNotices {
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;
  private disposed = false;
  private revision = 0;
  private pointsRevision = 0;
  private owner: string | null = null;
  private session: number | null = null;
  private listFlight?: Promise<void>;
  private pointsFlight?: Promise<PointsSummary | undefined>;
  private claimFlight?: { id: string; promise: Promise<GiftReceipt | undefined> };
  private nextNoticeRead = 0;
  private retryGift?: GiftNotice;
  private gifts: GiftNotice[] = [];
  private openingGifts = false;
  private loaded = false;
  private snapshot?: PointsSummary;
  private receiptBalance?: string;
  private feedback?: PointsFeedback;
  private readonly turns = new Map<string, Turn>();
  private prompt?: PromptState;
  private starOpen = false;
  private errorUntil = 0;

  constructor(
    private readonly account: NoticeAccount,
    private readonly version: string,
    private readonly promptStorage?: { port: DeviceSettingsPort; emptyData: boolean },
    private readonly now = Date.now
  ) {
    if (promptStorage) {
      // Obsidian's local storage can outlive an uninstall. Empty plugin data marks a fresh install.
      const saved = promptStorage.emptyData ? null : readDeviceSettings(promptStorage.port, STAR_PREFERENCE_KEY) as Partial<PromptState> | null;
      const strings = (value: unknown) => Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
      this.prompt = {
        firstSeenAt: pointsAmount(saved?.firstSeenAt) ?? now(), upgraded: saved?.upgraded ?? !promptStorage.emptyData,
        eligible: saved?.eligible === true, shown: saved?.shown === true, laterCount: pointsAmount(saved?.laterCount) ?? 0,
        nextAt: pointsAmount(saved?.nextAt) ?? 0, clicked: saved?.clicked === true,
        turns: strings(saved?.turns), producedTasks: strings(saved?.producedTasks)
      };
      this.persistPrompt();
    }
    this.unsubscribe = account.subscribe(() => this.accountChanged());
    this.accountChanged();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(): void { for (const listener of this.listeners) listener(); }
  private current(revision: number): boolean {
    return !this.disposed && this.revision === revision && this.owner === this.account.noticeAccountId()
      && this.session === this.account.checkInSession();
  }
  private accountChanged(): void {
    const owner = this.account.noticeAccountId(), session = this.account.checkInSession();
    if (owner === this.owner && session === this.session) return;
    ++this.revision; ++this.pointsRevision;
    this.owner = owner; this.session = session;
    this.gifts = []; this.loaded = false; this.nextNoticeRead = 0; this.retryGift = undefined;
    this.snapshot = undefined; this.receiptBalance = undefined; this.feedback = undefined;
    this.claimFlight = undefined; this.listFlight = undefined; this.pointsFlight = undefined;
    this.openingGifts = false; this.starOpen = false; this.turns.clear();
    this.emit();
  }
  refreshNotices(force = false): Promise<void> {
    if (!this.owner || this.disposed) return Promise.resolve();
    if (this.listFlight) return this.listFlight;
    if (this.openingGifts || (!force && this.now() < this.nextNoticeRead)) return Promise.resolve();
    const revision = this.revision;
    this.nextNoticeRead = this.now() + 10_000;
    const request = this.account.getNotices(this.version).then(response => {
      if (!this.current(revision) || this.openingGifts) return;
      const notices = new Map(response.notices.map(notice => [notice.id, notice]));
      if (this.retryGift) notices.set(this.retryGift.id, this.retryGift);
      this.gifts = [...notices.values()];
      this.loaded = true;
      this.emit();
    }).catch(() => undefined).finally(() => {
      if (this.listFlight === request) this.listFlight = undefined;
    });
    this.listFlight = request;
    return request;
  }
  pendingGifts(): readonly GiftNotice[] { return this.gifts; }
  accountRevision(): number { return this.revision; }
  signedIn(): boolean { return !!this.owner; }
  giftSequenceActive(): boolean { return this.openingGifts; }
  beginGiftSequence(): number | undefined {
    if (this.openingGifts || !this.owner || !this.gifts.length) return;
    this.openingGifts = true;
    this.emit();
    return this.revision;
  }
  giftSequenceCurrent(revision: number): boolean { return this.openingGifts && this.current(revision); }
  endGiftSequence(revision: number, completed: boolean): void {
    if (!this.giftSequenceCurrent(revision)) return;
    this.openingGifts = false;
    if (completed && !this.gifts.length && this.prompt?.upgraded && !this.prompt.shown) {
      this.prompt.eligible = true;
      this.persistPrompt();
    }
    this.emit();
  }
  claimGift(notice: GiftNotice, revision: number): Promise<GiftReceipt | undefined> {
    if (!this.giftSequenceCurrent(revision)) return Promise.resolve(undefined);
    if (this.claimFlight) return this.claimFlight.id === notice.id ? this.claimFlight.promise : Promise.resolve(undefined);
    const promise = this.account.claimGift(notice.id, this.version).then<GiftReceipt | undefined>(receipt => {
      if (!this.giftSequenceCurrent(revision)) return;
      this.retryGift = undefined;
      this.gifts = this.gifts.filter(gift => gift.id !== notice.id);
      const before = pointsAmount(this.balance());
      this.receiptBalance = receipt.balance;
      ++this.pointsRevision;
      this.pointsFlight = undefined;
      for (const turn of this.turns.values()) turn.comparable = false;
      if (receipt.granted) this.feedback = { kind: "gift", amount: receipt.points, before };
      this.emit();
      void this.refreshPoints();
      return receipt;
    }).catch(error => {
      if (!this.giftSequenceCurrent(revision)) return undefined;
      this.retryGift = notice;
      throw error;
    }).finally(() => {
      if (this.claimFlight?.promise === promise) this.claimFlight = undefined;
    });
    this.claimFlight = { id: notice.id, promise };
    return promise;
  }

  balance(): string | undefined { return this.receiptBalance ?? this.snapshot?.balance; }
  points(): PointsSummary | undefined { return this.snapshot; }
  visibleBalance(): number | undefined {
    return this.openingGifts && this.feedback?.kind === "gift" && this.feedback.before !== undefined
      ? this.feedback.before : pointsAmount(this.balance());
  }
  pointsFeedback(conversationId: string): PointsFeedback | undefined {
    return this.turns.has(conversationId)
      ? { kind: "settling", conversationId }
      : this.feedback?.kind === "gift" ? (this.openingGifts ? undefined : this.feedback)
        : this.feedback?.conversationId === conversationId ? this.feedback : undefined;
  }
  clearPointsFeedback(feedback: PointsFeedback): void {
    if (this.feedback !== feedback) return;
    this.feedback = undefined;
    this.emit();
  }
  refreshPoints(fresh = false): Promise<PointsSummary | undefined> {
    if (!this.owner || this.disposed) return Promise.resolve(undefined);
    if (!fresh && this.pointsFlight) return this.pointsFlight;
    const ownerRevision = this.revision, revision = ++this.pointsRevision;
    const request = this.account.getPoints().then(data => {
      if (!this.current(ownerRevision) || revision !== this.pointsRevision || pointsAmount(data?.balance) === undefined) return;
      this.snapshot = data;
      this.receiptBalance = undefined;
      this.emit();
      return data;
    }).catch(() => undefined).finally(() => {
      if (this.pointsFlight === request) this.pointsFlight = undefined;
    });
    this.pointsFlight = request;
    return request;
  }
  startCloudTurn(conversationId: string): void {
    if (!this.owner) return;
    const comparable = this.turns.size === 0;
    for (const turn of this.turns.values()) turn.comparable = false;
    this.turns.set(conversationId, { before: pointsAmount(this.balance()), comparable });
    this.feedback = undefined;
    this.emit();
  }
  async finishCloudTurn(conversationId: string): Promise<void> {
    const turn = this.turns.get(conversationId);
    if (!turn) return;
    const summary = await this.refreshPoints(true);
    if (this.turns.get(conversationId) !== turn) return;
    this.turns.delete(conversationId);
    const after = pointsAmount(summary?.balance);
    if (turn.comparable && turn.before !== undefined && after !== undefined && this.feedback?.kind !== "gift") {
      const amount = Math.round((turn.before - after) * 1000) / 1000;
      if (amount >= 0) this.feedback = { kind: "spent", conversationId, amount };
    }
    this.emit();
  }

  recordCompletion(runId: string, taskId: string, answered: boolean, produced: boolean): void {
    const prompt = this.prompt;
    if (!prompt || prompt.eligible || (!answered && !produced) || prompt.turns.includes(runId)) return;
    const threshold = this.now() - prompt.firstSeenAt >= 3 * DAY && (prompt.turns.length >= 10 || prompt.producedTasks.length >= 3);
    if (answered && prompt.turns.length < 10) prompt.turns.push(runId);
    if (produced && prompt.producedTasks.length < 3 && !prompt.producedTasks.includes(taskId)) prompt.producedTasks.push(taskId);
    if (threshold) prompt.eligible = true;
    this.persistPrompt();
    this.emit();
  }
  recordTurnError(): void { this.errorUntil = this.now() + 15_000; this.emit(); }
  starClicked(): boolean {
    return this.prompt?.clicked === true;
  }
  starReadyAt(): number | undefined {
    if (!this.prompt?.eligible || this.starClicked() || this.openingGifts || this.gifts.length ||
      (this.session !== null && (!this.owner || !this.loaded))) return;
    return Math.max(this.prompt.nextAt, this.errorUntil);
  }
  openStar(): boolean {
    const at = this.starReadyAt();
    if (this.starOpen || !this.prompt || at === undefined || at > this.now()) return false;
    this.starOpen = true;
    this.prompt.shown = true;
    this.persistPrompt();
    return true;
  }
  releaseStar(): void { this.starOpen = false; }
  laterStar(): void {
    if (!this.prompt || !this.starOpen) return;
    this.releaseStar();
    this.prompt.laterCount++;
    this.prompt.nextAt = this.now() + 7 * DAY;
    this.persistPrompt();
    this.emit();
  }
  clickStar(): void {
    if (!this.prompt) return;
    this.releaseStar();
    this.prompt.clicked = true;
    this.persistPrompt();
    this.emit();
  }
  private persistPrompt(): void {
    if (this.promptStorage && this.prompt) writeDeviceSettings(this.promptStorage.port, this.prompt, STAR_PREFERENCE_KEY);
  }
  dispose(): void { this.disposed = true; this.unsubscribe(); this.listeners.clear(); }
}
