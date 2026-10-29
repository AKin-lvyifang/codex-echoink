import type { ExpertLicense, ExpertMetadata } from "./contracts";
import type { ExpertContentService } from "./service";
import { ownedEl } from "../ui/owned-dom";

export interface ExpertHallOptions {
  document?: Document;
  service: ExpertContentService;
  getHiredIds(): Iterable<string>;
  hasPro?(): boolean;
  onHire(expert: ExpertMetadata): Promise<void>;
  onDismiss(expert: ExpertMetadata): Promise<void>;
  onOpen(expert: ExpertMetadata): void | Promise<void>;
  onUpgrade(): void | Promise<void>;
  onViewChange?(aboutId?: string): void;
  /** Host adapters can supply Origin / MobileUI controls; semantics stay shared. */
  createButton?(parent: HTMLElement, label: string, variant: "primary" | "secondary" | "tertiary"): HTMLButtonElement;
}
export interface ExpertHallHandle {
  refresh(forceCatalog?: boolean): Promise<void>;
  showAbout(id: string): Promise<void>;
  dispose(): void;
}
function element<K extends keyof HTMLElementTagNameMap>(document: Document, parent: HTMLElement, tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = ownedEl(document, tag); node.className = className;
  if (text !== undefined) node.textContent = text;
  parent.appendChild(node); return node;
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : "操作未完成，请重试。"; }

/** Render only public summaries and bundled license texts. Never accept a package body. */
export function renderExpertLicenses(container: HTMLElement, licenses: readonly ExpertLicense[], document = container.ownerDocument): void {
  const section = element(document, container, "section", "echoink-expert-licenses");
  element(document, section, "h3", "echoink-expert-licenses-title", "版权与许可");
  for (const license of licenses) {
    const details = element(document, section, "details", "echoink-expert-license");
    element(document, details, "summary", "echoink-expert-license-name", license.name);
    const source = element(document, details, "a", "echoink-expert-license-source", license.source);
    source.href = license.source; source.target = "_blank"; source.rel = "noopener noreferrer";
    element(document, details, "pre", "echoink-expert-license-text", license.text);
  }
}

/** One DOM renderer; each host owns navigation, accounts and the actual hire transaction. */
export function renderExpertHall(container: HTMLElement, options: ExpertHallOptions): ExpertHallHandle {
  const document = options.document ?? container.ownerDocument;
  let disposed = false, generation = 0, catalog: ExpertMetadata[] = [], view: string | null = null;
  const pending = new Map<string, string>(), errors = new Map<string, string>();
  const root = element(document, container, "section", "echoink-expert-hall");
  const button = (parent: HTMLElement, label: string, variant: "primary" | "secondary" | "tertiary", action: () => void | Promise<void>): HTMLButtonElement => {
    const node = options.createButton?.(parent, label, variant) ?? element(document, parent, "button", "", label);
    node.type = "button";
    node.classList.add("echoink-expert-button", `is-${variant}`);
    if (variant === "primary") node.classList.add("mod-cta");
    node.addEventListener("click", () => {
      if (!disposed && !node.disabled) void Promise.resolve().then(action).catch(error => {
        if (!disposed) status(errorText(error), true);
      });
    });
    return node;
  };
  const status = (message: string, error = false): void => {
    const existing = root.querySelector(".echoink-expert-page-status"); existing?.remove();
    const node = element(document, root, "p", `echoink-expert-page-status${error ? " is-error" : ""}`, message);
    node.setAttribute("role", error ? "alert" : "status");
  };
  const hasPro = () => options.hasPro?.() ?? options.service.hasRemoteAccess();
  const run = async (expert: ExpertMetadata, message: string, action: () => void | Promise<void>): Promise<void> => {
    if (disposed || pending.has(expert.id)) return;
    pending.set(expert.id, message); errors.delete(expert.id); draw();
    try { await action(); }
    catch (error) { errors.set(expert.id, errorText(error)); }
    finally { pending.delete(expert.id); if (!disposed && view === null) draw(); }
  };
  const draw = (): void => {
    if (disposed || view !== null) return;
    root.replaceChildren(); root.removeAttribute("aria-busy");
    element(document, root, "h2", "echoink-expert-hall-title", "专家");
    if (!catalog.length) { status("暂时没有可聘请的专家。"); return; }
    const hired = new Set(options.getHiredIds());
    const grid = element(document, root, "div", "echoink-expert-grid");
    for (const expert of catalog) {
      const card = element(document, grid, "article", "echoink-expert-card"); card.dataset.expertId = expert.id;
      const top = element(document, card, "div", "echoink-expert-card-top");
      const avatar = element(document, top, "img", "echoink-expert-avatar");
      avatar.src = expert.avatarUrl; avatar.alt = ""; avatar.width = 56; avatar.height = 56; avatar.loading = "lazy"; avatar.referrerPolicy = "no-referrer";
      const identity = element(document, top, "div", "echoink-expert-identity");
      element(document, identity, "h3", "echoink-expert-name", expert.name);
      element(document, identity, "p", "echoink-expert-scene", expert.scene);
      element(document, card, "p", "echoink-expert-quote", `“${expert.quote}”`);
      const tags = element(document, card, "ul", "echoink-expert-tags");
      for (const tag of expert.tags) element(document, tags, "li", "echoink-expert-tag", tag);
      const actions = element(document, card, "div", "echoink-expert-actions");
      button(actions, "关于", "tertiary", () => showAbout(expert.id));
      const busy = pending.get(expert.id);
      if (busy) {
        card.setAttribute("aria-busy", "true");
        const control = button(actions, busy, "secondary", () => {}); control.disabled = true; control.setAttribute("aria-busy", "true");
      } else if (hired.has(expert.id)) {
        button(actions, "解聘", "tertiary", () => run(expert, "解聘中…", () => options.onDismiss(expert)));
        button(actions, "去聊聊", "secondary", () => run(expert, "打开中…", () => options.onOpen(expert)));
      } else if (!options.service.compatible(expert)) {
        const control = button(actions, "请更新插件或使用支持的设备", "secondary", () => {}); control.disabled = true;
      } else if (hasPro()) {
        button(actions, "聘请", "primary", () => run(expert, "下载中…", () => options.onHire(expert)));
      } else {
        button(actions, "开通 PRO", "secondary", () => options.onUpgrade());
      }
      const message = errors.get(expert.id);
      if (message) { const error = element(document, card, "p", "echoink-expert-card-error", message); error.setAttribute("role", "alert"); }
    }
  };
  const refresh = async (forceCatalog = false): Promise<void> => {
    const current = ++generation; view = null;
    root.replaceChildren(); root.setAttribute("aria-busy", "true");
    element(document, root, "h2", "echoink-expert-hall-title", "专家"); status("正在加载专家…");
    try {
      const response = await options.service.publicCatalog(forceCatalog);
      if (disposed || current !== generation) return;
      catalog = response.experts; draw();
    } catch (error) {
      if (disposed || current !== generation) return;
      root.removeAttribute("aria-busy"); status(errorText(error), true);
      button(root, "重试", "secondary", () => refresh(true));
    }
  };
  const showAbout = async (id: string): Promise<void> => {
    const expert = catalog.find(item => item.id === id);
    if (disposed || !expert) return;
    const current = ++generation; view = id; options.onViewChange?.(id);
    root.replaceChildren(); root.removeAttribute("aria-busy");
    button(root, "返回专家", "tertiary", () => { ++generation; view = null; options.onViewChange?.(); draw(); });
    element(document, root, "h2", "echoink-expert-about-title", expert.name);
    element(document, root, "p", "echoink-expert-about-summary", expert.summary);
    if (!hasPro()) {
      status("下载专家包后可查看随包版权与许可。");
      button(root, "开通 PRO", "secondary", () => options.onUpgrade()); return;
    }
    status("正在加载版权与许可…");
    try {
      const resolved = await options.service.resolve(id);
      if (disposed || current !== generation) return;
      root.querySelector(".echoink-expert-page-status")?.remove();
      renderExpertLicenses(root, resolved.licenseTexts(), document);
    } catch (error) {
      if (disposed || current !== generation) return;
      status(errorText(error), true); button(root, "重试", "secondary", () => showAbout(id));
    }
  };
  const unsubscribe = options.service.subscribe(() => { if (!disposed && view === null && !root.hasAttribute("aria-busy")) draw(); });
  void refresh();
  return { refresh, showAbout, dispose() { disposed = true; ++generation; unsubscribe(); root.remove(); } };
}
