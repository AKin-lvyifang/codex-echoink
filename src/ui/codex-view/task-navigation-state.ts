import { normalizeTaskWorkspace, prefillNewTask, type TaskDraft, type TaskPage, type TaskWorkspace } from "../../agents/task-workspace";

/** Data-only navigation state; no Conversation creation or execution occurs here. */
const listPositions = new WeakMap<object, Map<string, { scrollTop: number; taskId?: string }>>();
export class TaskNavigationState {
  private generation = 0;
  readonly listPositions: Map<string, { scrollTop: number; taskId?: string }>;
  constructor(private readonly workspace: () => TaskWorkspace, cacheKey: object = workspace) {
    this.listPositions = listPositions.get(cacheKey) ?? new Map();
    listPositions.set(cacheKey, this.listPositions);
  }
  get page(): TaskPage { return this.workspace().page; }
  get token(): number { return this.generation; }
  static draftKey(page: TaskPage): string { return page.kind === "list" ? `agent:${page.agentId}` : page.taskId; }
  get draftKey(): string { return TaskNavigationState.draftKey(this.page); }
  draft(page = this.page): TaskDraft {
    return structuredClone((page.kind === "list" ? this.workspace().newTaskDrafts[page.agentId] : this.workspace().replyDrafts[page.taskId]) ?? { text: "", attachments: [] });
  }
  save(draft: TaskDraft, page = this.page): void {
    const normalized = normalizeTaskWorkspace({ newTaskDrafts: { draft }, replyDrafts: {} }).newTaskDrafts.draft;
    if (page.kind === "list") this.workspace().newTaskDrafts[page.agentId] = normalized;
    else this.workspace().replyDrafts[page.taskId] = normalized;
  }
  navigate(page: TaskPage): number { this.workspace().page = page; return ++this.generation; }
  prefill(agentId: string, text: string, prefillSource?: string, englishDiarySourcePath?: string): boolean {
    const result = prefillNewTask(this.workspace(), agentId, { text, attachments: [], ...(prefillSource ? { prefillSource } : {}), ...(englishDiarySourcePath ? { englishDiarySourcePath } : {}) });
    this.workspace().newTaskDrafts = result.workspace.newTaskDrafts;
    return result.accepted;
  }
}

export { consumeAcceptedTaskDraft } from "../../agents/task-workspace";
