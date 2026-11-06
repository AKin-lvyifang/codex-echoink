import { AGENT_PRESETS } from "../../agents/presets";
import { Notice, setIcon } from "obsidian";
import { getModuleOwner, grantModuleCapabilities, moduleCapability, setModuleOwner } from "../../agents/registry";
import { createBrowserAvatarRenderer, processAgentAvatar } from "../agent-avatar-processor";
import type { AgentEditorCreationOptions } from "../codex-view/agent-editor-contract";
import { AGENT_STYLES } from "../../agents/styles";
import { AGENT_PERSONA_MAX_LENGTH, agentPersonaLength, getAgentPersonaTemplate, hasCustomAgentPersona, isExpertAgent, normalizeAgentPersona } from "../../agents/persona";
import { AGENT_MODULE_NAMES, GENERAL_ASSISTANT_ID, isUndeletableAgent, usesDisabledCapabilityList, type AgentDefinition, type AgentModuleId } from "../../agents/types";
import { mcpToolCapabilityId, skillCapabilityIds } from "../../agents/capability-core";
import { normalizeAgentDisplayName, type AgentAvatarState } from "../../harness/memory/agent-identity-model";
import { BUILTIN_SKILL_IDS } from "../../harness/resources/builtin-skills";
import type { MobileAgentRegistrySnapshot } from "../../mobile/agent-registry-service";
import { AGENT_AVATAR_PRESETS } from "../agent-avatar-presets";
import type { MobileShellPage } from "../mobile/shell-types";
import type { IPadPageContext } from "./workbench-contract";
import { ipadAvatar, ipadButton, ipadElement as el } from "./workbench-elements";

const FORM_AVATAR_ORDER = ["sol", "nova", "rio", "lin", "aya", "han", "bo", "cleo", "dev", "emi", "finn", "gia", "ivo", "june", "mica"];
const FORM_MODULES: readonly AgentModuleId[] = ["knowledge-base", "journal", "review", "todos", "finance", "english-diary", "pdf-reading"];
const CAPABILITIES = [["knowledge", "知识整理"], ["journal", "日记"], ["review", "复盘"], ["todos", "待办"], ["finance", "财务"], ["english-diary", "英文日记"], ["pdf-reading", "PDF 精读"], ["web-search", "联网搜索"], ["obsidian-plugins", "Obsidian 插件管理"]] as const;

export function createAgentFormPage(ctx: IPadPageContext, agentId?: string, creation: AgentEditorCreationOptions = {}): MobileShellPage {
  const content = el(ctx.document, "div", "pd-agent-form"), fields = el(ctx.document, "fieldset", "pd-form-fields");
  const error = el(ctx.document, "div", "pd-error"); error.setAttribute("role", "alert"); error.hidden = true;
  const loading = el(ctx.document, "div", "pd-empty", "正在读取…"); content.append(loading, fields, error);
  const footer = el(ctx.document, "div", "pd-form-footer"), leaveArea = el(ctx.document, "div", "pd-leave-confirm"), actbar = el(ctx.document, "div", "pd-form-actbar"); footer.append(leaveArea, actbar);
  let snapshot: MobileAgentRegistrySnapshot | undefined, draft: AgentDefinition | undefined, baseline = "", selectedPreset = "";
  let avatarExpanded = false;
  let modules = new Set<AgentModuleId>(), disposed = false, busy = false, allowLeave = false, leaveResolve: ((allowed: boolean) => void) | undefined;
  const expertHooks = ctx.host.services as typeof ctx.host.services & { dismissExpert?: (agentId: string, version: string) => Promise<void>; showExpertAbout?: (agentId: string) => void | Promise<void> };
  const selected = (id: string) => usesDisabledCapabilityList(draft!.id) ? !draft!.disabledCapabilityIds?.includes(id) : !!draft!.capabilityIds?.includes(id);
  const signature = () => draft ? JSON.stringify({ ...draft, capabilityIds: [...(draft.capabilityIds ?? [])].sort(), disabledCapabilityIds: [...(draft.disabledCapabilityIds ?? [])].sort(), modules: [...modules].sort() }) : "";
  const changed = () => { error.hidden = true; };
  const showError = (failure: unknown) => { error.textContent = failure instanceof Error ? failure.message : String(failure); error.hidden = false; };
  const setBusy = (value: boolean) => { busy = value; fields.disabled = value; save.disabled = value || !draft; cancel.disabled = value; save.querySelector(".pd-button-visible > span:last-child")!.textContent = value ? "正在保存…" : agentId ? "保存" : "创建"; };
  const cancel = ipadButton(ctx.document, "取消", () => { void ctx.shell.back(); });
  const save = ipadButton(ctx.document, agentId ? "保存" : "创建", () => { void persist(); }, "is-primary"); save.disabled = true; actbar.append(cancel, save);
  const titleLeading = ctx.root.classList.contains("pd-agent-pane") ? el(ctx.document, "span", "pd-agent-form-title-avatar") : undefined;
  const page: MobileShellPage = { id: `ipad-agent-form-${agentId ?? "new"}`, title: agentId ? `${ctx.host.settings().agentRegistry.agents.find(agent => agent.id === agentId)?.name ?? "Agent"}` : "新建 Agent", content, footer, titleLeading };

  const dirty = el(ctx.document, "span", "pd-form-dirty"); dirty.setAttribute("role", "status"); actbar.prepend(dirty);
  const refreshSave = () => { save.disabled = busy || !draft || !normalizeAgentDisplayName(draft.name); dirty.textContent = draft && signature() !== baseline ? "有未保存的修改" : ""; };
  const group = (label: string, parent = fields): HTMLElement => {
    const section = el(ctx.document, "section", "pd-agent-group"), heading = el(ctx.document, "h3", "pd-agent-group-title", label), box = el(ctx.document, "div", "pd-agent-group-box");
    section.append(heading, box); parent.append(section); return box;
  };
  const checkbox = (parent: HTMLElement, name: string, checked: boolean, change: (checked: boolean) => void, hint?: string): HTMLInputElement => {
    const row = el(ctx.document, "label", "pd-choice"), input = el(ctx.document, "input", ""); input.type = "checkbox"; input.checked = checked; input.setAttribute("aria-label", name);
    row.append(input, el(ctx.document, "span", "pd-choice-name", name)); if (hint) row.append(el(ctx.document, "span", "pd-choice-hint", hint));
    input.addEventListener("change", () => { change(input.checked); changed(); refreshSave(); }); parent.append(row); return input;
  };
  const capabilityChecks = new Map<HTMLInputElement, readonly string[]>();
  const required = (id: string) => [...modules].some(module => moduleCapability(module) === id);
  const refreshCapabilities = () => { for (const [check, ids] of capabilityChecks) {
    check.checked = ids.length > 0 && ids.every(selected); check.indeterminate = ids.some(selected) && !ids.every(selected);
    check.disabled = !ids.length || ids.some(required); check.parentElement?.classList.toggle("is-required", ids.some(required));
    if (ids.some(required)) {
      check.setAttribute("aria-description", "负责这个模块，必须能用");
      if (!check.parentElement?.querySelector(".pd-required-lock")) { const lock = el(ctx.document, "span", "pd-required-lock"); lock.setAttribute("aria-hidden", "true"); setIcon(lock, "lock"); check.parentElement?.append(lock); }
    } else { check.removeAttribute("aria-description"); check.parentElement?.querySelector(".pd-required-lock")?.remove(); }
  } };
  const capability = (parent: HTMLElement, ids: string[], name: string, hint?: string) => {
    const input = checkbox(parent, name, ids.length > 0 && ids.every(selected), enabled => {
      const key = usesDisabledCapabilityList(draft!.id) ? "disabledCapabilityIds" : "capabilityIds", values = new Set(draft![key] ?? []);
      for (const id of ids) { if (usesDisabledCapabilityList(draft!.id) ? !enabled : enabled) values.add(id); else values.delete(id); } draft![key] = [...values];
    }, hint);
    capabilityChecks.set(input, ids);
    input.parentElement?.addEventListener("click", () => { if (ids.some(required)) new Notice("负责这个模块，必须能用"); });
  };
  const render = () => {
    if (!draft || !snapshot || disposed) return;
    fields.replaceChildren(); capabilityChecks.clear(); const current = draft, expert = isExpertAgent(current), main = current.id === GENERAL_ASSISTANT_ID;
    titleLeading?.replaceChildren(ipadAvatar(ctx.document, current));
    if (!agentId) {
      const area = group("从预设开始"), presets = el(ctx.document, "div", "pd-presets"); area.classList.add("pd-agent-presets-box");
      for (const preset of AGENT_PRESETS) {
        const button = el(ctx.document, "button", `pd-preset${selectedPreset === preset.presetId ? " is-selected" : ""}`); button.type = "button"; button.setAttribute("aria-pressed", `${selectedPreset === preset.presetId}`);
        const visible = el(ctx.document, "span", "pd-preset-visible"); visible.append(ipadAvatar(ctx.document, preset.agent), el(ctx.document, "span", "", preset.agent.name)); button.append(visible);
        button.addEventListener("click", () => {
          if (busy) return; selectedPreset = preset.presetId;
          Object.assign(current, structuredClone(preset.agent)); modules = new Set([...preset.moduleIds, ...(creation.moduleIds ?? [])]);
          for (const module of modules) grantModuleCapabilities(current, module); changed(); render();
        }); presets.append(button);
      }
      area.append(presets);
    }
    const identity = group("身份");
    if (!expert) {
      const row = el(ctx.document, "div", "pd-agent-avatar-row");
      const preview = el(ctx.document, "span", "pd-agent-avatar-preview"); preview.append(ipadAvatar(ctx.document, current));
      const change = ipadButton(ctx.document, "更换", () => { avatarExpanded = !avatarExpanded; avatars.hidden = !avatarExpanded; change.setAttribute("aria-expanded", String(avatarExpanded)); }, "is-text"); change.setAttribute("aria-expanded", String(avatarExpanded));
      row.append(el(ctx.document, "span", "pd-grow", "头像"), preview, change); identity.append(row);
      const avatars = el(ctx.document, "div", "pd-agent-avatar-expanded"); avatars.hidden = !avatarExpanded;
      const grid = el(ctx.document, "div", "pd-avatar-picker"); grid.setAttribute("role", "group"); grid.setAttribute("aria-label", "选择头像");
      for (const preset of [...AGENT_AVATAR_PRESETS].sort((a, b) => FORM_AVATAR_ORDER.indexOf(a.id) - FORM_AVATAR_ORDER.indexOf(b.id))) {
        const avatar: AgentAvatarState = { kind: "preset", presetId: preset.id }, selected = current.avatar.kind === "preset" && current.avatar.presetId === preset.id;
        const button = el(ctx.document, "button", `pd-avatar-option${selected ? " is-selected" : ""}`); button.type = "button"; button.setAttribute("aria-label", `头像 ${preset.labelZh}`); button.setAttribute("aria-pressed", String(selected));
        button.append(ipadAvatar(ctx.document, { name: preset.labelZh, avatar }));
        button.addEventListener("click", () => { if (busy) return; current.avatar = avatar; preview.replaceChildren(ipadAvatar(ctx.document, current)); titleLeading?.replaceChildren(ipadAvatar(ctx.document, current)); changed(); refreshSave(); for (const item of Array.from(grid.querySelectorAll("button"))) { item.classList.toggle("is-selected", item === button); item.setAttribute("aria-pressed", String(item === button)); } }); grid.append(button);
      }
      const file = el(ctx.document, "input", ""); file.type = "file"; file.accept = "image/svg+xml"; file.hidden = true; file.dataset.field = "avatar-file";
      file.addEventListener("change", () => {
        const image = file.files?.[0]; if (!image || busy) return; setBusy(true);
        void processAgentAvatar(image, image.type, image.size, createBrowserAvatarRenderer()).then(avatar => { if (disposed) return; current.avatar = avatar; changed(); }).catch(() => showError(new Error("头像处理失败，请选择安全的正方形 SVG（不超过 4MB）。"))).finally(() => { if (!disposed) { setBusy(false); render(); } });
      });
      avatars.append(grid, ipadButton(ctx.document, "上传 SVG", () => file.click(), "is-text", "upload"), file); identity.append(avatars);
    } else {
      const summary = el(ctx.document, "div", "pd-expert-identity"); summary.setAttribute("aria-label", "身份，只读");
      summary.append(ipadAvatar(ctx.document, current), el(ctx.document, "div", "pd-expert-name", current.name), el(ctx.document, "div", "pd-expert-position", current.position));
      const lock = el(ctx.document, "span", "pd-expert-lock"); lock.setAttribute("aria-hidden", "true"); setIcon(lock, "lock"); summary.append(lock); identity.append(summary);
    }
    const textField = (label: string, value: string, placeholder: string, change: (value: string) => void, maxLength?: number) => {
      const area = el(ctx.document, "label", "pd-form-field"), input = el(ctx.document, "input", "pd-input"); input.type = "text"; input.value = value; input.placeholder = placeholder; input.setAttribute("aria-label", label);
      if (maxLength) input.maxLength = maxLength; input.addEventListener("input", () => { change(input.value); changed(); refreshSave(); }); area.append(el(ctx.document, "span", "pd-field-label", label), input); identity.append(area); return input;
    };
    if (!expert) {
      textField("名字", current.name, "输入名字", value => { current.name = value; }, 96);
      if (!main) { textField("职位", current.position, "输入职位", value => { current.position = value; }); textField("一句话简介", current.positionDescription ?? "", "一句话描述职责", value => { current.positionDescription = value; }); }
    }
    const persona = group("人格"); persona.classList.add("pd-persona-field");
    if (expert) {
      persona.setAttribute("aria-label", "人格，只读");
      const heading = persona.parentElement!.querySelector("h3")!;
      const lock = el(ctx.document, "span", "pd-expert-lock"); lock.setAttribute("aria-hidden", "true"); setIcon(lock, "lock"); heading.append(lock);
      persona.append(el(ctx.document, "div", "pd-expert-summary", current.expert?.summary ?? ""));
    } else {
      const templates = el(ctx.document, "div", "pd-persona-templates"), confirmation = el(ctx.document, "div", "pd-persona-confirm");
      templates.setAttribute("role", "group"); templates.setAttribute("aria-label", "人格模板");
      const input = el(ctx.document, "textarea", "pd-persona-input"); input.value = current.persona ?? "";
      input.placeholder = "描述 Agent 的做事风格"; input.setAttribute("aria-label", "人格正文"); input.dataset.field = "persona";
      const counter = el(ctx.document, "div", "pd-persona-count"); counter.id = `pd-persona-count-${current.id}`; input.setAttribute("aria-describedby", counter.id);
      const updateCount = () => { counter.textContent = `${agentPersonaLength(input.value)} / ${AGENT_PERSONA_MAX_LENGTH}`; };
      const update = () => { const value = normalizeAgentPersona(input.value); if (value !== input.value) input.value = value; current.persona = value; updateCount(); changed(); refreshSave(); };
      input.addEventListener("input", event => { if (!(event as InputEvent).isComposing) update(); }); input.addEventListener("compositionend", update);
      for (const style of AGENT_STYLES) {
        const apply = () => { current.styleId = style.id; current.persona = getAgentPersonaTemplate(style.id); changed(); render(); fields.querySelector<HTMLTextAreaElement>("[data-field=persona]")?.focus(); };
        const template = ipadButton(ctx.document, style.name, () => {
          if (busy) return; if (!hasCustomAgentPersona(current.persona)) { apply(); return; }
          const panel = el(ctx.document, "div", "pd-confirm", "用模板替换当前人格？"), choices = el(ctx.document, "div", "pd-confirm-actions");
          const keep = ipadButton(ctx.document, "保留修改", () => { confirmation.replaceChildren(); template.focus(); });
          choices.append(keep, ipadButton(ctx.document, "替换", apply, "is-primary")); panel.append(choices); confirmation.replaceChildren(panel); keep.focus();
        }, "is-text");
        template.dataset.personaTemplate = style.id; template.classList.add("pd-persona-template");
        template.classList.toggle("is-selected", current.styleId === style.id); template.setAttribute("aria-pressed", String(current.styleId === style.id)); templates.append(template);
      }
      const bottom = el(ctx.document, "div", "pd-persona-bottom"); bottom.append(templates, counter); updateCount(); persona.append(input, bottom, confirmation);
    }
    if (main) {
      const area = group("员工审批"); area.classList.add("pd-agent-approval"); area.setAttribute("role", "radiogroup"); area.setAttribute("aria-label", "员工审批");
      for (const [value, title] of [["user", "我来审批"], ["assistant", "总助审批"]] as const) {
        const row = el(ctx.document, "label", `pd-choice${(current.companyApprovalMode ?? "user") === value ? " is-selected" : ""}`), input = el(ctx.document, "input", "");
        input.type = "radio"; input.name = `company-approval-${current.id}`; input.value = value; input.setAttribute("aria-label", title); input.checked = (current.companyApprovalMode ?? "user") === value;
        input.addEventListener("change", () => { if (input.checked) { current.companyApprovalMode = value; changed(); refreshSave(); for (const item of Array.from(area.querySelectorAll("label"))) item.classList.toggle("is-selected", item === row); } });
        const copy = el(ctx.document, "span", "pd-choice-name", title); if (value === "assistant") copy.append(el(ctx.document, "span", "pd-agent-approval-note", "删除仍由你来批")); row.append(input, copy); area.append(row);
      }
    } else {
      const ownerRows = group("负责的模块"); ownerRows.classList.add("pd-agent-module-grid");
      for (const moduleId of FORM_MODULES) {
        const owner = getModuleOwner(snapshot.registry, moduleId), name = AGENT_MODULE_NAMES[moduleId][0];
        const input = checkbox(ownerRows, name, modules.has(moduleId), on => { if (on) { modules.add(moduleId); grantModuleCapabilities(current, moduleId); } else modules.delete(moduleId); refreshCapabilities(); }, owner && owner.id !== current.id ? owner.name : undefined);
        input.dataset.moduleId = moduleId;
      }
      if (!expert) {
        const capabilities = group("能用的能力"); capabilities.classList.add("pd-agent-capabilities");
        capabilities.parentElement!.querySelector("h3")!.append(ipadButton(ctx.document, "刷新", render, "is-text"));
        const builtins = el(ctx.document, "div", "pd-agent-capability-section"); builtins.append(el(ctx.document, "h4", "pd-capability-group-label", "内置技能")); const builtinRows = el(ctx.document, "div", "pd-agent-capability-grid");
        for (const [id, name] of CAPABILITIES) capability(builtinRows, [id], name); builtins.append(builtinRows); capabilities.append(builtins);
        const resources = ctx.host.settings().resources, custom = resources.catalog.filter(resource => resource.kind === "skill" && !(BUILTIN_SKILL_IDS as readonly string[]).includes(typeof resource.metadata?.resourceId === "string" ? resource.metadata.resourceId : resource.id));
        const mine = el(ctx.document, "div", "pd-agent-capability-section"); mine.append(el(ctx.document, "h4", "pd-capability-group-label", "我的 Skill"));
        for (const resource of custom) {
          const ids = skillCapabilityIds(resource.id), enabled = !ids.some(id => current.disabledCapabilityIds?.includes(id)) && (usesDisabledCapabilityList(current.id) || ids.some(id => current.capabilityIds?.includes(id)));
          checkbox(mine, resource.name, enabled, value => { current.capabilityIds = (current.capabilityIds ?? []).filter(id => !ids.includes(id)); current.disabledCapabilityIds = (current.disabledCapabilityIds ?? []).filter(id => !ids.includes(id)); if (value) current.capabilityIds.push(ids[0]); else current.disabledCapabilityIds.push(ids[0]); }, resource.enabled ? undefined : "未启用");
        }
        if (!custom.length) mine.append(el(ctx.document, "div", "pd-form-empty", "暂无自建 Skill")); capabilities.append(mine);
        const mcp = el(ctx.document, "div", "pd-agent-capability-section"); mcp.append(el(ctx.document, "h4", "pd-capability-group-label", "MCP"));
        const remote = resources.catalog.filter(resource => resource.kind === "mcp-server" && resources.mcpConnections[resource.id]?.transport === "http");
        for (const resource of remote) { const connection = resources.mcpConnections[resource.id], ids = (connection?.tools ?? []).map(tool => mcpToolCapabilityId(resource.id, tool.name)); capability(mcp, ids, `${resource.name} · 远程`, !ids.length ? "尚未发现工具" : !resource.enabled ? "未启用" : undefined); }
        if (!remote.length) mcp.append(el(ctx.document, "div", "pd-form-empty", "暂无远程 MCP 服务")); capabilities.append(mcp); refreshCapabilities();
      }
    }
    if (expert && agentId) {
      const actions = el(ctx.document, "div", "pd-expert-actions"), dismiss = ipadButton(ctx.document, "解聘", () => { void dismissExpert(); }, "is-danger"); dismiss.dataset.action = "dismiss-expert"; dismiss.disabled = !expertHooks.dismissExpert; actions.append(dismiss); fields.append(actions);
    } else if (agentId && !isUndeletableAgent(agentId)) {
      const danger = el(ctx.document, "div", "pd-danger-zone"), remove = ipadButton(ctx.document, "删除 Agent", () => {
        remove.hidden = true; const confirm = el(ctx.document, "div", "pd-confirm", `删除${current.name}后，负责的模块变为未指定；先停止进行中的任务，历史任务交给通才，不会自动重新执行。`), choices = el(ctx.document, "div", "pd-confirm-actions");
        choices.append(ipadButton(ctx.document, "保留", () => { confirm.remove(); remove.hidden = false; }), ipadButton(ctx.document, "删除并交通才", () => { void removeAgent(); }, "is-danger")); confirm.append(choices); danger.append(confirm);
      }, "is-danger", "trash-2"); danger.append(remove); fields.append(danger);
    }
    refreshSave();
  };
  async function persist(): Promise<void> {
    if (!snapshot || !draft || busy) return;
    const name = normalizeAgentDisplayName(draft.name); if (!name) { showError(new Error("请输入 1–24 个字符的名字。")); fields.querySelector<HTMLInputElement>("input[type=text]")?.focus(); return; }
    const candidate = isExpertAgent(draft) ? structuredClone(draft) : structuredClone({ ...draft, name, position: draft.position.trim(), identityEdited: true }), owned = new Set(modules); setBusy(true); error.hidden = true;
    try {
      await ctx.host.agents.update(registry => {
        const current = registry.agents.find(agent => agent.id === candidate.id);
        if (agentId) { if (!current) throw new Error("这个 Agent 已被删除，未保存改动。"); Object.assign(current, candidate); }
        else { if (current) throw new Error("Agent 已存在，未保存改动。"); registry.agents.push(candidate); }
        for (const moduleId of FORM_MODULES) {
          if (candidate.id !== GENERAL_ASSISTANT_ID && owned.has(moduleId)) Object.assign(registry, setModuleOwner(registry, moduleId, candidate.id));
          else if (getModuleOwner(registry, moduleId)?.id === candidate.id) Object.assign(registry, setModuleOwner(registry, moduleId, ""));
        }
      }, snapshot.version);
      allowLeave = true;
      try { await ctx.host.services.refreshAgentIdentity(); } catch (failure) { ctx.error(failure); }
      if (!disposed) {
        setBusy(false); await ctx.shell.back();
        if (creation.onReturn) creation.onReturn();
        else if (!agentId) await ctx.navigate({ kind: "agent", agentId: candidate.id }, ctx.shell.activePageId?.startsWith("ipad-agent-"));
      }
    } catch (failure) { if (!disposed) { showError(failure); setBusy(false); } }
  }
  async function dismissExpert(): Promise<void> {
    if (!agentId || !snapshot || !draft || !isExpertAgent(draft) || !expertHooks.dismissExpert || busy) return;
    setBusy(true); error.hidden = true;
    try {
      await expertHooks.dismissExpert(agentId, snapshot.version); allowLeave = true;
      if (!disposed) { setBusy(false); await ctx.shell.back(); if (ctx.shell.activePageId?.startsWith("ipad-agent-")) await ctx.navigate({ kind: "agent", agentId: GENERAL_ASSISTANT_ID }, true); }
    } catch (failure) { if (!disposed) { showError(failure); setBusy(false); } }
  }
  async function removeAgent(): Promise<void> {
    if (!agentId || agentId === GENERAL_ASSISTANT_ID || !snapshot || busy) return;
    setBusy(true); error.hidden = true;
    try {
      await ctx.host.services.removeAgent(agentId, snapshot.version); allowLeave = true;
      if (!disposed) { setBusy(false); await ctx.shell.back(); if (ctx.shell.activePageId?.startsWith("ipad-agent-")) await ctx.navigate({ kind: "agent", agentId: GENERAL_ASSISTANT_ID }, true); }
    } catch (failure) { if (!disposed) { showError(failure); setBusy(false); } }
  }
  page.canLeave = () => {
    if (busy) return false;
    if (allowLeave || !draft || signature() === baseline) return true;
    if (leaveResolve) return false;
    return new Promise<boolean>(resolve => {
      leaveResolve = resolve; const confirm = el(ctx.document, "div", "pd-confirm", "Agent 还有未保存的修改。"), choices = el(ctx.document, "div", "pd-confirm-actions");
      const decide = (allowed: boolean) => { const done = leaveResolve; leaveResolve = undefined; leaveArea.replaceChildren(); done?.(allowed); };
      const keep = ipadButton(ctx.document, "继续编辑", () => decide(false));
      choices.append(keep, ipadButton(ctx.document, "放弃修改", () => { allowLeave = true; decide(true); }, "is-primary")); confirm.append(choices); leaveArea.replaceChildren(confirm); keep.focus();
    });
  };
  page.dispose = () => { disposed = true; leaveResolve?.(false); leaveResolve = undefined; };
  void ctx.host.agents.snapshot().then(next => {
    if (disposed) return; snapshot = next;
    const existing = agentId ? next.registry.agents.find(agent => agent.id === agentId) : undefined;
    if (agentId && !existing) throw new Error("这个 Agent 已被删除。");
    draft = existing ? structuredClone(existing) : { id: crypto.randomUUID(), name: "", position: "", avatar: { kind: "preset", presetId: "nova" }, styleId: "execution", capabilityIds: [] };
    modules = new Set([...FORM_MODULES.filter(moduleId => getModuleOwner(next.registry, moduleId)?.id === draft!.id), ...(!agentId ? creation.moduleIds ?? [] : [])]); for (const module of modules) grantModuleCapabilities(draft, module); baseline = signature(); loading.remove(); render(); refreshSave();
  }).catch(failure => { if (!disposed) { loading.remove(); showError(failure); } });
  return page;
}
