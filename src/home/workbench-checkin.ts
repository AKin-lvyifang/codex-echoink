import type CodexForObsidianPlugin from "../main";
import { type AccountService, MembershipApiError } from "../membership/account-service";
import type { CheckInSummary } from "../membership/types";

export const WORKBENCH_CHECKIN_ENABLED = true;

export interface WorkbenchCheckinData { signedDates: string[]; agentDates: string[] }
export function workbenchDate(now = Date.now()): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
export function normalizeWorkbenchCheckin(value: unknown): WorkbenchCheckinData {
  const raw = value as Partial<WorkbenchCheckinData> | null;
  const dates = (items: unknown): string[] => Array.isArray(items)
    ? [...new Set(items.filter((item): item is string => typeof item === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(item) && workbenchDate(new Date(`${item}T12:00:00`).getTime()) === item))].sort() : [];
  const agentDates = dates(raw?.agentDates);
  return { signedDates: [...new Set([...dates(raw?.signedDates), ...agentDates])].sort(), agentDates };
}
const services = new WeakMap<object, WorkbenchCheckinService>();
export function workbenchCheckin(plugin: CodexForObsidianPlugin): WorkbenchCheckinService {
  let service = services.get(plugin);
  if (!service) { service = new WorkbenchCheckinService(plugin); services.set(plugin, service); }
  return service;
}
export class WorkbenchCheckinService {
  private account: AccountService | null = null;
  private session: number | null = null;
  private date = "";
  private context = 0;
  private writeRevision = 0;
  private summary: CheckInSummary | null = null;
  private attempted = false;
  private getFlight: Promise<CheckInSummary | null> | null = null;
  private postFlight: Promise<{ alreadyCheckedIn: boolean; total: number }> | null = null;
  private error: unknown = null;
  private errorVersion = 0;
  private retryUntil = { GET: 0, POST: 0 };
  private listeners = new Set<() => void>();
  private unsubscribeAccount?: () => void;
  constructor(private readonly plugin: CodexForObsidianPlugin, private readonly now = () => Date.now(),
    private readonly timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC") {}
  private sync(): void {
    const account = this.plugin.accountService ?? null;
    const session = account?.checkInSession() ?? null, date = workbenchDate(this.now());
    if (account !== this.account) { this.unsubscribeAccount?.(); this.unsubscribeAccount = undefined; }
    if (account !== this.account || session !== this.session || date !== this.date) {
      this.context++; this.account = account; this.session = session; this.date = date;
      this.summary = null; this.attempted = false; this.getFlight = this.postFlight = null;
      this.error = null; this.retryUntil = { GET: 0, POST: 0 };
    }
    if (account && this.listeners.size && !this.unsubscribeAccount) this.unsubscribeAccount = account.subscribe(() => {
      const before = this.context; this.sync();
      if (this.context !== before) this.emit();
    });
  }
  snapshot(): { context: number; checkedIn: boolean; total: number | null; error: unknown; errorVersion: number } {
    this.sync();
    return { context: this.context, checkedIn: this.summary?.today.checkedIn === true, total: this.summary?.total ?? null, error: this.error, errorVersion: this.errorVersion };
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener); this.sync();
    return () => { this.listeners.delete(listener); if (!this.listeners.size) { this.unsubscribeAccount?.(); this.unsubscribeAccount = undefined; } };
  }
  private emit(): void { for (const listener of this.listeners) listener(); }
  private current(context: number): boolean { this.sync(); return this.context === context; }
  private cooldown(method: "GET" | "POST"): void {
    const remaining = Math.ceil((this.retryUntil[method] - this.now()) / 1000);
    if (remaining > 0) throw new MembershipApiError("RATE_LIMITED", remaining);
  }
  private fail(error: unknown, method: "GET" | "POST"): void {
    if (error instanceof MembershipApiError && error.code === "OPERATION_CANCELLED") return;
    if (error instanceof MembershipApiError && error.code === "RATE_LIMITED" && error.retryAfter)
      this.retryUntil[method] = Math.min(Number.MAX_SAFE_INTEGER, this.now() + error.retryAfter * 1000);
    this.error = error; this.errorVersion++; this.emit();
  }
  refresh(force = false): Promise<CheckInSummary | null> {
    this.sync();
    if (!WORKBENCH_CHECKIN_ENABLED || this.session === null || !this.account) return Promise.resolve(null);
    if (this.getFlight) return this.getFlight;
    if (this.postFlight || this.attempted && !force) return Promise.resolve(this.summary);
    const context = this.context, account = this.account, date = this.date, revision = this.writeRevision;
    this.attempted = true;
    const run = Promise.resolve().then(async () => {
      try {
        this.cooldown("GET"); const result = await account.getCheckIns(date);
        if (!this.current(context)) throw new MembershipApiError("OPERATION_CANCELLED");
        if (revision !== this.writeRevision) return this.summary;
        this.summary = result; this.error = null; this.emit(); return result;
      } catch (error) { if (this.current(context) && revision === this.writeRevision) { this.summary = null; this.fail(error, "GET"); } throw error; }
      finally { if (this.current(context)) this.getFlight = null; }
    });
    this.getFlight = run;
    return run;
  }
  record(): Promise<{ alreadyCheckedIn: boolean; total: number }> {
    this.sync();
    if (this.postFlight) return this.postFlight;
    if (this.summary?.today.checkedIn) return Promise.resolve({ alreadyCheckedIn: true, total: this.summary.total });
    const context = this.context, account = this.account, date = this.date;
    this.writeRevision++;
    const run = Promise.resolve().then(async () => {
      try {
        if (!WORKBENCH_CHECKIN_ENABLED || this.session === null || !account) throw new MembershipApiError("AUTH_REQUIRED");
        this.cooldown("POST");
        // Recompute only on a new manual action. Failed actions are never queued for replay.
        const result = await account.checkIn({ date, timezone: this.timezone(), source: "manual" });
        if (!this.current(context)) throw new MembershipApiError("OPERATION_CANCELLED");
        this.summary = { ...result.summary, today: { date, checkedIn: true, source: "manual" } };
        this.attempted = true; this.error = null; this.emit(); return { alreadyCheckedIn: result.alreadyCheckedIn, total: result.summary.total };
      } catch (error) { if (this.current(context)) this.fail(error, "POST"); throw error; }
      finally { if (this.current(context)) this.postFlight = null; }
    });
    this.postFlight = run;
    return run;
  }
}
