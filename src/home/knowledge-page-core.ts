import type { App } from "obsidian";
import type { KnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import type { KnowledgeBaseDashboardHealth, KnowledgeBaseDashboardSnapshot } from "../knowledge-base/dashboard";
import type { KnowledgeLinkHealth } from "../knowledge-base/link-health";
import type { KnowledgeMaintenanceRecord } from "../knowledge-base/maintenance-record";
import type { KnowledgeSourceHealth } from "../knowledge-base/source-health-core";
import type { KnowledgeBaseMaintenanceHistoryEntry, KnowledgeBaseSettings } from "../settings/settings";
import { mergeKnowledgeMaintenanceHistory } from "../knowledge-base/maintenance-history-core";

export type KnowledgePageDirectoryRole = "raw" | "wiki" | "projects" | "inbox";
export type KnowledgePageDirectoryState = "ready" | "partial" | "disabled" | "unbound" | "invalid" | "unavailable";
export interface KnowledgePageDirectoryRoot {
  path: string;
  state: KnowledgePageDirectoryState;
  count: number | null;
  latestMtime: number;
  error?: string;
}
export interface KnowledgePageDirectory {
  role: KnowledgePageDirectoryRole;
  state: KnowledgePageDirectoryState;
  count: number | null;
  unit: "份" | "篇" | "个" | "条";
  latestMtime: number;
  roots: KnowledgePageDirectoryRoot[];
}
export interface KnowledgePageActivityDay { date: string; added: number; organized: number; total: number; }
export interface KnowledgePageHost {
  app: Pick<App, "vault">;
  settings: { knowledgeBase?: KnowledgeBaseSettings };
  settingsKnowledgeBindings?(): KnowledgeFolderBindings | null | undefined;
  getKnowledgeSurfaceService(): {
    getDashboardSnapshot(): Promise<KnowledgeBaseDashboardSnapshot>;
    getMaintenanceRecords?(): Promise<KnowledgeMaintenanceRecord[]>;
  } | null;
}
export interface KnowledgePageSnapshot {
  generatedAt: number;
  bindings: KnowledgeFolderBindings;
  dashboard: KnowledgeBaseDashboardSnapshot | null;
  health: KnowledgeBaseDashboardHealth | null;
  weekly: { added: number | null; organized: number | null; weekStart: number; unknownCreatedAtCount: number };
  activityDays: KnowledgePageActivityDay[];
  directories: KnowledgePageDirectory[];
  links: KnowledgeLinkHealth;
  sources: KnowledgeSourceHealth;
  maintenanceHistory: KnowledgeBaseMaintenanceHistoryEntry[];
  maintenanceRecords: KnowledgeMaintenanceRecord[];
  errors: Partial<Record<"health" | "activity" | "directories" | "links" | "sources" | "history", string>>;
}

export interface PageFile { path: string; mtime: number; birthtime: number | null; }

/** Local calendar dates retain the year, including ranges crossing New Year's Day. */
export function knowledgePageLocalDate(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function localWeekStart(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - (date.getDay() + 6) % 7);
  return date.getTime();
}
function maintenanceAt(entry: KnowledgeBaseMaintenanceHistoryEntry): number | null {
  if (Number.isFinite(entry.at) && entry.at > 0) return entry.at;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(entry.date);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return knowledgePageLocalDate(date.getTime()) === entry.date ? date.getTime() : null;
}
function completedMaintenance(entry: KnowledgeBaseMaintenanceHistoryEntry): boolean {
  // Legacy Outputs and Inbox runs also executed organization and recorded formal terminal batches.
  if (entry.mode !== "maintain" && entry.mode !== "reingest" && entry.mode !== "inbox" && entry.mode !== "outputs") return false;
  if (entry.status !== "success") return false;
  if (entry.resultStatus) return entry.resultStatus === "completed" || entry.resultStatus === "noop";
  return !entry.completion || entry.completion === "full" || entry.completion === "noop";
}

/** Shared event collection for the weekly figures and every heatmap range. */
export function aggregateKnowledgePageActivity(files: readonly PageFile[], history: readonly KnowledgeBaseMaintenanceHistoryEntry[], now: number): {
  weekly: KnowledgePageSnapshot["weekly"]; activityDays: KnowledgePageActivityDay[];
} {
  const weekStart = localWeekStart(now), days = new Map<string, KnowledgePageActivityDay>();
  let added = 0, organized = 0, unknownCreatedAtCount = 0;
  const add = (at: number, kind: "added" | "organized"): void => {
    if (!Number.isFinite(at) || at <= 0 || at > now) return;
    const date = knowledgePageLocalDate(at), day = days.get(date) ?? { date, added: 0, organized: 0, total: 0 };
    day[kind]++; day.total++; days.set(date, day);
    if (at >= weekStart) { if (kind === "added") added++; else organized++; }
  };
  for (const file of new Map(files.map(file => [file.path, file])).values()) {
    if (file.birthtime === null || !Number.isFinite(file.birthtime) || file.birthtime <= 0 || file.birthtime > now) unknownCreatedAtCount++;
    else add(file.birthtime, "added");
  }
  // The history merger owns private-record precedence and run/record identity.
  for (const entry of mergeKnowledgeMaintenanceHistory(history, [])) if (completedMaintenance(entry)) {
    const at = maintenanceAt(entry);
    if (at !== null) add(at, "organized");
  }
  return { weekly: { added, organized, weekStart, unknownCreatedAtCount }, activityDays: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

