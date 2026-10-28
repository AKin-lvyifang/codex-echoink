import { formatMobileDateTime } from "../../mobile/date-display";
import { Notice } from "obsidian";
import type { MobileMemoryCorrection, MobileMemoryCorrectionPreview, MobileMemorySettingsPort, MobileMemorySnapshot, MobileUserProfileSnapshot } from "../../mobile/memory-contracts";
import type { MobileShellPage } from "../mobile/shell-types";
import { IPHONE_MODULES, iphoneAvatar, iphoneElement as el } from "./workbench-elements";
import type { IPhonePageContext } from "./workbench-contract";
import { settingsMessage, settingsText } from "./settings-language";
import { pushSettingsPage, settingsBody, settingsButton, settingsError, settingsField, settingsGroup, settingsRow, settingsSelect, settingsSwitch } from "./settings-elements";

/** iPhone page state stays local; profile, Memory and Dream share the canonical service. */
export class IPhoneAgentSettingsPages {
  private readonly refreshers = new Set<() => Promise<void>>();
  private readonly previousDisabled = new WeakMap<HTMLElement, boolean>();
  constructor(private readonly ctx: IPhonePageContext, private readonly editAgent: (id?: string) => Promise<void>) {}
  private get service(): MobileMemorySettingsPort { return this.ctx.host.services.memory; }
  refresh(): void { for (const refresh of this.refreshers) void refresh(); }

  async open(): Promise<void> {
    const { ctx } = this, id = "iphone-settings-agent";
    if (ctx.shell.hasPage(id)) { this.refresh(); await ctx.shell.backTo(id); return; }
    const body = this.body(); let disposed = false, busy = false, revision = 0, expanded = false, prefs = this.service.readSettings(), limitBase = prefs.dreamRunsPerDay, limit = String(limitBase), controller: AbortController | undefined;
    let dreamView: (() => void) | undefined;
    const guard = this.leaveGuard(body, () => busy, () => limit !== String(limitBase));
    const stop = async () => { controller?.abort(); await this.service.cancelDream(); };
    const render = async () => {
      if (disposed || busy) return;
      if (limit !== String(limitBase) && body.querySelector(".ip-agent-dream")) { dreamView?.(); return; }
      const current = ++revision;
      const [registry, profile, archives] = await Promise.allSettled([ctx.host.agents.snapshot(), this.service.readProfile(), this.service.listArchives()]);
      if (disposed || busy || current !== revision) return;
      body.replaceChildren(); const agents = settingsGroup(ctx, body, "我的 Agent"), owners = settingsGroup(ctx, body, "模块负责人");
      if (registry.status === "fulfilled") {
        for (const agent of registry.value.registry.agents) settingsRow(ctx, agents, agent.name, { leading: iphoneAvatar(ctx.document, agent), literal: true, literalDetail: true, detail: agent.position || undefined, action: () => this.editAgent(agent.id) });
        settingsRow(ctx, agents, "新建 Agent", { icon: "user-plus", action: () => this.editAgent() });
        let snapshot = registry.value;
        const ownerError = settingsError(ctx, body);
        const renderOwners = () => {
          owners.replaceChildren();
          for (const module of ["knowledge-base", "todos", "finance", "journal", "english-diary", "pdf-reading"].map(id => IPHONE_MODULES.find(module => module.id === id)!)) {
            const owner = snapshot.registry.agents.find(agent => agent.id === snapshot.registry.moduleOwners[module.id]);
            const select = settingsSelect(ctx, owners, module.name, snapshot.registry.agents.map(agent => [agent.id, agent.name] as const), owner?.id ?? "", value => {
              if (busy || value === snapshot.registry.moduleOwners[module.id]) { select.value = snapshot.registry.moduleOwners[module.id]; return; }
              busy = true; this.controls(body, true); body.setAttribute("aria-busy", "true"); ownerError.show();
              void (async () => {
                let saved = false;
                try {
                  snapshot = await ctx.host.agents.setOwner(module.id, value, snapshot.version); saved = true;
                  try { await ctx.host.services.refreshAgentIdentity(); } catch (failure) { ctx.error(failure); }
                } catch (failure) {
                  try { snapshot = await ctx.host.agents.snapshot(); } catch (reloadFailure) { ctx.error(reloadFailure); }
                  if (!disposed) ownerError.show(failure);
                } finally {
                  busy = false; this.controls(body, false); body.removeAttribute("aria-busy");
                  if (!disposed) { renderOwners(); if (saved) this.refresh(); }
                }
              })();
            }, owner ? iphoneAvatar(ctx.document, owner, "ip-avatar ip-agent-owner-avatar") : undefined);
            select.dataset.moduleOwner = module.id;
          }
        }; renderOwners();
      } else { settingsError(ctx, agents).show(registry.reason); agents.append(settingsButton(ctx, "重试", () => { void render(); })); }
      const memory = settingsGroup(ctx, body, "记忆"); prefs = this.service.readSettings(); limitBase = prefs.dreamRunsPerDay; limit = String(limitBase);
      const persist = async (key: "memoryEnabled" | "dreamEnabled" | "autoArchive", value: boolean) => {
        if (busy) throw new Error(this.text("正在保存，请稍候。", "Saving. Please wait.")); busy = true;
        let saved = false;
        try {
          prefs = await this.service.saveSettings({ ...prefs, [key]: value }); limitBase = prefs.dreamRunsPerDay;
          if (key === "dreamEnabled") { expanded = value; if (!value) await stop(); }
          saved = true;
        } finally { busy = false; if (saved && !disposed) void render(); }
      };
      settingsSwitch(ctx, memory, "长期记忆", () => this.service.readSettings().memoryEnabled, value => persist("memoryEnabled", value));
      const dreamRow = el(ctx.document, "div", "ip-settings-row ip-agent-dream-row"), dreamLink = el(ctx.document, "button", "ip-agent-dream-link"); dreamLink.type = "button";
      const dreamLabels = el(ctx.document, "span", "ip-settings-label"); dreamLabels.append(settingsMessage(ctx, el(ctx.document, "span", "ip-settings-name"), "做梦"), el(ctx.document, "span", "ip-settings-detail", this.dailyLimit(prefs.dreamRunsPerDay)));
      dreamLink.append(dreamLabels); dreamLink.disabled = !prefs.dreamEnabled; dreamLink.setAttribute("aria-expanded", String(expanded && prefs.dreamEnabled));
      dreamLink.addEventListener("click", () => { expanded = !expanded; dreamContent.hidden = !expanded; dreamLink.setAttribute("aria-expanded", String(expanded)); }); dreamRow.append(dreamLink); memory.append(dreamRow);
      settingsSwitch(ctx, memory, "做梦", () => this.service.readSettings().dreamEnabled, value => persist("dreamEnabled", value), undefined, dreamRow);
      const dreamContent = el(ctx.document, "div", "ip-agent-dream"); dreamContent.hidden = !expanded || !prefs.dreamEnabled; memory.append(dreamContent);
      const limitInput = settingsField(ctx, dreamContent, "每天最多整理次数", limit, value => { limit = value; dreamView?.(); }, "number"); limitInput.min = "1"; limitInput.max = "6"; limitInput.step = "1";
      const dreamStatus = el(ctx.document, "div", "ip-agent-status"); dreamStatus.setAttribute("role", "status"); dreamStatus.setAttribute("aria-live", "polite"); dreamContent.append(dreamStatus);
      const dreamError = settingsError(ctx, dreamContent), actions = this.actions(dreamContent);
      const run = settingsButton(ctx, "立即整理", () => { void (async () => {
        if (busy || controller || this.service.dreamStatus().phase === "running") return;
        controller = new AbortController(); const request = controller; dreamError.show(); dreamView?.();
        try { await this.service.runDream(request.signal); }
        catch (failure) { if (!disposed && !request.signal.aborted) dreamError.show(failure); }
        finally { if (controller === request) controller = undefined; if (!disposed) { dreamView?.(); this.refresh(); } }
      })(); });
      const cancel = settingsButton(ctx, "停止", () => { void stop().then(() => dreamView?.()).catch(dreamError.show); });
      const saveLimit = settingsButton(ctx, "保存", () => { void (async () => {
        if (busy) return; const value = Number(limit);
        if (!Number.isInteger(value) || value < 1 || value > 6) { dreamError.show(this.text("请输入 1–6 的整数。", "Enter a whole number from 1 to 6.")); return; }
        busy = true; this.controls(dreamContent, true); dreamError.show();
        try { const saved = await this.service.saveSettings({ ...prefs, dreamRunsPerDay: value }); prefs = saved; limitBase = saved.dreamRunsPerDay; limit = String(limitBase); busy = false; if (!disposed) { await render(); this.notice("设置已保存"); } }
        catch (failure) { if (!disposed) dreamError.show(failure); }
        finally { busy = false; if (!disposed) this.controls(dreamContent, false); }
      })(); }, "is-primary");
      actions.append(run, cancel, settingsButton(ctx, "重新读取", () => { prefs = this.service.readSettings(); limitBase = prefs.dreamRunsPerDay; dreamError.show(); dreamView?.(); this.notice("已重新读取，输入已保留"); }), saveLimit);
      dreamView = () => {
        const state = this.service.dreamStatus(), running = state.phase === "running" || !!controller;
        dreamStatus.textContent = `${this.dreamPhase(state.phase)} · ${this.text(`今天已尝试 ${state.attemptsToday} / ${state.dailyLimit} 次`, `${state.attemptsToday} / ${state.dailyLimit} attempts today`)}`;
        run.hidden = running; run.disabled = busy || limit !== String(limitBase); cancel.hidden = !running; saveLimit.disabled = busy || running; limitInput.disabled = busy || running;
        if (state.error) dreamError.show(state.error);
      }; dreamView();
      settingsRow(ctx, memory, "你的画像", { value: profile.status === "fulfilled" ? this.text(`${profile.value.items.filter(item => item.status === "current").length} 项`, `${profile.value.items.filter(item => item.status === "current").length} items`) : undefined, literalValue: true, action: () => this.profile() });
      if (profile.status === "rejected") settingsError(ctx, memory).show(profile.reason);
      settingsRow(ctx, memory, "记忆修正", { action: () => this.memories() });
      const sessions = settingsGroup(ctx, body, "会话"), archiveRow = el(ctx.document, "div", "ip-settings-row"), archiveLabel = el(ctx.document, "span", "ip-settings-label");
      archiveLabel.append(settingsMessage(ctx, el(ctx.document, "span", "ip-settings-name"), "自动归档"), settingsMessage(ctx, el(ctx.document, "span", "ip-settings-detail"), "完成 7 天后")); archiveRow.append(archiveLabel); sessions.append(archiveRow);
      settingsSwitch(ctx, sessions, "自动归档", () => this.service.readSettings().autoArchive, value => persist("autoArchive", value), undefined, archiveRow);
      settingsRow(ctx, sessions, "已归档会话", { value: archives.status === "fulfilled" ? String(archives.value.length) : undefined, literalValue: true, action: () => this.archives() });
      if (archives.status === "rejected") settingsError(ctx, sessions).show(archives.reason);
    };
    this.loading(body); this.refreshers.add(render);
    const unsubscribe = this.service.subscribe(() => { if (!disposed) { dreamView?.(); void render(); } });
    const background = () => { if (ctx.document.hidden && (controller || this.service.dreamStatus().phase === "running")) void stop().catch(error => ctx.error(error)); };
    ctx.document.addEventListener("visibilitychange", background);
    await pushSettingsPage(ctx, { id, title: "Agent", content: body, canLeave: async () => { if (!await guard.canLeave()) return false; if (controller || this.service.dreamStatus().phase === "running") await stop(); return true; }, dispose: () => { disposed = true; revision++; unsubscribe(); guard.dispose(); this.refreshers.delete(render); ctx.document.removeEventListener("visibilitychange", background); if (controller || this.service.dreamStatus().phase === "running") void stop().catch(error => ctx.error(error)); } });
    if (!disposed) await render();
  }

  private async profile(): Promise<void> {
    const { ctx } = this, id = "iphone-settings-user-profile";
    if (ctx.shell.hasPage(id)) { await ctx.shell.backTo(id); return; }
    const body = this.body(), error = settingsError(ctx, body); let snapshot: MobileUserProfileSnapshot | undefined, editing: string | undefined, draft = "", busy = false, disposed = false, revision = 0;
    const expanded = new Set<string>(), guard = this.leaveGuard(body, () => busy, () => !!editing && draft !== (snapshot?.items.find(item => item.status === "current" && item.profileKey === editing)?.text ?? ""));
    const mutate = async (operation: () => Promise<MobileUserProfileSnapshot>) => {
      if (busy) return; busy = true; this.controls(body, true); error.show();
      try { const saved = await operation(); if (disposed) return; snapshot = saved; editing = undefined; draft = ""; busy = false; render(); this.refresh(); }
      catch (failure) { if (!disposed) error.show(failure); } finally { busy = false; if (!disposed) this.controls(body, false); }
    };
    const renderSlot = (parent: HTMLElement, slot: MobileUserProfileSnapshot["slots"][number]) => {
      const item = snapshot!.items.find(item => item.profileKey === slot.profileKey && item.status === "current"), row = el(ctx.document, "section", "ip-agent-profile-item"); row.dataset.profileKey = slot.profileKey;
      const header = el(ctx.document, "div", "ip-agent-item-head"); header.append(el(ctx.document, "h3", "", settingsText(ctx, slot.labelZh))); row.append(header); parent.append(row);
      if (editing === slot.profileKey) {
        const editor = this.editor(row, slot.labelZh, draft, value => { draft = value; }); editor.maxLength = 120;
        const actions = this.actions(row);
        actions.append(settingsButton(ctx, "重新读取", () => { void reload(true); }), settingsButton(ctx, "取消", () => { editing = undefined; draft = ""; render(); }), settingsButton(ctx, "保存", () => { void mutate(() => this.service.saveProfile(slot.profileKey, draft, snapshot!.revision)); }, "is-primary"));
        return;
      }
      if (item) {
        row.append(el(ctx.document, "p", "ip-agent-profile-text", item.text), el(ctx.document, "div", "ip-agent-basis", this.profileBasis(item.basis)));
        const sources = snapshot!.sources.filter(source => source.profileKey === slot.profileKey), details = el(ctx.document, "details", "ip-agent-sources"); details.append(settingsMessage(ctx, el(ctx.document, "summary", ""), "来源"));
        for (const source of sources) {
          settingsRow(ctx, details, source.title || source.id, { literal: true, detail: source.available ? undefined : "来源不可用", action: source.available ? () => this.memory(source.id) : undefined });
          if (source.content) { const content = el(ctx.document, "div", "ip-agent-source-content"); ctx.host.renderMarkdown(source.content, content); details.append(content); }
        }
        if (!sources.length) this.empty(details, "未找到可用来源"); row.append(details);
      }
      const actions = this.actions(row), edit = settingsButton(ctx, item ? "编辑" : "补写", () => { editing = slot.profileKey; draft = item?.text ?? ""; render(); body.querySelector("textarea")?.focus(); }); edit.disabled = !!editing;
      actions.append(edit);
      if (item && item.basis !== "explicit_memory") { const confirm = settingsButton(ctx, "确认", () => { void mutate(() => this.service.confirmProfile(slot.profileKey, snapshot!.revision)); }); confirm.disabled = !!editing; actions.append(confirm); }
      if (item) {
        const remove = settingsButton(ctx, "删除", () => this.confirm(row, "仅删除这项画像，来源记忆会保留。", "删除", () => mutate(() => this.service.deleteProfile(slot.profileKey, snapshot!.revision)), true), "is-danger"); remove.disabled = !!editing; actions.append(remove);
      }
    };
    const render = () => {
      if (!snapshot || disposed) return; body.replaceChildren();
      for (const [section, name] of [["identity", "身份"], ["preference", "偏好"], ["collaboration", "协作"]] as const) {
        const group = settingsGroup(ctx, body, name), slots = snapshot.slots.filter(slot => slot.section === section), filled = slots.filter(slot => snapshot!.items.some(item => item.profileKey === slot.profileKey && item.status === "current"));
        for (const slot of filled) renderSlot(group, slot);
        const missing = slots.filter(slot => !filled.includes(slot));
        if (missing.length) {
          const details = el(ctx.document, "details", "ip-agent-missing"); details.open = expanded.has(section); details.append(el(ctx.document, "summary", "", this.text(`未填写 · ${missing.length} 项`, `${missing.length} unfilled`)));
          details.addEventListener("toggle", () => { if (details.open) expanded.add(section); else expanded.delete(section); });
          for (const slot of missing) renderSlot(details, slot); group.append(details);
        }
        if (!slots.length) this.empty(group, "暂无画像项");
      }
      body.append(error.element);
    };
    const reload = async (preserveDraft = false) => {
      if (busy || (editing && !preserveDraft)) return; const current = ++revision;
      try { const next = await this.service.readProfile(); if (disposed || current !== revision || busy || (editing && !preserveDraft)) return; snapshot = next; error.show(); render(); if (preserveDraft) this.notice("已重新读取，输入已保留"); }
      catch (failure) { if (!disposed && current === revision) { if (!snapshot) this.loadFailure(body, failure, () => reload()); else error.show(failure); } }
    };
    this.loading(body); const refresh = () => reload(); this.refreshers.add(refresh);
    await pushSettingsPage(ctx, { id, title: "你的画像", content: body, canLeave: guard.canLeave, dispose: () => { disposed = true; revision++; guard.dispose(); this.refreshers.delete(refresh); } });
    if (!disposed) await reload();
  }

  private async memories(): Promise<void> {
    const { ctx } = this, id = "iphone-settings-memories";
    if (ctx.shell.hasPage(id)) { await ctx.shell.backTo(id); return; }
    const body = this.body(), view = ctx.document.defaultView; let query = "", disposed = false, busy = false, revision = 0, timer: number | undefined;
    const search = settingsField(ctx, body, "搜索记忆", "", value => { query = value; if (view) { view.clearTimeout(timer); timer = view.setTimeout(() => { void render(); }, 180); } else void render(); }, "search"); search.autocomplete = "off";
    const actions = this.actions(body), exportButton = settingsButton(ctx, "导出记忆", () => { void (async () => {
      if (busy) return; busy = true; exportButton.disabled = true; error.show();
      try { const exported = await this.service.export(); if (!disposed) { exportArea.replaceChildren(); settingsRow(ctx, exportArea, "打开导出文件", { detail: exported.path, literalDetail: true, action: () => ctx.host.openNote(exported.path) }); } }
      catch (failure) { if (!disposed) error.show(failure); } finally { busy = false; if (!disposed) exportButton.disabled = false; }
    })(); }); actions.append(exportButton);
    const exportArea = el(ctx.document, "div", "ip-agent-export"), records = settingsGroup(ctx, body), forgotten = el(ctx.document, "details", "ip-agent-forgotten"), error = settingsError(ctx, body); body.append(exportArea, forgotten);
    const render = async () => {
      if (disposed || busy) return; const current = ++revision;
      try {
        const snapshot = await this.service.list(query); if (disposed || current !== revision || busy) return; error.show(); records.replaceChildren(); forgotten.replaceChildren();
        for (const record of snapshot.records) settingsRow(ctx, records, record.title, { literal: true, literalDetail: true, detail: `${record.status === "current" ? "" : `${this.memoryStatus(record.status)} · `}${this.memoryKind(record.kind)} · ${this.memoryBasis(record.basis)} · ${record.date}`, action: () => this.memory(record.id) });
        if (!snapshot.records.length) this.empty(records, query ? "没有匹配的记忆" : "还没有记忆");
        forgotten.append(el(ctx.document, "summary", "", this.text(`已忘记 · ${snapshot.forgotten.length}`, `Forgotten · ${snapshot.forgotten.length}`)));
        for (const item of snapshot.forgotten) {
          const row = el(ctx.document, "div", "ip-agent-forgotten-item"); row.append(el(ctx.document, "h3", "", item.title), el(ctx.document, "div", "ip-agent-basis", this.date(item.forgottenAt)));
          if (item.reason) row.append(el(ctx.document, "p", "", item.reason));
          row.append(settingsButton(ctx, "恢复", () => this.confirm(row, "恢复这条记忆？", "恢复", async () => {
            if (busy) return; busy = true; this.controls(row, true); error.show();
            try { await this.service.restore(item.id, snapshot.revision); busy = false; await render(); this.refresh(); }
            catch (failure) { error.show(failure); } finally { busy = false; if (!disposed) this.controls(row, false); }
          }))); forgotten.append(row);
        }
        if (!snapshot.forgotten.length) this.empty(forgotten, "没有已忘记的记忆");
      } catch (failure) { if (!disposed && current === revision) error.show(failure); }
    };
    this.refreshers.add(render); records.append(settingsMessage(ctx, el(ctx.document, "div", "ip-agent-empty"), "正在加载…"));
    await pushSettingsPage(ctx, { id, title: "记忆修正", content: body, canLeave: () => !busy, dispose: () => { disposed = true; revision++; view?.clearTimeout(timer); this.refreshers.delete(render); } });
    if (!disposed) await render();
  }

  private async memory(recordId: string): Promise<void> {
    const { ctx } = this, id = `iphone-settings-memory-${recordId}`;
    if (ctx.shell.hasPage(id)) { await ctx.shell.backTo(id); return; }
    const body = this.body(), error = settingsError(ctx, body); let snapshot: MobileMemorySnapshot | undefined, draft: MobileMemoryCorrection | undefined, preview: MobileMemoryCorrectionPreview | undefined, editing = false, busy = false, disposed = false, revision = 0;
    const signature = (value: MobileMemoryCorrection | undefined) => JSON.stringify(value);
    const original = () => snapshot ? { title: snapshot.record.title, content: snapshot.record.content, recallWhen: snapshot.record.recallWhen } : undefined;
    const guard = this.leaveGuard(body, () => busy, () => editing && signature(draft) !== signature(original()));
    const render = () => {
      if (!snapshot || disposed) return; body.replaceChildren(); const record = snapshot.record, heading = el(ctx.document, "h2", "ip-agent-title", record.title); body.append(heading);
      const meta = settingsGroup(ctx, body); settingsRow(ctx, meta, "类型", { value: this.memoryKind(record.kind), literalValue: true }); settingsRow(ctx, meta, "状态", { value: this.memoryStatus(record.status), literalValue: true }); settingsRow(ctx, meta, "来源", { detail: this.text(record.contentOrigin === "user_edit" ? "你手动编辑的记录" : "任务中保存的记录", record.contentOrigin === "user_edit" ? "Records you edited" : "Records saved in a task"), literalDetail: true, value: this.memoryBasis(record.basis), literalValue: true }); settingsRow(ctx, meta, "记录日期", { value: record.date, literalValue: true });
      if (!editing) {
        this.markdown(body, record.content); if (record.recallWhen) { const group = settingsGroup(ctx, body, "何时想起"); group.append(el(ctx.document, "div", "ip-agent-copy", record.recallWhen)); }
        const actions = this.actions(body); actions.append(settingsButton(ctx, "修正", () => { draft = original(); editing = true; preview = undefined; render(); }));
        actions.append(settingsButton(ctx, "忘记", () => this.confirm(body, "忘记这条记忆？之后仍可恢复。", "忘记", async () => {
          if (busy) return; busy = true; this.controls(body, true); error.show();
          try { await this.service.forget(recordId, settingsText(ctx, "由你手动忘记"), snapshot!.revision); busy = false; this.refresh(); if (!disposed) await ctx.shell.back(); }
          catch (failure) { if (!disposed) error.show(failure); } finally { busy = false; if (!disposed) this.controls(body, false); }
        }, true), "is-danger"));
      } else if (preview) {
        const before = settingsGroup(ctx, body, "当前内容"); before.append(el(ctx.document, "h3", "ip-agent-preview-title", preview.original.title)); this.markdown(before, preview.original.content); settingsRow(ctx, before, "何时想起", { detail: preview.original.recallWhen || settingsText(ctx, "未设置"), literalDetail: true });
        const after = settingsGroup(ctx, body, "修改后"); after.append(el(ctx.document, "h3", "ip-agent-preview-title", preview.title)); this.markdown(after, preview.content); settingsRow(ctx, after, "何时想起", { detail: preview.recallWhen || settingsText(ctx, "未设置"), literalDetail: true });
        const actions = this.actions(body); actions.append(settingsButton(ctx, "返回修改", () => { preview = undefined; render(); }), settingsButton(ctx, "取消", () => { editing = false; preview = undefined; draft = undefined; render(); }), settingsButton(ctx, "确认修正", () => { void (async () => {
          if (busy || !preview) return; busy = true; this.controls(body, true); error.show();
          try { const saved = await this.service.applyCorrection(preview); if (!disposed) { snapshot = saved; editing = false; preview = undefined; draft = undefined; busy = false; render(); this.refresh(); } }
          catch (failure) { if (!disposed) error.show(failure); } finally { busy = false; if (!disposed) this.controls(body, false); }
        })(); }, "is-primary"));
      } else if (draft) {
        settingsField(ctx, body, "标题", draft.title, value => { draft!.title = value; }); this.editor(body, "记忆内容", draft.content, value => { draft!.content = value; }); settingsField(ctx, body, "何时想起", draft.recallWhen, value => { draft!.recallWhen = value; });
        const actions = this.actions(body); actions.append(settingsButton(ctx, "重新读取", () => { void reload(true); }), settingsButton(ctx, "取消", () => { editing = false; draft = undefined; render(); }), settingsButton(ctx, "预览修正", () => { void (async () => {
          if (busy) return; busy = true; this.controls(body, true); error.show();
          try { const next = await this.service.previewCorrection(recordId, { ...draft! }, snapshot!.revision); if (!disposed) { preview = next; busy = false; render(); } }
          catch (failure) { if (!disposed) error.show(failure); } finally { busy = false; if (!disposed) this.controls(body, false); }
        })(); }, "is-primary"));
      }
      body.append(error.element);
    };
    const reload = async (preserve = false) => {
      if (busy || (editing && !preserve)) return; const current = ++revision;
      try { const next = await this.service.read(recordId); if (disposed || current !== revision || busy || (editing && !preserve)) return; snapshot = next; preview = undefined; error.show(); render(); if (preserve) this.notice("已重新读取，输入已保留"); }
      catch (failure) { if (!disposed && current === revision) { if (!snapshot) this.loadFailure(body, failure, () => reload()); else error.show(failure); } }
    };
    this.loading(body); const refresh = () => reload(); this.refreshers.add(refresh);
    await pushSettingsPage(ctx, { id, title: "记忆详情", content: body, canLeave: guard.canLeave, dispose: () => { disposed = true; revision++; guard.dispose(); this.refreshers.delete(refresh); } });
    if (!disposed) await reload();
  }

  private async archives(): Promise<void> {
    const { ctx } = this, id = "iphone-settings-archives";
    if (ctx.shell.hasPage(id)) { await ctx.shell.backTo(id); return; }
    const body = this.body(); let disposed = false, revision = 0;
    const render = async () => {
      const current = ++revision;
      try {
        const [items, registry] = await Promise.all([this.service.listArchives(), ctx.host.agents.snapshot()]); if (disposed || current !== revision) return;
        body.replaceChildren(); const group = settingsGroup(ctx, body);
        for (const item of items) { const owner = registry.registry.agents.find(agent => agent.id === item.agentId); settingsRow(ctx, group, item.title, { literal: true, literalDetail: true, detail: `${owner?.name ?? item.agentId} · ${this.date(item.archivedAt)}`, action: () => this.archive(item.id) }); }
        if (!items.length) this.empty(group, "还没有归档会话");
      } catch (failure) { if (!disposed && current === revision) this.loadFailure(body, failure, render); }
    };
    this.loading(body); this.refreshers.add(render);
    await pushSettingsPage(ctx, { id, title: "已归档会话", content: body, dispose: () => { disposed = true; revision++; this.refreshers.delete(render); } }); if (!disposed) await render();
  }
  private async archive(taskId: string): Promise<void> {
    const { ctx } = this, id = `iphone-settings-archive-${taskId}`;
    if (ctx.shell.hasPage(id)) { await ctx.shell.backTo(id); return; }
    const body = this.body(); let disposed = false, busy = false;
    const load = async () => {
      try {
        const [task, registry] = await Promise.all([this.service.readArchive(taskId), ctx.host.agents.snapshot()]); if (disposed) return;
        body.replaceChildren(); body.append(el(ctx.document, "h2", "ip-agent-title", task.title)); const owner = registry.registry.agents.find(agent => agent.id === task.agentId), group = settingsGroup(ctx, body);
        settingsRow(ctx, group, "所属 Agent", { value: owner?.name ?? task.agentId, literalValue: true, valueLeading: owner ? iphoneAvatar(ctx.document, owner, "ip-avatar ip-agent-owner-avatar") : undefined });
        if (task.archivedAt) settingsRow(ctx, group, "归档时间", { value: this.date(task.archivedAt), literalValue: true });
        for (const message of task.messages) {
          if (!("content" in message)) continue;
          const text = typeof message.content === "string" ? message.content : message.content.filter(part => part.type === "text").map(part => "text" in part ? part.text : "").join("\n"); if (!text) continue;
          const section = el(ctx.document, "section", "ip-agent-history-message"); section.append(settingsMessage(ctx, el(ctx.document, "h3", ""), message.role === "user" ? "你" : message.role === "assistant" ? "Agent" : "工具结果")); this.markdown(section, text); body.append(section);
        }
        if (!task.messages.length) this.empty(body, "这段会话没有消息");
        const error = settingsError(ctx, body), actions = this.actions(body); actions.append(settingsButton(ctx, "恢复会话", () => this.confirm(body, "恢复到原 Agent 的会话列表？", "恢复", async () => {
          if (busy) return; busy = true; this.controls(body, true); error.show();
          try { await this.service.restoreArchive(taskId); busy = false; this.refresh(); if (!disposed) await ctx.shell.back(); }
          catch (failure) { if (!disposed) error.show(failure); } finally { busy = false; if (!disposed) this.controls(body, false); }
        })));
      } catch (failure) { if (!disposed) this.loadFailure(body, failure, load); }
    };
    this.loading(body); await pushSettingsPage(ctx, { id, title: "归档会话", content: body, canLeave: () => !busy, dispose: () => { disposed = true; } }); if (!disposed) await load();
  }

  private body(): HTMLElement { const body = settingsBody(this.ctx); body.classList.add("ip-agent-settings"); return body; }
  private text(zh: string, en: string): string { return this.ctx.host.settings().settingsLanguage === "en" ? en : zh; }
  private notice(message: string): void { new Notice(settingsText(this.ctx, message)); }
  private date(at: number): string { return formatMobileDateTime(at, Date.now(), this.ctx.host.settings().settingsLanguage === "en" ? "en" : "zh-CN"); }
  private dailyLimit(limit: number): string { return this.text(`每天最多 ${limit} 次`, `At most ${limit} per day`); }
  private dreamPhase(phase: ReturnType<MobileMemorySettingsPort["dreamStatus"]>["phase"]): string { return settingsText(this.ctx, { idle: "尚未整理", running: "正在整理…", completed: "已完成", interrupted: "已中断", failed: "整理失败" }[phase]); }
  private profileBasis(basis: string): string { return settingsText(this.ctx, basis === "explicit_memory" ? "你确认的" : basis === "observed_memory" ? "系统观察 · 仅供参考" : "旧资料 · 待确认"); }
  private memoryBasis(basis: string): string { return settingsText(this.ctx, basis === "explicit" ? "你确认的" : "系统观察 · 仅供参考"); }
  private memoryStatus(status: string): string { return settingsText(this.ctx, status === "superseded" ? "已被更新" : status === "closed" ? "已结束" : "当前有效"); }
  private memoryKind(kind: string): string { return settingsText(this.ctx, ({ fact: "事实", view: "观点", decision: "决定", goal: "目标", task: "任务", open_loop: "待跟进", episode: "经历" } as Record<string, string>)[kind] ?? kind); }
  private actions(parent: HTMLElement): HTMLElement { const actions = el(this.ctx.document, "div", "ip-settings-actions ip-agent-actions"); parent.append(actions); return actions; }
  private editor(parent: HTMLElement, name: string, value: string, change: (value: string) => void): HTMLTextAreaElement {
    const label = el(this.ctx.document, "label", "ip-settings-field"); label.append(settingsMessage(this.ctx, el(this.ctx.document, "span", "ip-settings-field-label"), name)); const editor = el(this.ctx.document, "textarea", "ip-agent-editor"); editor.value = value; editor.setAttribute("aria-label", settingsText(this.ctx, name)); editor.addEventListener("input", () => change(editor.value)); label.append(editor); parent.append(label); return editor;
  }
  private markdown(parent: HTMLElement, text: string): void { const content = el(this.ctx.document, "div", "ip-agent-markdown markdown-rendered"); parent.append(content); this.ctx.host.renderMarkdown(text, content); }
  private empty(parent: HTMLElement, text: string): void { parent.append(settingsMessage(this.ctx, el(this.ctx.document, "div", "ip-agent-empty"), text)); }
  private loading(body: HTMLElement): void { body.replaceChildren(settingsMessage(this.ctx, el(this.ctx.document, "div", "ip-agent-status"), "正在加载…")); }
  private loadFailure(body: HTMLElement, failure: unknown, retry: () => Promise<void>): void { body.replaceChildren(); settingsError(this.ctx, body).show(failure); body.append(settingsButton(this.ctx, "重试", () => { this.loading(body); void retry(); })); }
  private controls(parent: HTMLElement, busy: boolean): void {
    for (const field of Array.from(parent.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLTextAreaElement | HTMLSelectElement>("input,button,textarea,select"))) {
      if (busy) { if (!this.previousDisabled.has(field)) this.previousDisabled.set(field, field.disabled); field.disabled = true; }
      else if (this.previousDisabled.has(field)) { field.disabled = this.previousDisabled.get(field)!; this.previousDisabled.delete(field); }
    }
    parent.setAttribute("aria-busy", String(busy));
  }
  private confirm(parent: HTMLElement, message: string, label: string, execute: () => Promise<void>, danger = false): void {
    if (parent.querySelector(":scope > .ip-settings-confirm")) return;
    const confirmation = el(this.ctx.document, "div", "ip-settings-confirm"); confirmation.append(settingsMessage(this.ctx, el(this.ctx.document, "p", ""), message)); const actions = this.actions(confirmation);
    actions.append(settingsButton(this.ctx, "取消", () => confirmation.remove()), settingsButton(this.ctx, label, () => { void (async () => { this.controls(confirmation, true); try { await execute(); } catch (failure) { settingsError(this.ctx, confirmation).show(failure); } finally { if (confirmation.isConnected) this.controls(confirmation, false); } })(); }, danger ? "is-danger" : "is-primary")); parent.append(confirmation); confirmation.scrollIntoView({ block: "nearest" });
  }
  private leaveGuard(body: HTMLElement, blocked: () => boolean, dirty: () => boolean): { canLeave: NonNullable<MobileShellPage["canLeave"]>; dispose: () => void } {
    let resolve: ((value: boolean) => void) | undefined, allow = false;
    return { canLeave: () => {
      if (blocked()) return false; if (allow || !dirty()) return true; if (resolve) return false;
      return new Promise<boolean>(done => {
        resolve = done; const confirmation = el(this.ctx.document, "div", "ip-settings-confirm"); confirmation.append(settingsMessage(this.ctx, el(this.ctx.document, "p", ""), "还有未保存的修改。")); const actions = this.actions(confirmation);
        const decide = (allowed: boolean) => { const pending = resolve; resolve = undefined; confirmation.remove(); pending?.(allowed); };
        const keep = settingsButton(this.ctx, "继续编辑", () => decide(false)); actions.append(keep, settingsButton(this.ctx, "放弃修改", () => { allow = true; decide(true); }, "is-primary")); confirmation.append(actions); body.append(confirmation); confirmation.scrollIntoView({ block: "nearest" }); keep.focus();
      });
    }, dispose: () => { resolve?.(false); resolve = undefined; } };
  }
}
