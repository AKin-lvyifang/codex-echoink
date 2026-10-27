import type CodexForObsidianPlugin from "../main";

// Keep the local implementation dormant until account-backed check-in is ready.
export const WORKBENCH_CHECKIN_ENABLED = false;

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
const autoPresented = new WeakSet<object>();
export function workbenchCheckin(plugin: CodexForObsidianPlugin): WorkbenchCheckinService {
  let service = services.get(plugin);
  if (!service) { service = new WorkbenchCheckinService(plugin); services.set(plugin, service); }
  return service;
}
export class WorkbenchCheckinService {
  private tail: Promise<unknown> = Promise.resolve();
  private saving: WorkbenchCheckinData | null = null;
  constructor(private readonly plugin: CodexForObsidianPlugin) {}
  snapshot(): WorkbenchCheckinData { return this.saving ?? normalizeWorkbenchCheckin(this.plugin.settings.workbenchCheckin); }
  consumeAutoPresentation(): boolean {
    if (!WORKBENCH_CHECKIN_ENABLED) return false;
    if (autoPresented.has(this.plugin.app) || !this.snapshot().agentDates.includes(workbenchDate())) return false;
    autoPresented.add(this.plugin.app); return true;
  }
  record(agent = false, at = Date.now()): Promise<void> {
    if (!WORKBENCH_CHECKIN_ENABLED) return Promise.resolve();
    const date = workbenchDate(at);
    const run = this.tail.then(async () => {
      const before = this.plugin.settings.workbenchCheckin;
      const current = this.snapshot();
      if (current.signedDates.includes(date) && (!agent || current.agentDates.includes(date))) return;
      const next = normalizeWorkbenchCheckin({ signedDates: [...current.signedDates, date], agentDates: [...current.agentDates, ...(agent ? [date] : [])] });
      this.saving = current;
      this.plugin.settings.workbenchCheckin = next;
      try { await this.plugin.saveSettings(true); }
      catch (error) { if (this.plugin.settings.workbenchCheckin === next) this.plugin.settings.workbenchCheckin = before; throw error; }
      finally { this.saving = null; }
      this.plugin.notifyHomeSurfacesChanged();
    });
    this.tail = run.catch(() => undefined);
    return run;
  }
}
