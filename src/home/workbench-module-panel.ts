import type { ItemView, WorkspaceLeaf } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import type { WorkbenchNavigationId } from "../settings/workbench-navigation-settings";
import { EchoInkJournalView } from "./journal-page";
import { TodoPageView } from "./todo-page";
import { KnowledgePageView } from "./knowledge-page";
import { EnglishDiaryPageView } from "./english-diary-page";
import { PdfReadingPageView } from "./pdf-reading-page";
import { NewsPageView } from "./news-page";
import { ExpertHallView } from "../experts/view";
import { LifestyleView } from "../lifestyle/view";

/** Obsidian's own View lifecycle: open() appends and loads, close() detaches, unloads and calls onClose. */
type HostedView = ItemView & { open(host: HTMLElement): Promise<void>; close(): Promise<void> };
export type WorkbenchEmbeddedView = ItemView & { refresh?(): unknown; refreshLanguage?(): unknown; refreshIfSettingsChanged?(): unknown };

const hosted = new Set<WorkbenchEmbeddedView>();
/** Module pages currently shown inside a workbench, for the same refresh fan-out as their own tabs. */
export function embeddedWorkbenchViews(): readonly WorkbenchEmbeddedView[] { return [...hosted]; }

function createModuleView(id: WorkbenchNavigationId, leaf: WorkspaceLeaf, plugin: CodexForObsidianPlugin): ItemView {
  switch (id) {
    case "journal": return new EchoInkJournalView(leaf, plugin);
    case "todos": return new TodoPageView(leaf, plugin);
    case "finance": return new LifestyleView(leaf, plugin.lifestyle, "finance");
    case "knowledge-base": return new KnowledgePageView(leaf, plugin);
    case "english-diary": return new EnglishDiaryPageView(leaf, plugin);
    case "pdf-reading": return new PdfReadingPageView(leaf, plugin);
    case "experts": return new ExpertHallView(leaf, plugin.getExpertHallHost());
    case "news": return new NewsPageView(leaf, plugin);
  }
}

/**
 * Shows one module page below the workbench navigation. The page is the same
 * view class as its own tab; only one is alive at a time, and switching away
 * closes it so its Vault and store listeners are released.
 */
export class WorkbenchModulePanel {
  private view: HostedView | null = null;
  private moduleId: WorkbenchNavigationId | null = null;
  private generation = 0;

  constructor(private readonly host: HTMLElement, private readonly leaf: WorkspaceLeaf, private readonly plugin: CodexForObsidianPlugin) {}

  get current(): WorkbenchEmbeddedView | null { return this.view; }
  get currentId(): WorkbenchNavigationId | null { return this.moduleId; }

  async show(id: WorkbenchNavigationId): Promise<boolean> {
    if (this.moduleId === id && this.view) return true;
    const generation = ++this.generation;
    const isCurrent = () => generation === this.generation;
    await this.clear(false);
    if (!isCurrent()) return false;
    if (id === "finance" && !await this.plugin.lifestyle.prepareFinanceOpen(isCurrent)) return false;
    if (!isCurrent()) return false;
    const view = createModuleView(id, this.leaf, this.plugin) as HostedView;
    view.containerEl.addClass("echoink-workbench-embedded");
    this.view = view; this.moduleId = id; hosted.add(view);
    try { await view.open(this.host); }
    catch (error) {
      if (this.view === view) await this.clear(false);
      else view.containerEl.remove();
      throw error;
    }
    return isCurrent();
  }

  /** Closes the current page; `invalidate` also cancels a show() still in progress. */
  async clear(invalidate = true): Promise<void> {
    if (invalidate) this.generation++;
    const view = this.view;
    this.view = null; this.moduleId = null;
    if (!view) return;
    hosted.delete(view);
    try { await view.close(); }
    finally { view.containerEl.remove(); }
  }
}
