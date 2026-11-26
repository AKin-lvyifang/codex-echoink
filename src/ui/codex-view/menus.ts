import { bindPressFeedback } from "../press-feedback";
import { renderProviderBrandIcon, type ProviderBrandId } from "../../settings/provider-brand-icons";
import { remoteSkillLocked } from "../../resources/remote-skill-presentation";
import type { CapabilityAccess } from "../../membership/types";
import { ownedDiv } from "../owned-dom";
import { attachNativeTooltip } from "../native-tooltip";
import {showEchoInkMenu} from "../theme-boundary";
import { Menu, Notice, setIcon } from "obsidian";
import type { SettingsLanguage } from "../../settings/settings";
import type { GenerationTemplate } from "../../generation/types";
import { setGenerationIcon } from "../../generation/icons";
import { filterSkillResources } from "../../resources/registry";
import { resourcePresentation } from "../../resources/resource-presentation";
import type { EchoInkResource } from "../../resources/types";
import type { ReasoningEffort, UiMode } from "../../types/app-server";
import { knowledgeCommandOptions, type KnowledgeBaseCommandOption } from "../../knowledge-base/commands";
import { selectKnowledgeCommandItem, setKnowledgeCommandMenuOpen } from "../knowledge-command-menu";
import { labelFor } from "./composer";
import { positionAnchoredMenu, positionSubmenu } from "./floating-menu-position";
import { conversationUiText } from "./ui-i18n";

export interface SkillMenuElements {
  skillMenuEl: HTMLElement;
  knowledgeCommandMenuEl: HTMLElement;
}

export interface SkillMenuState {
  language?: SettingsLanguage;
  skillsRequested: boolean;
}

export interface SkillMenuCallbacks {
  onSkillsRequested: () => void;
  onLoadSkills: () => Promise<EchoInkResource[]>;
  onRenderMatches: (skills?: EchoInkResource[]) => void;
}

export interface SkillMatchesState {
  proAccess?: CapabilityAccess | null;
  language?: SettingsLanguage;
  skills: EchoInkResource[];
  selectedSkill: EchoInkResource | null;
  generationTemplates?: GenerationTemplate[];
  generationEntryReason?: string | null;
  generationTemplateReasons?: Record<string, string | null>;
}

export interface SkillMatchesCallbacks {
  onSelectSkill: (skill: EchoInkResource) => void;
}

export interface SlashMenuCallbacks extends SkillMatchesCallbacks {
  onFillCommand: (command: string) => void;
  onSelectGenerationTemplate?: (template: GenerationTemplate) => void;
}

export interface AddMenuCallbacks {
  onAttachActiveFile: () => void;
  onPickFiles: (imagesOnly: boolean) => void;
  onToggleMcpPanel: () => void;
}

export interface WorkspaceMenuCallbacks {
  onChooseWorkspace: () => void;
  onRevealWorkspace: () => boolean;
  onClearWorkspace: () => void;
}

export interface ModelMenuState {
  readCurrent?: () => ModelMenuState;
  subscribeChanges?: (listener: () => void) => () => void;
  language?: SettingsLanguage;
  providerModels: ComposerProviderModelOption[];
  pointsGrouping?: { balance?: string };
  selectedProviderSettingsId: string;
  selectedModel: string;
  selectedReasoning: ReasoningEffort | null;
  reasoningCurrentValue: string;
  reasoningDisabledReason: string;
  reasoningAdjustable: boolean;
  reasoningOptions: readonly Readonly<{
    effort: ReasoningEffort;
    label: string;
  }>[];
  selectedMode: UiMode;
}

export interface ComposerProviderModelOption {
  providerBrand?: ProviderBrandId;
  providerSettingsId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  typicalPointsLabel?: string;
  isXiaoechoModel?: boolean;
}

export interface ModelMenuCallbacks {
  onSelectModel: (selection: Readonly<{
    providerSettingsId: string;
    modelId: string;
  }>) => void;
  onSelectReasoning: (reasoning: ReasoningEffort) => void;
  onSelectMode: (mode: UiMode) => void;
}

export interface SessionMenuCallbacks {
  onRename?: () => void;
  onArchive?: () => void;
  onResetCache?: () => void;
  onDelete?: () => void;
  onStop?: () => void;
  onResume?: () => void;
  onRevoke?: () => void;
  onRetrySave?: () => void;
  onOpenSource?: () => void;
}

interface ComposerParameterOption {
  providerBrand?: ProviderBrandId;
  value: string;
  label: string;
  typicalPointsLabel?: string;
  isXiaoechoModel?: boolean;
  selected: boolean;
  group?: string;
  groupId?: string;
  groupDetail?: string;
  providerSettingsId?: string;
}

interface ComposerParameterSection {
  id: string;
  icon: string;
  label: string;
  currentValue: string;
  disabled?: boolean;
  disabledReason?: string;
  options: ComposerParameterOption[];
  onSelect: (option: ComposerParameterOption) => void;
}

interface ActiveComposerParameterMenu {
  anchor: HTMLElement;
  root: HTMLElement;
  submenu: HTMLElement | null;
  submenuPressCleanup?: () => void;
  activeTrigger: HTMLButtonElement | null;
  activeSectionId: string;
  cleanup: () => void;
  reposition: () => void;
}

let activeComposerParameterMenu: ActiveComposerParameterMenu | null = null;

export function openSkillMenu(event: MouseEvent, elements: SkillMenuElements, state: SkillMenuState, callbacks: SkillMenuCallbacks): void {
  event.preventDefault();
  event.stopPropagation();
  elements.knowledgeCommandMenuEl.removeClass("is-visible");
  if (elements.skillMenuEl.hasClass("is-visible")) {
    elements.skillMenuEl.removeClass("is-visible");
    return;
  }
  callbacks.onSkillsRequested();
  if (!state.skillsRequested) {
    elements.skillMenuEl.empty();
    elements.skillMenuEl.createDiv({
      cls: "codex-skill-empty",
      text: conversationUiText(state.language ?? "zh-CN", "正在加载 skills...", "Loading Skills...")
    });
    elements.skillMenuEl.addClass("is-visible");
  } else {
    callbacks.onRenderMatches();
  }
  void callbacks.onLoadSkills().then((skills) => callbacks.onRenderMatches(skills));
}

export function openAddMenu(
  event: MouseEvent,
  callbacks: AddMenuCallbacks,
  language: SettingsLanguage = "zh-CN"
): void {
  event.preventDefault();
  const menu = new Menu();
  menu.addItem((item) =>
    item
      .setTitle(conversationUiText(language, "添加当前笔记（只作上下文）", "Add current note (context only)"))
      .setIcon("file-text")
      .onClick(callbacks.onAttachActiveFile)
  );
  menu.addItem((item) =>
    item
      .setTitle(conversationUiText(language, "添加文件（只作上下文）", "Add file (context only)"))
      .setIcon("folder")
      .onClick(() => callbacks.onPickFiles(false))
  );
  menu.addItem((item) =>
    item
      .setTitle(conversationUiText(language, "添加图片", "Add image"))
      .setIcon("image")
      .onClick(() => callbacks.onPickFiles(true))
  );
  menu.addSeparator();
  menu.addItem((item) =>
    item
      .setTitle(conversationUiText(language, "MCP 状态", "MCP status"))
      .setIcon("blocks")
      .onClick(callbacks.onToggleMcpPanel)
  );
  showEchoInkMenu( (event.currentTarget as HTMLElement | null)?.ownerDocument ?? document, () => menu.showAtMouseEvent(event));
}

export function openWorkspaceMenu(
  event: MouseEvent,
  workspacePath: string,
  callbacks: WorkspaceMenuCallbacks,
  language: SettingsLanguage = "zh-CN"
): void {
  event.preventDefault();
  const menu = new Menu();
  if (workspacePath) {
    menu.addItem((item) => item.setTitle(workspacePath).setIcon("folder-open").setIsLabel(true));
    menu.addSeparator();
  }
  menu.addItem((item) =>
    item
      .setTitle(workspacePath
        ? conversationUiText(language, "更换工作区", "Change workspace")
        : conversationUiText(language, "选择工作区", "Choose workspace"))
      .setIcon("folder-plus")
      .onClick(callbacks.onChooseWorkspace)
  );
  if (workspacePath) {
    menu.addItem((item) =>
      item
        .setTitle(conversationUiText(language, "在 Finder 显示", "Show in Finder"))
        .setIcon("external-link")
        .onClick(() => {
          if (!callbacks.onRevealWorkspace()) {
            new Notice(conversationUiText(language, "无法打开这个文件夹", "Could not open this folder"));
          }
        })
    );
    menu.addItem((item) =>
      item
        .setTitle(conversationUiText(language, "清除工作区", "Clear workspace"))
        .setIcon("x")
        .onClick(callbacks.onClearWorkspace)
    );
  }
  showEchoInkMenu( (event.currentTarget as HTMLElement | null)?.ownerDocument ?? document, () => menu.showAtMouseEvent(event));
}

export function openKnowledgeCommandMenu(
  event: MouseEvent,
  onFillCommand: (command: string) => void,
  language: SettingsLanguage = "zh-CN"
): void {
  event.preventDefault();
  const menu = new Menu();
  for (const command of knowledgeCommandOptions()) {
    const copy = localizedKnowledgeCommandOption(command, language);
    menu.addItem((item) =>
      item
        .setTitle(copy.title)
        .setIcon(command.icon)
        .onClick(() => onFillCommand(command.text))
    );
  }
  showEchoInkMenu( (event.currentTarget as HTMLElement | null)?.ownerDocument ?? document, () => menu.showAtMouseEvent(event));
}

export function openModelMenu(event: MouseEvent, state: ModelMenuState, callbacks: ModelMenuCallbacks): void {
  const language = state.language ?? "zh-CN";
  openComposerParameterMenu(
    event,
    parameterSections(state, callbacks, true),
    conversationUiText(language, "模型和运行参数", "Model and run settings"),
    language,
    state.readCurrent ? () => parameterSections(state.readCurrent!(), callbacks, true) : undefined,
    state.subscribeChanges
  );
}

/** Toolbar redraws replace the trigger; the open menu still belongs to the same Composer. */
export function reanchorComposerParameterMenu(previous: HTMLElement | null, next: HTMLElement | null): void {
  const active = activeComposerParameterMenu;
  if (!active || active.anchor !== previous || !next || next.ownerDocument !== active.root.ownerDocument) return;
  active.anchor.removeClass("is-open");
  active.anchor.setAttribute("aria-expanded", "false");
  active.anchor = next;
  next.addClass("is-open");
  next.setAttribute("aria-expanded", "true");
  active.reposition();
}

export function closeComposerParameterMenu(): void {
  const active = activeComposerParameterMenu;
  if (!active) return;
  activeComposerParameterMenu = null;
  active.anchor.removeClass("is-open");
  active.anchor.setAttribute("aria-expanded", "false");
  active.submenuPressCleanup?.(); active.submenuPressCleanup = undefined;
  active.submenu?.remove();
  active.root.remove();
  active.cleanup();
}

export function openSessionMenu(
  event: MouseEvent,
  callbacks: SessionMenuCallbacks,
  language: SettingsLanguage = "zh-CN",
  options: { task?: boolean; document?: Document } = {}
): void {
  event.preventDefault();
  const menu = new Menu();
  if (options.task) menu.setUseNativeMenu(false);
  const add = (run: (() => void) | undefined, zh: string, en: string, icon: string) => {
    if (run) menu.addItem(item => item.setTitle(conversationUiText(language, zh, en)).setIcon(icon).onClick(run));
  };
  add(callbacks.onStop, "停止", "Stop", "square");
  add(callbacks.onResume, "继续", "Continue", "play");
  add(callbacks.onRevoke, "撤销建议", "Revoke suggestion", "undo-2");
  add(callbacks.onRetrySave, "重试保存", "Retry saving", "refresh-cw");
  add(callbacks.onOpenSource, "查看正文", "Open source note", "file-text");
  if (callbacks.onRename) menu.addItem((item) =>
    item
      .setTitle(conversationUiText(language, options.task ? "重命名任务" : "重命名会话", options.task ? "Rename task" : "Rename conversation"))
      .setIcon("pencil")
      .onClick(callbacks.onRename!)
  );
  if (callbacks.onArchive) menu.addItem((item) =>
    item
      .setTitle(conversationUiText(language, options.task ? "归档任务" : "归档会话", options.task ? "Archive task" : "Archive conversation"))
      .setIcon("archive")
      .onClick(callbacks.onArchive!)
  );
  if (callbacks.onResetCache) menu.addItem((item) =>
    item
      .setTitle(conversationUiText(language, "重置 Agent 缓存", "Reset Agent cache"))
      .setIcon("rotate-ccw")
      .onClick(callbacks.onResetCache!)
  );
  if (callbacks.onDelete) menu.addItem((item) =>
    item
      .setTitle(conversationUiText(language, options.task ? "删除任务" : "删除会话", options.task ? "Delete task" : "Delete conversation"))
      .setIcon("trash")
      .setWarning(true)
      .onClick(callbacks.onDelete!)
  );
  showEchoInkMenu(options.document ?? (event.currentTarget as HTMLElement | null)?.ownerDocument ?? document, () => menu.showAtMouseEvent(event));
}

export function renderSkillMatches(container: HTMLElement, query: string, state: SkillMatchesState, callbacks: SkillMatchesCallbacks): void {
  const language = state.language ?? "zh-CN";
  container.empty();
  const matches = filterSkillResources(state.skills, query);
  for (const skill of matches) {
    const presentation = resourcePresentation(skill, language);
    const item = container.createDiv({ cls: "codex-skill-item" });
    item.toggleClass("is-selected", state.selectedSkill?.id === skill.id);
    const heading = item.createDiv({ cls: "codex-skill-heading" });
    const icon = heading.createSpan({ cls: "codex-skill-icon" });
    setIcon(icon, remoteSkillLocked(skill, state.proAccess) ? "lock" : "box");
    heading.createDiv({ cls: "codex-skill-name", text: presentation.name });
    item.createDiv({ cls: "codex-skill-desc", text: presentation.description || skill.contentPath || skill.source });
    item.onclick = () => callbacks.onSelectSkill(skill);
  }
  if (matches.length === 0) {
    container.createDiv({
      cls: "codex-skill-empty",
      text: conversationUiText(language, "没有匹配的 skill", "No matching Skills")
    });
  }
  container.addClass("is-visible");
}

export function renderKnowledgeCommandMatches(
  container: HTMLElement,
  input: HTMLTextAreaElement,
  query: string,
  state: SkillMatchesState,
  callbacks: SlashMenuCallbacks
): void {
  const language = state.language ?? "zh-CN";
  container.empty();
  const commands = knowledgeCommandOptions(query);
  const skills = filterSkillResources(state.skills, query);
  let index = 0;
  for (const command of commands) {
    container.appendChild(createKnowledgeCommandItem(
      container,
      input,
      localizedKnowledgeCommandOption(command, language),
      index++,
      callbacks.onFillCommand
    ));
  }
  for (const skill of skills) {
    container.appendChild(createSlashSkillItem(
      container,
      input,
      skill,
      index++,
      state.selectedSkill?.id === skill.id,
      callbacks.onSelectSkill,
      language,
      state.proAccess
    ));
  }
  if (callbacks.onSelectGenerationTemplate) {
    const term = query.trim().replace(/^\//u, "").toLocaleLowerCase();
    const allCommands = knowledgeCommandOptions("");
    const names = new Set([...state.skills.map(skill => resourcePresentation(skill, language).name), ...allCommands.flatMap(command => [command.text.trim().replace(/^\//u, ""), command.title])].map(name => name.toLocaleLowerCase()));
    for (const template of state.generationTemplates ?? []) {
      const reason = state.generationEntryReason || state.generationTemplateReasons?.[template.id];
      if (term && !`${template.name} ${template.description}`.toLocaleLowerCase().includes(term)) continue;
      const item = container.createEl("button", { cls: "codex-command-item codex-command-generation", attr: { type: "button", role: "option", "aria-selected": "false", id: `${container.id}-option-${index}` } });
      const icon = item.createSpan({ cls: "codex-command-icon" }); setGenerationIcon(icon, template.outputKind);
      const body = item.createDiv({ cls: "codex-command-body" });
      body.createSpan({ cls: "codex-command-text", text: names.has(template.name.toLocaleLowerCase()) ? `生成·${template.name}` : `/${template.name}` });
      body.createSpan({ cls: "codex-command-desc", text: reason || template.description });
      item.setAttr("aria-disabled", String(Boolean(reason))); item.toggleClass("is-disabled", Boolean(reason));
      const itemIndex = index++;
      item.onmouseenter = () => selectKnowledgeCommandItem(input, container, itemIndex);
      item.onmousedown = event => event.preventDefault();
      item.onclick = () => { if (!reason) callbacks.onSelectGenerationTemplate!(template); };
    }
  }
  if (index === 0) {
    container.createDiv({
      cls: "codex-skill-empty",
      text: conversationUiText(language, "没有匹配的命令或已启用 Skill", "No matching commands or enabled Skills")
    });
  }
  container.scrollTop = 0;
  setKnowledgeCommandMenuOpen(input, container, true);
  selectKnowledgeCommandItem(input, container, index > 0 ? 0 : -1);
}

function parameterSections(
  state: ModelMenuState,
  callbacks: ModelMenuCallbacks,
  includeRuntimeOptions: boolean
): ComposerParameterSection[] {
  const language = state.language ?? "zh-CN";
  const selectedModel = state.providerModels.find((model) =>
    model.providerSettingsId === state.selectedProviderSettingsId
    && model.modelId === state.selectedModel
  );
  const grouping = state.pointsGrouping;
  const options = grouping
    ? [...state.providerModels.filter(model => model.isXiaoechoModel), ...state.providerModels.filter(model => !model.isXiaoechoModel)]
    : state.providerModels;
  const sections: ComposerParameterSection[] = [{
      id: "model",
      icon: "box",
      label: conversationUiText(language, "模型", "Model"),
      currentValue: selectedModel?.modelName || state.selectedModel || conversationUiText(language, "未选择", "Not selected"),
      options: options.map((model) => ({
        value: model.modelId,
        label: model.modelName,
        typicalPointsLabel: grouping && model === selectedModel ? undefined : model.typicalPointsLabel,
        isXiaoechoModel: model.isXiaoechoModel,
        selected: model.providerSettingsId === state.selectedProviderSettingsId
          && model.modelId === state.selectedModel,
        group: grouping ? model.isXiaoechoModel
          ? conversationUiText(language, "小echo 云端", "Xiaoecho cloud")
          : conversationUiText(language, "其他模型", "Other models") : model.providerName,
        groupId: grouping ? model.isXiaoechoModel ? "xiaoecho" : "other" : model.providerSettingsId,
        groupDetail: grouping ? model.isXiaoechoModel
          ? grouping.balance !== undefined ? conversationUiText(language, `剩余 ${grouping.balance} 点`, `${grouping.balance} pts left`) : undefined
          : conversationUiText(language, "不消耗 EchoInk 点数", "Uses no EchoInk points") : undefined,
        providerBrand: model.providerBrand,
        providerSettingsId: model.providerSettingsId
      })),
      onSelect: (option) => {
        if (!option.providerSettingsId) return;
        callbacks.onSelectModel({
          providerSettingsId: option.providerSettingsId,
          modelId: option.value
        });
      }
    }];
  sections.push({
    id: "reasoning",
    icon: "brain",
    label: "Think",
    currentValue: state.reasoningCurrentValue,
    disabled: !state.reasoningAdjustable
      || Boolean(state.reasoningDisabledReason),
    disabledReason: state.reasoningDisabledReason,
    options: state.reasoningOptions.map((option) => ({
      value: option.effort,
      label: option.label,
      selected: state.selectedReasoning === option.effort
    })),
    onSelect: (option) => callbacks.onSelectReasoning(option.value as ReasoningEffort)
  });
  if (!includeRuntimeOptions) return sections;

  sections.push({
      id: "mode",
      icon: "route",
      label: conversationUiText(language, "模式", "Mode"),
      currentValue: labelFor(state.selectedMode, language),
      options: (["agent", "plan"] as UiMode[]).map((mode) => ({
        value: mode,
        label: labelFor(mode, language),
        selected: state.selectedMode === mode
      })),
      onSelect: (option) => callbacks.onSelectMode(option.value as UiMode)
    });
  return sections;
}

function openComposerParameterMenu(
  event: MouseEvent,
  sections: ComposerParameterSection[],
  ariaLabel: string,
  language: SettingsLanguage,
  readSections?: () => ComposerParameterSection[],
  subscribeChanges?: (listener: () => void) => () => void
): void {
  event.preventDefault();
  event.stopPropagation();
  const currentTarget = event.currentTarget as HTMLElement | null;
  const AnchorElement = currentTarget?.ownerDocument?.defaultView?.HTMLElement ?? HTMLElement;
  const anchor = currentTarget instanceof AnchorElement ? currentTarget : null;
  if (!anchor) return;
  if (activeComposerParameterMenu?.anchor === anchor) {
    closeComposerParameterMenu();
    return;
  }
  closeComposerParameterMenu();

  const doc = anchor.ownerDocument;
  const view = doc.defaultView ?? window;
  const root = ownedDiv(doc);
  root.className = "codex-composer-parameter-menu";
  root.setAttribute("role", "menu");
  root.setAttribute("aria-label", ariaLabel);
  root.setCssStyles({ visibility: "hidden" });
  doc.body.appendChild(root);
  const pressCleanup = anchor.closest("[data-echoink-press-scope]") ? bindPressFeedback(root) : () => {};

  const active: ActiveComposerParameterMenu = {
    anchor,
    root,
    submenu: null,
    activeTrigger: null,
    activeSectionId: "",
    cleanup: () => undefined,
    reposition: () => undefined
  };
  activeComposerParameterMenu = active;
  anchor.addClass("is-open");
  anchor.setAttribute("aria-expanded", "true");

  const renderSections = (nextSections: ComposerParameterSection[]) => {
    const sectionId = active.activeSectionId;
    const focused = doc.activeElement as HTMLElement | null;
    const focusedTriggerId = focused?.dataset.parameterSection;
    const optionFocused = Boolean(focused && active.submenu?.contains(focused));
    const focusedValue = focused?.dataset.parameterValue;
    const focusedProvider = focused?.dataset.parameterProvider;
    const scrollTop = active.submenu?.scrollTop ?? 0;
    closeActiveParameterSubmenu(active);
    root.replaceChildren();
    for (const section of nextSections) {
      const trigger = createParameterTrigger(root, section, language);
      trigger.dataset.parameterSection = section.id;
      trigger.onmouseenter = () => {
        if (section.disabled) {
          closeActiveParameterSubmenu(active);
          return;
        }
        openParameterSubmenu(active, section, trigger, false);
      };
      trigger.onclick = (clickEvent) => {
        clickEvent.preventDefault();
        clickEvent.stopPropagation();
        if (section.disabled) return;
        openParameterSubmenu(active, section, trigger, true);
      };
      trigger.onkeydown = (keyEvent) => {
        if (keyEvent.key !== "ArrowRight" && keyEvent.key !== "Enter" && keyEvent.key !== " ") return;
        keyEvent.preventDefault();
        if (section.disabled) return;
        openParameterSubmenu(active, section, trigger, true);
      };
      if (section.id === sectionId && !section.disabled) openParameterSubmenu(active, section, trigger, false);
      if (focusedTriggerId === section.id) trigger.focus();
    }
    if (active.submenu) {
      active.submenu.scrollTop = scrollTop;
      if (optionFocused) {
        const options = Array.from(active.submenu.querySelectorAll<HTMLButtonElement>(".codex-parameter-option"));
        const retained = options.find(option => option.dataset.parameterValue === focusedValue && option.dataset.parameterProvider === focusedProvider);
        (retained ?? options.find(option => option.getAttribute("aria-checked") === "true") ?? options[0] ?? active.activeTrigger)?.focus();
      }
    } else if (optionFocused) {
      root.querySelector<HTMLButtonElement>("button")?.focus();
    }
  };
  renderSections(sections);

  const reposition = () => {
    if (!active.anchor.isConnected) {
      closeComposerParameterMenu();
      return;
    }
    const anchorRect = active.anchor.getBoundingClientRect();
    const rootRect = root.getBoundingClientRect();
    const viewport = { width: doc.documentElement.clientWidth, height: doc.documentElement.clientHeight };
    const placement = positionAnchoredMenu(anchorRect, rootRect, viewport);
    root.setCssStyles({
      left: `${placement.left}px`,
      top: `${placement.top}px`
    });
    root.dataset.verticalSide = placement.verticalSide;
    root.setCssStyles({ visibility: "visible" });
    positionActiveSubmenu(active);
  };
  active.reposition = reposition;

  const onPointerDown = (pointerEvent: PointerEvent) => {
    const target = pointerEvent.target instanceof (view.Node ?? Node) ? pointerEvent.target : null;
    if (!target || root.contains(target) || active.submenu?.contains(target) || active.anchor.contains(target)) return;
    closeComposerParameterMenu();
  };
  const onKeyDown = (keyEvent: KeyboardEvent) => {
    if (keyEvent.key !== "Escape") return;
    keyEvent.preventDefault();
    if (active.submenu) {
      const trigger = active.activeTrigger;
      closeActiveParameterSubmenu(active);
      trigger?.focus();
      return;
    }
    closeComposerParameterMenu();
    active.anchor.focus();
  };
  const observer = new MutationObserver(() => {
    if (!active.anchor.isConnected) closeComposerParameterMenu();
  });
  observer.observe(doc.body, { childList: true, subtree: true });
  doc.addEventListener("pointerdown", onPointerDown, true);
  doc.addEventListener("keydown", onKeyDown, true);
  doc.addEventListener("scroll", reposition, true);
  view.addEventListener("resize", reposition);
  const unsubscribeChanges = readSections && subscribeChanges?.(() => {
    if (activeComposerParameterMenu !== active) return;
    renderSections(readSections());
    reposition();
  });
  active.cleanup = () => {
    pressCleanup(); active.submenuPressCleanup?.(); active.submenuPressCleanup = undefined;
    unsubscribeChanges?.();
    observer.disconnect();
    doc.removeEventListener("pointerdown", onPointerDown, true);
    doc.removeEventListener("keydown", onKeyDown, true);
    doc.removeEventListener("scroll", reposition, true);
    view.removeEventListener("resize", reposition);
  };

  reposition();
  root.querySelector<HTMLButtonElement>("button")?.focus();
}

function createParameterTrigger(
  container: HTMLElement,
  section: ComposerParameterSection,
  language: SettingsLanguage
): HTMLButtonElement {
  const trigger = container.createEl("button", {
    cls: "codex-parameter-menu-item codex-parameter-menu-trigger",
    attr: {
      type: "button",
      role: "menuitem"
    }
  });
  trigger.toggleClass("is-disabled", Boolean(section.disabled));
  if (section.disabled) {
    trigger.setAttribute("aria-disabled", "true");
    if (section.disabledReason) {
      trigger.setAttribute(
        "aria-label",
        language === "en"
          ? `${section.label}: ${section.currentValue}. ${section.disabledReason}`
          : `${section.label}：${section.currentValue}。${section.disabledReason}`
      );
      attachNativeTooltip(trigger, section.disabledReason);
    }
  } else {
    trigger.setAttribute("aria-haspopup", "menu");
    trigger.setAttribute("aria-expanded", "false");
  }
  const icon = trigger.createSpan({ cls: "codex-parameter-menu-icon" });
  setIcon(icon, section.icon);
  trigger.createSpan({ cls: "codex-parameter-menu-label", text: section.label });
  trigger.createSpan({ cls: "codex-parameter-menu-value", text: section.currentValue });
  if (!section.disabled) {
    const chevron = trigger.createSpan({ cls: "codex-parameter-menu-chevron" });
    setIcon(chevron, "chevron-right");
  }
  return trigger;
}

function openParameterSubmenu(
  active: ActiveComposerParameterMenu,
  section: ComposerParameterSection,
  trigger: HTMLButtonElement,
  focusFirstOption: boolean
): void {
  if (activeComposerParameterMenu !== active || section.disabled) return;
  if (active.activeSectionId === section.id && active.submenu) {
    if (focusFirstOption) active.submenu.querySelector<HTMLButtonElement>("button")?.focus();
    return;
  }

  active.activeTrigger?.removeClass("is-open");
  active.activeTrigger?.setAttribute("aria-expanded", "false");
  active.submenuPressCleanup?.(); active.submenuPressCleanup = undefined;
  active.submenu?.remove();
  active.activeTrigger = trigger;
  active.activeSectionId = section.id;
  trigger.addClass("is-open");
  trigger.setAttribute("aria-expanded", "true");

  const panel = ownedDiv(active.root.ownerDocument);
  panel.className = `codex-composer-parameter-submenu${section.options.some(option => option.isXiaoechoModel) ? " has-xiaoecho-models" : ""}`;
  panel.setAttribute("role", "menu");
  panel.setAttribute("aria-label", section.label);
  panel.setCssStyles({ visibility: "hidden" });
  panel.createDiv({ cls: "codex-parameter-submenu-title", text: section.label });
  let previousGroupId = "";
  for (const option of section.options) {
    if (option.group && option.groupId !== previousGroupId) {
      const heading = panel.createDiv({
        cls: option.groupDetail ? "codex-parameter-option-group echoink-model-group" : "codex-parameter-option-group",
        attr: { role: "presentation" }
      });
      heading.createSpan({ text: option.group });
      if (option.groupDetail) heading.createSpan({ cls: "echoink-model-group-detail", text: option.groupDetail });
      previousGroupId = option.groupId ?? option.group;
    }
    const button = panel.createEl("button", {
      cls: `codex-parameter-menu-item codex-parameter-option${option.selected ? " is-selected" : ""}`,
      attr: {
        type: "button",
        role: "menuitemradio",
        "aria-checked": String(option.selected)
      }
    });
    button.dataset.parameterValue = option.value;
    button.dataset.parameterProvider = option.providerSettingsId ?? "";
    if (option.isXiaoechoModel) button.addClass("is-xiaoecho-model");
    if (option.providerBrand) {
      button.classList.add("has-provider-brand");
      const brand = button.createSpan({ cls: "codex-parameter-menu-icon", attr: { "aria-hidden": "true" } });
      renderProviderBrandIcon(brand, option.providerBrand);
    }
    button.createSpan({ cls: "codex-parameter-option-label", text: option.label });
    if (option.typicalPointsLabel) {
      button.addClass("has-typical-points");
      button.createSpan({ cls: "codex-parameter-option-points", text: option.typicalPointsLabel });
    }
    if (option.isXiaoechoModel) attachNativeTooltip(button, option.label);
    const check = button.createSpan({ cls: "codex-parameter-option-check" });
    if (option.selected) setIcon(check, "check");
    button.onclick = (clickEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      closeComposerParameterMenu();
      section.onSelect(option);
    };
  }
  panel.onkeydown = (keyEvent) => {
    if (keyEvent.key !== "ArrowLeft") return;
    keyEvent.preventDefault();
    active.submenuPressCleanup?.(); active.submenuPressCleanup = undefined;
    panel.remove();
    active.submenu = null;
    active.activeSectionId = "";
    trigger.removeClass("is-open");
    trigger.setAttribute("aria-expanded", "false");
    trigger.focus();
  };
  active.root.ownerDocument.body.appendChild(panel);
  active.submenu = panel;
  active.submenuPressCleanup = active.anchor.closest("[data-echoink-press-scope]") ? bindPressFeedback(panel) : undefined;
  positionActiveSubmenu(active);
  if (focusFirstOption) panel.querySelector<HTMLButtonElement>("button")?.focus();
}

function closeActiveParameterSubmenu(
  active: ActiveComposerParameterMenu
): void {
  active.activeTrigger?.removeClass("is-open");
  active.activeTrigger?.setAttribute("aria-expanded", "false");
  active.submenuPressCleanup?.(); active.submenuPressCleanup = undefined;
  active.submenu?.remove();
  active.submenu = null;
  active.activeSectionId = "";
  active.activeTrigger = null;
}

function positionActiveSubmenu(active: ActiveComposerParameterMenu): void {
  if (!active.submenu || !active.activeTrigger) return;
  const doc = active.root.ownerDocument;
  const triggerRect = active.activeTrigger.getBoundingClientRect();
  const rootRect = active.root.getBoundingClientRect();
  const panelRect = active.submenu.getBoundingClientRect();
  const viewport = { width: doc.documentElement.clientWidth, height: doc.documentElement.clientHeight };
  const placement = positionSubmenu(triggerRect, rootRect, panelRect, viewport);
  active.submenu.setCssStyles({
    left: `${placement.left}px`,
    top: `${placement.top}px`
  });
  active.submenu.dataset.horizontalSide = placement.horizontalSide;
  active.submenu.setCssStyles({ visibility: "visible" });
}

function createKnowledgeCommandItem(
  container: HTMLElement,
  input: HTMLTextAreaElement,
  command: KnowledgeBaseCommandOption,
  index: number,
  onFillCommand: (command: string) => void
): HTMLElement {
  const item = window.createEl("button");
  item.setAttribute("type", "button");
  item.setAttribute("role", "option");
  item.setAttribute("aria-selected", "false");
  item.id = `${container.id}-option-${index}`;
  item.addClass("codex-command-item");
  const icon = item.createSpan({ cls: "codex-command-icon" });
  setIcon(icon, command.icon);
  const body = item.createDiv({ cls: "codex-command-body" });
  const heading = body.createDiv({ cls: "codex-command-heading" });
  heading.createSpan({ cls: "codex-command-text", text: command.text.trim() });
  heading.createSpan({ cls: "codex-command-title", text: command.title });
  body.createDiv({ cls: "codex-command-desc", text: command.description });
  item.onmouseenter = () => selectKnowledgeCommandItem(input, container, index);
  item.onmousedown = (event) => event.preventDefault();
  item.onclick = () => onFillCommand(command.text);
  return item;
}

function createSlashSkillItem(
  container: HTMLElement,
  input: HTMLTextAreaElement,
  skill: EchoInkResource,
  index: number,
  selected: boolean,
  onSelectSkill: (skill: EchoInkResource) => void,
  language: SettingsLanguage,
  proAccess?: CapabilityAccess | null
): HTMLElement {
  const presentation = resourcePresentation(skill, language);
  const item = window.createEl("button");
  item.setAttribute("type", "button");
  item.setAttribute("role", "option");
  item.setAttribute("aria-selected", String(selected));
  item.id = `${container.id}-option-${index}`;
  item.addClass("codex-command-item", "codex-command-skill");
  item.toggleClass("is-current", selected);
  const icon = item.createSpan({ cls: "codex-command-icon" });
  setIcon(icon, remoteSkillLocked(skill, proAccess) ? "lock" : "box");
  const body = item.createDiv({ cls: "codex-command-body" });
  body.createSpan({ cls: "codex-command-text", text: presentation.name });
  body.createSpan({
    cls: "codex-command-desc",
    text: presentation.description || skill.contentPath || conversationUiText(language, "已启用 Skill", "Enabled Skill")
  });
  item.createSpan({
    cls: "codex-command-shortcut",
    text: selected ? conversationUiText(language, "已选择", "Selected") : "↵"
  });
  item.onmouseenter = () => selectKnowledgeCommandItem(input, container, index);
  item.onmousedown = (event) => event.preventDefault();
  item.onclick = () => onSelectSkill(skill);
  return item;
}

function localizedKnowledgeCommandOption(
  command: KnowledgeBaseCommandOption,
  language: SettingsLanguage
): KnowledgeBaseCommandOption {
  if (language !== "en") return command;
  if (command.text.trim() === "/ask") {
    return { ...command, title: "Ask", description: "Ask the knowledge base" };
  }
  if (command.text.trim() === "/maintain") {
    return { ...command, title: "Maintain Knowledge", description: "Refine, write, and verify knowledge" };
  }
  return command;
}
