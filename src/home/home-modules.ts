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
  { id: "footprints", selector: ".footprints", zhName: "本周足迹", enName: "Weekly activity", defaultVisible: true },
  { id: "calendar", selector: ".calendar", zhName: "日记与足迹日历", enName: "Journal & activity calendar", defaultVisible: true },
  { id: "wiki", selector: ".bento.wiki", zhName: "Wiki 知识库", enName: "Wiki knowledge base", defaultVisible: true },
  { id: "outputs", selector: ".bento.outputs", zhName: "Outputs 成果", enName: "Outputs", defaultVisible: true },
  { id: "projects", selector: ".bento.projects", zhName: "Projects 项目", enName: "Projects", defaultVisible: true },
  { id: "inbox", selector: ".bento.inbox", zhName: "Inbox 收件箱", enName: "Inbox", defaultVisible: true },
  { id: "journal", selector: ".bento.journal", zhName: "Journal 日记", enName: "Journal", defaultVisible: true },
  { id: "review", selector: ".bento.review", zhName: "Review 回顾", enName: "Review", defaultVisible: true },
  { id: "todos", selector: ".todo-section", zhName: "待办", enName: "To-dos", defaultVisible: true }
];

export function defaultHomeModuleVisibility(): Record<string, boolean> {
  const record: Record<string, boolean> = {};
  for (const module of ECHOINK_HOME_MODULES) record[module.id] = module.defaultVisible;
  return record;
}
