import { runErrors } from "../../run-reports/recent-errors";
import { Notice } from "obsidian";
import type { AgentModuleId } from "../../agents/types";
import { HomeSearchService } from "../../home/home-search";
import { isHomeNotePath } from "../../home/home-note-visibility";
import { IPadShell } from "./shell";
import { createHomePage } from "./workbench-pages";
import type { IPadPageContext, IPadRoute, IPadWorkbenchHost } from "./workbench-contract";
import { ipadElement as el } from "./workbench-elements";
import { mobileModuleEnabled } from "../../mobile/module-settings";
import { createJournalPage } from "./journal-page";
import { createTodoPage } from "./todo-pages";
import { createFinancePage } from "./finance-pages";
import { createKnowledgePage } from "./knowledge-pages";
import { createEnglishDiaryPage } from "./english-diary-pages";

/** Central iPad pages. Agent routes belong to the host's separate right pane. */
export class IPadWorkbench {
  readonly shell: IPadShell;
  private readonly context: IPadPageContext;
  private serial = Promise.resolve();
  private mounted = false;
  private closed = false;

  constructor(private readonly root: HTMLElement, private readonly host: IPadWorkbenchHost) {
    this.shell = new IPadShell(root, { onError: error => this.error(error) });
    this.context = { root, host, document: root.ownerDocument, shell: this.shell,
      navigate: (route, replace) => this.navigate(route, replace), error: error => this.error(error) };
  }

  async mount(): Promise<void> {
    if (this.closed || this.mounted) return;
    this.mounted = true;
    this.shell.mount(createHomePage(this.context));
  }

  navigate(route: IPadRoute, _replace = false): Promise<void> {
    return this.enqueue(async () => {
      if (route.kind !== "home") { await this.host.openAgent(route); return; }
      if (this.shell.hasPage("ipad-home")) await this.shell.backTo("ipad-home");
      else this.shell.mount(createHomePage(this.context));
    });
  }

  openModule(module: AgentModuleId): Promise<void> {
    return this.enqueue(async () => {
      if (!mobileModuleEnabled(this.host.settings(), module)) throw new Error("此模块已停用。");
      if (module === "journal" || module === "todos" || module === "finance") {
        const id = `module:${module}`;
        if (this.shell.hasPage(id)) { await this.shell.backTo(id); return; }
        const page = module === "journal" ? createJournalPage(this.context) : module === "todos" ? createTodoPage(this.context) : createFinancePage(this.context);
        if (!await this.shell.push(page)) page.dispose?.(); return;
      }
      if (module === "knowledge-base") {
        if (this.shell.hasPage("module:knowledge-base")) { await this.shell.backTo("module:knowledge-base"); return; }
        const page = createKnowledgePage(this.context); if (!await this.shell.push(page)) page.dispose?.(); return;
      }
      if (module === "english-diary") {
        if (this.shell.hasPage("module:english-diary")) { await this.shell.backTo("module:english-diary"); return; }
        const page = createEnglishDiaryPage(this.context); if (!await this.shell.push(page)) page.dispose?.();
      }
    });
  }

  openSearch(): Promise<void> {
    return this.enqueue(async () => {
      if (this.shell.hasPage("ipad-search")) {
        if (await this.shell.backTo("ipad-search")) this.root.querySelector<HTMLInputElement>(".pd-search-input")?.focus();
        return;
      }
      const document = this.root.ownerDocument, window = document.defaultView;
      const service = new HomeSearchService(this.host.app, path => isHomeNotePath(path, this.host.settings().englishDiary));
      const content = el(document, "div", "pd-search-page"), field = el(document, "label", "pd-search-field");
      const label = el(document, "span", "pd-search-label", "搜索笔记"), input = el(document, "input", "pd-search-input");
      input.type = "search"; input.placeholder = "标题、别名、标签或正文";
      const status = el(document, "div", "pd-search-status"), results = el(document, "div", "pd-search-results");
      status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
      field.append(label, input); content.append(field, status, results);
      let disposed = false, composing = false, dirty = false, timer: number | undefined, query: AbortController | undefined;
      const cancel = () => { query?.abort(); query = undefined; if (timer !== undefined) window?.clearTimeout(timer); timer = undefined; };
      const search = async () => {
        cancel(); if (disposed || composing) return;
        dirty = false;
        if (!input.value.trim()) { status.textContent = ""; results.replaceChildren(); return; }
        const current = new AbortController(); query = current; status.textContent = "正在搜索…"; results.setAttribute("aria-busy", "true");
        try {
          const result = await service.search(input.value, current.signal);
          if (disposed || current.signal.aborted || query !== current) return;
          results.replaceChildren();
          status.textContent = result.failed
            ? `${result.count} 条已读取结果，${result.failed} 篇笔记读取失败。`
            : result.count ? `${result.count} 条结果` : "未找到匹配的笔记。";
          for (const match of result.matches) {
            const row = el(document, "button", "pd-search-result"); row.type = "button";
            row.append(el(document, "span", "pd-search-result-title", match.title));
            if (match.snippet) row.append(el(document, "span", "pd-sub", match.snippet));
            row.addEventListener("click", () => { void this.host.openNote(match.path).catch(error => this.error(error)); }); results.append(row);
          }
        } catch (error) { if (!disposed && !current.signal.aborted && query === current) status.textContent = error instanceof Error ? error.message : String(error); }
        finally { if (query === current) { query = undefined; results.removeAttribute("aria-busy"); } }
      };
      const schedule = () => {
        cancel(); results.removeAttribute("aria-busy"); results.replaceChildren();
        status.textContent = input.value.trim() && !composing ? "正在搜索…" : "";
        if (!disposed && !composing) timer = window?.setTimeout(() => { void search(); }, 120);
      };
      input.addEventListener("input", schedule);
      input.addEventListener("compositionstart", () => { composing = true; cancel(); });
      input.addEventListener("compositionend", () => { composing = false; schedule(); });
      input.addEventListener("focus", () => { if (dirty) schedule(); });
      const invalidate = () => { service.clear(); dirty = true; if (this.shell.activePageId === "ipad-search") schedule(); };
      const vault = this.host.app.vault, cache = this.host.app.metadataCache;
      const refs = [vault.on("create", invalidate), vault.on("modify", invalidate), vault.on("delete", invalidate), vault.on("rename", invalidate)];
      const metadataRef = cache.on("changed", invalidate);
      const page = { id: "ipad-search", title: "搜索笔记", content, dispose: () => {
        disposed = true; cancel(); service.clear(); for (const ref of refs) vault.offref(ref); cache.offref(metadataRef);
      } };
      if (await this.shell.push(page)) input.focus(); else page.dispose();
    });
  }

  private enqueue(action: () => Promise<void>): Promise<void> {
    const next = this.serial.catch(() => {}).then(async () => { if (!this.closed) await action(); });
    this.serial = next;
    return next;
  }

  private error(error: unknown): void { runErrors.record("mobile.page", error, { conversationId: this.shell.activePageId?.startsWith("task:") ? this.shell.activePageId.slice(5) : undefined }); new Notice(error instanceof Error ? error.message : String(error)); }
  dispose(): void { if (this.closed) return; this.closed = true; this.shell.dispose(); }
}
