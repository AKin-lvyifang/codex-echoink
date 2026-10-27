import { normalizeWebSearchSettings, webSearchApiKey, setWebSearchApiKey, webSearchProvider, WEB_SEARCH_PROVIDERS } from "../../tools/web-search-settings";
import { Notice } from "obsidian";
import { skillIcon } from "../../agents/skill-icons";
import type { MobileCapabilitiesPort, MobileMcpDraft, MobileMcpSummary, MobileSkillSnapshot } from "../../mobile/capabilities-contracts";
import type { MobileShellPage } from "../mobile/shell-types";
import { ipadAvatar, ipadIcon } from "./workbench-elements";
import { settingsText as t } from "./settings-i18n";
import { el, settingsContent, settingsGroup, settingsRow, settingsAction, settingsField, settingsSwitch, settingsToggle, settingsError, showSettingsError, liveSettingsPage, leaveSettingsConfirm, type IPadSettingsContext } from "./settings-elements";

type EditAgent = (id: string) => Promise<unknown>;
const capabilities = (ctx: IPadSettingsContext): MobileCapabilitiesPort => ctx.host.services.capabilities;
const sourceKey = (ctx: IPadSettingsContext): string => JSON.stringify([ctx.host.settings().resources, ctx.host.settings().agentRegistry, ctx.host.settings().tavily, ctx.host.settings().settingsLanguage]);
const enabledCount = (ctx: IPadSettingsContext, count: number, total?: number): string => ctx.host.settings().settingsLanguage === "en"
  ? `${count}${total === undefined ? "" : ` / ${total}`} enabled` : total === undefined ? `${count} 个启用` : `${count} / ${total} 启用`;

function tile(ctx: IPadSettingsContext, icon: string, large = false): HTMLElement {
  const node = el(ctx.document, "span", `pd-cap-icon${large ? " is-large" : ""}`); node.append(ipadIcon(ctx.document, icon)); return node;
}
function status(ctx: IPadSettingsContext, parent: HTMLElement, message: string): HTMLElement {
  const node = el(ctx.document, "div", "pd-cap-status", t(ctx, message)); node.setAttribute("role", "status"); parent.append(node); return node;
}
function textAction(ctx: IPadSettingsContext, label: string, action: () => void | Promise<unknown>): HTMLButtonElement {
  const button = settingsAction(ctx, label, action); button.classList.add("pd-cap-text-action"); return button;
}
function buttonText(button: HTMLButtonElement, text: string): void { button.firstElementChild!.textContent = text; }
function check(ctx: IPadSettingsContext, parent: HTMLElement, title: string, value: boolean, changed: (value: boolean) => void): HTMLInputElement {
  const row = el(ctx.document, "label", "pd-settings-row pd-cap-check"), input = el(ctx.document, "input", ""); input.type = "checkbox"; input.checked = value;
  input.setAttribute("aria-label", title); input.addEventListener("change", () => changed(input.checked)); row.append(el(ctx.document, "span", "pd-settings-copy", title), input); parent.append(row); return input;
}
function safeFailure(error: unknown, secrets: string[]): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) message = message.split(secret).join("[redacted]");
  return message;
}

/** Read-only asynchronous lists never replace an editor or the right-hand task pane. */
function resourcePage<T>(ctx: IPadSettingsContext, id: string, title: string, load: () => Promise<T>, draw: (parent: HTMLElement, value: T) => void): MobileShellPage {
  const content = settingsContent(ctx); content.classList.add("pd-capabilities");
  let key: string | undefined, disposed = false, generation = 0;
  const refresh = () => {
    const next = sourceKey(ctx); if (key === next) return; key = next; const ticket = ++generation;
    content.setAttribute("aria-busy", "true");
    if (!content.childElementCount) status(ctx, content, "读取中…");
    void load().then(value => {
      if (disposed || generation !== ticket) return;
      content.replaceChildren(); draw(content, value);
    }).catch(failure => {
      if (disposed || generation !== ticket) return;
      content.replaceChildren(); const error = settingsError(ctx); showSettingsError(error, failure); content.append(error);
      content.append(settingsAction(ctx, "重试", () => { key = undefined; refresh(); }));
    }).finally(() => { if (!disposed && generation === ticket) content.setAttribute("aria-busy", "false"); });
  };
  return liveSettingsPage(ctx, { id, title, content, dispose: () => { disposed = true; generation++; } }, refresh);
}

export function createCapabilityPage(ctx: IPadSettingsContext, editAgent: EditAgent): MobileShellPage {
  const api = capabilities(ctx), error = settingsError(ctx); let opening = false, disposed = false;
  const openMcp = async (service?: MobileMcpSummary) => {
    if (opening || disposed) return; opening = true; error.hidden = true;
    page.content.querySelectorAll<HTMLButtonElement>("button").forEach(button => { button.disabled = true; });
    try {
      const draft = await api.createMcpDraft(service?.id); if (disposed) return;
      opening = false; await ctx.push(createMcpPage(ctx, draft, service));
    } catch (failure) { if (!disposed) showSettingsError(error, failure); }
    finally { opening = false; if (!disposed) page.content.querySelectorAll<HTMLButtonElement>("button").forEach(button => { button.disabled = false; }); }
  };
  const page = resourcePage(ctx, "ipad-settings-caps", "能力", async () => {
    const [skills, mcp] = await Promise.all([api.listSkills(), api.listMcp()]); return { skills, mcp, tavily: api.readTavily() };
  }, (content, data) => {
    const builtin = data.skills.filter(skill => skill.builtin), mine = data.skills.filter(skill => !skill.builtin);
    const skills = settingsGroup(ctx, content, "Skills");
    settingsRow(ctx, skills, t(ctx, "内置技能"), enabledCount(ctx, builtin.filter(skill => skill.enabled && skill.mobileAvailable).length), () => ctx.push(createSkillList(ctx, true, editAgent)), tile(ctx, "sparkles"));
    settingsRow(ctx, skills, t(ctx, "我的 Skill"), enabledCount(ctx, mine.filter(skill => skill.enabled && skill.mobileAvailable).length, mine.length), () => ctx.push(createSkillList(ctx, false, editAgent)), tile(ctx, "sparkles"));
    const mcp = settingsGroup(ctx, content, "MCP");
    for (const service of data.mcp) settingsRow(ctx, mcp, service.name, t(ctx, service.statusLabel), () => openMcp(service), tile(ctx, "plug"));
    settingsRow(ctx, mcp, t(ctx, "添加 MCP 服务"), "", () => openMcp(), tile(ctx, "plus"));
    settingsRow(ctx, settingsGroup(ctx, content, t(ctx, "工具")), t(ctx, "联网搜索"), t(ctx, webSearchApiKey(data.tavily) ? "已填写 Key" : "未填写 Key"), () => ctx.push(createTavilyPage(ctx)), tile(ctx, "globe"));
    content.append(error); if (opening) content.querySelectorAll<HTMLButtonElement>("button").forEach(button => { button.disabled = true; });
  });
  page.canLeave = () => !opening;
  const dispose = page.dispose; page.dispose = () => { disposed = true; dispose?.(); }; return page;
}

function createSkillList(ctx: IPadSettingsContext, builtin: boolean, editAgent: EditAgent): MobileShellPage {
  const api = capabilities(ctx);
  return resourcePage(ctx, `ipad-skills-${builtin ? "builtin" : "mine"}`, builtin ? "内置技能" : "我的 Skill", () => api.listSkills(), (content, all) => {
    const list = all.filter(skill => skill.builtin === builtin), group = el(ctx.document, "div", "pd-settings-group pd-cap-skill-list"), error = settingsError(ctx); content.append(group, error);
    if (!list.length) { group.append(el(ctx.document, "div", "pd-settings-empty", t(ctx, "还没有我的 Skill"))); return; }
    for (const skill of list) {
      const row = el(ctx.document, "div", "pd-cap-skill-row"), button = el(ctx.document, "button", "pd-cap-skill-main"); button.type = "button"; button.dataset.skillId = skill.id;
      const copy = el(ctx.document, "span", "pd-settings-copy"), count = skill.agents.filter(agent => agent.allowed).length;
      copy.append(el(ctx.document, "span", "pd-settings-name", skill.name), el(ctx.document, "span", "pd-settings-description", !skill.mobileAvailable ? t(ctx, skill.unavailableReason || "只能在电脑上用") : `${ctx.host.settings().settingsLanguage === "en" ? `${count} Agents can use` : `${count} 个 Agent 能用`} · ${skill.description}`));
      button.append(tile(ctx, skillIcon(skill.id)), copy);
      button.addEventListener("click", () => { void ctx.push(createSkillDetail(ctx, skill.id, editAgent)).catch(error => ctx.error(error)); }); row.append(button);
      if (skill.mobileAvailable) {
        const toggle = settingsToggle(ctx, `${t(ctx, "启用")}${skill.name}`, skill.enabled, async enabled => {
          error.hidden = true;
          try { await api.setSkillEnabled(skill.id, enabled); ctx.refresh(); }
          catch (failure) { showSettingsError(error, failure); throw failure; }
        }); const hit = el(ctx.document, "label", "pd-settings-switch-hit"); hit.append(toggle); row.append(hit);
      }
      group.append(row);
    }
  });
}

function createSkillDetail(ctx: IPadSettingsContext, id: string, editAgent: EditAgent): MobileShellPage {
  const api = capabilities(ctx), content = settingsContent(ctx), error = settingsError(ctx), leaveArea = el(ctx.document, "div", ""); content.classList.add("pd-capabilities");
  let snapshot: MobileSkillSnapshot | undefined, draft = "", editing = false, busy = false, disposed = false, nested = false, key: string | undefined;
  let leave: Promise<boolean> | undefined, allowLeave = false, generation = 0;
  const dirty = () => editing && draft !== snapshot?.content;
  const page: MobileShellPage = { id: `ipad-skill-${id}`, title: "Skill", content,
    canLeave: () => {
      if (busy) return false;
      if (nested || allowLeave || !dirty()) return true;
      return leave ??= leaveSettingsConfirm(ctx, leaveArea).then(allowed => { leave = undefined; allowLeave = allowed; return allowed; });
    }, dispose: () => { disposed = true; generation++; } };
  const report = (failure: unknown) => { if (!disposed) showSettingsError(error, failure); };
  function update(): void {
    content.setAttribute("aria-busy", String(busy));
    content.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement>("button,input,textarea").forEach(control => { control.disabled = busy; });
  }
  function render(): void {
    if (!snapshot || disposed) return;
    page.title = snapshot.name;
    const heading = content.closest(".echoink-ipad-page")?.querySelector(".echoink-ipad-title"); if (heading) heading.textContent = snapshot.name;
    content.replaceChildren();
    const head = el(ctx.document, "div", "pd-cap-skill-head"), copy = el(ctx.document, "div", "pd-settings-copy");
    copy.append(el(ctx.document, "div", "pd-cap-skill-title", snapshot.name), el(ctx.document, "div", "pd-cap-skill-description", snapshot.description)); head.append(tile(ctx, skillIcon(id), true), copy); content.append(head);
    const state = el(ctx.document, "div", "pd-settings-group pd-cap-detail-state"); content.append(state);
    if (snapshot.mobileAvailable) settingsSwitch(ctx, state, t(ctx, "启用"), snapshot.enabled, async enabled => {
      busy = true; update();
      try { const summary = await api.setSkillEnabled(id, enabled); if (disposed) return; snapshot = { ...snapshot!, ...summary }; ctx.refresh(); }
      catch (failure) { report(failure); throw failure; }
      finally { busy = false; update(); }
    });
    else settingsRow(ctx, state, t(ctx, "状态"), t(ctx, snapshot.unavailableReason || "只能在电脑上用"));
    const location = settingsRow(ctx, state, t(ctx, "文件位置")), path = el(ctx.document, "span", "pd-cap-path", snapshot.contentPath || snapshot.sourceLabel); location.querySelector(".pd-settings-copy")!.append(path);
    if (snapshot.contentPath) {
      const copyButton = textAction(ctx, "复制路径", async () => {
        const clipboard = ctx.document.defaultView?.navigator.clipboard;
        if (!clipboard) { report(t(ctx, "无法复制路径")); return; }
        try { await clipboard.writeText(snapshot!.contentPath!); if (!disposed) new Notice(t(ctx, "路径已复制")); } catch (failure) { report(failure); }
      }); copyButton.classList.add("pd-cap-copy"); copyButton.firstElementChild!.replaceChildren(ipadIcon(ctx.document, "copy")); copyButton.setAttribute("aria-label", t(ctx, "复制路径")); location.append(copyButton);
    }
    const agents = settingsGroup(ctx, content, t(ctx, "哪些 Agent 能用"));
    const chooseAgents = async () => { nested = true; try {
      await ctx.push(createSkillAgentsPage(ctx, snapshot!, summary => {
        snapshot = { ...snapshot!, ...summary }; renderAgentRows(); ctx.refresh();
      }));
    } finally { nested = false; } };
    const renderAgentRows = () => {
      agents.replaceChildren();
      for (const agent of snapshot!.agents.filter(agent => agent.allowed)) {
        const identity = ctx.host.settings().agentRegistry.agents.find(item => item.id === agent.id);
        settingsRow(ctx, agents, agent.name, "", chooseAgents, identity ? ipadAvatar(ctx.document, identity) : undefined);
      }
      if (!agents.childElementCount) settingsRow(ctx, agents, t(ctx, "选择 Agent"), "", chooseAgents);
    }; renderAgentRows();
    const title = el(ctx.document, "div", "pd-cap-section-heading"); title.append(el(ctx.document, "h2", "pd-settings-label", t(ctx, "Skill 指令"))); content.append(title);
    if (editing) {
      const editor = el(ctx.document, "textarea", "pd-cap-skill-editor"); editor.value = draft; editor.setAttribute("aria-label", t(ctx, "Skill 指令")); editor.spellcheck = false;
      editor.addEventListener("input", () => { draft = editor.value; allowLeave = false; error.hidden = true; }); content.append(editor);
      const actions = el(ctx.document, "div", "pd-settings-actions");
      if (snapshot.builtin && api.defaultSkillContent(id) !== null) actions.append(textAction(ctx, "恢复默认", () => {
        const original = api.defaultSkillContent(id); if (original === null || busy) return; draft = original; editor.value = draft; allowLeave = false; new Notice(t(ctx, "已恢复为默认内容，保存后生效"));
      }));
      actions.append(settingsAction(ctx, "取消", () => { editing = false; draft = snapshot!.content; error.hidden = true; render(); }), settingsAction(ctx, "保存", async () => {
        if (busy) return; busy = true; error.hidden = true; update();
        try {
          const saved = await api.saveSkill(id, draft, snapshot!.version); if (disposed) return;
          snapshot = saved; draft = saved.content; editing = false; render(); ctx.refresh(); new Notice(t(ctx, "Skill 指令已保存"));
        } catch (failure) { report(failure); }
        finally { busy = false; if (!disposed) update(); }
      }, true)); content.append(actions);
    } else {
      title.append(settingsAction(ctx, "编辑", () => { editing = true; draft = snapshot!.content; render(); content.querySelector<HTMLTextAreaElement>("textarea")?.focus(); }));
      const body = el(ctx.document, "div", "pd-cap-skill-body"); ctx.host.renderMarkdown(snapshot.content, body, snapshot.contentPath ?? undefined); content.append(body);
    }
    content.append(error, leaveArea); update();
  }
  const refresh = () => {
    if (snapshot) page.title = snapshot.name;
    if (editing || busy || disposed) return;
    const next = sourceKey(ctx); if (next === key) { if (snapshot) page.title = snapshot.name; return; } key = next; const ticket = ++generation;
    if (!snapshot) { content.replaceChildren(); status(ctx, content, "读取中…"); }
    void api.readSkill(id).then(value => { if (disposed || ticket !== generation || editing) return; snapshot = value; render(); }).catch(failure => {
      if (disposed || ticket !== generation) return; content.replaceChildren(error); report(failure);
      content.append(settingsAction(ctx, "重试", () => { key = undefined; refresh(); }));
    });
  };
  return liveSettingsPage(ctx, page, refresh);
}

function createSkillAgentsPage(ctx: IPadSettingsContext, snapshot: MobileSkillSnapshot, saved: (summary: Awaited<ReturnType<MobileCapabilitiesPort["saveSkillAgents"]>>) => void): MobileShellPage {
  const content = settingsContent(ctx), group = settingsGroup(ctx, content, t(ctx, "哪些 Agent 能用")), error = settingsError(ctx), footer = el(ctx.document, "div", "pd-settings-actions"), leaveArea = el(ctx.document, "div", "");
  const selected = new Set(snapshot.agents.filter(agent => agent.allowed).map(agent => agent.id)), original = [...selected].sort().join("\n");
  let busy = false, disposed = false, allow = false; content.append(error, leaveArea);
  for (const agent of snapshot.agents) {
    const input = check(ctx, group, agent.name, selected.has(agent.id), value => { if (value) selected.add(agent.id); else selected.delete(agent.id); allow = false; error.hidden = true; });
    const identity = ctx.host.settings().agentRegistry.agents.find(item => item.id === agent.id); if (identity) input.parentElement!.prepend(ipadAvatar(ctx.document, identity));
  }
  const cancel = settingsAction(ctx, "取消", () => { allow = true; return ctx.back(); }), save = settingsAction(ctx, "保存", async () => {
    if (busy) return; busy = true; update(); error.hidden = true;
    try { const summary = await capabilities(ctx).saveSkillAgents(snapshot.id, [...selected], snapshot.agentsVersion); if (disposed) return; saved(summary); allow = true; busy = false; await ctx.back(); }
    catch (failure) { if (!disposed) showSettingsError(error, failure); }
    finally { busy = false; if (!disposed) update(); }
  }, true);
  function update(): void { content.querySelectorAll<HTMLInputElement>("input").forEach(input => { input.disabled = busy; }); cancel.disabled = save.disabled = busy; content.setAttribute("aria-busy", String(busy)); }
  footer.append(cancel, save);
  return { id: `ipad-skill-agents-${snapshot.id}`, title: t(ctx, "选择 Agent"), content, footer,
    canLeave: () => busy ? false : allow || [...selected].sort().join("\n") === original ? true : leaveSettingsConfirm(ctx, leaveArea),
    dispose: () => { disposed = true; } };
}

function createMcpPage(ctx: IPadSettingsContext, input: MobileMcpDraft, summary?: MobileMcpSummary): MobileShellPage {
  const api = capabilities(ctx), draft = structuredClone(input), content = settingsContent(ctx), fields = el(ctx.document, "fieldset", "pd-cap-fields"), error = settingsError(ctx);
  content.classList.add("pd-capabilities"); content.append(fields, error);
  const footer = el(ctx.document, "div", ""), leaveArea = el(ctx.document, "div", ""), actions = el(ctx.document, "div", "pd-settings-actions"); footer.append(leaveArea, actions);
  const readonly = draft.readonly || draft.transport === "stdio", baseline = JSON.stringify(draft);
  let busy = false, saving = false, disposed = false, allowLeave = false, abort: AbortController | undefined, leave: Promise<boolean> | undefined;
  const connection = status(ctx, fields, summary?.statusLabel || (readonly ? "只能在电脑上用" : "尚未连接"));
  const tools = el(ctx.document, "div", "pd-cap-tools");
  const changed = () => { allowLeave = false; error.hidden = true; };
  const secrets = () => { let query: string[] = []; try { query = [...new URL(draft.url).searchParams.values()]; } catch { /* A partial URL is editable. */ } return [...Object.values(draft.headers), draft.url, ...query]; };
  const report = (failure: unknown) => { if (!disposed) showSettingsError(error, safeFailure(failure, secrets())); };
  const cancel = settingsAction(ctx, "取消", () => ctx.back()), stop = settingsAction(ctx, "停止", () => abort?.abort());
  const save = settingsAction(ctx, "保存", async () => {
    if (busy || readonly) return; busy = true; saving = true; error.hidden = true; update();
    try { await api.saveMcp(structuredClone(draft)); allowLeave = true; ctx.refresh(); if (!disposed) { new Notice(t(ctx, "已保存")); busy = false; saving = false; await ctx.back(); } }
    catch (failure) { report(failure); }
    finally { busy = false; saving = false; update(); }
  }, true);
  let discover: HTMLButtonElement | undefined;
  function update(): void {
    if (disposed) return; fields.disabled = busy; cancel.disabled = busy; stop.hidden = !busy || saving;
    save.disabled = busy || !draft.name.trim() || !draft.url.trim(); content.setAttribute("aria-busy", String(busy));
    buttonText(save, t(ctx, saving ? "保存中…" : "保存"));
    if (discover) { discover.disabled = busy || !draft.url.trim(); buttonText(discover, t(ctx, busy && !saving ? "连接中…" : "连接并发现工具")); }
  }
  function renderTools(): void {
    tools.replaceChildren(); const group = settingsGroup(ctx, tools, t(ctx, "可用工具"));
    if (!draft.tools.length) { group.append(el(ctx.document, "div", "pd-settings-empty", t(ctx, "尚未发现工具"))); return; }
    for (const tool of draft.tools) {
      const item = el(ctx.document, "div", "pd-cap-tool"), policy = draft.toolPolicies[tool.name] ?? { enabled: false, trusted: false };
      if (readonly) settingsRow(ctx, item, tool.name, t(ctx, policy.enabled ? "已启用" : "未启用"), undefined, undefined, tool.description);
      else {
        const title = el(ctx.document, "div", "pd-cap-tool-title"); title.append(el(ctx.document, "span", "pd-settings-name", tool.name));
        if (tool.description) title.append(el(ctx.document, "span", "pd-settings-description", tool.description)); item.append(title);
        check(ctx, item, t(ctx, "允许调用"), policy.enabled, enabled => { draft.toolPolicies[tool.name] = { ...policy, ...draft.toolPolicies[tool.name], enabled }; changed(); });
        check(ctx, item, t(ctx, "信任此工具"), policy.trusted, trusted => { draft.toolPolicies[tool.name] = { ...policy, ...draft.toolPolicies[tool.name], trusted }; changed(); });
      }
      group.append(item);
    }
  }
  if (readonly) {
    const group = settingsGroup(ctx, fields, "MCP"); settingsRow(ctx, group, draft.name, t(ctx, "只能在电脑上用"), undefined, tile(ctx, "plug"), draft.description);
    fields.append(tools); renderTools();
    return { id: `ipad-mcp-${draft.id}`, title: draft.name, content, dispose: () => { disposed = true; } };
  }
  settingsField(ctx, fields, t(ctx, "连接名称"), draft.name, value => { draft.name = value; changed(); update(); });
  settingsField(ctx, fields, t(ctx, "说明"), draft.description, value => { draft.description = value; changed(); });
  const url = settingsField(ctx, fields, t(ctx, "接口地址"), draft.url, value => { draft.url = value; changed(); connection.textContent = t(ctx, "连接配置已修改，请重新连接"); update(); }, "url"); url.autocomplete = "off"; url.spellcheck = false;
  const authentication = settingsGroup(ctx, fields, t(ctx, "认证请求头")), headers = Object.entries(draft.headers).map(([name, value]) => ({ name, value })), headersBaseline = JSON.stringify(headers);
  const syncHeaders = () => { draft.headers = Object.fromEntries(headers.filter(header => header.name.trim()).map(header => [header.name.trim(), header.value])); changed(); connection.textContent = t(ctx, "连接配置已修改，请重新连接"); };
  function renderHeaders(): void {
    authentication.replaceChildren();
    for (const header of headers) {
      const row = el(ctx.document, "div", "pd-cap-header-fields");
      const name = settingsField(ctx, row, t(ctx, "名称"), header.name, value => { header.name = value; syncHeaders(); }); name.autocomplete = "off"; name.spellcheck = false;
      const value = settingsField(ctx, row, t(ctx, "值"), header.value, value => { header.value = value; syncHeaders(); }, "password"); value.autocomplete = "off"; value.spellcheck = false;
      row.append(textAction(ctx, "移除", () => { headers.splice(headers.indexOf(header), 1); syncHeaders(); renderHeaders(); })); authentication.append(row);
    }
    authentication.append(settingsAction(ctx, "添加请求头", () => { headers.push({ name: "", value: "" }); renderHeaders(); }));
  }
  renderHeaders();
  const permissions = settingsGroup(ctx, fields, t(ctx, "调用权限"));
  settingsSwitch(ctx, permissions, t(ctx, "启用"), draft.enabled, enabled => { draft.enabled = enabled; changed(); });
  const trust = check(ctx, permissions, t(ctx, "信任此服务"), draft.trusted, trusted => { draft.trusted = trusted; changed(); });
  discover = settingsAction(ctx, "连接并发现工具", async () => {
    if (busy || !draft.url.trim()) return; busy = true; saving = false; error.hidden = true; abort = new AbortController(); const signal = abort.signal; connection.textContent = t(ctx, "连接中…"); update();
    try {
      const discovered = await api.discoverMcp(structuredClone(draft), signal); if (disposed || signal.aborted) return;
      Object.assign(draft, discovered); trust.checked = draft.trusted; url.value = draft.url; connection.textContent = t(ctx, "已连接，尚未保存"); renderTools(); changed();
    } catch (failure) { if (!disposed) connection.textContent = t(ctx, signal.aborted ? "连接已取消" : "连接失败"); report(signal.aborted ? t(ctx, "连接已取消") : failure); }
    finally { if (!disposed && signal.aborted) connection.textContent = t(ctx, "连接已取消"); busy = false; abort = undefined; update(); }
  }); fields.append(discover, tools); renderTools(); actions.append(cancel, stop, save); update();
  return { id: `ipad-mcp-${draft.id}`, title: t(ctx, summary ? "编辑 MCP 服务" : "添加 MCP 服务"), content, footer,
    canLeave: () => {
      if (busy) return false;
      if (allowLeave || JSON.stringify(draft) === baseline && JSON.stringify(headers) === headersBaseline) return true;
      return leave ??= leaveSettingsConfirm(ctx, leaveArea).then(allowed => { leave = undefined; allowLeave = allowed; return allowed; });
    }, dispose: () => { disposed = true; abort?.abort(); } };
}

function createTavilyPage(ctx: IPadSettingsContext): MobileShellPage {
  const api = capabilities(ctx), initial = api.readTavily(), draft = { ...initial, ...normalizeWebSearchSettings(initial) }, content = settingsContent(ctx), fields = el(ctx.document, "fieldset", "pd-cap-fields"), error = settingsError(ctx);
  content.classList.add("pd-capabilities"); content.append(fields, error);
  const footer = el(ctx.document, "div", ""), leaveArea = el(ctx.document, "div", ""), actions = el(ctx.document, "div", "pd-settings-actions"); footer.append(leaveArea, actions);
  const baseline = JSON.stringify(draft); let busy = false, saving = false, disposed = false, allowLeave = false, generation = 0, abort: AbortController | undefined, leave: Promise<boolean> | undefined;
  const changed = () => { generation++; abort?.abort(); abort = undefined; busy = false; allowLeave = false; error.hidden = true; result.hidden = true; };
  const group = settingsGroup(ctx, fields, t(ctx, "联网搜索"));
  const toggle = settingsSwitch(ctx, group, t(ctx, "启用"), draft.enabled, value => { changed(); draft.enabled = value; update(); });
  const providers = el(ctx.document, "div", ""); providers.setAttribute("role", "radiogroup"); providers.setAttribute("aria-label", t(ctx, "搜索服务")); group.append(providers);
  const radios: HTMLInputElement[] = [];
  for (const provider of WEB_SEARCH_PROVIDERS) {
    const row = el(ctx.document, "label", "pd-settings-row"), radio = el(ctx.document, "input", ""); radio.type = "radio"; radio.name = "ipad-search-provider"; radio.value = provider; radio.checked = draft.provider === provider;
    const name = provider === "deepseek" ? "DeepSeek" : "Tavily"; radio.setAttribute("aria-label", name); row.append(el(ctx.document, "span", "pd-settings-copy", name), radio); providers.append(row); radios.push(radio);
    radio.addEventListener("change", () => { if (!radio.checked) return; changed(); draft.provider = provider; if (!webSearchApiKey(draft)) { draft.enabled = false; showSettingsError(error, t(ctx, "请先填写当前搜索服务的 API Key。")); } refreshKey(); update(); });
  }
  const key = settingsField(ctx, fields, "API Key", webSearchApiKey(draft), value => { changed(); setWebSearchApiKey(draft, value); if (!webSearchApiKey(draft)) draft.enabled = false; update(); }, "password"); key.autocomplete = "off"; key.spellcheck = false;
  const pricing = el(ctx.document, "div", "pd-sub"); fields.append(pricing);
  function refreshKey(): void {
    key.value = webSearchApiKey(draft); const deepseek = webSearchProvider(draft) === "deepseek";
    pricing.replaceChildren(); const link = el(ctx.document, "a", "", t(ctx, "官网 / 获取 API Key")); link.href = deepseek ? "https://platform.deepseek.com/api_keys" : "https://app.tavily.com"; link.target = "_blank"; link.rel = "noopener noreferrer";
    const price = el(ctx.document, "a", "", t(ctx, "官方定价")); price.href = deepseek ? "https://api-docs.deepseek.com/zh-cn/guides/search/" : "https://docs.tavily.com/documentation/api-credits"; price.target = "_blank"; price.rel = "noopener noreferrer";
    pricing.append(link, ctx.document.createTextNode(" · "), price, el(ctx.document, "div", "", t(ctx, "测试会发送一次搜索请求，按官方定价计费。")));
  }
  const result = status(ctx, content, ""); result.hidden = true;
  const cancel = settingsAction(ctx, "取消", () => ctx.back()), stop = settingsAction(ctx, "停止", () => abort?.abort());
  const test = settingsAction(ctx, "测试连接", async () => {
    if (busy || !webSearchApiKey(draft)) return; busy = true; saving = false; abort = new AbortController(); const request = abort, revision = ++generation; error.hidden = true; result.hidden = true; update();
    try { await api.testTavily({ ...draft }, request.signal); if (!disposed && revision === generation && !request.signal.aborted) { result.textContent = t(ctx, "连接成功"); result.hidden = false; } }
    catch (failure) { if (!disposed && revision === generation) showSettingsError(error, request.signal.aborted ? t(ctx, "测试已取消。") : t(ctx, safeFailure(failure, [draft.apiKey, draft.deepseekApiKey]))); }
    finally { if (revision === generation) { busy = false; abort = undefined; update(); } }
  });
  const save = settingsAction(ctx, "保存", async () => {
    if (busy || draft.enabled && !webSearchApiKey(draft)) return; busy = true; saving = true; error.hidden = true; update();
    try { await api.saveTavily({ ...draft }); allowLeave = true; ctx.refresh(); if (!disposed) { new Notice(t(ctx, "已保存")); busy = false; saving = false; await ctx.back(); } }
    catch (failure) { if (!disposed) showSettingsError(error, safeFailure(failure, [draft.apiKey, draft.deepseekApiKey])); }
    finally { busy = false; saving = false; update(); }
  }, true);
  function update(): void {
    if (disposed) return; fields.disabled = saving; toggle.checked = draft.enabled; for (const radio of radios) radio.checked = draft.provider === radio.value;
    cancel.disabled = saving; test.disabled = busy || !webSearchApiKey(draft); save.disabled = busy || draft.enabled && !webSearchApiKey(draft); stop.hidden = !busy || saving;
    content.setAttribute("aria-busy", String(busy)); buttonText(test, t(ctx, busy && !saving ? "测试中…" : "测试连接")); buttonText(save, t(ctx, saving ? "保存中…" : "保存"));
  }
  actions.append(cancel, test, stop, save); refreshKey(); update();
  return { id: "ipad-tavily", title: t(ctx, "联网搜索"), content, footer,
    canLeave: () => {
      if (saving) return false;
      if (allowLeave || JSON.stringify(draft) === baseline) return true;
      return leave ??= leaveSettingsConfirm(ctx, leaveArea).then(allowed => { leave = undefined; allowLeave = allowed; return allowed; });
    }, dispose: () => { disposed = true; generation++; abort?.abort(); } };
}
