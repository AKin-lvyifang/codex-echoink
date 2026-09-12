/**
 * Unified workbench module definitions. The home view and the
 * "Layout & appearance" settings group both read this table, so adding a
 * module only means appending one entry here plus its markup/render code.
 */
export interface EchoInkHomeModuleDefinition {
  readonly id: string;
  /** CSS selector of the module root inside the home view content. */
  readonly selector: string;
  readonly zhName: string;
  readonly enName: string;
  readonly defaultVisible: boolean;
}

export const ECHOINK_HOME_MODULES: readonly EchoInkHomeModuleDefinition[] = [
  { id: "recent-notes", selector: ".recent-section", zhName: "最近笔记", enName: "Recent notes", defaultVisible: true },
  { id: "calendar", selector: ".calendar", zhName: "日记与足迹日历", enName: "Journal & activity calendar", defaultVisible: true },
  { id: "knowledge", selector: ".knowledge-section", zhName: "知识卡片区", enName: "Knowledge cards", defaultVisible: true },
  { id: "todos", selector: ".todo-section", zhName: "待办", enName: "To-dos", defaultVisible: true }
];

export function defaultHomeModuleVisibility(): Record<string, boolean> {
  const record: Record<string, boolean> = {};
  for (const module of ECHOINK_HOME_MODULES) record[module.id] = module.defaultVisible;
  return record;
}
