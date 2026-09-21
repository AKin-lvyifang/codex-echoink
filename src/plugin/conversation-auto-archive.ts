import type { PiConversationCatalogEntry } from "../harness/pi-native/contracts";

export interface AutoArchivePort {
  days(): number;
  list(): Promise<readonly Readonly<PiConversationCatalogEntry>[]>;
  /** Latest real run activity plus catalog edits/restores; reads never touch it. */
  activity(id: string): Promise<{ updatedAt: number; hasDrafts: boolean }>;
  isProtected(id: string): boolean;
  archive(id: string): Promise<void>;
  changed(): Promise<void>;
  onError(): void;
}

/** Local lifecycle only: one timer, one scan, no model or provider dependency. */
export class ConversationAutoArchive {
  private timer: ReturnType<typeof setInterval> | undefined;
  private flight: Promise<void> | undefined;
  private generation = 0;
  private configuredDays = 0;
  private disposed = false;
  constructor(private readonly port: AutoArchivePort, private readonly now = Date.now) {}
  configure(): void {
    if (this.disposed) return;
    const days = this.port.days();
    if (days === this.configuredDays) return;
    this.configuredDays = days; this.generation++;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    if (!days) return;
    void this.scan();
    this.timer = setInterval(() => { void this.scan(); }, 60 * 60 * 1_000);
  }
  async scan(): Promise<void> {
    if (this.disposed || !this.port.days()) return;
    if (this.flight) return this.flight;
    const generation = this.generation;
    const days = this.port.days();
    const live = () => !this.disposed && generation === this.generation && this.port.days() === days;
    const work = async () => {
      let changed = false;
      try {
        for (const entry of await this.port.list()) {
          if (!live()) break;
          if (entry.status !== "active" || this.port.isProtected(entry.conversationId)) continue;
          if (this.now() - entry.updatedAt <= days * 86_400_000) continue;
          const activity = await this.port.activity(entry.conversationId);
          if (!live()) break;
          if (activity.hasDrafts || this.port.isProtected(entry.conversationId)) continue;
          const updatedAt = Math.max(entry.updatedAt, activity.updatedAt);
          if (!Number.isFinite(updatedAt) || this.now() - updatedAt <= days * 86_400_000) continue;
          await this.port.archive(entry.conversationId);
          changed = true;
        }
      } catch { this.port.onError(); }
      finally { if (changed) await this.port.changed(); }
    };
    this.flight = work().catch(() => this.port.onError()).finally(() => {
      this.flight = undefined;
      // A setting changed while awaiting local IO: apply the new interval now.
      if (!this.disposed && this.port.days() && generation !== this.generation) void this.scan();
    });
    return this.flight;
  }
  async dispose(): Promise<void> {
    this.disposed = true; this.generation++;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    await this.flight;
  }
}
