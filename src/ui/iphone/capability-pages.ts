import { skillDeliveryNotice } from "../../resources/remote-skill-presentation";
import { safeSkillCompareUrl } from "../../membership/skill-delivery";
import { normalizeWebSearchSettings, webSearchApiKey, setWebSearchApiKey, webSearchProvider, WEB_SEARCH_PROVIDERS } from "../../tools/web-search-settings";
import { Notice } from "obsidian";
import { skillIcon } from "../../agents/skill-icons";
import type { AgentDefinition } from "../../agents/types";
import type { MobileCapabilitiesPort, MobileMcpDraft, MobileSkillSnapshot, MobileSkillSummary } from "../../mobile/capabilities-contracts";
import type { MobileShellPage } from "../mobile/shell-types";
import type { IPhonePageContext } from "./workbench-contract";
import { iphoneAvatar, iphoneElement as el, iphoneIcon } from "./workbench-elements";
import { settingsMessage, settingsText } from "./settings-language";
import { pushSettingsPage, settingsBody, settingsButton, settingsCheck, settingsError, settingsField, settingsGroup, settingsRow, settingsSwitch } from "./settings-elements";

/** The iPhone owns its page DOM and drafts; only capability data is shared. */
export class IPhoneCapabilityPages {
  private readonly refreshers = new Set<() => Promise<void>>();
  constructor(private readonly ctx: IPhonePageContext, private readonly editAgent: (id: string) => Promise<void>) {}
  private get service(): MobileCapabilitiesPort { return this.ctx.host.services.capabilities; }
  refresh(): void { for (const refresh of this.refreshers) void refresh(); }

  async open(): Promise<void> {
    const { ctx } = this, id = "iphone-settings-caps";
    if (ctx.shell.hasPage(id)) { this.refresh(); await ctx.shell.backTo(id); return; }
    const body = this.body(); let disposed = false, revision = 0;
    const render = async () => {
      const current = ++revision;
      try {
        const [skills, servers] = await Promise.all([this.service.listSkills(), this.service.listMcp()]);
        if (disposed || current !== revision) return;
        body.replaceChildren(); const builtin = skills.filter(skill => skill.builtin), mine = skills.filter(skill => !skill.builtin);
        const group = settingsGroup(ctx, body, "Skills", true);
        settingsRow(ctx, group, "内置技能", { leading: this.tile("sparkles"), value: this.text(`${builtin.filter(skill => skill.enabled && skill.mobileAvailable).length} 个启用`, `${builtin.filter(skill => skill.enabled && skill.mobileAvailable).length} enabled`), literalValue: true, action: () => this.skills(true) });
        settingsRow(ctx, group, "我的 Skill", { leading: this.tile("sparkles"), value: this.text(`${mine.filter(skill => skill.enabled).length} / ${mine.length} 启用`, `${mine.filter(skill => skill.enabled).length} / ${mine.length} enabled`), literalValue: true, action: () => this.skills(false) });
        const mcp = settingsGroup(ctx, body, "MCP", true);
        for (const server of servers) settingsRow(ctx, mcp, server.name, { literal: true, literalValue: true, leading: this.tile("plug"), value: server.statusLabel, action: () => this.mcp(server.id) });
        settingsRow(ctx, mcp, "添加 MCP 服务", { leading: this.tile("plus"), action: () => this.mcp() });
        const tavily = this.service.readTavily();
        settingsRow(ctx, settingsGroup(ctx, body, "工具"), "联网搜索", { leading: this.tile("globe"), value: webSearchApiKey(tavily) ? "已填写 Key" : "未填写 Key", action: () => this.tavily() });
      } catch (failure) { if (!disposed && current === revision) this.loadFailure(body, failure, render); }
    };
    this.loading(body); this.refreshers.add(render);
    await pushSettingsPage(ctx, { id, title: "能力", content: body, dispose: () => { disposed = true; revision++; this.refreshers.delete(render); } });
    if (!disposed) await render();
  }

  private async skills(builtin: boolean): Promise<void> {
    const { ctx } = this, id = `iphone-settings-skills-${builtin ? "builtin" : "mine"}`;
    if (ctx.shell.hasPage(id)) { await ctx.shell.backTo(id); return; }
    const body = this.body(); let disposed = false, busy = 0, revision = 0;
    const render = async () => {
      if (busy) return;
      const current = ++revision;
      try {
        const skills = (await this.service.listSkills()).filter(skill => skill.builtin === builtin);
        if (disposed || current !== revision || busy) return;
        body.replaceChildren(); const group = settingsGroup(ctx, body);
        if (!skills.length) this.empty(group, "还没有我的 Skill");
        for (const skill of skills) {
          const row = el(ctx.document, "div", "ip-cap-skill-row"), main = el(ctx.document, "button", "ip-cap-skill-main"); main.type = "button";
          main.append(this.tile(skill.locked ? "lock" : skill.builtin ? skillIcon(skill.id) : "sparkles"));
          const label = el(ctx.document, "span", "ip-settings-label");
          label.append(el(ctx.document, "span", "ip-settings-name", skill.name), el(ctx.document, "span", "ip-settings-detail", this.skillDescription(skill)));
          main.append(label); main.addEventListener("click", () => { void this.skill(skill.id).catch(ctx.error); }); row.append(main); group.append(row);
          if (skill.mobileAvailable) settingsSwitch(ctx, group, skill.name, () => skill.enabled, async value => {
            busy++;
            try { Object.assign(skill, await this.service.setSkillEnabled(skill.id, value)); label.querySelector(".ip-settings-detail")!.textContent = this.skillDescription(skill); this.refresh(); }
            finally { busy--; }
          }, undefined, row);
        }
      } catch (failure) { if (!disposed && current === revision) this.loadFailure(body, failure, render); }
    };
    this.loading(body); this.refreshers.add(render);
    await pushSettingsPage(ctx, { id, title: builtin ? "内置技能" : "我的 Skill", content: body, canLeave: () => busy === 0, dispose: () => { disposed = true; revision++; this.refreshers.delete(render); } });
    if (!disposed) await render();
  }

  private async skill(id: string): Promise<void> {
    const { ctx } = this, pageId = `iphone-settings-skill-${id}`;
    if (ctx.shell.hasPage(pageId)) { await ctx.shell.backTo(pageId); return; }
    const body = this.body(); let snapshot: MobileSkillSnapshot | undefined, draft = "", editing = false, busy = false, disposed = false, visitingAgent = false, revision = 0;
    let definitions: AgentDefinition[] = [], agentGroup: HTMLElement | undefined;
    const guard = this.leaveGuard(body, () => busy, () => editing && draft !== snapshot?.content && !visitingAgent);
    const renderAgents = () => {
      if (!snapshot || !agentGroup) return; agentGroup.replaceChildren();
      const allowed = snapshot.agents.filter(agent => agent.allowed);
      const choose = async () => {
        visitingAgent = true;
        try { await this.skillAgents(snapshot!, summary => { snapshot = { ...snapshot!, ...summary }; renderAgents(); this.refresh(); }); }
        finally { visitingAgent = false; }
      };
      for (const agent of allowed) {
        const definition = definitions.find(item => item.id === agent.id);
        settingsRow(ctx, agentGroup, agent.name, { literal: true, leading: definition ? iphoneAvatar(ctx.document, definition) : iphoneIcon(ctx.document, "bot"), action: choose });
      }
      if (!allowed.length) settingsRow(ctx, agentGroup, "选择 Agent", { action: choose });
    };
    const render = () => {
      if (!snapshot || disposed) return;
      body.replaceChildren(); const head = el(ctx.document, "div", "ip-cap-skill-head");
      head.append(this.tile(snapshot.builtin ? skillIcon(id) : "sparkles", true));
      const labels = el(ctx.document, "div", "ip-settings-label");
      labels.append(el(ctx.document, "div", "ip-cap-skill-title", snapshot.name), el(ctx.document, "div", "ip-cap-skill-description", snapshot.description)); head.append(labels); body.append(head);
      if (snapshot.remote || snapshot.readonly) {
        const english = ctx.host.settings().settingsLanguage === "en";
        const info = settingsGroup(ctx, body);
        settingsRow(ctx, info, "PRO", { literal: true, value: snapshot.locked ? (english ? "PRO required" : "需要 PRO") : (snapshot.contentVersion ?? "PRO"), literalValue: true });
        const compareUrl = snapshot.compareUrl ? safeSkillCompareUrl(snapshot.compareUrl) : null;
        if (compareUrl) settingsRow(ctx, info, english ? "View examples" : "查看对比示例", { literal: true, action: () => { ctx.document.defaultView?.open(compareUrl, "_blank", "noopener,noreferrer"); } });
        else settingsRow(ctx, info, english ? "Comparison examples are not available yet." : "对比示例尚未提供。", { literal: true });
        const disclosure = el(ctx.document, "details", ""); disclosure.append(el(ctx.document, "summary", "", english ? "Downloads and offline use" : "下载与离线使用"), el(ctx.document, "p", "ip-settings-detail", skillDeliveryNotice(english))); body.append(disclosure);
        if (!snapshot.locked) { const content = el(ctx.document, "div", "ip-cap-skill-body markdown-rendered"); body.append(content); ctx.host.renderMarkdown(snapshot.content, content); }
        return;
      }
      const info = settingsGroup(ctx, body);
      if (snapshot.mobileAvailable) settingsSwitch(ctx, info, "启用", () => snapshot!.enabled, async value => {
        busy = true;
        try { Object.assign(snapshot!, await this.service.setSkillEnabled(id, value)); renderAgents(); this.refresh(); }
        finally { busy = false; }
      });
      else settingsRow(ctx, info, "状态", { value: snapshot.unavailableReason || "只能在电脑上用", literalValue: !!snapshot.unavailableReason });
      const location = el(ctx.document, "div", "ip-settings-row"), pathLabel = el(ctx.document, "span", "ip-settings-label");
      pathLabel.append(settingsMessage(ctx, el(ctx.document, "span", "ip-settings-name"), "文件位置"), el(ctx.document, "span", "ip-cap-path", snapshot.contentPath || snapshot.sourceLabel)); location.append(pathLabel);
      if (snapshot.contentPath) {
        const copy = settingsButton(ctx, "复制路径", () => { void this.copy(snapshot!.contentPath!).catch(failure => error.show(failure)); }, "is-icon");
        copy.replaceChildren(iphoneIcon(ctx.document, "copy")); copy.setAttribute("aria-label", settingsText(ctx, "复制路径")); location.append(copy);
      }
      info.append(location);
      agentGroup = settingsGroup(ctx, body, "哪些 Agent 能用"); renderAgents();
      const header = el(ctx.document, "div", "ip-cap-section-head"); header.append(settingsMessage(ctx, el(ctx.document, "h2", ""), "Skill 指令"));
      if (!editing) header.append(settingsButton(ctx, "编辑", () => { draft = snapshot!.content; editing = true; render(); body.querySelector("textarea")?.focus(); })); body.append(header);
      const error = settingsError(ctx, body);
      if (editing) {
        const editor = el(ctx.document, "textarea", "ip-cap-editor"); editor.value = draft; editor.setAttribute("aria-label", settingsText(ctx, "Skill 指令")); editor.spellcheck = false;
        editor.addEventListener("input", () => { draft = editor.value; }); body.append(editor);
        const actions = el(ctx.document, "div", "ip-settings-actions ip-cap-actions");
        if (snapshot.builtin && this.service.defaultSkillContent(id) !== null) actions.append(settingsButton(ctx, "恢复默认", () => {
          const content = this.service.defaultSkillContent(id); if (content === null || busy) return;
          draft = content; editor.value = content; this.notice("已恢复为默认内容，保存后生效");
        }));
        actions.append(settingsButton(ctx, "取消", () => { if (!busy) { editing = false; draft = snapshot!.content; render(); } }));
        const save = settingsButton(ctx, "保存", () => { void (async () => {
          if (busy) return; busy = true; editor.disabled = true; this.disabled(actions, true); error.show();
          try {
            const saved = await this.service.saveSkill(id, draft, snapshot!.version);
            if (disposed) return; snapshot = saved; draft = saved.content; editing = false; busy = false; render(); this.refresh(); this.notice("Skill 指令已保存");
          } catch (failure) { if (!disposed) { error.show(failure); editor.disabled = false; this.disabled(actions, false); } }
          finally { busy = false; }
        })(); }, "is-primary"); actions.append(save); body.append(actions);
      } else {
        const content = el(ctx.document, "div", "ip-cap-skill-body markdown-rendered"); body.append(content); ctx.host.renderMarkdown(snapshot.content, content, snapshot.contentPath || undefined);
      }
    };
    const refresh = async () => {
      if (busy) return; const current = ++revision;
      try {
        const [next, registry] = await Promise.all([this.service.readSkill(id), ctx.host.agents.snapshot()]); if (disposed || current !== revision || busy) return;
        definitions = registry.registry.agents;
        if (editing && snapshot) { snapshot = { ...next, content: snapshot.content, version: snapshot.version }; renderAgents(); return; }
        snapshot = next; draft = next.content; render();
      } catch (failure) { if (!disposed && current === revision) { if (!snapshot) this.loadFailure(body, failure, refresh); else settingsError(ctx, body).show(failure); } }
    };
    this.loading(body); await refresh(); this.refreshers.add(refresh);
    await pushSettingsPage(ctx, { id: pageId, title: snapshot?.name ?? "Skill", content: body, canLeave: guard.canLeave, dispose: () => { disposed = true; revision++; guard.dispose(); this.refreshers.delete(refresh); } });
  }

  private async skillAgents(snapshot: MobileSkillSnapshot, saved: (summary: MobileSkillSummary) => void): Promise<void> {
    const { ctx } = this, body = this.body(), group = settingsGroup(ctx, body, "哪些 Agent 能用"), error = settingsError(ctx, body);
    const selected = new Set(snapshot.agents.filter(agent => agent.allowed).map(agent => agent.id)), baseline = [...selected].sort().join("\n"); let busy = false, disposed = false, allow = false;
    const guard = this.leaveGuard(body, () => busy, () => !allow && [...selected].sort().join("\n") !== baseline);
    for (const agent of snapshot.agents) {
      const definition = ctx.host.settings().agentRegistry.agents.find(item => item.id === agent.id);
      settingsCheck(ctx, group, agent.name, selected.has(agent.id), value => { if (value) selected.add(agent.id); else selected.delete(agent.id); error.show(); }, definition ? iphoneAvatar(ctx.document, definition) : iphoneIcon(ctx.document, "bot"), true);
    }
    const footer = el(ctx.document, "div", "ip-settings-actions");
    footer.append(settingsButton(ctx, "取消", () => { allow = true; void ctx.shell.back(); }), settingsButton(ctx, "保存", () => { void (async () => {
      if (busy) return; busy = true; error.show(); this.disabled(body, true); this.disabled(footer, true);
      try { const summary = await this.service.saveSkillAgents(snapshot.id, [...selected], snapshot.agentsVersion); if (disposed) return; saved(summary); allow = true; busy = false; await ctx.shell.back(); }
      catch (failure) { if (!disposed) error.show(failure); }
      finally { busy = false; if (!disposed) { this.disabled(body, false); this.disabled(footer, false); } }
    })(); }, "is-primary"));
    await pushSettingsPage(ctx, { id: `iphone-skill-agents-${snapshot.id}`, title: "选择 Agent", content: body, footer, canLeave: guard.canLeave, dispose: () => { disposed = true; guard.dispose(); } });
  }

  private async mcp(id?: string): Promise<void> {
    const { ctx } = this, pageId = `iphone-settings-mcp-${id ?? "new"}`;
    if (ctx.shell.hasPage(pageId)) { await ctx.shell.backTo(pageId); return; }
    const body = this.body(); let draft: MobileMcpDraft | undefined, saving = false, disposed = false, controller: AbortController | undefined;
    let headers: { name: string; value: string }[] = [], baseline = "";
    const signature = () => JSON.stringify([draft, headers]);
    const guard = this.leaveGuard(body, () => saving, () => !!draft && !draft.readonly && signature() !== baseline);
    const render = () => {
      if (!draft || disposed) return;
      body.replaceChildren(); const fields = el(ctx.document, "fieldset", "ip-settings-fields"); body.append(fields);
      const statusGroup = settingsGroup(ctx, fields), status = settingsRow(ctx, statusGroup, "状态", { value: this.mcpStatus(draft), literalValue: true });
      if (draft.readonly || draft.transport === "stdio") {
        settingsRow(ctx, statusGroup, draft.name, { literal: true, detail: draft.description, literalDetail: true });
        this.tools(fields, draft, true); return;
      }
      settingsSwitch(ctx, statusGroup, "启用", () => draft!.enabled, async value => { draft!.enabled = value; });
      settingsField(ctx, fields, "名称", draft.name, value => { draft!.name = value; });
      settingsField(ctx, fields, "用途", draft.description, value => { draft!.description = value; });
      const endpoint = settingsField(ctx, fields, "服务地址", draft.url, value => { draft!.url = value; invalidate(); }, "url"); endpoint.autocomplete = "off"; endpoint.spellcheck = false;
      const auth = settingsGroup(ctx, fields, "请求头"), headerList = el(ctx.document, "div", "ip-cap-headers"); auth.append(headerList);
      const headerRender = () => {
        headerList.replaceChildren();
        for (const header of headers) {
          const row = el(ctx.document, "div", "ip-cap-header-row"); headerList.append(row);
          const name = settingsField(ctx, row, "请求头名称", header.name, value => { header.name = value; invalidate(); }); name.autocomplete = "off"; name.spellcheck = false;
          const value = settingsField(ctx, row, "请求头值", header.value, value => { header.value = value; invalidate(); }, "password"); value.autocomplete = "off";
          const remove = settingsButton(ctx, "移除请求头", () => { headers = headers.filter(item => item !== header); invalidate(); headerRender(); }, "is-icon"); remove.replaceChildren(iphoneIcon(ctx.document, "x")); remove.setAttribute("aria-label", settingsText(ctx, "移除请求头")); row.append(remove);
        }
      };
      headerRender(); auth.append(settingsButton(ctx, "添加请求头", () => { headers.push({ name: "", value: "" }); headerRender(); }));
      const permissions = settingsGroup(ctx, fields, "调用权限"); settingsCheck(ctx, permissions, "信任此服务", draft.trusted, value => { draft!.trusted = value; });
      this.tools(fields, draft, false);
      const error = settingsError(ctx, body), actions = el(ctx.document, "div", "ip-settings-actions ip-cap-actions"), stop = settingsButton(ctx, "停止", () => { controller?.abort(); }); stop.hidden = true;
      if (draft.error) error.show(this.safeFailure(draft.error, headers.map(header => header.value)));
      const discover = settingsButton(ctx, "连接并发现工具", () => { void (async () => {
        if (saving || controller) return;
        try { collect(); } catch (failure) { error.show(failure); return; }
        controller = new AbortController(); const request = controller; fields.disabled = true; discover.disabled = true; save.disabled = true; stop.hidden = false; error.show(); status.querySelector(".ip-settings-value")!.textContent = this.text("正在连接…", "Connecting…");
        try {
          const next = await this.service.discoverMcp(structuredClone(draft!), request.signal);
          if (request.signal.aborted) throw new Error(this.text("已停止", "Stopped"));
          if (!disposed) { draft = next; controller = undefined; render(); }
        }
        catch (failure) { if (!disposed) { error.show(request.signal.aborted ? this.text("已停止", "Stopped") : this.safeFailure(failure, headers.map(header => header.value))); status.querySelector(".ip-settings-value")!.textContent = this.mcpStatus(draft!); } }
        finally { if (controller === request) controller = undefined; if (!disposed) { fields.disabled = false; discover.disabled = false; save.disabled = false; stop.hidden = true; } }
      })(); });
      const save = settingsButton(ctx, "保存", () => { void (async () => {
        if (saving || controller) return;
        try { collect(); } catch (failure) { error.show(failure); return; }
        saving = true; fields.disabled = true; this.disabled(actions, true); error.show();
        try { await this.service.saveMcp(structuredClone(draft!)); if (!disposed) { baseline = signature(); saving = false; this.refresh(); this.notice("MCP 服务已保存"); await ctx.shell.back(); } }
        catch (failure) { if (!disposed) error.show(this.safeFailure(failure, headers.map(header => header.value))); }
        finally { saving = false; if (!disposed) { fields.disabled = false; this.disabled(actions, false); } }
      })(); }, "is-primary");
      actions.append(discover, stop, save); body.append(actions);
      function invalidate() { draft!.status = "configured"; draft!.error = undefined; status.querySelector(".ip-settings-value")!.textContent = settingsText(ctx, "已配置"); }
      function collect() {
        const next: Record<string, string> = {};
        for (const header of headers) {
          const name = header.name.trim(); if (!name && !header.value) continue;
          if (!name || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /[\r\n]/.test(header.value) || Object.keys(next).some(key => key.toLowerCase() === name.toLowerCase())) throw new Error(settingsText(ctx, "请求头名称无效或重复"));
          next[name] = header.value;
        }
        draft!.headers = next;
      }
    };
    const load = async () => {
      try { draft = await this.service.createMcpDraft(id); if (disposed) return; headers = Object.entries(draft.headers).map(([name, value]) => ({ name, value })); baseline = signature(); render(); }
      catch (failure) { if (!disposed) this.loadFailure(body, failure, load); }
    };
    this.loading(body);
    await pushSettingsPage(ctx, { id: pageId, title: id ? "编辑 MCP 服务" : "添加 MCP 服务", content: body, canLeave: guard.canLeave, dispose: () => { disposed = true; controller?.abort(); controller = undefined; guard.dispose(); } });
    if (!disposed) await load();
  }

  private tools(parent: HTMLElement, draft: MobileMcpDraft, readonly: boolean): void {
    const { ctx } = this, group = settingsGroup(ctx, parent, "可用工具");
    if (!draft.tools.length) { this.empty(group, readonly ? "尚未发现工具" : "还没有发现工具"); return; }
    for (const tool of draft.tools) {
      const section = el(ctx.document, "details", "ip-cap-tool"), summary = el(ctx.document, "summary", "ip-settings-row"), labels = el(ctx.document, "span", "ip-settings-label");
      labels.append(el(ctx.document, "span", "ip-settings-name", tool.name));
      if (tool.description) labels.append(el(ctx.document, "span", "ip-settings-detail", tool.description));
      summary.append(labels, el(ctx.document, "span", "ip-cap-tool-kind", this.text(tool.destructive ? "可能删除内容" : tool.readOnly ? "只读" : "会修改内容", tool.destructive ? "May delete content" : tool.readOnly ? "Read only" : "Can change content"))); section.append(summary);
      const policy = draft.toolPolicies[tool.name] ?? { enabled: false, trusted: false };
      const enabled = settingsCheck(ctx, section, "允许调用", policy.enabled, value => { draft.toolPolicies[tool.name] = { ...policy, enabled: value }; policy.enabled = value; }); enabled.disabled = readonly;
      const trusted = settingsCheck(ctx, section, "信任此工具", policy.trusted, value => { draft.toolPolicies[tool.name] = { ...policy, trusted: value }; policy.trusted = value; }); trusted.disabled = readonly;
      group.append(section);
    }
  }

  private async tavily(): Promise<void> {
    const { ctx } = this, id = "iphone-settings-tavily";
    if (ctx.shell.hasPage(id)) { await ctx.shell.backTo(id); return; }
    const initial = this.service.readTavily(), draft = { ...initial, ...normalizeWebSearchSettings(initial) }, body = this.body(), fields = el(ctx.document, "fieldset", "ip-settings-fields"); body.append(fields);
    let baseline = JSON.stringify(draft), saving = false, disposed = false, generation = 0, controller: AbortController | undefined;
    const guard = this.leaveGuard(body, () => saving, () => JSON.stringify(draft) !== baseline), group = settingsGroup(ctx, fields);
    const changed = () => { generation++; controller?.abort(); controller = undefined; result.textContent = ""; error.show(); update(); };
    const toggle = settingsSwitch(ctx, group, "启用", () => draft.enabled, async value => { changed(); draft.enabled = value; update(); });
    const providers = el(ctx.document, "div", ""); providers.setAttribute("role", "radiogroup"); providers.setAttribute("aria-label", this.text("搜索服务", "Search service")); group.append(providers);
    const radios: HTMLInputElement[] = [];
    for (const provider of WEB_SEARCH_PROVIDERS) {
      const row = el(ctx.document, "label", "ip-settings-row"), radio = el(ctx.document, "input", ""); radio.type = "radio"; radio.name = "iphone-search-provider"; radio.value = provider; radio.checked = draft.provider === provider;
      const name = provider === "deepseek" ? "DeepSeek" : "Tavily"; radio.setAttribute("aria-label", name); row.append(el(ctx.document, "span", "ip-settings-label", name), radio); providers.append(row); radios.push(radio);
      radio.addEventListener("change", () => { if (!radio.checked) return; changed(); draft.provider = provider; if (!webSearchApiKey(draft)) { draft.enabled = false; error.show(this.text("请先填写当前搜索服务的 API Key。", "Enter the selected search service's API key first.")); } refreshKey(); update(); });
    }
    const key = settingsField(ctx, fields, "API Key", webSearchApiKey(draft), value => { changed(); setWebSearchApiKey(draft, value); if (!webSearchApiKey(draft)) draft.enabled = false; update(); }, "password"); key.autocomplete = "off"; key.spellcheck = false;
    const pricing = el(ctx.document, "div", "ip-sub"); fields.append(pricing);
    const refreshKey = () => {
      key.value = webSearchApiKey(draft); const deepseek = webSearchProvider(draft) === "deepseek";
      pricing.replaceChildren(); const link = el(ctx.document, "a", "", this.text("官网 / 获取 API Key", "Website / Get an API key")); link.href = deepseek ? "https://platform.deepseek.com/api_keys" : "https://app.tavily.com"; link.target = "_blank"; link.rel = "noopener noreferrer";
      const price = el(ctx.document, "a", "", this.text("官方定价", "Official pricing")); price.href = deepseek ? "https://api-docs.deepseek.com/zh-cn/guides/search/" : "https://docs.tavily.com/documentation/api-credits"; price.target = "_blank"; price.rel = "noopener noreferrer";
      pricing.append(link, ctx.document.createTextNode(" · "), price, el(ctx.document, "div", "", this.text("测试会发送一次搜索请求，按官方定价计费。", "Testing sends one search request, charged at official rates.")));
    };
    const result = el(ctx.document, "div", "ip-cap-result"); result.setAttribute("role", "status"); result.setAttribute("aria-live", "polite"); body.append(result);
    const error = settingsError(ctx, body), actions = el(ctx.document, "div", "ip-settings-actions ip-cap-actions"), stop = settingsButton(ctx, "停止", () => { controller?.abort(); }); stop.hidden = true;
    const test = settingsButton(ctx, "测试连接", () => { void (async () => {
      if (saving || controller || !webSearchApiKey(draft)) return; controller = new AbortController(); const request = controller, revision = ++generation;
      update(); error.show(); result.textContent = this.text("正在测试…", "Testing…");
      try {
        const response = await this.service.testTavily({ ...draft }, request.signal);
        if (request.signal.aborted) throw new Error(this.text("已停止", "Stopped"));
        if (!disposed && revision === generation) result.textContent = this.text(`连接成功 · ${response.results.length} 条结果`, `Connected · ${response.results.length} results`);
      }
      catch (failure) { if (!disposed && revision === generation) { result.textContent = ""; error.show(request.signal.aborted ? this.text("已停止", "Stopped") : this.safeFailure(failure, [draft.apiKey, draft.deepseekApiKey])); } }
      finally { if (revision === generation) { controller = undefined; if (!disposed) update(); } }
    })(); });
    const save = settingsButton(ctx, "保存", () => { void (async () => {
      if (saving || controller || draft.enabled && !webSearchApiKey(draft)) return; saving = true; update(); error.show();
      try { const saved = await this.service.saveTavily({ ...draft }); if (!disposed) { Object.assign(draft, saved); baseline = JSON.stringify(draft); saving = false; this.refresh(); this.notice("联网搜索设置已保存"); await ctx.shell.back(); } }
      catch (failure) { if (!disposed) error.show(this.safeFailure(failure, [draft.apiKey, draft.deepseekApiKey])); }
      finally { saving = false; if (!disposed) update(); }
    })(); }, "is-primary");
    function update(): void {
      fields.disabled = saving; toggle.checked = draft.enabled; toggle.setAttribute("aria-checked", String(draft.enabled)); for (const radio of radios) radio.checked = draft.provider === radio.value;
      test.disabled = saving || Boolean(controller) || !webSearchApiKey(draft); save.disabled = saving || Boolean(controller) || draft.enabled && !webSearchApiKey(draft); stop.hidden = !controller || saving; body.setAttribute("aria-busy", String(saving || Boolean(controller)));
    }
    actions.append(test, stop, save); body.append(actions); refreshKey(); update();
    await pushSettingsPage(ctx, { id, title: "联网搜索", content: body, canLeave: guard.canLeave, dispose: () => { disposed = true; generation++; controller?.abort(); controller = undefined; guard.dispose(); } });
  }

  private leaveGuard(body: HTMLElement, blocked: () => boolean, dirty: () => boolean): { canLeave: NonNullable<MobileShellPage["canLeave"]>; dispose: () => void } {
    let resolve: ((value: boolean) => void) | undefined, allow = false;
    return { canLeave: () => {
      if (blocked()) return false; if (allow || !dirty()) return true; if (resolve) return false;
      return new Promise<boolean>(done => {
        resolve = done; const confirmation = el(this.ctx.document, "div", "ip-settings-confirm"), choices = el(this.ctx.document, "div", "ip-settings-actions");
        confirmation.append(settingsMessage(this.ctx, el(this.ctx.document, "p", ""), "还有未保存的修改。"));
        const decide = (value: boolean) => { const pending = resolve; resolve = undefined; confirmation.remove(); pending?.(value); };
        const keep = settingsButton(this.ctx, "继续编辑", () => decide(false));
        choices.append(keep, settingsButton(this.ctx, "放弃修改", () => { allow = true; decide(true); }, "is-primary")); confirmation.append(choices); body.append(confirmation); confirmation.scrollIntoView({ block: "nearest" }); keep.focus();
      });
    }, dispose: () => { resolve?.(false); resolve = undefined; } };
  }
  private body(): HTMLElement { const body = settingsBody(this.ctx); body.classList.add("ip-capabilities"); return body; }
  private tile(icon: string, large = false): HTMLElement { const tile = el(this.ctx.document, "span", `ip-cap-tile${large ? " is-large" : ""}`); tile.append(iphoneIcon(this.ctx.document, icon)); return tile; }
  private text(zh: string, en: string): string { return this.ctx.host.settings().settingsLanguage === "en" ? en : zh; }
  private notice(message: string): void { new Notice(settingsText(this.ctx, message)); }
  private skillDescription(skill: MobileSkillSummary): string { return skill.locked ? skill.description : skill.mobileAvailable ? `${this.text(`${skill.agents.filter(agent => agent.allowed).length} 个 Agent 能用`, `${skill.agents.filter(agent => agent.allowed).length} Agents`)} · ${skill.description}` : skill.unavailableReason || settingsText(this.ctx, "只能在电脑上用"); }
  private mcpStatus(draft: MobileMcpDraft): string {
    if (draft.readonly || draft.transport === "stdio") return settingsText(this.ctx, "只能在电脑上用");
    if (draft.status === "connected") return settingsText(this.ctx, "已连接");
    if (draft.status === "failed") return this.text("连接失败", "Connection failed");
    if (draft.status === "credential-required") return this.text("需要认证", "Authentication required");
    return settingsText(this.ctx, draft.url ? "已配置" : "未配置");
  }
  private empty(parent: HTMLElement, message: string): void { parent.append(settingsMessage(this.ctx, el(this.ctx.document, "div", "ip-cap-empty"), message)); }
  private loading(body: HTMLElement): void { body.replaceChildren(settingsMessage(this.ctx, el(this.ctx.document, "div", "ip-settings-status"), "正在加载…")); }
  private loadFailure(body: HTMLElement, failure: unknown, retry: () => Promise<void>): void { body.replaceChildren(); settingsError(this.ctx, body).show(failure); body.append(settingsButton(this.ctx, "重试", () => { this.loading(body); void retry(); })); }
  private disabled(parent: HTMLElement, value: boolean): void { for (const button of Array.from(parent.querySelectorAll("button"))) button.disabled = value; parent.setAttribute("aria-busy", String(value)); }
  private safeFailure(failure: unknown, secrets: string[]): string { let message = failure instanceof Error ? failure.message : String(failure); for (const secret of secrets) if (secret) message = message.split(secret).join("••••"); return message; }
  private async copy(path: string): Promise<void> { const clipboard = this.ctx.document.defaultView?.navigator.clipboard; if (!clipboard) throw new Error(this.text("当前环境无法复制路径", "Path copying is unavailable")); await clipboard.writeText(path); this.notice("路径已复制"); }
}
