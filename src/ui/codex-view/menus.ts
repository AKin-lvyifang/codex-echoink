import { Menu, Notice, setIcon } from "obsidian";
import { DEFAULT_SETTINGS, ensureModelChoices } from "../../settings/settings";
import { filterSkillResources } from "../../resources/registry";
import type { EchoInkResource } from "../../resources/types";
import type { CodexModel, ReasoningEffort, ServiceTierChoice, UiMode } from "../../types/app-server";
import { knowledgeCommandOptions, type KnowledgeBaseCommandOption } from "../../knowledge-base/commands";
import { labelFor } from "./composer";

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
  onDelete: () => void;
}

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
  event.preventDefault();
  const menu = new Menu();
  const models = modelChoicesForState(state);
  menu.addItem((item) => item.setTitle("知识库模型").setIsLabel(true));
  if (!state.providerModels.length) {
    menu.addItem((item) =>
      item
        .setTitle("自动")
        .setIcon("wand-sparkles")
        .setChecked(!state.selectedModel)
        .onClick(() => callbacks.onSelectModel(""))
    );
  }
  for (const model of models) {
    menu.addItem((item) =>
      item
        .setTitle(model.displayName || model.model)
        .setIcon("box")
        .setChecked(state.effectiveModel === model.model)
        .onClick(() => callbacks.onSelectModel(model.model))
    );
  }
  addReasoningSection(menu, state.selectedReasoning, callbacks.onSelectReasoning);
  menu.showAtMouseEvent(event);
}

export function openModelMenu(event: MouseEvent, state: ModelMenuState, callbacks: ModelMenuCallbacks): void {
  event.preventDefault();
  const menu = new Menu();
  const models = modelChoicesForState(state);
  menu.addItem((item) => item.setTitle("模型").setIsLabel(true));
  if (!state.providerModels.length) {
    menu.addItem((item) =>
      item
        .setTitle("自动")
        .setIcon("wand-sparkles")
        .setChecked(!state.selectedModel)
        .onClick(() => callbacks.onSelectModel(""))
    );
  }
  if (models.length) {
    for (const model of models) {
      menu.addItem((item) =>
        item
          .setTitle(model.displayName || model.model)
          .setIcon("box")
          .setChecked(state.effectiveModel === model.model)
          .onClick(() => callbacks.onSelectModel(model.model))
      );
    }
  } else {
    menu.addItem((item) => item.setTitle(state.selectedModel || "自动").setIcon("box").setChecked(true));
  }
  addReasoningSection(menu, state.selectedReasoning, callbacks.onSelectReasoning);
  menu.addSeparator();
  menu.addItem((item) => item.setTitle("速度").setIsLabel(true));
  for (const tier of ["standard", "fast", "flex"] as ServiceTierChoice[]) {
    menu.addItem((item) =>
      item
        .setTitle(labelFor(tier))
        .setIcon("gauge")
        .setChecked(state.selectedServiceTier === tier)
        .onClick(() => callbacks.onSelectServiceTier(tier))
    );
  }
  menu.addSeparator();
  menu.addItem((item) => item.setTitle("模式").setIsLabel(true));
  for (const mode of ["agent", "plan"] as UiMode[]) {
    menu.addItem((item) =>
      item
        .setTitle(labelFor(mode))
        .setIcon("route")
        .setChecked(state.selectedMode === mode)
        .onClick(() => callbacks.onSelectMode(mode))
    );
  }
  menu.showAtMouseEvent(event);
}

export function openSessionMenu(event: MouseEvent, knowledgeSession: boolean, callbacks: SessionMenuCallbacks): void {
  event.preventDefault();
  if (knowledgeSession) {
    new Notice("知识库管理频道是常驻频道，不能删除");
    return;
  }
  const menu = new Menu();
  menu.addItem((item) =>
    item
      .setTitle("重命名会话")
      .setIcon("pencil")
      .onClick(callbacks.onRename)
  );
  menu.addItem((item) =>
    item
      .setTitle("删除会话")
      .setIcon("trash")
      .setWarning(true)
      .onClick(callbacks.onDelete)
  );
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

export function renderKnowledgeCommandMatches(container: HTMLElement, query: string, onFillCommand: (command: string) => void): void {
  container.empty();
  const matches = knowledgeCommandOptions(query);
  for (const command of matches) container.appendChild(createKnowledgeCommandItem(command, onFillCommand));
  if (matches.length === 0) container.createDiv({ cls: "codex-skill-empty", text: "没有匹配的知识库命令" });
  container.addClass("is-visible");
}

function modelChoicesForState(state: ModelMenuState): CodexModel[] {
  return state.providerModels.length
    ? ensureModelChoices([], ...state.providerModels)
    : ensureModelChoices(state.availableModels, state.selectedModel, state.defaultModel, DEFAULT_SETTINGS.defaultModel);
}

function addReasoningSection(menu: Menu, selectedReasoning: ReasoningEffort, onSelectReasoning: (reasoning: ReasoningEffort) => void): void {
  menu.addSeparator();
  menu.addItem((item) => item.setTitle("思考强度").setIsLabel(true));
  for (const effort of ["low", "medium", "high", "xhigh"] as ReasoningEffort[]) {
    menu.addItem((item) =>
      item
        .setTitle(labelFor(effort))
        .setIcon("brain")
        .setChecked(selectedReasoning === effort)
        .onClick(() => onSelectReasoning(effort))
    );
  }
}

function createKnowledgeCommandItem(command: KnowledgeBaseCommandOption, onFillCommand: (command: string) => void): HTMLElement {
  const item = document.createElement("div");
  item.addClass("codex-command-item");
  const icon = item.createSpan({ cls: "codex-command-icon" });
  setIcon(icon, command.icon);
  const body = item.createDiv({ cls: "codex-command-body" });
  const heading = body.createDiv({ cls: "codex-command-heading" });
  heading.createSpan({ cls: "codex-command-text", text: command.text.trim() });
  heading.createSpan({ cls: "codex-command-title", text: command.title });
  body.createDiv({ cls: "codex-command-desc", text: command.description });
  item.onclick = () => onFillCommand(command.text);
  return item;
}
