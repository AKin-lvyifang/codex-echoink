import type { AgentEditorHost } from "./agent-editor-contract";
import { setIcon } from "obsidian";
import { AGENT_MODULE_IDS, GENERAL_ASSISTANT_ID, type AgentDefinition, type AgentModuleId } from "../../agents/types";
import { AGENT_PRESETS } from "../../agents/presets";
import { AGENT_STYLES } from "../../agents/styles";
import { mcpToolCapabilityId, vaultSkillCapabilityId } from "../../agents/capability-policy";
import { BUILTIN_SKILL_IDS } from "../../harness/resources/builtin-skills";
import { normalizeAgentDisplayName } from "../../harness/memory/agent-identity-model";
import { AGENT_AVATAR_PRESETS, resolveAgentAvatarUrl } from "../agent-avatar-presets";
import { AvatarProcessingError, createBrowserAvatarRenderer, processAgentAvatar } from "../agent-avatar-processor";
import { createOriginButton, createOriginCheck, createOriginInput, createOriginRadioGroup, disposeOriginControls, type OriginCheckElement } from "../../settings/origin-controls";
import { applyAmicroButton, setAmicroButtonPending } from "../../settings/amicro-buttons";
import { showSettingsInlineConfirmation } from "../../settings/settings-v2";
import { resolveMcpConnectionRecord } from "../../resources/mcp-connections";
import type { EchoInkResource } from "../../resources/types";

const MODULE_NAMES: Record<AgentModuleId, string> = { journal: "日记", todos: "待办", finance: "财务", "knowledge-base": "知识库", "english-diary": "英文日记", "pdf-reading": "PDF 精读", review: "复盘" };
const MODULE_CAPABILITY = (id: AgentModuleId) => id === "knowledge-base" ? "knowledge" : id;
const CAPABILITIES = [
  ["journal", "日记", "Journal"], ["todos", "待办", "To-dos"], ["finance", "财务", "Finance"], ["knowledge", "知识整理", "Knowledge organization"],
  ["english-diary", "英文日记", "English diary"], ["pdf-reading", "PDF 精读", "PDF reading"], ["review", "复盘", "Review"],
  ["web-search", "联网搜索", "Web search"], ["obsidian-plugins", "Obsidian 插件管理", "Obsidian plugin management"]
] as const;
const MODULE_NAMES_EN: Record<AgentModuleId, string> = { journal: "Journal", todos: "To-dos", finance: "Finance", "knowledge-base": "Knowledge base", "english-diary": "English diary", "pdf-reading": "PDF reading", review: "Review" };
const PRESET_NAMES_EN: Record<string, string> = { organizer: "Organizer", bookkeeper: "Bookkeeper", researcher: "Researcher", "journal-companion": "Journal companion", reviewer: "Reviewer" };
const STYLE_COPY_EN: Record<AgentDefinition["styleId"], { name: string; description: string }> = {
  execution: { name: "Direct execution", description: "Focus on the goal, constraints and acceptance criteria, then take the shortest useful path. Be concise and direct. Conclusion → actions → risks." },
  analysis: { name: "Careful analysis", description: "Check assumptions, evidence and omissions; weigh the strongest alternatives before deciding. Stay measured and evidence-led. Judgment → evidence → uncertainty." },
  companion: { name: "Gentle companion", description: "Acknowledge feelings and circumstances, clarify the problem and constraints, then suggest a small practical step. Be warm and considerate. Response → clarity → one suggestion." },
  creative: { name: "Creative exploration", description: "Explore distinct possibilities, then choose a direction that fits the goal and constraints. Be lively and imaginative. Options → recommendation → next step." }
};
interface EditorDraft { agent: AgentDefinition; moduleIds: AgentModuleId[]; presetId: string; dirty: boolean; revision: number }
// No DOM, View, host callback, promise or runtime is retained across View instances.
const formDrafts = new WeakMap<object, Map<string, EditorDraft>>();
let editorSequence = 0;

export class AgentEditorController {
  private readonly instanceId = `echoink-agent-editor-${++editorSequence}`;
  private root: HTMLElement | null = null;
  private draft: EditorDraft | null = null;
  private editingId: string | undefined;
  private cacheKey = "new";
  private resources: readonly EchoInkResource[] = [];
  private loadingResources = false;
  private resourceError = "";
  private error = "";
  private avatarError = "";
  private disposed = false;
  private generation = 0;
  private busy: "save" | "delete" | "avatar" | null = null;
  private saveButton: HTMLButtonElement | null = null;
  private status: HTMLElement | null = null;
  private nameError: HTMLElement | null = null;
  private nameInput: HTMLInputElement | null = null;
  private resourceArea: HTMLElement | null = null;
  private deleteArea: HTMLElement | null = null;
  private ownership = new Map<AgentModuleId, HTMLElement>();
  private capabilityChecks = new Map<string, OriginCheckElement>();
  private mcpChecks: Array<{ check: OriginCheckElement; ids: string[] }> = [];
  private deleteCounts: { total: number; running: number } | null = null;
  private deleteLoading = false;
  private deleteError = "";

  constructor(private readonly host: AgentEditorHost) {}

  private t(zh: string, en: string): string { return this.host.settings.settingsLanguage === "en" ? en : zh; }
  private moduleName(id: AgentModuleId): string { return this.t(MODULE_NAMES[id], MODULE_NAMES_EN[id]); }
  private capabilityName(id: string): string {
    const copy = CAPABILITIES.find(([capability]) => capability === id);
    return copy ? this.t(copy[1], copy[2]) : id;
  }
  private availabilityReason(reason: string): string {
    if (this.host.settings.settingsLanguage !== "en") return reason;
    // Only known system status copy is localized. Resource names, tool names,
    // user identity fields and arbitrary source/error text remain verbatim.
    const copy: Record<string, string> = {
      "对应功能尚未启用": "This feature is not enabled",
      "需要有效 PRO，已有资料仍可查看": "A valid PRO membership is required; existing data remains readable",
      "资源已禁用或不可用": "Resource disabled or unavailable",
      "资源不可用": "Resource unavailable",
      "PRO 已到期": "PRO membership has expired"
    };
    return copy[reason] ?? reason;
  }

  open(agentId?: string): void {
    this.generation++;
    this.editingId = agentId;
    this.cacheKey = agentId ?? "new";
    this.disposed = false;
    this.busy = null; this.error = ""; this.avatarError = ""; this.deleteError = "";
    this.deleteCounts = null; this.deleteLoading = false;
    const current = this.host.settings.agentRegistry.agents.find(agent => agent.id === agentId);
    const saved = formDrafts.get(this.host.draftCacheKey)?.get(this.cacheKey);
    this.draft = saved ? structuredClone(saved) : { agent: current ? structuredClone(current) : {
      id: `agent-${globalThis.crypto.randomUUID()}`, name: "", avatar: { kind: "default" }, position: "", styleId: "execution", capabilityIds: []
    }, moduleIds: current ? AGENT_MODULE_IDS.filter(id => this.host.settings.agentRegistry.moduleOwners[id] === current.id) : [], presetId: "", dirty: false, revision: 0 };
    this.persistDraft();
    void this.reloadResources();
  }

  render(root: HTMLElement): void {
    if (!this.draft || this.disposed) return;
    if (this.root) disposeOriginControls(this.root);
    this.root = root;
    root.replaceChildren(); root.lang = this.host.settings.settingsLanguage === "en" ? "en" : "zh-CN"; root.classList.add("echoink-agent-editor", "echoink-theme-boundary");
    this.ownership.clear(); this.capabilityChecks.clear(); this.mcpChecks = [];
    const header = this.el(root, "header", "echoink-agent-editor-header");
    const back = this.button(header, this.t("返回", "Back"), "tertiary", () => this.close(false));
    back.setAttribute("aria-label", this.t("返回 Agent 任务", "Back to Agent tasks"));
    this.el(header, "h2", "echoink-agent-editor-title", this.editingId ? this.t("编辑 Agent", "Edit Agent") : this.t("新建 Agent", "New Agent"));
    const body = this.el(root, "div", "echoink-agent-editor-body");
    const fields = this.el(body, "fieldset", "echoink-agent-editor-fields");
    if (!this.editingId) this.renderPresets(fields);
    this.renderIdentity(fields);
    this.renderResponsibilities(fields);
    this.resourceArea = this.el(fields, "section", "echoink-agent-editor-resources");
    this.renderResources();
    this.renderStyles(fields);
    this.deleteArea = this.el(body, "section", "echoink-agent-editor-delete");
    this.renderDelete();
    const footer = this.el(root, "footer", "echoink-agent-editor-footer");
    this.status = this.el(footer, "div", "echoink-agent-editor-status");
    this.status.setAttribute("role", "status"); this.status.setAttribute("aria-live", "polite");
    const actions = this.el(footer, "div", "echoink-agent-editor-actions");
    this.button(actions, this.t("取消", "Cancel"), "secondary", () => this.close(true));
    this.saveButton = this.button(actions, this.editingId ? this.t("保存", "Save") : this.t("创建", "Create"), "primary", () => { void this.save(); });
    this.saveButton.dataset.action = "save-agent";
    this.refresh();
  }

  dispose(): void {
    this.persistDraft(); this.disposed = true; this.generation++;
    if (this.root) {
      disposeOriginControls(this.root); this.root.replaceChildren();
      this.root.classList.remove("echoink-agent-editor", "echoink-theme-boundary"); this.root.removeAttribute("lang");
    }
    this.root = null; this.status = null; this.saveButton = null; this.nameInput = null; this.nameError = null;
    this.resourceArea = null; this.deleteArea = null; this.ownership.clear(); this.capabilityChecks.clear(); this.mcpChecks = [];
  }

  private el<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
    const element = parent.ownerDocument.createElement(tag);
    if (cls) element.className = cls;
    if (text !== undefined) element.textContent = text;
    parent.append(element); return element;
  }
  private button(parent: HTMLElement, text: string, variant: "primary" | "secondary" | "tertiary" | "danger", action: () => void): HTMLButtonElement {
    const button = createOriginButton(parent, { text, cls: `echoink-agent-editor-button${variant === "primary" ? " mod-cta" : ""}`, attr: { type: "button" } });
    applyAmicroButton(button, { variant, motion: "none" });
    button.onclick = () => { if (!button.disabled && !this.busy) action(); }; return button;
  }
  private section(parent: HTMLElement, title: string): HTMLElement {
    const section = this.el(parent, "section", "echoink-agent-editor-section");
    this.el(section, "h3", "echoink-agent-editor-section-title", title); return section;
  }
  private changed(): void {
    if (!this.draft) return;
    this.draft.dirty = true; this.draft.revision++; this.error = ""; this.persistDraft(); this.refresh();
  }
  private persistDraft(): void {
    if (!this.draft) return;
    let drafts = formDrafts.get(this.host.draftCacheKey);
    if (!drafts) { drafts = new Map(); formDrafts.set(this.host.draftCacheKey, drafts); }
    drafts.set(this.cacheKey, structuredClone(this.draft));
  }
  private close(discard: boolean): void {
    if (this.busy) return;
    if (discard) { formDrafts.get(this.host.draftCacheKey)?.delete(this.cacheKey); this.draft = null; }
    else this.persistDraft();
    this.dispose();
    this.host.onClose();
  }
  private invalidAgent(): boolean { return !!this.editingId && !this.host.settings.agentRegistry.agents.some(agent => agent.id === this.editingId); }

  private renderPresets(parent: HTMLElement): void {
    const section = this.section(parent, this.t("从预设开始", "Start from a preset"));
    const group = createOriginRadioGroup(section, this.draft!.presetId, this.t("从预设开始", "Start from a preset"), value => {
      const preset = AGENT_PRESETS.find(item => item.presetId === value); if (!preset || this.busy) return;
      const apply = () => {
        const id = this.draft!.agent.id;
        this.draft = { agent: { ...structuredClone(preset.agent), id }, moduleIds: [...preset.moduleIds], presetId: value, dirty: false, revision: this.draft!.revision + 1 };
        this.persistDraft(); if (this.root) this.render(this.root);
      };
      const trigger = section.querySelector<HTMLButtonElement>(`[data-preset="${value}"]`)!;
      if (this.draft!.dirty) {
        showSettingsInlineConfirmation(section, trigger, { message: this.t("用预设替换当前未保存的表单？", "Replace the unsaved form with this preset?"), confirmLabel: this.t("使用预设", "Use preset"), cancelLabel: this.t("保留修改", "Keep changes"), onConfirm: async () => { apply(); } });
        section.querySelector<HTMLButtonElement>(".echoink-settings-inline-confirm button")?.addEventListener("click", () => queueMicrotask(() => { if (this.root && !this.disposed) this.render(this.root); }));
      }
      else queueMicrotask(() => { if (this.root && !this.disposed) apply(); });
    });
    group.element.classList.add("echoink-agent-editor-presets");
    for (const preset of AGENT_PRESETS) {
      const row = this.el(group.element, "label", "echoink-agent-editor-choice");
      const radio = group.addItem(row, preset.presetId, false); radio.dataset.preset = preset.presetId; radio.setAttribute("aria-label", this.t(preset.agent.name, PRESET_NAMES_EN[preset.presetId]));
      this.el(row, "span", "", this.t(preset.agent.name, PRESET_NAMES_EN[preset.presetId]));
    }
  }

  private renderIdentity(parent: HTMLElement): void {
    const section = this.section(parent, this.t("名字与头像、职位", "Name, avatar and role"));
    const nameId = `${this.instanceId}-name`;
    const label = this.el(section, "label", "echoink-agent-editor-label", this.t("名字", "Name")); label.htmlFor = nameId;
    this.nameInput = createOriginInput(section, { value: this.draft!.agent.name, attr: { id: nameId, autocomplete: "off", maxlength: "96", "aria-describedby": `${nameId}-error` } });
    this.nameInput.dataset.field = "name";
    this.nameError = this.el(section, "div", "echoink-agent-editor-error"); this.nameError.id = `${nameId}-error`; this.nameError.setAttribute("aria-live", "polite");
    this.nameInput.oninput = () => { this.draft!.agent.name = this.nameInput!.value; this.changed(); };
    const avatar = this.el(section, "details", "echoink-agent-editor-avatars");
    const summary = this.el(avatar, "summary", "echoink-agent-editor-avatar-summary");
    const image = this.el(summary, "img", "echoink-agent-editor-avatar-preview"); image.alt = this.t("当前头像", "Current avatar");
    this.setAvatarImage(image);
    this.el(summary, "span", "", this.t("头像", "Avatar"));
    const chevron = this.el(summary, "span", "echoink-agent-editor-avatar-chevron"); chevron.setAttribute("aria-hidden", "true"); setIcon(chevron, "chevron-down");
    const grid = this.el(avatar, "div", "echoink-agent-editor-avatar-grid");
    const selected = this.draft!.agent.avatar;
    const choices = [{ value: "default", label: this.t("默认头像", "Default avatar"), avatar: { kind: "default" as const } }, ...AGENT_AVATAR_PRESETS.map(preset => ({ value: `preset:${preset.id}`, label: this.t(preset.labelZh, preset.labelEn), avatar: { kind: "preset" as const, presetId: preset.id } })),
      ...(selected.kind === "custom" ? [{ value: "custom", label: this.t("自定义头像", "Custom avatar"), avatar: selected }] : [])];
    const value = selected.kind === "preset" ? `preset:${selected.presetId}` : selected.kind;
    const radios = createOriginRadioGroup(grid, value, this.t("选择头像", "Choose an avatar"), value => {
      const choice = choices.find(choice => choice.value === value); if (!choice) return;
      this.draft!.agent.avatar = structuredClone(choice.avatar); this.avatarError = "";
      this.setAvatarImage(image); this.changed();
    });
    radios.element.classList.add("echoink-agent-editor-avatar-grid-inner");
    for (const choice of choices) {
      const tile = this.el(radios.element, "label", "echoink-agent-editor-avatar-option");
      const radio = radios.addItem(tile, choice.value, false); radio.setAttribute("aria-label", choice.label);
      const picture = this.el(tile, "img"); picture.alt = "";
      const url = resolveAgentAvatarUrl(choice.avatar) ?? resolveAgentAvatarUrl({ kind: "preset", presetId: "sol" }); if (url) picture.src = url;
    }
    const fileInput = this.el(avatar, "input"); fileInput.type = "file"; fileInput.accept = "image/svg+xml"; fileInput.hidden = true; fileInput.dataset.field = "avatar-file";
    this.button(avatar, this.t("上传 SVG 头像", "Upload SVG avatar"), "secondary", () => fileInput.click());
    const avatarError = this.el(section, "div", "echoink-agent-editor-error"); avatarError.setAttribute("role", "status");
    fileInput.onchange = () => {
      const file = fileInput.files?.[0]; if (!file || this.busy) return;
      const generation = this.generation; this.busy = "avatar"; this.refresh();
      void processAgentAvatar(file, file.type, file.size, createBrowserAvatarRenderer()).then(value => {
        if (this.disposed || generation !== this.generation) return;
        this.draft!.agent.avatar = value; this.avatarError = ""; this.changed();
      }).catch(error => {
        if (this.disposed || generation !== this.generation) return;
        this.avatarError = error instanceof AvatarProcessingError && error.code === "unsupported_type" ? this.t("只支持 SVG 头像。", "Only SVG avatars are supported.") : this.t("头像处理失败，请选择安全的正方形 SVG（不超过 4MB）。", "Could not process the avatar. Choose a safe, square SVG under 4MB.");
        avatarError.textContent = this.avatarError;
      }).finally(() => {
        fileInput.value = "";
        if (!this.disposed && generation === this.generation) { this.busy = null; if (this.root) this.render(this.root); }
      });
    };
    avatarError.textContent = this.avatarError;
    const positionId = `${this.instanceId}-position`;
    const positionLabel = this.el(section, "label", "echoink-agent-editor-label", this.t("职位", "Role")); positionLabel.htmlFor = positionId;
    const position = this.el(section, "textarea", "echoink-agent-editor-position"); position.id = positionId; position.rows = 2; position.value = this.draft!.agent.position;
    position.dataset.field = "position"; position.oninput = () => { this.draft!.agent.position = position.value; this.changed(); };
  }
  private setAvatarImage(image: HTMLImageElement): void {
    const url = resolveAgentAvatarUrl(this.draft!.agent.avatar) ?? resolveAgentAvatarUrl({ kind: "preset", presetId: "sol" }); if (url) image.src = url;
  }

  private renderResponsibilities(parent: HTMLElement): void {
    const section = this.section(parent, this.t("负责模块", "Responsible for"));
    for (const id of AGENT_MODULE_IDS) {
      const row = this.el(section, "label", "echoink-agent-editor-module");
      const check = createOriginCheck(row, { attr: { "aria-label": this.t(`负责${MODULE_NAMES[id]}`, `Responsible for ${MODULE_NAMES_EN[id]}`), "data-module-id": id } });
      check.checked = this.draft!.moduleIds.includes(id);
      const copy = this.el(row, "span", "echoink-agent-editor-choice-copy"); this.el(copy, "span", "", this.moduleName(id));
      this.ownership.set(id, this.el(copy, "span", "echoink-agent-editor-ownership"));
      check.onchange = () => { this.draft!.moduleIds = check.checked ? [...new Set([...this.draft!.moduleIds, id])] : this.draft!.moduleIds.filter(value => value !== id); this.changed(); };
    }
  }
  private selected(id: string): boolean {
    return this.draft!.agent.id === GENERAL_ASSISTANT_ID ? !this.draft!.agent.disabledCapabilityIds?.includes(id) : this.draft!.agent.capabilityIds?.includes(id) === true;
  }
  private setCapability(id: string, enabled: boolean): void {
    const agent = this.draft!.agent;
    const key = agent.id === GENERAL_ASSISTANT_ID ? "disabledCapabilityIds" : "capabilityIds";
    const contains = key === "disabledCapabilityIds" ? !enabled : enabled;
    const ids = new Set(agent[key] ?? []); if (contains) ids.add(id); else ids.delete(id); agent[key] = [...ids];
  }
  private capability(parent: HTMLElement, id: string, name: string, resource?: EchoInkResource, extraReason?: string): void {
    const row = this.el(parent, "label", "echoink-agent-editor-choice");
    const check = createOriginCheck(row, { attr: { "aria-label": name, "data-capability-id": id } });
    check.checked = this.selected(id); this.capabilityChecks.set(id, check);
    const copy = this.el(row, "span", "echoink-agent-editor-choice-copy"); this.el(copy, "span", "", name);
    const availability = this.host.getCapabilityAvailability?.(id);
    const reasons = [...new Set([availability?.available === false ? this.availabilityReason(availability.reason ?? this.t("当前不可用", "Currently unavailable")) : "", resource?.enabled === false ? this.t("资源未启用", "Resource disabled") : "", extraReason ?? ""].filter(Boolean))];
    if (reasons.length) this.el(copy, "span", "echoink-agent-editor-availability", reasons.join(this.t("；", "; ")));
    check.onchange = () => { this.setCapability(id, check.checked); this.changed(); };
  }
  private renderResources(): void {
    const area = this.resourceArea; if (!area) return;
    disposeOriginControls(area); area.replaceChildren(); this.capabilityChecks.clear(); this.mcpChecks = [];
    this.el(area, "h3", "echoink-agent-editor-section-title", this.t("能用的能力", "Capabilities"));
    const base = this.el(area, "div", "echoink-agent-editor-capabilities");
    for (const [id] of CAPABILITIES) this.capability(base, id, this.capabilityName(id));
    const bar = this.el(area, "div", "echoink-agent-editor-resource-heading"); this.el(bar, "h4", "", this.t("我的 Skill", "My Skills"));
    const reload = this.button(bar, this.loadingResources ? this.t("正在读取…", "Loading…") : this.t("刷新资源", "Refresh resources"), "tertiary", () => { void this.reloadResources(); }); reload.disabled = this.loadingResources;
    if (this.resourceError) this.el(area, "div", "echoink-agent-editor-error", this.resourceError).setAttribute("role", "alert");
    const custom = this.resources.filter(resource => resource.kind === "skill" && !(BUILTIN_SKILL_IDS as readonly string[]).includes(String(resource.metadata?.resourceId ?? "")));
    for (const resource of custom) this.capability(area, vaultSkillCapabilityId(resource.id), resource.name, resource);
    if (!custom.length && !this.loadingResources && !this.resourceError) this.el(area, "div", "echoink-agent-editor-empty", this.t("暂无自建 Skill", "No custom Skills"));
    this.el(area, "h4", "echoink-agent-editor-resource-heading", this.t("MCP 服务", "MCP services"));
    const servers = this.resources.filter(resource => resource.kind === "mcp-server");
    for (const resource of servers) {
      const record = resolveMcpConnectionRecord(resource, this.host.settings.resources);
      const details = this.el(area, "details", "echoink-agent-editor-mcp"); details.dataset.resourceId = resource.id;
      const head = this.el(details, "div", "echoink-agent-editor-mcp-heading");
      const label = this.el(head, "label", "echoink-agent-editor-choice");
      const check = createOriginCheck(label, { attr: { "aria-label": this.t(`MCP 服务：${resource.name}`, `MCP service: ${resource.name}`) } });
      this.el(label, "span", "", resource.name);
      const summary = this.el(details, "summary", "echoink-agent-editor-mcp-summary", this.t(`${record?.tools.length ?? 0} 个工具`, `${record?.tools.length ?? 0} ${record?.tools.length === 1 ? "tool" : "tools"}`));
      // Keep summary the first child for native details keyboard semantics;
      // the service checkbox has its own non-toggling sibling header.
      details.before(head); details.prepend(summary);
      const ids = (record?.tools ?? []).map(tool => mcpToolCapabilityId(resource.id, tool.name));
      this.mcpChecks.push({ check, ids }); check.disabled = !ids.length;
      const reason = !record ? this.t("尚未连接服务", "Service not connected") : !record.tools.length ? this.t("尚未发现可用工具", "No tools discovered") : !record.trusted ? this.t("服务尚未信任", "Service not trusted") : !resource.enabled ? this.t("服务未启用", "Service disabled") : "";
      if (reason) this.el(head, "span", "echoink-agent-editor-availability", reason);
      check.onchange = () => { for (const id of ids) this.setCapability(id, check.checked); this.changed(); };
      let rendered = false;
      details.ontoggle = () => {
        if (!details.open || rendered || this.disposed) return;
        rendered = true;
        for (const tool of record?.tools ?? []) this.capability(details, mcpToolCapabilityId(resource.id, tool.name), tool.name, resource,
          !record?.toolPolicies[tool.name]?.enabled ? this.t("工具未启用", "Tool disabled") : !record.toolPolicies[tool.name].trusted ? this.t("工具尚未信任", "Tool not trusted") : "");
        this.refresh();
      };
    }
    if (!servers.length && !this.loadingResources && !this.resourceError) this.el(area, "div", "echoink-agent-editor-empty", this.t("暂无已连接的 MCP 服务", "No connected MCP services"));
    this.refresh();
  }
  private async reloadResources(): Promise<void> {
    const generation = this.generation; this.loadingResources = true; this.resourceError = "";
    if (this.resourceArea) this.renderResources();
    try {
      const resources = await this.host.loadResources();
      if (this.disposed || generation !== this.generation) return;
      this.resources = resources;
    } catch (error) {
      if (this.disposed || generation !== this.generation) return;
      this.resourceError = error instanceof Error ? error.message : this.t("资源读取失败，请重试。", "Could not load resources. Please retry.");
    } finally {
      if (!this.disposed && generation === this.generation) { this.loadingResources = false; this.renderResources(); }
    }
  }

  private renderStyles(parent: HTMLElement): void {
    const section = this.section(parent, this.t("风格", "Style"));
    const description = this.el(section, "p", "echoink-agent-editor-style-description");
    const describe = () => {
      const style = AGENT_STYLES.find(style => style.id === this.draft!.agent.styleId)!;
      description.textContent = this.t(`${style.thinking} ${style.tone}；${style.responseStructure}。`, STYLE_COPY_EN[style.id].description);
    };
    const group = createOriginRadioGroup(section, this.draft!.agent.styleId, this.t("风格", "Style"), id => { this.draft!.agent.styleId = id as AgentDefinition["styleId"]; describe(); this.changed(); });
    for (const style of AGENT_STYLES) {
      const row = this.el(group.element, "label", "echoink-agent-editor-choice");
      const name = this.t(style.name, STYLE_COPY_EN[style.id].name);
      group.addItem(row, style.id, false).setAttribute("aria-label", name); this.el(row, "span", "", name);
    }
    section.append(description); describe();
  }

  private refresh(): void {
    if (!this.root || !this.draft) return;
    const invalidName = !normalizeAgentDisplayName(this.draft.agent.name);
    if (this.nameError) this.nameError.textContent = invalidName && this.draft.dirty ? this.t("名字需为 1–24 个字符，不能包含换行或制表符。", "Use 1–24 characters without line breaks or tabs.") : "";
    this.nameInput?.setAttribute("aria-invalid", String(invalidName && this.draft.dirty));
    if (this.status) this.status.textContent = this.invalidAgent() ? this.t("这个 Agent 已不存在，请返回。", "This Agent no longer exists. Go back to the task list.") : this.error || (this.busy === "save" ? this.t("正在保存…", "Saving…") : this.busy === "avatar" ? this.t("正在处理头像…", "Processing avatar…") : this.busy === "delete" ? this.t("正在停止任务并交回总助…", "Stopping tasks and transferring them to the general assistant…") : "");
    const fields = this.root.querySelector("fieldset"); if (fields) fields.disabled = !!this.busy;
    this.root.setAttribute("aria-busy", String(!!this.busy));
    for (const button of Array.from(this.root.querySelectorAll<HTMLButtonElement>(".echoink-agent-editor-header button,.echoink-agent-editor-footer button"))) button.disabled = !!this.busy;
    if (this.saveButton) { this.saveButton.disabled = !!this.busy || invalidName || this.invalidAgent() || this.loadingResources || !!this.deleteCounts; setAmicroButtonPending(this.saveButton, this.busy === "save"); }
    for (const [id, element] of this.ownership) {
      const selected = this.draft.moduleIds.includes(id);
      const ownerId = this.host.settings.agentRegistry.moduleOwners[id];
      const owner = this.host.settings.agentRegistry.agents.find(agent => agent.id === ownerId)?.name ?? this.t("原负责人", "Previous owner");
      const target = this.draft.agent.name.trim() || this.t("当前 Agent", "Current Agent");
      const moved = selected && ownerId !== this.draft.agent.id ? `${owner} → ${target}` : "";
      const missing = selected && !this.selected(MODULE_CAPABILITY(id)) ? this.t(`缺少「${this.capabilityName(MODULE_CAPABILITY(id))}」能力`, `Missing “${this.capabilityName(MODULE_CAPABILITY(id))}” capability`) : "";
      element.textContent = [moved, missing].filter(Boolean).join(this.t("；", "; "));
    }
    for (const [id, check] of this.capabilityChecks) check.checked = this.selected(id);
    for (const { check, ids } of this.mcpChecks) { const count = ids.filter(id => this.selected(id)).length; check.checked = !!ids.length && count === ids.length; check.indeterminate = count > 0 && count < ids.length; }
  }
  private async save(): Promise<void> {
    if (!this.draft || this.busy || this.invalidAgent() || this.loadingResources) return;
    const name = normalizeAgentDisplayName(this.draft.agent.name);
    if (!name) { this.draft.dirty = true; this.refresh(); this.nameInput?.focus(); return; }
    const generation = this.generation, key = this.cacheKey, revision = this.draft.revision;
    const agent = { ...structuredClone(this.draft.agent), name, position: this.draft.agent.position.trim() };
    this.busy = "save"; this.error = ""; this.refresh();
    try {
      await this.host.saveAgent(agent, [...this.draft.moduleIds]);
      if (formDrafts.get(this.host.draftCacheKey)?.get(key)?.revision === revision) formDrafts.get(this.host.draftCacheKey)?.delete(key);
      if (!this.disposed && generation === this.generation) { this.draft = null; this.dispose(); this.host.onClose(agent.id); }
    } catch (error) {
      if (!this.disposed && generation === this.generation) this.error = error instanceof Error ? error.message : this.t("保存失败，请重试。", "Could not save. Please retry.");
    } finally { if (!this.disposed && generation === this.generation) { this.busy = null; this.refresh(); } }
  }

  private renderDelete(): void {
    const area = this.deleteArea; if (!area) return;
    disposeOriginControls(area); area.replaceChildren();
    if (!this.editingId || this.editingId === GENERAL_ASSISTANT_ID) return;
    const trigger = this.button(area, this.deleteLoading ? this.t("正在读取任务数量…", "Loading task counts…") : this.t("删除 Agent", "Delete Agent"), "danger", () => { void this.requestDelete(); });
    trigger.dataset.action = "delete-agent"; trigger.disabled = this.deleteLoading || !!this.busy;
    trigger.setAttribute("aria-expanded", String(!!this.deleteCounts));
    if (this.deleteError) this.el(area, "p", "echoink-agent-editor-error", this.deleteError).setAttribute("role", "alert");
    if (!this.deleteCounts) return;
    const panel = this.el(area, "div", "echoink-agent-editor-confirm"); panel.setAttribute("role", "group"); panel.setAttribute("aria-label", this.t("确认删除 Agent", "Confirm Agent deletion"));
    this.el(panel, "p", "", this.t(`它名下有 ${this.deleteCounts.total} 件事（${this.deleteCounts.running} 件正在进行）会交给总助。正在进行的会先停下，不会自动重新执行。`, `Its ${this.deleteCounts.total} ${this.deleteCounts.total === 1 ? "task" : "tasks"} (${this.deleteCounts.running} running) will be transferred to the general assistant. Running tasks will be stopped first and will not restart automatically.`));
    const actions = this.el(panel, "div", "echoink-agent-editor-actions");
    const cancel = this.button(actions, this.t("取消删除", "Cancel deletion"), "secondary", () => { this.deleteCounts = null; this.deleteError = ""; this.renderDelete(); this.refresh(); this.deleteArea?.querySelector<HTMLButtonElement>("button")?.focus(); });
    const confirm = this.button(actions, this.busy === "delete" ? this.t("正在停止任务并交回总助…", "Stopping tasks and transferring them to the general assistant…") : this.t("删除并交回总助", "Delete and transfer to the general assistant"), "danger", () => { void this.delete(); });
    confirm.dataset.action = "confirm-delete"; confirm.disabled = cancel.disabled = !!this.busy;
    panel.onkeydown = event => {
      if (event.key !== "Escape" || this.busy) return;
      event.preventDefault(); event.stopPropagation(); cancel.click();
    };
    if (!this.busy) cancel.focus({ preventScroll: true });
  }
  private async requestDelete(): Promise<void> {
    if (!this.editingId || this.editingId === GENERAL_ASSISTANT_ID || this.busy || this.deleteLoading) return;
    const generation = this.generation; this.deleteLoading = true; this.deleteError = ""; this.renderDelete();
    try {
      const counts = await this.host.getDeleteCounts(this.editingId);
      if (this.disposed || generation !== this.generation) return;
      if (!Number.isSafeInteger(counts.total) || counts.total < 0 || !Number.isSafeInteger(counts.running) || counts.running < 0 || counts.running > counts.total) throw new Error(this.t("任务数量读取失败，请重试。", "Could not load task counts. Please retry."));
      this.deleteCounts = counts;
    } catch (error) { if (!this.disposed && generation === this.generation) this.deleteError = error instanceof Error ? error.message : this.t("任务数量读取失败，请重试。", "Could not load task counts. Please retry."); }
    finally { if (!this.disposed && generation === this.generation) { this.deleteLoading = false; this.renderDelete(); this.refresh(); } }
  }
  private async delete(): Promise<void> {
    if (!this.editingId || this.editingId === GENERAL_ASSISTANT_ID || !this.deleteCounts || this.busy) return;
    const generation = this.generation; this.busy = "delete"; this.deleteError = ""; this.renderDelete(); this.refresh();
    try {
      await this.host.deleteAgent(this.editingId);
      formDrafts.get(this.host.draftCacheKey)?.delete(this.cacheKey);
      if (!this.disposed && generation === this.generation) { this.draft = null; this.dispose(); this.host.onClose(GENERAL_ASSISTANT_ID); }
    } catch (error) {
      if (!this.disposed && generation === this.generation) { this.deleteError = error instanceof Error ? error.message : this.t("删除失败，请重试。", "Could not delete this Agent. Please retry."); this.deleteCounts = null; }
    } finally { if (!this.disposed && generation === this.generation) { this.busy = null; this.renderDelete(); this.refresh(); } }
  }
}
