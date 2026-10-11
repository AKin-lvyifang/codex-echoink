// Frozen desktop behavior before the mobile extraction (2.6.2).
import * as fsp from "node:fs/promises";
import { writeFileAtomic, isMissingPathError } from "../knowledge-base/utils";

export type HomeActivityKind = "created" | "modified" | "reopened";
export interface HomeActivityEvent { path: string; kind: HomeActivityKind; at: number; date: string }
export interface HomeActivitySnapshot {
  startedAt: number;
  events: readonly HomeActivityEvent[];
  error: "" | "read" | "write";
}
interface StoredActivity {
  version: 1;
  startedAt: number;
  opened: string[];
  events: HomeActivityEvent[];
}

export function homeActivityDate(at: number): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function isNotePath(value: unknown): value is string {
  return typeof value === "string" && value.endsWith(".md") && !value.startsWith("/")
    && !value.split("/").some((part) => part === ".." || part.startsWith("."));
}

/** One plugin-owned stream shared by all home leaves; never stores note content. */
export class HomeActivityService {
  private startedAt: number;
  private readonly events = new Map<string, HomeActivityEvent>();
  private readonly opened = new Set<string>();
  private currentPath: string | null = null;
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writes: Promise<void> = Promise.resolve();
  private dirty = false;
  private disposed = false;
  private writable = true;
  private error: HomeActivitySnapshot["error"] = "";

  constructor(private readonly filePath: string, private readonly now: () => number = Date.now) {
    this.startedAt = now();
  }

  async initialize(): Promise<void> {
    try {
      const raw: unknown = JSON.parse(await fsp.readFile(this.filePath, "utf8"));
      const data = raw as Partial<StoredActivity> | null;
      if (!data || data.version !== 1 || !Number.isFinite(data.startedAt)
        || !Array.isArray(data.events) || !Array.isArray(data.opened)) throw new Error("Invalid activity data");
      this.startedAt = data.startedAt!;
      for (const p of data.opened) if (isNotePath(p)) this.opened.add(p);
      for (const e of data.events) {
        if (!e || !isNotePath(e.path) || !["created", "modified", "reopened"].includes(e.kind)
          || !Number.isFinite(e.at) || e.at < this.startedAt || e.date !== homeActivityDate(e.at)) continue;
        this.events.set(this.key(e), { path: e.path, kind: e.kind, at: e.at, date: e.date });
      }
    } catch (error) {
      if (!isMissingPathError(error)) {
        this.error = "read";
        this.writable = false; // Preserve unreadable bytes for recovery.
      }
    }
  }

  snapshot(): HomeActivitySnapshot {
    return { startedAt: this.startedAt, events: [...this.events.values()].sort((a, b) => b.at - a.at), error: this.error };
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  record(path: string, kind: "created" | "modified"): void {
    if (!isNotePath(path) || this.disposed) return;
    this.add(path, kind);
  }
  open(path: string | null): void {
    if (this.disposed || path === this.currentPath) return;
    this.currentPath = path;
    if (!isNotePath(path)) return;
    if (this.opened.has(path)) this.add(path, "reopened");
    else {
      this.opened.add(path);
      this.changed();
    }
  }
  restoreOpen(path: string | null): void {
    this.currentPath = path;
    if (isNotePath(path) && !this.opened.has(path)) {
      this.opened.add(path);
      this.changed();
    }
  }
  rename(oldPath: string, newPath: string): void {
    if (this.disposed) return;
    const remap = (p: string) => p === oldPath ? newPath : p.startsWith(`${oldPath}/`) ? newPath + p.slice(oldPath.length) : p;
    const records = [...this.events.values()];
    this.events.clear();
    for (const event of records) {
      const next = { ...event, path: remap(event.path) };
      if (!isNotePath(next.path)) continue;
      const previous = this.events.get(this.key(next));
      if (!previous || next.at > previous.at) this.events.set(this.key(next), next);
    }
    const seen = [...this.opened];
    this.opened.clear();
    for (const p of seen) if (isNotePath(remap(p))) this.opened.add(remap(p));
    if (this.currentPath) this.currentPath = remap(this.currentPath);
    this.changed();
  }
  delete(path: string): void {
    if (this.disposed) return;
    const matches = (p: string) => p === path || p.startsWith(`${path}/`);
    for (const [key, e] of this.events) if (matches(e.path)) this.events.delete(key);
    for (const p of this.opened) if (matches(p)) this.opened.delete(p);
    if (this.currentPath && matches(this.currentPath)) this.currentPath = null;
    this.changed();
  }
  async flush(): Promise<void> {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (!this.dirty || !this.writable) { this.emit(); return this.writes; }
    this.dirty = false;
    const bytes = JSON.stringify({ version: 1, startedAt: this.startedAt, opened: [...this.opened], events: [...this.events.values()] } satisfies StoredActivity);
    this.writes = this.writes.then(async () => {
      try {
        await writeFileAtomic(this.filePath, bytes);
        this.error = "";
      } catch {
        this.error = "write";
        this.dirty = true;
      }
    });
    await this.writes;
    this.emit();
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    await this.flush();
    this.listeners.clear();
  }
  private key(e: HomeActivityEvent): string { return `${e.date}\0${e.kind}\0${e.path}`; }
  private add(path: string, kind: HomeActivityKind): void {
    const at = this.now();
    const event = { path, kind, at, date: homeActivityDate(at) };
    this.events.set(this.key(event), event);
    this.changed();
  }
  private changed(): void {
    this.dirty = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, 650);
  }
  private emit(): void { for (const listener of this.listeners) listener(); }
}
