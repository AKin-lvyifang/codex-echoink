import { localizeExpert, type ExpertMetadata } from "./contracts";
import type { ExpertContentService } from "./service";
import { ownedEl } from "../ui/owned-dom";
import { userFacingErrorText } from "../core/error-copy";

export interface ExpertHallOptions {
  document?: Document;
  service: ExpertContentService;
  getHiredIds(): Iterable<string>;
  hasPro?(): boolean;
  /** Reader language; defaults to Chinese. */
  english?(): boolean;
  initialExpertId?: string;
  onHire(expert: ExpertMetadata): Promise<void>;
  onDismiss(expert: ExpertMetadata): Promise<void>;
  /** Compatibility for existing hosts; navigation is now the public detail page. */
  onOpen?(expert: ExpertMetadata): void | Promise<void>;
  onUpgrade(): void | Promise<void>;
  onViewChange?(expertId?: string): void;
  createButton?(parent: HTMLElement, label: string, variant: "primary" | "secondary" | "tertiary"): HTMLButtonElement;
}
export interface ExpertHallHandle {
  refresh(forceCatalog?: boolean): Promise<void>;
  showDetail(id: string): Promise<void>;
  /** Accept old routes without exposing their old UI. */
  showAbout(id: string): Promise<void>;
  showHall(): void;
  /** Re-render with the current language without refetching. */
  redraw(): void;
  dispose(): void;
}
function element<K extends keyof HTMLElementTagNameMap>(document: Document, parent: HTMLElement, tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = ownedEl(document, tag); node.className = className;
  if (text !== undefined) node.textContent = text;
  parent.appendChild(node); return node;
}

/** Both pages render catalog metadata only; no private package is loaded for browsing. */
export function renderExpertHall(container: HTMLElement, options: ExpertHallOptions): ExpertHallHandle {
  const document = options.document ?? container.ownerDocument;
  const english = (): boolean => options.english?.() ?? false;
  const t = (zh: string, en: string): string => english() ? en : zh;
  const errorText = (error: unknown): string => userFacingErrorText(error, t("专家操作未能完成。请稍后重试；如问题持续，请点击“上报问题”。", "The expert action could not be completed. Please try again later. If the problem persists, select Report issue."), english() ? "en" : "zh");
  const shown = (expert: ExpertMetadata): ExpertMetadata => localizeExpert(expert, english());
  let disposed = false, generation = 0, catalog: ExpertMetadata[] = [], view: string | null = options.initialExpertId ?? null;
  let loading = false, catalogReady = false, loadError = "";
  const pending = new Map<string, string>(), errors = new Map<string, string>();
  const root = element(document, container, "section", "echoink-expert-hall");
  const focus = (key: string): void => { Array.from(root.querySelectorAll<HTMLElement>("[data-expert-focus]")).find(node => node.dataset.expertFocus === key)?.focus(); };
  const button = (parent: HTMLElement, label: string, variant: "primary" | "secondary" | "tertiary", action: () => void | Promise<void>): HTMLButtonElement => {
    const node = options.createButton?.(parent, label, variant) ?? element(document, parent, "button", "", label);
    node.type = "button"; node.classList.add("echoink-expert-button", `is-${variant}`);
    if (variant === "primary") node.classList.add("mod-cta");
    node.addEventListener("click", event => {
      event.stopPropagation();
      if (!disposed && !node.disabled) void Promise.resolve().then(action).catch(error => { if (!disposed) status(root, errorText(error), true); });
    });
    return node;
  };
  const status = (parent: HTMLElement, message: string, error = false): void => {
    const node = element(document, parent, "p", `echoink-expert-page-status${error ? " is-error" : ""}`, message);
    node.setAttribute("role", error ? "alert" : "status");
  };
  const hasPro = () => options.hasPro?.() ?? options.service.hasRemoteAccess();
  const run = async (expert: ExpertMetadata, message: string, action: () => void | Promise<void>): Promise<void> => {
    if (disposed || pending.has(expert.id)) return;
    const origin = view, restoreFocus = root.contains(document.activeElement);
    pending.set(expert.id, message); errors.delete(expert.id); draw();
    try { await action(); }
    catch (error) { errors.set(expert.id, errorText(error)); }
    finally {
      pending.delete(expert.id);
      if (!disposed) { draw(); if (restoreFocus && view === origin) focus(`action:${expert.id}`); }
    }
  };
  const identity = (parent: HTMLElement, source: ExpertMetadata, detail = false): void => {
    const expert = shown(source);
    const top = element(document, parent, "header", "echoink-expert-card-top");
    const avatar = element(document, top, "img", "echoink-expert-avatar");
    avatar.src = expert.avatarUrl; avatar.alt = ""; avatar.width = 56; avatar.height = 56; avatar.loading = "lazy"; avatar.referrerPolicy = "no-referrer";
    const text = element(document, top, "div", "echoink-expert-identity");
    element(document, text, detail ? "h2" : "h3", detail ? "echoink-expert-detail-title" : "echoink-expert-name", expert.name);
    element(document, text, "p", "echoink-expert-scene", expert.scene);
    const sourceLabel = expert.source === "community" ? t("社区", "Community") : t("官方", "Official");
    const author = expert.author?.name;
    const count = expert.hireCount;
    const attribution = [sourceLabel];
    if (author) attribution.push(t(`作者：${author}`, `By ${author}`));
    if (count !== undefined) attribution.push(t(`${count} 人聘请`, `${count.toLocaleString("en")}${count === 1 ? " hire" : " hires"}`));
    element(document, text, "p", "echoink-expert-scene echoink-expert-attribution", attribution.join(" · "));
  };
  const tags = (parent: HTMLElement, expert: ExpertMetadata): void => {
    const list = element(document, parent, "ul", "echoink-expert-tags");
    for (const tag of shown(expert).tags) element(document, list, "li", "echoink-expert-tag", tag);
  };
  const action = (parent: HTMLElement, expert: ExpertMetadata, detail = false): void => {
    const actions = element(document, parent, "div", "echoink-expert-actions");
    const busy = pending.get(expert.id), hired = new Set(options.getHiredIds()).has(expert.id);
    const variant = detail ? "primary" : "secondary";
    let control: HTMLButtonElement;
    if (busy) { control = button(actions, busy, variant, () => {}); control.disabled = true; control.setAttribute("aria-busy", "true"); control.title = t("正在处理，请稍候。", "Processing. Please wait."); }
    else if (hired) control = button(actions, t("解聘", "Dismiss"), variant, () => run(expert, t("解聘", "Dismiss"), () => options.onDismiss(expert)));
    else if (!hasPro()) control = button(actions, t("开通 PRO", "Get PRO"), variant, () => run(expert, t("开通 PRO", "Get PRO"), () => options.onUpgrade()));
    else if (!options.service.compatible(expert)) { control = button(actions, t("聘请", "Hire"), variant, () => {}); control.disabled = true; control.title = t("此专家不支持当前插件版本或设备，请更新插件或使用支持的设备。", "This expert does not support the current plugin version or device. Update the plugin or use a supported device."); }
    else control = button(actions, t("聘请", "Hire"), "primary", () => run(expert, t("聘请", "Hire"), () => options.onHire(expert)));
    control.dataset.expertFocus = `action:${expert.id}`;
    const message = errors.get(expert.id);
    if (message) { const error = element(document, parent, "p", "echoink-expert-card-error", message); error.setAttribute("role", "alert"); }
    else if (!hired && hasPro() && !options.service.compatible(expert)) {
      const error = element(document, parent, "p", "echoink-expert-card-error", t(`当前插件版本或设备不支持此专家。请更新至 ${expert.minPluginVersion} 或更新版本，并使用支持的设备。`, `The current plugin version or device does not support this expert. Update to ${expert.minPluginVersion} or later and use a supported device.`));
      error.setAttribute("role", "alert");
    }
  };
  const back = (): void => { const control = button(root, t("返回专家", "Back to experts"), "tertiary", showHall); control.classList.add("echoink-expert-back"); control.dataset.expertFocus = "back"; };
  const draw = (): void => {
    if (disposed) return;
    const active = document.activeElement as HTMLElement | null, activeKey = root.contains(active) ? active?.dataset.expertFocus : undefined;
    root.replaceChildren(); root.classList.toggle("is-detail", view !== null);
    if (loading) root.setAttribute("aria-busy", "true"); else root.removeAttribute("aria-busy");
    if (view !== null) back();
    if (loadError || !catalogReady) {
      element(document, root, "h2", "echoink-expert-hall-title", t("专家", "Experts"));
      status(root, loadError || t("正在加载专家…", "Loading experts…"), !!loadError);
      if (loadError) button(root, t("重试", "Retry"), "secondary", () => refresh(true));
    } else if (view !== null) {
      const expert = catalog.find(item => item.id === view);
      if (!expert) status(root, t("此专家已不在当前目录中。请返回后刷新列表。", "This expert is no longer in the catalog. Go back and refresh the list."), true);
      else {
        const detail = element(document, root, "article", "echoink-expert-detail"); detail.dataset.expertId = expert.id;
        const copy = shown(expert);
        identity(detail, expert, true);
        element(document, detail, "p", "echoink-expert-detail-summary", copy.summary);
        tags(detail, expert);
        if (copy.description?.trim()) element(document, detail, "p", "echoink-expert-detail-description", copy.description);
        if (copy.story?.trim()) element(document, detail, "p", "echoink-expert-detail-story", copy.story);
        const examples = copy.examples?.filter(item => item.trim()) ?? [];
        if (examples.length) {
          const section = element(document, detail, "section", "echoink-expert-example-section");
          element(document, section, "h3", "echoink-expert-detail-section-title", t("你可以这样问他", "Try asking"));
          const list = element(document, section, "ul", "echoink-expert-examples");
          for (const example of examples) element(document, list, "li", "echoink-expert-example", example);
        }
        action(detail, expert, true);
      }
    } else {
      element(document, root, "h2", "echoink-expert-hall-title", t("专家", "Experts"));
      if (!catalog.length) status(root, t("暂时没有可聘请的专家。", "No experts are available to hire right now."));
      const grid = element(document, root, "div", "echoink-expert-grid");
      for (const expert of catalog) {
        const card = element(document, grid, "article", "echoink-expert-card"); card.dataset.expertId = expert.id;
        const link = element(document, card, "a", "echoink-expert-card-link"); link.href = `#expert-${expert.id}`;
        link.setAttribute("aria-label", t(`查看${shown(expert).name}详情`, `View ${shown(expert).name}`)); link.dataset.expertFocus = `card:${expert.id}`;
        identity(link, expert);
        element(document, link, "p", "echoink-expert-quote", `“${shown(expert).quote}”`);
        tags(link, expert); action(card, expert);
        card.addEventListener("click", event => {
          if ((event.target as Element | null)?.closest("button")) return;
          event.preventDefault(); void showDetail(expert.id);
        });
      }
    }
    if (activeKey) focus(activeKey);
  };
  const refresh = async (forceCatalog = false): Promise<void> => {
    if (disposed) return;
    const current = ++generation; loading = true; loadError = ""; draw();
    try {
      const response = await options.service.publicCatalog(forceCatalog);
      if (disposed || current !== generation) return;
      catalog = response.experts; catalogReady = true;
    } catch (error) { if (!disposed && current === generation) loadError = errorText(error); }
    finally { if (!disposed && current === generation) { loading = false; draw(); } }
  };
  const showDetail = async (id: string): Promise<void> => {
    if (disposed) return;
    view = id; options.onViewChange?.(id);
    if (!catalogReady) await refresh(); else draw();
    if (!disposed && view === id) focus("back");
  };
  const showHall = (): void => {
    if (disposed) return;
    const previous = view; view = null; options.onViewChange?.(); draw();
    if (previous) focus(`card:${previous}`);
  };
  const unsubscribe = options.service.subscribe(updated => {
    if (!disposed && !loading) {
      if (updated) { catalog = updated.experts; catalogReady = true; loadError = ""; }
      draw();
    }
  });
  void refresh();
  return { refresh, redraw: draw, showDetail, showAbout: showDetail, showHall, dispose() { disposed = true; ++generation; unsubscribe(); root.remove(); } };
}
