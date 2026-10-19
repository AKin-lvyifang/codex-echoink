import { Notice, setIcon } from "obsidian";
import type CodexForObsidianPlugin from "../main";
import { getProPluginAccess, unavailableCapabilityAccess } from "../membership/access";
import { ProPluginControls } from "../ui/pro-plugin-controls";
import { createOriginButton, createOriginSwitch, disposeOriginControls } from "./origin-controls";
import { createSettingsSection } from "./settings-v2";
import { createPluginEditionBadge } from "./plugin-edition-badge";

export type DesktopModuleId = "knowledge" | "journal" | "review" | "todo" | "selection" | "finance" | "english" | "pdf";
export interface DesktopModuleSettingsOptions {
  plugin: CodexForObsidianPlugin;
  expanded: Set<DesktopModuleId>;
  renderContent(module: DesktopModuleId, parent: HTMLElement): void | (() => void);
  summary?(module: DesktopModuleId): string;
  onExpandedChange?(module: DesktopModuleId, expanded: boolean): void;
  onProBenefits(): void;
}

const modules: readonly { id: DesktopModuleId; zh: string; en: string; icon: string; pro?: boolean }[] = [
  { id: "knowledge", zh: "知识库", en: "Knowledge", icon: "library" },
  { id: "journal", zh: "日记", en: "Journal", icon: "book-open" },
  { id: "review", zh: "复盘", en: "Review", icon: "history" },
  { id: "todo", zh: "待办", en: "To-dos", icon: "list-todo" },
  { id: "selection", zh: "选文提问", en: "Selection Ask", icon: "text-cursor-input" },
  { id: "finance", zh: "财务", en: "Finance", icon: "wallet", pro: true },
  { id: "english", zh: "英文日记", en: "English diary", icon: "languages", pro: true },
  { id: "pdf", zh: "PDF 精读 · 提取", en: "PDF reading and extraction", icon: "file-text", pro: true }
];

/** Owns presentation and the original enable paths; the settings tab owns routes and expansion. */
export function renderDesktopModuleSettings(host: HTMLElement, options: DesktopModuleSettingsOptions): () => void {
  const { plugin } = options;
  const english = plugin.settings.settingsLanguage === "en";
  const root = host.createDiv({ cls: "echoink-desktop-modules" });
  const access = plugin.accountService ?? unavailableCapabilityAccess;
  const disposers: (() => void)[] = [];
  let disposed = false;
  for (const pro of [false, true]) {
    const group = createSettingsSection(root, { title: pro ? (english ? "PRO modules" : "PRO 模块") : (english ? "Basic modules" : "基础模块"), surface: "flat" });
    group.addClass("echoink-module-group");
    if (pro) {
      const benefits = createOriginButton(group.querySelector<HTMLElement>(".echoink-settings-section-header")!, { text: english ? "View PRO benefits" : "查看 PRO 权益", cls: "text-button is-tertiary" });
      benefits.onclick = options.onProBenefits;
    }
    for (const module of modules.filter(item => Boolean(item.pro) === pro)) {
      const card = createSettingsSection(group, { surface: "group" });
      card.addClass("echoink-module-drawer"); card.dataset.module = module.id;
      const header = card.createDiv({ cls: "echoink-module-drawer-header" });
      const title = english ? module.en : module.zh;
      const trigger = createOriginButton(header, { cls: "echoink-module-drawer-trigger", attr: { "aria-label": title, "data-echoink-focus-key": `module:${module.id}` } });
      setIcon(trigger.createSpan({ cls: "echoink-module-drawer-icon", attr: { "aria-hidden": "true" } }), module.icon);
      const copy = trigger.createSpan({ cls: "echoink-module-drawer-copy" });
      const name = copy.createSpan({ cls: "echoink-module-drawer-name" });
      name.createSpan({ cls: "echoink-module-drawer-title", text: title });
      if (module.pro) createPluginEditionBadge(name, "pro", plugin.settings.settingsLanguage);
      const summary = copy.createSpan({ cls: "echoink-module-drawer-summary" });
      const optional = module.id === "selection" || pro;
      if (!optional) setIcon(trigger.createSpan({ cls: "echoink-module-drawer-chevron", attr: { "aria-hidden": "true" } }), "chevron-down");
      const toggle = optional ? createOriginSwitch(header, { attr: { "aria-label": english ? `Enable ${title}` : `启用${title}`, "data-echoink-focus-key": `module:${module.id}:enabled` } }) : null;
      const content = card.createDiv({ cls: "echoink-module-drawer-content", attr: { id: `echoink-module-content-${module.id}` } });
      trigger.setAttribute("aria-controls", content.id);
      let rendered = false, pending = false;
      let animation: Animation | null = null;
      let wasOpen: boolean | undefined;
      disposers.push(() => animation?.cancel());
      const enabled = () => module.id === "selection" ? plugin.settings.selectionAsk.enabled : module.id === "finance" ? plugin.settings.lifestyle.finance.enabled : module.id === "english" ? plugin.settings.englishDiary.enabled : module.id === "pdf" ? plugin.settings.pdfReading.enabled : true;
      const setExpanded = (value: boolean) => {
        if (value) options.expanded.add(module.id); else options.expanded.delete(module.id);
        options.onExpandedChange?.(module.id, value);
      };
      const controls = pro ? new ProPluginControls(access, () => getProPluginAccess(access, enabled())) : null;
      const refresh = (animate = false) => {
        if (disposed) return;
        animation?.cancel(); animation = null;
        content.removeClass("is-animating");
        const previousHeight = content.hidden ? 0 : content.getBoundingClientRect().height;
        const active = enabled();
        const open = options.expanded.has(module.id) && active;
        trigger.disabled = pending || !active || (pro && !getProPluginAccess(access, active).canEnter);
        trigger.setAttribute("aria-expanded", String(open));
        card.toggleClass("is-expanded", open);
        card.toggleClass("is-disabled", !active);
        content.hidden = !open;
        summary.textContent = !active ? (english ? "Disabled" : "已停用") : options.summary?.(module.id) || (module.id === "selection" ? (english ? "Ask about selected text" : "选中文字后直接提问") : "");
        summary.hidden = !summary.textContent;
        if (toggle) { toggle.checked = active; toggle.disabled = pending; }
        controls?.refresh();
        if (open && !rendered) {
          rendered = true;
          const dispose = options.renderContent(module.id, content);
          if (dispose) disposers.push(dispose);
        }
        content.inert = !open;
        if (animate && wasOpen !== undefined && wasOpen !== open && typeof content.animate === "function" && !content.ownerDocument.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
          content.hidden = false;
          const nextHeight = open ? content.getBoundingClientRect().height : 0;
          content.addClass("is-animating");
          const current = content.animate([{ height: `${previousHeight}px` }, { height: `${nextHeight}px` }], { duration: 180, easing: "cubic-bezier(.2,.7,.2,1)" });
          animation = current;
          void current.finished.catch(() => {}).then(() => { if (animation !== current || disposed) return; animation = null; content.hidden = !open; content.removeClass("is-animating"); });
        }
        wasOpen = open;
      };
      if (controls && toggle) { controls.bind(toggle, { businessDisabled: () => pending }); disposers.push(() => controls.dispose()); }
      if (pro) disposers.push(access.subscribe(() => refresh()));
      trigger.onclick = () => { if (trigger.disabled) return; setExpanded(!options.expanded.has(module.id)); refresh(true); };
      if (toggle) {
        toggle.onchange = () => {
          if (pending || disposed) return;
          const value = toggle.checked;
          pending = true; refresh();
          void (async () => {
            if (module.id === "finance") await plugin.lifestyle.setEnabled("finance", value);
            else if (module.id === "pdf") { if (!plugin.pdfReading) throw new Error("PDF 精读尚未就绪"); await plugin.pdfReading.setEnabled(value); }
            else if (module.id === "english") { if (!plugin.englishDiary) throw new Error("英文日记尚未就绪"); await plugin.englishDiary.setEnabled(value); }
            else {
              const previous = plugin.settings.selectionAsk.enabled;
              plugin.settings.selectionAsk.enabled = value;
              try { await plugin.saveSettings(true); } catch (error) { plugin.settings.selectionAsk.enabled = previous; throw error; }
            }
            setExpanded(value);
          })().catch(error => { if (!disposed) new Notice(error instanceof Error ? error.message : String(error)); })
            .finally(() => { pending = false; refresh(true); });
        };
      }
      refresh();
    }
  }
  return () => { disposed = true; for (const dispose of disposers.reverse()) dispose(); disposeOriginControls(root); };
}
