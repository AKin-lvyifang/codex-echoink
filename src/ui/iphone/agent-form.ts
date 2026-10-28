import { AGENT_PRESETS } from "../../agents/presets";
import { AGENT_STYLES } from "../../agents/styles";
import { GENERAL_ASSISTANT_ID, type AgentDefinition, type AgentModuleId } from "../../agents/types";
import { mcpToolCapabilityId, skillCapabilityIds } from "../../agents/capability-core";
import { normalizeAgentDisplayName, type AgentAvatarState } from "../../harness/memory/agent-identity-model";
import { BUILTIN_SKILL_IDS } from "../../harness/resources/builtin-skills";
import type { MobileAgentRegistrySnapshot } from "../../mobile/agent-registry-service";
import { AGENT_AVATAR_PRESETS } from "../agent-avatar-presets";
import type { MobileShellPage } from "../mobile/shell-types";
import type { IPhonePageContext } from "./workbench-contract";
import { IPHONE_MODULES, iphoneAvatar, iphoneButton, iphoneElement as el } from "./workbench-elements";

const FORM_MODULES = ["knowledge-base", "todos", "finance", "journal", "english-diary", "pdf-reading"] as const;
const CAPABILITIES = [["knowledge", "知识整理"], ["finance", "财务"], ["journal", "日记"], ["review", "复盘"],
  ["english-diary", "英文日记"], ["web-search", "联网搜索"], ["pdf-reading", "PDF 精读"]] as const;

export function createAgentFormPage(ctx: IPhonePageContext, agentId?: string): MobileShellPage {
  const content = el(ctx.document, "div", "ip-agent-form"), fields = el(ctx.document, "fieldset", "ip-form-fields");
  const error = el(ctx.document, "div", "ip-error"); error.setAttribute("role", "alert"); error.hidden = true;
  const loading = el(ctx.document, "div", "ip-empty", "正在读取…"); content.append(loading, fields, error);
  const footer = el(ctx.document, "div", "ip-form-footer"), leaveArea = el(ctx.document, "div", "ip-leave-confirm"), actbar = el(ctx.document, "div", "ip-form-actbar"); footer.append(leaveArea, actbar);
  let snapshot: MobileAgentRegistrySnapshot | undefined, draft: AgentDefinition | undefined, baseline = "", selectedPreset = "";
  let modules = new Set<AgentModuleId>(), disposed = false, busy = false, allowLeave = false, leaveResolve: ((allowed: boolean) => void) | undefined;
  const selected = (id: string) => draft!.id === GENERAL_ASSISTANT_ID ? !draft!.disabledCapabilityIds?.includes(id) : !!draft!.capabilityIds?.includes(id);
  const signature = () => draft ? JSON.stringify({ ...draft, capabilityIds: [...(draft.capabilityIds ?? [])].sort(), disabledCapabilityIds: [...(draft.disabledCapabilityIds ?? [])].sort(), modules: [...modules].sort() }) : "";
  const changed = () => { error.hidden = true; };
  const showError = (failure: unknown) => { error.textContent = failure instanceof Error ? failure.message : String(failure); error.hidden = false; };
  const setBusy = (value: boolean) => { busy = value; fields.disabled = value; save.disabled = value || !draft; cancel.disabled = value; save.querySelector(".ip-button-visible > span:last-child")!.textContent = value ? "正在保存…" : agentId ? "保存" : "创建"; };
  const cancel = iphoneButton(ctx.document, "取消", () => { void ctx.shell.back(); });
  const save = iphoneButton(ctx.document, agentId ? "保存" : "创建", () => { void persist(); }, "is-primary"); save.disabled = true; actbar.append(cancel, save);
  const page: MobileShellPage = { id: `iphone-agent-form-${agentId ?? "new"}`, title: agentId ? `编辑 ${ctx.host.settings().agentRegistry.agents.find(agent => agent.id === agentId)?.name ?? "Agent"}` : "新建 Agent", content, footer };

  const group = (label: string, parent = fields): HTMLElement => {
    const area = el(ctx.document, "div", "ip-form-field"), title = el(ctx.document, "div", "ip-field-label", label); area.append(title); parent.append(area); return area;
  };
  const checkbox = (parent: HTMLElement, name: string, checked: boolean, change: (checked: boolean) => void, hint?: string): HTMLInputElement => {
    const row = el(ctx.document, "label", "ip-choice"), input = el(ctx.document, "input", ""); input.type = "checkbox"; input.checked = checked;
    row.append(input, el(ctx.document, "span", "ip-choice-name", name)); if (hint) row.append(el(ctx.document, "span", "ip-choice-hint", hint));
    input.addEventListener("change", () => { change(input.checked); changed(); }); parent.append(row); return input;
  };
  const capability = (parent: HTMLElement, ids: string[], name: string, hint?: string) => {
    const input = checkbox(parent, name, ids.length > 0 && ids.every(selected), enabled => {
      const key = draft!.id === GENERAL_ASSISTANT_ID ? "disabledCapabilityIds" : "capabilityIds", values = new Set(draft![key] ?? []);
      for (const id of ids) { if (draft!.id === GENERAL_ASSISTANT_ID ? !enabled : enabled) values.add(id); else values.delete(id); } draft![key] = [...values];
    }, hint);
    input.disabled = !ids.length; input.indeterminate = ids.some(selected) && !ids.every(selected);
  };
  const render = () => {
    if (!draft || !snapshot || disposed) return;
    fields.replaceChildren(); const current = draft;
    if (!agentId) {
      const area = group("从预设开始"), presets = el(ctx.document, "div", "ip-presets");
      for (const preset of AGENT_PRESETS) {
        const button = el(ctx.document, "button", `ip-preset${selectedPreset === preset.presetId ? " is-selected" : ""}`); button.type = "button"; button.setAttribute("aria-pressed", `${selectedPreset === preset.presetId}`);
        const visible = el(ctx.document, "span", "ip-preset-visible"); visible.append(iphoneAvatar(ctx.document, preset.agent), el(ctx.document, "span", "", preset.agent.name)); button.append(visible);
        button.addEventListener("click", () => {
          if (busy) return; selectedPreset = preset.presetId;
          // Only the visible preset-controlled fields change; no Registry write happens here.
          Object.assign(current, structuredClone(preset.agent)); modules = new Set(preset.moduleIds); changed(); render();
        }); presets.append(button);
      }
      area.append(presets);
    }
    const avatars = el(ctx.document, "div", "ip-avatar-picker"); avatars.setAttribute("role", "group"); avatars.setAttribute("aria-label", "头像");
    const avatarOrder = ["sol", "nova", "rio", "lin", "aya", "han", "bo", "cleo", "dev", "emi", "finn", "gia", "ivo", "june", "mica"];
    const avatarOptions: { label: string; avatar: AgentAvatarState }[] = [...AGENT_AVATAR_PRESETS].sort((a, b) => avatarOrder.indexOf(a.id) - avatarOrder.indexOf(b.id)).map(preset => ({ label: preset.labelZh, avatar: { kind: "preset", presetId: preset.id } }));
    const original = snapshot.registry.agents.find(agent => agent.id === agentId)?.avatar;
    if (original && original.kind !== "preset") avatarOptions.push({ label: original.kind === "custom" ? "自定义头像" : "默认头像", avatar: original });
    for (const option of avatarOptions) {
      const isSelected = JSON.stringify(option.avatar) === JSON.stringify(current.avatar), button = el(ctx.document, "button", `ip-avatar-option${isSelected ? " is-selected" : ""}`);
      button.type = "button"; button.setAttribute("aria-label", `头像 ${option.label}`); button.setAttribute("aria-pressed", `${isSelected}`);
      button.append(iphoneAvatar(ctx.document, { name: option.label, avatar: option.avatar })); button.addEventListener("click", () => { current.avatar = structuredClone(option.avatar); changed(); for (const item of Array.from(avatars.querySelectorAll("button"))) { const active = item === button; item.classList.toggle("is-selected", active); item.setAttribute("aria-pressed", `${active}`); } }); avatars.append(button);
    }
    group("头像").append(avatars);
    const ownerHints = new Map<AgentModuleId, { text: HTMLElement; check: HTMLInputElement }>();
    const updateOwnerHints = () => {
      for (const [moduleId, hint] of ownerHints) {
        const id = snapshot!.registry.moduleOwners[moduleId], owner = snapshot!.registry.agents.find(agent => agent.id === id), on = hint.check.checked;
        hint.text.textContent = id && id !== current.id ? on ? `${owner?.name ?? "总助"} → ${current.name.trim() || "新 Agent"}` : `现在：${owner?.name ?? "总助"}` : "";
      }
    };
    const textField = (label: string, value: string, placeholder: string, change: (value: string) => void, maxLength?: number) => {
      const area = el(ctx.document, "label", "ip-form-field"), input = el(ctx.document, "input", "ip-input"); input.type = "text"; input.value = value; input.placeholder = placeholder;
      if (maxLength) input.maxLength = maxLength; input.addEventListener("input", () => { change(input.value); changed(); }); area.append(el(ctx.document, "span", "ip-field-label", label), input); fields.append(area); return input;
    };
    textField("名字", current.name, "比如：整理员", value => { current.name = value; updateOwnerHints(); }, 24);
    textField("职位", current.position, "一句话说清它管什么", value => { current.position = value; });
    const ownerRows = el(ctx.document, "div", "ip-choices");
    for (const moduleId of FORM_MODULES) {
      const input = checkbox(ownerRows, IPHONE_MODULES.find(module => module.id === moduleId)!.name, modules.has(moduleId), on => { if (on) modules.add(moduleId); else modules.delete(moduleId); updateOwnerHints(); });
      const hint = el(ctx.document, "span", "ip-choice-hint"); input.parentElement!.append(hint); ownerHints.set(moduleId, { text: hint, check: input });
    }
    group("负责的模块").append(ownerRows); updateOwnerHints();
    const capabilities = group("能用的能力"); capabilities.append(el(ctx.document, "div", "ip-capability-group-label", "模块")); const moduleCapabilities = el(ctx.document, "div", "ip-choices");
    for (const [id, name] of CAPABILITIES) capability(moduleCapabilities, [id], name); capabilities.append(moduleCapabilities);
    const resources = ctx.host.settings().resources;
    const custom = resources.catalog.filter(resource => resource.kind === "skill" && !(BUILTIN_SKILL_IDS as readonly string[]).includes(typeof resource.metadata?.resourceId === "string" ? resource.metadata.resourceId : resource.id));
    capabilities.append(el(ctx.document, "div", "ip-capability-group-label", "我的 Skill"));
    if (custom.length) { const rows = el(ctx.document, "div", "ip-choices"); for (const resource of custom) {
      const ids = skillCapabilityIds(resource.id), enabled = !ids.some(id => current.disabledCapabilityIds?.includes(id))
        && (current.id === GENERAL_ASSISTANT_ID || ids.some(id => current.capabilityIds?.includes(id)));
      checkbox(rows, resource.name, enabled, value => {
        current.capabilityIds = (current.capabilityIds ?? []).filter(id => !ids.includes(id));
        current.disabledCapabilityIds = (current.disabledCapabilityIds ?? []).filter(id => !ids.includes(id));
        if (value) current.capabilityIds.push(ids[0]); else current.disabledCapabilityIds.push(ids[0]);
      }, resource.enabled ? undefined : "未启用");
    } capabilities.append(rows); }
    else capabilities.append(el(ctx.document, "div", "ip-form-empty", "暂无自建 Skill"));
    capabilities.append(el(ctx.document, "div", "ip-capability-group-label", "MCP 服务"));
    const remote = resources.catalog.filter(resource => resource.kind === "mcp-server" && resources.mcpConnections[resource.id]?.transport === "http");
    if (remote.length) {
      const rows = el(ctx.document, "div", "ip-choices");
      for (const resource of remote) { const connection = resources.mcpConnections[resource.id], ids = (connection?.tools ?? []).map(tool => mcpToolCapabilityId(resource.id, tool.name)); capability(rows, ids, `${resource.name} · 远程`, !ids.length ? "尚未发现工具" : !resource.enabled ? "未启用" : undefined); } capabilities.append(rows);
    } else capabilities.append(el(ctx.document, "div", "ip-form-empty", "暂无远程 MCP 服务"));
    const styles = el(ctx.document, "div", "ip-styles"); styles.setAttribute("role", "radiogroup"); styles.setAttribute("aria-label", "风格");
    for (const style of AGENT_STYLES) {
      const row = el(ctx.document, "label", "ip-style-choice"), radio = el(ctx.document, "input", ""); radio.type = "radio"; radio.name = `ip-style-${current.id}`; radio.value = style.id; radio.checked = current.styleId === style.id; row.classList.toggle("is-selected", radio.checked);
      const copy = el(ctx.document, "span", "ip-style-copy"); copy.append(el(ctx.document, "span", "ip-style-name", style.name), el(ctx.document, "span", "ip-sub", style.responseStructure)); row.append(radio, copy); styles.append(row);
      radio.addEventListener("change", () => { if (radio.checked) { for (const choice of Array.from(styles.querySelectorAll<HTMLElement>(".ip-style-choice"))) choice.classList.toggle("is-selected", choice.querySelector<HTMLInputElement>("input")!.checked); current.styleId = style.id; changed(); } });
    }
    group("风格").append(styles);
    if (agentId && agentId !== GENERAL_ASSISTANT_ID) {
      const danger = el(ctx.document, "div", "ip-danger-zone"), remove = iphoneButton(ctx.document, "删除这个 Agent", () => {
        remove.hidden = true; const confirm = el(ctx.document, "div", "ip-confirm", `先停止${snapshot!.registry.agents.find(agent => agent.id === agentId)?.name ?? "这个 Agent"}正在处理的任务，再把它负责的模块和全部任务交回总助；不会自动重新执行。`);
        const choices = el(ctx.document, "div", "ip-confirm-actions");
        choices.append(iphoneButton(ctx.document, "取消", () => { confirm.remove(); remove.hidden = false; }), iphoneButton(ctx.document, "删除并交回总助", () => { void removeAgent(); }, "is-danger")); confirm.append(choices); danger.append(confirm);
      }, "", "trash-2"); danger.append(remove); fields.append(danger);
    }
  };
  async function persist(): Promise<void> {
    if (!snapshot || !draft || busy) return;
    const name = normalizeAgentDisplayName(draft.name); if (!name) { showError(new Error("请输入 1–24 个字符的名字。")); fields.querySelector<HTMLInputElement>("input[type=text]")?.focus(); return; }
    const candidate = structuredClone({ ...draft, name, position: draft.position.trim(), identityEdited: true }), owned = new Set(modules); setBusy(true); error.hidden = true;
    try {
      await ctx.host.agents.update(registry => {
        const current = registry.agents.find(agent => agent.id === candidate.id);
        if (agentId) { if (!current) throw new Error("这个 Agent 已被删除，未保存改动。"); Object.assign(current, candidate); }
        else { if (current) throw new Error("Agent 已存在，未保存改动。"); registry.agents.push(candidate); }
        for (const moduleId of FORM_MODULES) {
          if (owned.has(moduleId)) registry.moduleOwners[moduleId] = candidate.id;
          else if (registry.moduleOwners[moduleId] === candidate.id) registry.moduleOwners[moduleId] = GENERAL_ASSISTANT_ID;
        }
      }, snapshot.version);
      allowLeave = true;
      try { await ctx.host.services.refreshAgentIdentity(); } catch (failure) { ctx.error(failure); }
      if (!disposed) {
        setBusy(false); await ctx.shell.back();
        if (!agentId) await ctx.navigate({ kind: "agent", agentId: candidate.id }, ctx.shell.activePageId?.startsWith("iphone-agent-"));
      }
    } catch (failure) { if (!disposed) { showError(failure); setBusy(false); } }
  }
  async function removeAgent(): Promise<void> {
    if (!agentId || agentId === GENERAL_ASSISTANT_ID || !snapshot || busy) return;
    setBusy(true); error.hidden = true;
    try {
      await ctx.host.services.removeAgent(agentId, snapshot.version); allowLeave = true;
      if (!disposed) { setBusy(false); await ctx.shell.back(); if (ctx.shell.activePageId?.startsWith("iphone-agent-")) await ctx.navigate({ kind: "agent", agentId: GENERAL_ASSISTANT_ID }, true); }
    } catch (failure) { if (!disposed) { showError(failure); setBusy(false); } }
  }
  page.canLeave = () => {
    if (busy) return false;
    if (allowLeave || !draft || signature() === baseline) return true;
    if (leaveResolve) return false;
    return new Promise<boolean>(resolve => {
      leaveResolve = resolve; const confirm = el(ctx.document, "div", "ip-confirm", "Agent 还有未保存的修改。"), choices = el(ctx.document, "div", "ip-confirm-actions");
      const decide = (allowed: boolean) => { const done = leaveResolve; leaveResolve = undefined; leaveArea.replaceChildren(); done?.(allowed); };
      const keep = iphoneButton(ctx.document, "继续编辑", () => decide(false));
      choices.append(keep, iphoneButton(ctx.document, "放弃修改", () => { allowLeave = true; decide(true); }, "is-primary")); confirm.append(choices); leaveArea.replaceChildren(confirm); keep.focus();
    });
  };
  page.dispose = () => { disposed = true; leaveResolve?.(false); leaveResolve = undefined; };
  void ctx.host.agents.snapshot().then(next => {
    if (disposed) return; snapshot = next;
    const existing = agentId ? next.registry.agents.find(agent => agent.id === agentId) : undefined;
    if (agentId && !existing) throw new Error("这个 Agent 已被删除。");
    draft = existing ? structuredClone(existing) : { id: crypto.randomUUID(), name: "", position: "", avatar: { kind: "preset", presetId: "nova" }, styleId: "execution", capabilityIds: [] };
    modules = new Set(FORM_MODULES.filter(moduleId => next.registry.moduleOwners[moduleId] === draft!.id)); baseline = signature(); loading.remove(); render(); save.disabled = false;
  }).catch(failure => { if (!disposed) { loading.remove(); showError(failure); } });
  return page;
}
