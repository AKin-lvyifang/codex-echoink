import { Menu, Notice, setIcon } from "obsidian";
import { DEFAULT_SETTINGS, ensureModelChoices } from "../../settings/settings";
import { filterSkillResources } from "../../resources/registry";
import type { EchoInkResource } from "../../resources/types";
import type { CodexModel, ReasoningEffort, ServiceTierChoice, UiMode } from "../../types/app-server";
import { knowledgeCommandOptions, type KnowledgeBaseCommandOption } from "../../knowledge-base/commands";
import { selectKnowledgeCommandItem, setKnowledgeCommandMenuOpen } from "../knowledge-command-menu";
import { labelFor } from "./composer";
import { positionAnchoredMenu, positionSubmenu } from "./floating-menu-position";

export interface SkillMenuElements {
  skillMenuEl: HTMLElement;
  knowledgeCommandMenuEl: HTMLElement;
}

export interface SkillMenuState {
  skillsRequested: boolean;
}

export interface SkillMenuCallbacks {
  onSkillsRequested: () => void;
  onLoadSkills: () => Promise<unknown>;
  onRenderMatches: () => void;
}

export interface SkillMatchesState {
  skills: EchoInkResource[];
  selectedSkill: EchoInkResource | null;
}

export interface SkillMatchesCallbacks {
  onSelectSkill: (skill: EchoInkResource) => void;
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
  providerModels: string[];
  availableModels: CodexModel[];
  selectedModel: string;
  defaultModel: string;
  effectiveModel: string;
  selectedReasoning: ReasoningEffort;
  selectedServiceTier: ServiceTierChoice;
  selectedMode: UiMode;
}

export interface KnowledgeModelMenuCallbacks {
  onSelectModel: (model: string) => void;
  onSelectReasoning: (reasoning: ReasoningEffort) => void;
}

export interface ModelMenuCallbacks extends KnowledgeModelMenuCallbacks {
  onSelectServiceTier: (tier: ServiceTierChoice) => void;
  onSelectMode: (mode: UiMode) => void;
}

export interface SessionMenuCallbacks {
  onRename: () => void;
  onResetCache: () => void;
  onDelete: () => void;
}

interface ComposerParameterOption {
  value: string;
  label: string;
  selected: boolean;
}

interface ComposerParameterSection {
  id: string;
  icon: string;
  label: string;
  currentValue: string;
  options: ComposerParameterOption[];
  onSelect: (value: string) => void;
}

interface ActiveComposerParameterMenu {
  anchor: HTMLElement;
  root: HTMLElement;
  submenu: HTMLElement | null;
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
  if (!state.skillsRequested) {
    callbacks.onSkillsRequested();
    elements.skillMenuEl.empty();
    elements.skillMenuEl.createDiv({ cls: "codex-skill-empty", text: "正在加载 skills..." });
    elements.skillMenuEl.addClass("is-visible");
    void callbacks.onLoadSkills().then(() => callbacks.onRenderMatches());
    return;
  }
  callbacks.onRenderMatches();
}

export function openAddMenu(event: MouseEvent, callbacks: AddMenuCallbacks): void {
  event.preventDefault();
  const menu = new Menu();
  menu.addItem((item) =>
    item
      .setTitle("添加当前笔记（只作上下文）")
      .setIcon("file-text")
      .onClick(callbacks.onAttachActiveFile)
  );
  menu.addItem((item) =>
    item
      .setTitle("添加文件（只作上下文）")
      .setIcon("folder")
      .onClick(() => callbacks.onPickFiles(false))
  );
  menu.addItem((item) =>
    item
      .setTitle("添加图片")
      .setIcon("image")
      .onClick(() => callbacks.onPickFiles(true))
  );
  menu.addSeparator();
  menu.addItem((item) =>
    item
      .setTitle("MCP 状态")
      .setIcon("blocks")
      .onClick(callbacks.onToggleMcpPanel)
  );
  menu.showAtMouseEvent(event);
}

export function openWorkspaceMenu(event: MouseEvent, workspacePath: string, callbacks: WorkspaceMenuCallbacks): void {
  event.preventDefault();
  const menu = new Menu();
  if (workspacePath) {
    menu.addItem((item) => item.setTitle(workspacePath).setIcon("folder-open").setIsLabel(true));
    menu.addSeparator();
  }
  menu.addItem((item) =>
    item
      .setTitle(workspacePath ? "更换工作区" : "选择工作区")
      .setIcon("folder-plus")
      .onClick(callbacks.onChooseWorkspace)
  );
  if (workspacePath) {
    menu.addItem((item) =>
      item
        .setTitle("在 Finder 显示")
        .setIcon("external-link")
        .onClick(() => {
          if (!callbacks.onRevealWorkspace()) new Notice("无法打开这个文件夹");
        })
    );
    menu.addItem((item) =>
      item
        .setTitle("清除工作区")
        .setIcon("x")
        .onClick(callbacks.onClearWorkspace)
    );
  }
  menu.showAtMouseEvent(event);
}

export function openKnowledgeCommandMenu(event: MouseEvent, onFillCommand: (command: string) => void): void {
  event.preventDefault();
  const menu = new Menu();
  for (const command of knowledgeCommandOptions()) {
    menu.addItem((item) =>
      item
        .setTitle(command.title)
        .setIcon(command.icon)
        .onClick(() => onFillCommand(command.text))
    );
  }
  menu.showAtMouseEvent(event);
}

export function openKnowledgeModelMenu(event: MouseEvent, state: ModelMenuState, callbacks: KnowledgeModelMenuCallbacks): void {
  openComposerParameterMenu(event, parameterSections(state, callbacks, false), "知识库模型和思考强度");
}

export function openModelMenu(event: MouseEvent, state: ModelMenuState, callbacks: ModelMenuCallbacks): void {
  openComposerParameterMenu(event, parameterSections(state, callbacks, true), "模型和运行参数");
}

export function closeComposerParameterMenu(): void {
  const active = activeComposerParameterMenu;
  if (!active) return;
  activeComposerParameterMenu = null;
  active.anchor.removeClass("is-open");
  active.anchor.setAttribute("aria-expanded", "false");
  active.submenu?.remove();
  active.root.remove();
  active.cleanup();
}

export function openSessionMenu(event: MouseEvent, knowledgeSession: boolean, callbacks: SessionMenuCallbacks): void {
  event.preventDefault();
  const menu = new Menu();
  if (!knowledgeSession) {
    menu.addItem((item) =>
      item
        .setTitle("重命名会话")
        .setIcon("pencil")
        .onClick(callbacks.onRename)
    );
  }
  menu.addItem((item) =>
    item
      .setTitle("重置 Agent 缓存")
      .setIcon("rotate-ccw")
      .onClick(callbacks.onResetCache)
  );
  if (!knowledgeSession) {
    menu.addItem((item) =>
      item
        .setTitle("删除会话")
        .setIcon("trash")
        .setWarning(true)
        .onClick(callbacks.onDelete)
    );
  }
  menu.showAtMouseEvent(event);
}

export function renderSkillMatches(container: HTMLElement, query: string, state: SkillMatchesState, callbacks: SkillMatchesCallbacks): void {
  container.empty();
  const matches = filterSkillResources(state.skills, query);
  for (const skill of matches) {
    const item = container.createDiv({ cls: "codex-skill-item" });
    item.toggleClass("is-selected", state.selectedSkill?.id === skill.id);
    const heading = item.createDiv({ cls: "codex-skill-heading" });
    const icon = heading.createSpan({ cls: "codex-skill-icon" });
    setIcon(icon, "box");
    heading.createDiv({ cls: "codex-skill-name", text: skill.name });
    item.createDiv({ cls: "codex-skill-desc", text: skill.description || skill.contentPath || skill.source });
    item.onclick = () => callbacks.onSelectSkill(skill);
  }
  if (matches.length === 0) container.createDiv({ cls: "codex-skill-empty", text: "没有匹配的 skill" });
  container.addClass("is-visible");
}

export function renderKnowledgeCommandMatches(
  container: HTMLElement,
  input: HTMLTextAreaElement,
  query: string,
  onFillCommand: (command: string) => void
): void {
  container.empty();
  const matches = knowledgeCommandOptions(query);
  matches.forEach((command, index) => container.appendChild(createKnowledgeCommandItem(container, input, command, index, onFillCommand)));
  if (matches.length === 0) container.createDiv({ cls: "codex-skill-empty", text: "没有匹配的知识库命令" });
  container.scrollTop = 0;
  setKnowledgeCommandMenuOpen(input, container, true);
  selectKnowledgeCommandItem(input, container, matches.length > 0 ? 0 : -1);
}

function modelChoicesForState(state: ModelMenuState): CodexModel[] {
  return state.providerModels.length
    ? ensureModelChoices([], ...state.providerModels)
    : ensureModelChoices(state.availableModels, state.selectedModel, state.defaultModel, DEFAULT_SETTINGS.defaultModel);
}

function parameterSections(
  state: ModelMenuState,
  callbacks: KnowledgeModelMenuCallbacks | ModelMenuCallbacks,
  includeRuntimeOptions: boolean
): ComposerParameterSection[] {
  const models = modelChoicesForState(state);
  const selectedModel = models.find((model) => model.model === state.selectedModel || model.model === state.effectiveModel);
  const sections: ComposerParameterSection[] = [
    {
      id: "model",
      icon: "box",
      label: "模型",
      currentValue: state.selectedModel ? selectedModel?.displayName || selectedModel?.model || state.selectedModel : "自动",
      options: [
        { value: "", label: "自动", selected: !state.selectedModel },
        ...models.map((model) => ({
          value: model.model,
          label: model.displayName || model.model,
          selected: Boolean(state.selectedModel) && (state.selectedModel === model.model || state.effectiveModel === model.model)
        }))
      ],
      onSelect: callbacks.onSelectModel
    },
    {
      id: "reasoning",
      icon: "brain",
      label: "思考强度",
      currentValue: labelFor(state.selectedReasoning),
      options: (["low", "medium", "high", "xhigh"] as ReasoningEffort[]).map((effort) => ({
        value: effort,
        label: labelFor(effort),
        selected: state.selectedReasoning === effort
      })),
      onSelect: (value) => callbacks.onSelectReasoning(value as ReasoningEffort)
    }
  ];
  if (!includeRuntimeOptions) return sections;

  const runtimeCallbacks = callbacks as ModelMenuCallbacks;
  sections.push(
    {
      id: "speed",
      icon: "gauge",
      label: "速度",
      currentValue: labelFor(state.selectedServiceTier),
      options: (["standard", "fast", "flex"] as ServiceTierChoice[]).map((tier) => ({
        value: tier,
        label: labelFor(tier),
        selected: state.selectedServiceTier === tier
      })),
      onSelect: (value) => runtimeCallbacks.onSelectServiceTier(value as ServiceTierChoice)
    },
    {
      id: "mode",
      icon: "route",
      label: "模式",
      currentValue: labelFor(state.selectedMode),
      options: (["agent", "plan"] as UiMode[]).map((mode) => ({
        value: mode,
        label: labelFor(mode),
        selected: state.selectedMode === mode
      })),
      onSelect: (value) => runtimeCallbacks.onSelectMode(value as UiMode)
    }
  );
  return sections;
}

function openComposerParameterMenu(event: MouseEvent, sections: ComposerParameterSection[], ariaLabel: string): void {
  event.preventDefault();
  event.stopPropagation();
  const anchor = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
  if (!anchor) return;
  if (activeComposerParameterMenu?.anchor === anchor) {
    closeComposerParameterMenu();
    return;
  }
  closeComposerParameterMenu();

  const doc = anchor.ownerDocument;
  const view = doc.defaultView ?? window;
  const root = doc.createElement("div");
  root.className = "codex-composer-parameter-menu";
  root.setAttribute("role", "menu");
  root.setAttribute("aria-label", ariaLabel);
  root.setCssStyles({ visibility: "hidden" });
  doc.body.appendChild(root);

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

  for (const section of sections) {
    const trigger = createParameterTrigger(root, section);
    trigger.onmouseenter = () => openParameterSubmenu(active, section, trigger, false);
    trigger.onclick = (clickEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      openParameterSubmenu(active, section, trigger, true);
    };
    trigger.onkeydown = (keyEvent) => {
      if (keyEvent.key !== "ArrowRight" && keyEvent.key !== "Enter" && keyEvent.key !== " ") return;
      keyEvent.preventDefault();
      openParameterSubmenu(active, section, trigger, true);
    };
  }

  const reposition = () => {
    if (!anchor.isConnected) {
      closeComposerParameterMenu();
      return;
    }
    const anchorRect = anchor.getBoundingClientRect();
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
    const target = pointerEvent.target instanceof Node ? pointerEvent.target : null;
    if (!target || root.contains(target) || active.submenu?.contains(target) || anchor.contains(target)) return;
    closeComposerParameterMenu();
  };
  const onKeyDown = (keyEvent: KeyboardEvent) => {
    if (keyEvent.key !== "Escape") return;
    keyEvent.preventDefault();
    if (active.submenu) {
      active.submenu.remove();
      active.submenu = null;
      active.activeSectionId = "";
      active.activeTrigger?.removeClass("is-open");
      active.activeTrigger?.setAttribute("aria-expanded", "false");
      active.activeTrigger?.focus();
      active.activeTrigger = null;
      return;
    }
    closeComposerParameterMenu();
    anchor.focus();
  };
  const observer = new MutationObserver(() => {
    if (!anchor.isConnected) closeComposerParameterMenu();
  });
  observer.observe(doc.body, { childList: true, subtree: true });
  doc.addEventListener("pointerdown", onPointerDown, true);
  doc.addEventListener("keydown", onKeyDown, true);
  doc.addEventListener("scroll", reposition, true);
  view.addEventListener("resize", reposition);
  active.cleanup = () => {
    observer.disconnect();
    doc.removeEventListener("pointerdown", onPointerDown, true);
    doc.removeEventListener("keydown", onKeyDown, true);
    doc.removeEventListener("scroll", reposition, true);
    view.removeEventListener("resize", reposition);
  };

  reposition();
  root.querySelector<HTMLButtonElement>("button")?.focus();
}

function createParameterTrigger(container: HTMLElement, section: ComposerParameterSection): HTMLButtonElement {
  const trigger = container.createEl("button", {
    cls: "codex-parameter-menu-item codex-parameter-menu-trigger",
    attr: {
      type: "button",
      role: "menuitem",
      "aria-haspopup": "menu",
      "aria-expanded": "false"
    }
  });
  const icon = trigger.createSpan({ cls: "codex-parameter-menu-icon" });
  setIcon(icon, section.icon);
  trigger.createSpan({ cls: "codex-parameter-menu-label", text: section.label });
  trigger.createSpan({ cls: "codex-parameter-menu-value", text: section.currentValue });
  const chevron = trigger.createSpan({ cls: "codex-parameter-menu-chevron" });
  setIcon(chevron, "chevron-right");
  return trigger;
}

function openParameterSubmenu(
  active: ActiveComposerParameterMenu,
  section: ComposerParameterSection,
  trigger: HTMLButtonElement,
  focusFirstOption: boolean
): void {
  if (activeComposerParameterMenu !== active) return;
  if (active.activeSectionId === section.id && active.submenu) {
    if (focusFirstOption) active.submenu.querySelector<HTMLButtonElement>("button")?.focus();
    return;
  }

  active.activeTrigger?.removeClass("is-open");
  active.activeTrigger?.setAttribute("aria-expanded", "false");
  active.submenu?.remove();
  active.activeTrigger = trigger;
  active.activeSectionId = section.id;
  trigger.addClass("is-open");
  trigger.setAttribute("aria-expanded", "true");

  const panel = active.root.ownerDocument.createElement("div");
  panel.className = "codex-composer-parameter-submenu";
  panel.setAttribute("role", "menu");
  panel.setAttribute("aria-label", section.label);
  panel.setCssStyles({ visibility: "hidden" });
  panel.createDiv({ cls: "codex-parameter-submenu-title", text: section.label });
  for (const option of section.options) {
    const button = panel.createEl("button", {
      cls: `codex-parameter-menu-item codex-parameter-option${option.selected ? " is-selected" : ""}`,
      attr: {
        type: "button",
        role: "menuitemradio",
        "aria-checked": String(option.selected)
      }
    });
    button.createSpan({ cls: "codex-parameter-option-label", text: option.label });
    const check = button.createSpan({ cls: "codex-parameter-option-check" });
    if (option.selected) setIcon(check, "check");
    button.onclick = (clickEvent) => {
      clickEvent.preventDefault();
      clickEvent.stopPropagation();
      closeComposerParameterMenu();
      section.onSelect(option.value);
    };
  }
  panel.onkeydown = (keyEvent) => {
    if (keyEvent.key !== "ArrowLeft") return;
    keyEvent.preventDefault();
    panel.remove();
    active.submenu = null;
    active.activeSectionId = "";
    trigger.removeClass("is-open");
    trigger.setAttribute("aria-expanded", "false");
    trigger.focus();
  };
  active.root.ownerDocument.body.appendChild(panel);
  active.submenu = panel;
  positionActiveSubmenu(active);
  if (focusFirstOption) panel.querySelector<HTMLButtonElement>("button")?.focus();
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
  const item = document.createElement("button");
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
