import { effectiveFinanceBudget } from "../lifestyle/finance-budget";
import { effectiveFinanceEntries } from "../lifestyle/finance-domain";
import { localWorkbenchDate } from "./workbench-source";
import { sha256Hex } from "../utils/sha256";
import type { WorkbenchFacts } from "./workbench-signals";
import type { WorkbenchSignal, WorkbenchSignalId } from "./workbench-types";

export interface WorkbenchDismissalBasis {
  kind: "sources" | "objects" | "system" | "budget";
  objects: Record<string, string>;
  mode?: string;
  count?: number;
}
export interface WorkbenchDismissals { version: 1; entries: Record<string, WorkbenchDismissalBasis> }
export const emptyWorkbenchDismissals = (): WorkbenchDismissals => ({ version: 1, entries: {} });

export function normalizeWorkbenchDismissals(value: unknown): WorkbenchDismissals {
  const root = value as Partial<WorkbenchDismissals> | null;
  if (!root || root.version !== 1 || !root.entries || typeof root.entries !== "object" || Array.isArray(root.entries)) return emptyWorkbenchDismissals();
  return { version: 1, entries: Object.fromEntries(Object.entries(root.entries).filter(([key, basis]) =>
    key.startsWith("workbench:") && basis && ["sources", "objects", "system", "budget"].includes(basis.kind)
    && basis.objects && typeof basis.objects === "object" && !Array.isArray(basis.objects)
    && Object.entries(basis.objects).every(([id, fingerprint]) => /^[a-f\d]{64}$/u.test(id) && typeof fingerprint === "string")
    && (basis.mode === undefined || typeof basis.mode === "string")
    && (basis.count === undefined || Number.isFinite(basis.count) && basis.count >= 0)
  )) };
}

/** Metadata written by maintenance is not a new source body. Identical bytes on either device have the same digest. */
export function workbenchBodyFingerprint(content: string, path: string): string {
  const text = content.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  return sha256Hex(/\.(?:md|markdown)$/iu.test(path) ? text.replace(/^---[ \t]*\n[\s\S]*?\n(?:---|\.\.\.)[ \t]*(?:\n|$)/u, "").replace(/^\n/u, "") : text);
}

export function workbenchDismissalBasis(id: WorkbenchSignalId, objects: readonly string[], facts: WorkbenchFacts): WorkbenchDismissalBasis {
  const entries = (items: readonly string[], values?: ReadonlyMap<string, string>) => Object.fromEntries(items.map(item => [sha256Hex(item), values?.get(item) ?? "present"]));
  if (id === 6 || id === 7) {
    const sources = id === 6 ? facts.inbox.filter(file => file.enteredAt !== undefined) : facts.raw;
    return { kind: "sources", objects: entries(objects, new Map(sources.map(file => [file.path, file.bodyFingerprint ?? file.fingerprint]))) };
  }
  if (id === 15) {
    const reminder = facts.knowledgeSystems?.find(item => item.mapPath === objects[0] && item.domain === objects[1]);
    return { kind: "system", objects: entries(objects), mode: reminder?.mode, count: reminder?.count ?? 0 };
  }
  if (id === 3 && facts.finance) {
    // A higher ten-percent band is a new budget risk; refunds do not wake a dismissed suggestion.
    const category = objects[1], month = objects[0];
    const budget = effectiveFinanceBudget(facts.finance.data, month);
    const limit = budget?.allocations[category] ?? 0;
    const spent = effectiveFinanceEntries(facts.finance.entries, month, localWorkbenchDate(facts.now)).filter(entry => entry.category === category)
      .reduce((sum, entry) => sum + (entry.kind === "expense" ? entry.amountCents : entry.kind === "refund" ? -entry.amountCents : 0), 0);
    return { kind: "budget", objects: entries(objects), count: limit > 0 ? Math.floor(spent / limit * 10) : 0 };
  }
  return { kind: "objects", objects: entries(id === 13 ? [String(facts.finance?.data.lastSuccessfulImportAt ?? "")] : objects) };
}

export function isWorkbenchSignalDismissed(signal: WorkbenchSignal, saved: WorkbenchDismissals | undefined): boolean {
  const previous = saved?.entries[signal.key], current = signal.dismissalBasis;
  if (!previous || !current || previous.kind !== current.kind || previous.mode !== current.mode) return false;
  if (Object.entries(current.objects).some(([id, fingerprint]) => previous.objects[id] !== fingerprint)) return false;
  if (current.kind === "system") return (current.count ?? 0) < (previous.count ?? 0) + 10;
  if (current.kind === "budget") return (current.count ?? 0) <= (previous.count ?? 0);
  return true;
}

type Settings = { workbenchDismissals?: WorkbenchDismissals; settingsLanguage?: string };
const writes = new WeakMap<Settings, Promise<void>>();
/** Serialize gestures, save before hiding, and roll back only our own field on failure. */
export function saveWorkbenchDismissal(settings: Settings, signal: WorkbenchSignal | null, save: () => Promise<void>): Promise<void> {
  const run = async () => {
    if (signal && !signal.dismissalBasis) throw new Error(settings.settingsLanguage === "en" ? "Refresh this suggestion and try again." : "请刷新这条建议后再试。");
    const previous = settings.workbenchDismissals;
    settings.workbenchDismissals = signal ? { version: 1, entries: { ...previous?.entries, [signal.key]: structuredClone(signal.dismissalBasis!) } } : emptyWorkbenchDismissals();
    try { await save(); }
    catch { settings.workbenchDismissals = previous; throw new Error(settings.settingsLanguage === "en" ? "Couldn't save. Your suggestions are unchanged. Please try again." : "没能保存，建议已保留，请重试。"); }
  };
  const pending = (writes.get(settings) ?? Promise.resolve()).catch(() => {}).then(run);
  writes.set(settings, pending);
  return pending;
}
