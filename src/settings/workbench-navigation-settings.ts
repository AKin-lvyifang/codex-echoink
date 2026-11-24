/** Desktop workbench navigation order and user-hidden entries. */
export const WORKBENCH_NAVIGATION_IDS = ["journal", "todos", "finance", "knowledge-base", "english-diary", "pdf-reading", "experts", "news"] as const;
export type WorkbenchNavigationId = typeof WORKBENCH_NAVIGATION_IDS[number];
export interface WorkbenchNavigationSettings {
  order: WorkbenchNavigationId[];
  hidden: WorkbenchNavigationId[];
}

export function defaultWorkbenchNavigation(): WorkbenchNavigationSettings {
  return { order: [...WORKBENCH_NAVIGATION_IDS], hidden: [] };
}

export function isWorkbenchNavigationId(value: unknown): value is WorkbenchNavigationId {
  return typeof value === "string" && (WORKBENCH_NAVIGATION_IDS as readonly string[]).includes(value);
}

/** Unknown ids are dropped; entries added in later versions join at the end. */
export function normalizeWorkbenchNavigation(value: unknown): WorkbenchNavigationSettings {
  const data = value && typeof value === "object" ? value as Partial<Record<keyof WorkbenchNavigationSettings, unknown>> : {};
  const list = (items: unknown) => [...new Set(Array.isArray(items) ? items.filter(isWorkbenchNavigationId) : [])];
  const order = list(data.order);
  for (const id of WORKBENCH_NAVIGATION_IDS) if (!order.includes(id)) order.push(id);
  return { order, hidden: list(data.hidden) };
}

export function isDefaultWorkbenchNavigation(value: WorkbenchNavigationSettings): boolean {
  return !value.hidden.length && value.order.every((id, index) => id === WORKBENCH_NAVIGATION_IDS[index]);
}
