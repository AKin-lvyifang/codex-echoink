import type { DesktopNotificationMessage, DesktopNotificationPort, DesktopNotificationResult } from "../plugin/desktop-notifications";
import type { ParsedTodoRecord } from "./todo-markdown";
import { isTodoDueTime, todoDueAt, todoReminderKey } from "./todo-due";

export interface TodoReminderSettings {
  enabled: boolean;
  /** Successfully sent task-id/local-deadline pairs, stored in plugin settings. */
  sent: Record<string, number>;
}

export function normalizeTodoReminders(value: unknown): TodoReminderSettings {
  const raw = value && typeof value === "object" ? value as Partial<TodoReminderSettings> : {};
  const sent: Record<string, number> = {};
  if (raw.sent && typeof raw.sent === "object" && !Array.isArray(raw.sent)) {
    for (const [key, timestamp] of Object.entries(raw.sent)) {
      if (!Number.isFinite(timestamp) || timestamp <= 0) continue;
      try {
        const pair: unknown = JSON.parse(key);
        if (!Array.isArray(pair) || pair.length !== 3 || pair.some((part) => typeof part !== "string")) continue;
        const [id, dueDate, dueTime] = pair as string[];
        if (id && isTodoDueTime(dueTime) && todoDueAt({ dueDate, dueTime }) !== null) sent[key] = timestamp;
      } catch { /* Invalid persisted entries are ignored. */ }
    }
  }
  return { enabled: raw.enabled === true, sent };
}

export function dueTodoReminders(records: readonly ParsedTodoRecord[], sent: Readonly<Record<string, number>>, now: number): ParsedTodoRecord[] {
  const seen = new Set<string>();
  return records.filter((record) => {
    const key = todoReminderKey(record);
    const due = todoDueAt(record);
    if (record.done || !key || due === null || due > now || sent[key] !== undefined || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function todoReminderMessage(records: readonly ParsedTodoRecord[], english: boolean): DesktopNotificationMessage {
  const title = records.length === 1
    ? (english ? "EchoInk · To-do due" : "EchoInk · 待办到期")
    : (english ? `EchoInk · ${records.length} to-dos due` : `EchoInk · ${records.length} 条待办已到期`);
  const lines = records.slice(0, 3).map((record) => `${record.title.slice(0, 120)} · ${record.dueDate} ${record.dueTime || "09:00"}`);
  if (records.length > 3) lines.push(english ? `…and ${records.length - 3} more` : `另有 ${records.length - 3} 条`);
  return { title, body: lines.join("\n") };
}

export type TodoReminderFailure = "read" | "send" | "unconfirmed" | "persistence" | "";
export interface TodoReminderSchedulerOptions {
  settings: () => TodoReminderSettings;
  readRecords: () => Promise<readonly ParsedTodoRecord[]>;
  persist: () => Promise<void>;
  notifications: DesktopNotificationPort;
  english: () => boolean;
  report: (failure: TodoReminderFailure) => void;
  now: () => number;
  setTimeout: (callback: () => void, delay: number) => number;
  clearTimeout: (timer: number) => void;
}

/** One scan/send/save at a time, with one bounded timer for sleep/clock recovery. */
export class TodoReminderScheduler {
  private active = false;
  private generation = 0;
  private timer: number | null = null;
  private flight: Promise<void> | null = null;
  private persistencePending = false;

  constructor(private readonly options: TodoReminderSchedulerOptions) {}

  start(): void {
    if (this.active || !this.options.settings().enabled) return;
    this.active = true;
    this.generation++;
    this.schedule(0);
  }

  stop(): void {
    this.active = false;
    this.generation++;
    if (this.timer !== null) this.options.clearTimeout(this.timer);
    this.timer = null;
    this.options.notifications.cancelPending();
  }

  sourceChanged(): void { if (this.active) this.schedule(250); }
  resume(): void { if (this.active) this.schedule(0); }

  private schedule(delay: number): void {
    if (!this.active || !this.options.settings().enabled) return;
    if (this.timer !== null) this.options.clearTimeout(this.timer);
    this.timer = this.options.setTimeout(() => {
      this.timer = null;
      void this.checkNow();
    }, delay);
  }

  checkNow(): Promise<void> {
    if (this.flight) return this.flight;
    const generation = this.generation;
    let nextDelay = 60_000;
    const run = this.scan(generation, (delay) => { nextDelay = delay; });
    this.flight = run.finally(() => {
      this.flight = null;
      if (this.active) this.schedule(nextDelay);
    });
    return this.flight;
  }

  private live(generation: number): boolean {
    return this.active && generation === this.generation && this.options.settings().enabled;
  }

  private async scan(generation: number, next: (delay: number) => void): Promise<void> {
    if (!this.live(generation)) return;
    if (this.persistencePending) {
      try { await this.options.persist(); this.persistencePending = false; }
      catch { this.options.report("persistence"); return; }
    }
    if (!this.live(generation) || this.options.notifications.permission() !== "granted") return;
    let records: readonly ParsedTodoRecord[];
    try { records = await this.options.readRecords(); }
    catch { if (this.live(generation)) this.options.report("read"); return; }
    if (!this.live(generation)) return;
    const now = this.options.now();
    const candidates = dueTodoReminders(records, this.options.settings().sent, now);
    let delay = 60_000;
    for (const record of records) {
      if (record.done) continue;
      const due = todoDueAt(record);
      if (due !== null && due > now) delay = Math.min(delay, Math.max(1, due - now));
    }
    next(delay);
    if (!candidates.length) { this.options.report(""); return; }
    let result: DesktopNotificationResult;
    try { result = await this.options.notifications.send(todoReminderMessage(candidates, this.options.english())); }
    catch { if (this.live(generation)) this.options.report("send"); return; }
    if (!result.ok) {
      if (this.live(generation) && !result.cancelled) this.options.report(result.error === "unconfirmed" ? "unconfirmed" : "send");
      return;
    }
    // Never roll back a sent notification after a save error: retry persistence
    // in this session, and report that a restart may repeat it until saved.
    const sent = this.options.settings().sent;
    for (const record of candidates) sent[todoReminderKey(record)!] = Math.max(1, this.options.now());
    this.persistencePending = true;
    try {
      await this.options.persist();
      this.persistencePending = false;
      this.options.report("");
    } catch { this.options.report("persistence"); }
  }
}
