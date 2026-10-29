import { Notice } from "obsidian";
import type { AgentModuleId } from "../../agents/types";
import type { MobileAgentRegistrySnapshot } from "../../mobile/agent-registry-service";
import type { UserProfileItem, UserProfileSlotDefinition } from "../../harness/memory/user-profile-state";
import type { MobileMemorySettingsPort, MobileMemorySettingsSnapshot, MobileUserProfileSnapshot, MobileMemoryListSnapshot, MobileMemorySnapshot, MobileMemoryCorrection, MobileMemoryCorrectionPreview, MobileArchiveItem } from "../../mobile/memory-contracts";
import type { MobileSession } from "../../mobile/store";
import type { MobileShellPage } from "../mobile/shell-types";
import { IPAD_MODULES, ipadAvatar, ipadIcon } from "./workbench-elements";
import { settingsText as t } from "./settings-i18n";
import { el, settingsContent, settingsGroup, settingsRow, settingsSelect, settingsAction, settingsField, settingsSwitch, settingsToggle, settingsError, showSettingsError, liveSettingsPage, leaveSettingsConfirm, type IPadSettingsContext } from "./settings-elements";

const memory = (ctx: IPadSettingsContext): MobileMemorySettingsPort => ctx.host.services.memory;
type EditAgent = (id?: string) => Promise<unknown>;
const en = (ctx: IPadSettingsContext): boolean => ctx.host.settings().settingsLanguage === "en";
const itemCount = (ctx: IPadSettingsContext, count: number): string => en(ctx) ? `${count} items` : `${count} 项`;
const currentItems = (snapshot: MobileUserProfileSnapshot): UserProfileItem[] => snapshot.items.filter(item => item.status === "current");
const kindLabels = { fact: "事实", view: "观点", decision: "决定", goal: "目标", task: "事项", open_loop: "待跟进", episode: "经历" };

/** Each page owns its drafts and subscriptions; only the central settings stack navigates. */
function view(ctx: IPadSettingsContext, id: string, title: string) {
  const content = settingsContent(ctx), body = el(ctx.document, "fieldset", "pd-agent-settings-body"), error = settingsError(ctx), leaveArea = el(ctx.document, "div", "pd-agent-leave");
  content.classList.add("pd-agent-settings"); content.append(body, error, leaveArea);
  body.append(el(ctx.document, "div", "pd-agent-loading", t(ctx, "读取中…")));
  let disposed = false, busy = false, nested = false, allowLeave = false, loaded = false, refreshPage = () => {}, leave: Promise<boolean> | undefined;
  const cleanup: (() => void)[] = [];
  const state = {
    content, body, error, leaveArea, get alive() { return !disposed; }, get busy() { return busy; },
    dirty: () => false, discard: () => {}, beforeLeave: async () => {},
    changed: () => { allowLeave = false; error.hidden = true; },
    report: (failure: unknown) => { if (!disposed) {
      body.querySelector(".pd-agent-loading")?.remove(); showSettingsError(error, failure);
      if (!loaded) error.append(settingsAction(ctx, "重试", () => refreshPage()));
    } },
    ready: () => { if (!loaded) error.hidden = true; loaded = true; body.querySelector(".pd-agent-loading")?.remove(); },
    allow: () => { allowLeave = true; },
    addCleanup: (dispose: () => void) => cleanup.push(dispose),
    async run(operation: () => Promise<void>): Promise<boolean> {
      if (disposed || busy) return false; busy = true; body.disabled = true; content.setAttribute("aria-busy", "true"); error.hidden = true;
      try { await operation(); return !disposed; }
      catch (failure) { state.report(failure); return false; }
      finally { busy = false; if (!disposed) { body.disabled = false; content.setAttribute("aria-busy", "false"); } }
    },
    async child(open: () => Promise<unknown>): Promise<void> { if (disposed || busy) return; nested = true; try { await open(); } finally { nested = false; } },
    page: { id, title, content } as MobileShellPage,
    bind(refresh: () => void): MobileShellPage {
      refreshPage = refresh;
      state.page.canLeave = async () => {
        if (busy) return false;
        if (!nested && !allowLeave && state.dirty()) {
          const allowed = await (leave ??= leaveSettingsConfirm(ctx, leaveArea).then(value => { leave = undefined; return value; }));
          if (!allowed) return false; state.discard(); allowLeave = true;
        }
        await state.beforeLeave(); return true;
      };
      state.page.dispose = () => { if (disposed) return; disposed = true; cleanup.forEach(dispose => dispose()); };
      let key = "";
      const page = liveSettingsPage(ctx, state.page, () => {
        const next = JSON.stringify([ctx.host.settings().settingsLanguage, ctx.host.settings().agentRegistry]);
        if (key !== next) { key = next; refresh(); }
      }), unsubscribe = memory(ctx).subscribe(refresh); cleanup.push(unsubscribe); return page;
    }
  };
  return state;
}

function empty(ctx: IPadSettingsContext, parent: HTMLElement, text: string): void { parent.append(el(ctx.document, "div", "pd-settings-empty", t(ctx, text))); }
function actions(ctx: IPadSettingsContext, parent: HTMLElement): HTMLElement { const row = el(ctx.document, "div", "pd-settings-actions"); parent.append(row); return row; }
function textarea(ctx: IPadSettingsContext, parent: HTMLElement, label: string, value: string, change: (value: string) => void, key: string): HTMLTextAreaElement {
  const field = el(ctx.document, "label", "pd-settings-field"), input = el(ctx.document, "textarea", "pd-agent-memory-editor"); input.value = value; input.setAttribute("aria-label", label); input.dataset.focus = key;
  input.addEventListener("input", () => change(input.value)); field.append(el(ctx.document, "span", "pd-settings-field-label", label), input); parent.append(field); return input;
}
function paint(ctx: IPadSettingsContext, parent: HTMLElement, draw: () => void): void {
  const active = ctx.document.activeElement, focused = active && parent.contains(active) ? active as HTMLInputElement : null;
  const key = focused?.dataset.focus, selection = focused && "selectionStart" in focused ? [focused.selectionStart, focused.selectionEnd] : null;
  const scroll = parent.closest<HTMLElement>(".echoink-ipad-content"), top = scroll?.scrollTop;
  parent.replaceChildren(); draw();
  if (scroll && top !== undefined) scroll.scrollTop = top;
  const next = key ? Array.from(parent.querySelectorAll<HTMLInputElement>("[data-focus]")).find(node => node.dataset.focus === key) : undefined;
  next?.focus({ preventScroll: true }); if (next && selection && selection[0] !== null && selection[1] !== null) next.setSelectionRange(selection[0], selection[1]);
}
function confirm(ctx: IPadSettingsContext, area: HTMLElement, message: string, label: string, apply: () => Promise<void>): void {
  const box = el(ctx.document, "div", "pd-settings-confirm"), row = actions(ctx, box); box.prepend(el(ctx.document, "p", "", t(ctx, message)));
  row.append(settingsAction(ctx, "取消", () => area.replaceChildren()), settingsAction(ctx, label, apply, true)); area.replaceChildren(box);
}
function status(ctx: IPadSettingsContext, parent: HTMLElement): HTMLElement { const node = el(ctx.document, "div", "pd-agent-status"); node.setAttribute("role", "status"); parent.append(node); return node; }

export function createAgentSettingsPage(ctx: IPadSettingsContext, editAgent: EditAgent): MobileShellPage {
  const api = memory(ctx), v = view(ctx, "ipad-settings-agent", "Agent");
  let settings = api.readSettings(), profileCount: number | null = null, archiveCount: number | null = null, limitDraft: string | undefined, generation = 0, signature = "", dreamExpanded = false;
  let registrySnapshot: MobileAgentRegistrySnapshot | undefined;
  let controller: AbortController | undefined, dreamStatus: HTMLElement | undefined, dreamRun: HTMLButtonElement | undefined, dreamStop: HTMLButtonElement | undefined;
  v.dirty = () => limitDraft !== undefined && limitDraft !== String(settings.dreamRunsPerDay);
  v.discard = () => { limitDraft = undefined; signature = ""; render(); };
  const stopDream = async () => { if (controller || api.dreamStatus().phase === "running") { controller?.abort(); await api.cancelDream(); } };
  v.beforeLeave = stopDream;
  const background = () => { if (ctx.document.hidden) void stopDream().catch(v.report); }, pagehide = () => { void stopDream().catch(v.report); };
  ctx.document.addEventListener("visibilitychange", background); ctx.document.defaultView?.addEventListener("pagehide", pagehide);
  v.addCleanup(() => { generation++; controller?.abort(); if (controller) void api.cancelDream().catch(() => {}); ctx.document.removeEventListener("visibilitychange", background); ctx.document.defaultView?.removeEventListener("pagehide", pagehide); });
  const open = (page: MobileShellPage) => v.child(() => ctx.push(page));
  async function saveSetting(patch: Partial<MobileMemorySettingsSnapshot>): Promise<void> {
    if (v.busy) return;
    const saved = await v.run(async () => {
      if (patch.memoryEnabled === false || patch.dreamEnabled === false) await stopDream();
      settings = await api.saveSettings({ ...api.readSettings(), ...patch }); if (patch.dreamEnabled !== undefined) dreamExpanded = patch.dreamEnabled; if (!v.alive) return; signature = ""; render(); ctx.refresh();
    });
    updateDream();
    if (saved) void loadCounts();
    if (!saved && v.alive) throw new Error(v.error.textContent || t(ctx, "保存失败"));
  }
  function updateDream(): void {
    if (!v.alive || !dreamStatus) return;
    const state = api.dreamStatus(), labels = { idle: "尚未整理", running: "正在整理…", completed: "整理完成", interrupted: "整理已中断", failed: "整理失败" };
    dreamStatus.textContent = [t(ctx, labels[state.phase]), en(ctx) ? `${state.attemptsToday} / ${state.dailyLimit} today` : `今天 ${state.attemptsToday} / ${state.dailyLimit} 次`, state.error].filter(Boolean).join(" · ");
    if (dreamRun) dreamRun.disabled = v.busy || state.phase === "running" || !settings.dreamEnabled || state.attemptsToday >= state.dailyLimit;
    if (dreamStop) { dreamStop.hidden = state.phase !== "running"; dreamStop.disabled = false; }
  }
  function render(): void {
    if (!v.alive || v.busy) return; settings = api.readSettings(); v.ready();
    const next = JSON.stringify([registrySnapshot, settings, profileCount, archiveCount, ctx.host.settings().settingsLanguage]);
    if (next === signature) { updateDream(); return; } signature = next;
    paint(ctx, v.body, () => {
      const registry = registrySnapshot?.registry ?? ctx.host.settings().agentRegistry, agents = settingsGroup(ctx, v.body, t(ctx, "我的 Agent"));
      for (const agent of registry.agents) settingsRow(ctx, agents, agent.name, "", () => v.child(() => editAgent(agent.id)), ipadAvatar(ctx.document, agent), agent.position);
      settingsRow(ctx, agents, t(ctx, "新建 Agent"), "", () => v.child(() => editAgent()), ipadIcon(ctx.document, "user-plus"));
      const owners = settingsGroup(ctx, v.body, t(ctx, "模块负责人"));
      for (const moduleId of ["knowledge-base", "todos", "finance", "journal", "english-diary", "pdf-reading"] as const) {
        const module = IPAD_MODULES.find(item => item.id === moduleId)!;
        const owner = registry.agents.find(agent => agent.id === registry.moduleOwners[module.id]);
        const select = settingsSelect(ctx, owners, t(ctx, module.name), registry.agents.map(agent => [agent.id, agent.name] as const), owner?.id ?? "", value => {
          if (v.busy || !registrySnapshot || value === registrySnapshot.registry.moduleOwners[module.id]) { select.value = registrySnapshot?.registry.moduleOwners[module.id] ?? ""; return; }
          void saveOwner(module.id, value);
        }, owner ? ipadAvatar(ctx.document, owner, "pd-avatar pd-agent-owner-avatar") : undefined);
        select.disabled = !registrySnapshot; select.dataset.moduleOwner = module.id;
      }
      const group = settingsGroup(ctx, v.body, t(ctx, "记忆"));
      settingsSwitch(ctx, group, t(ctx, "长期记忆"), settings.memoryEnabled, enabled => saveSetting({ memoryEnabled: enabled }));
      const dreamRow = settingsRow(ctx, group, t(ctx, "做梦")); dreamRow.classList.add("pd-agent-dream-row");
      const copy = dreamRow.querySelector<HTMLElement>(".pd-settings-copy")!, dreamLink = el(ctx.document, "button", "pd-agent-dream-link"); dreamLink.type = "button";
      dreamLink.append(...Array.from(copy.childNodes), el(ctx.document, "span", "pd-settings-description", en(ctx) ? `Up to ${settings.dreamRunsPerDay} per day` : `每天最多 ${settings.dreamRunsPerDay} 次`)); copy.replaceWith(dreamLink);
      dreamLink.disabled = !settings.dreamEnabled; dreamLink.setAttribute("aria-expanded", String(dreamExpanded && settings.dreamEnabled));
      const hit = el(ctx.document, "label", "pd-settings-switch-hit"); hit.append(settingsToggle(ctx, t(ctx, "做梦"), settings.dreamEnabled, enabled => saveSetting({ dreamEnabled: enabled }))); dreamRow.classList.add("has-switch-control"); dreamRow.append(hit);
      if (settings.dreamEnabled) {
        const area = el(ctx.document, "div", "pd-agent-dream"); area.hidden = !dreamExpanded; group.append(area);
        dreamLink.addEventListener("click", () => { dreamExpanded = !dreamExpanded; area.hidden = !dreamExpanded; dreamLink.setAttribute("aria-expanded", String(dreamExpanded)); });
        const limit = settingsField(ctx, area, t(ctx, "每日最多次数"), limitDraft ?? String(settings.dreamRunsPerDay), value => { limitDraft = value; v.changed(); }, "number"); limit.min = "1"; limit.step = "1"; limit.dataset.focus = "dream-limit";
        const runActions = actions(ctx, area);
        dreamRun = settingsAction(ctx, "立即整理", async () => {
          if (controller || api.dreamStatus().phase === "running") return; controller = new AbortController(); const current = controller;
          try { await api.runDream(current.signal); } catch (failure) { v.report(failure); }
          finally { if (controller === current) controller = undefined; if (v.alive) { updateDream(); void loadCounts(); } }
        });
        dreamStop = settingsAction(ctx, "停止", stopDream);
        runActions.append(dreamRun, dreamStop, settingsAction(ctx, "保存", async () => {
          const value = Number(limitDraft ?? settings.dreamRunsPerDay); if (!Number.isSafeInteger(value) || value < 1) { v.report(t(ctx, "请输入正整数。")); return; }
          await saveSetting({ dreamRunsPerDay: value }); if (v.alive && !v.error.hidden) return; limitDraft = undefined;
        }, true)); dreamStatus = status(ctx, area);
      } else { dreamStatus = undefined; dreamRun = undefined; dreamStop = undefined; }
      settingsRow(ctx, group, t(ctx, "你的画像"), profileCount === null ? "—" : itemCount(ctx, profileCount), () => open(createProfilePage(ctx)));
      settingsRow(ctx, group, t(ctx, "记忆修正"), "", () => open(createMemoryListPage(ctx)));
      const conversations = settingsGroup(ctx, v.body, t(ctx, "会话"));
      const archive = settingsSwitch(ctx, conversations, t(ctx, "自动归档"), settings.autoArchive, enabled => saveSetting({ autoArchive: enabled }));
      archive.parentElement!.querySelector(".pd-settings-copy")!.append(el(ctx.document, "span", "pd-settings-description", t(ctx, "完成 7 天后")));
      settingsRow(ctx, conversations, t(ctx, "已归档会话"), archiveCount === null ? "—" : String(archiveCount), () => open(createArchiveListPage(ctx)));
    }); updateDream();
  }
  async function loadCounts(): Promise<void> {
    const ticket = ++generation;
    const results = await Promise.allSettled([api.readProfile(), api.listArchives(), ctx.host.agents.snapshot()]); if (!v.alive || v.busy || ticket !== generation) return;
    if (results[0].status === "fulfilled") profileCount = currentItems(results[0].value).length; else { profileCount = null; v.report(results[0].reason); }
    if (results[1].status === "fulfilled") archiveCount = results[1].value.length; else { archiveCount = null; v.report(results[1].reason); }
    if (results[2].status === "fulfilled") registrySnapshot = results[2].value; else { registrySnapshot = undefined; v.report(results[2].reason); }
    render();
  }
  async function saveOwner(moduleId: AgentModuleId, agentId: string): Promise<void> {
    if (v.busy || !registrySnapshot) return;
    generation++;
    await v.run(async () => {
      try {
        registrySnapshot = await ctx.host.agents.setOwner(moduleId, agentId, registrySnapshot!.version);
        try { await ctx.host.services.refreshAgentIdentity(); } catch (failure) { ctx.error(failure); }
      } catch (failure) {
        try { registrySnapshot = await ctx.host.agents.snapshot(); } catch { registrySnapshot = undefined; }
        throw failure;
      }
    });
    if (v.alive) { signature = ""; render(); }
  }
  return v.bind(() => { if (!v.busy) { render(); void loadCounts(); } });
}

interface ProfileDraft { text: string; original: string; revision: number }
function createProfilePage(ctx: IPadSettingsContext): MobileShellPage {
  const api = memory(ctx), v = view(ctx, "ipad-user-profile", "你的画像"), drafts = new Map<string, ProfileDraft>(), expanded = new Set<string>();
  let snapshot: MobileUserProfileSnapshot | undefined, generation = 0;
  v.dirty = () => [...drafts.values()].some(draft => draft.text !== draft.original);
  v.discard = () => { drafts.clear(); draw(); };
  async function mutate(operation: () => Promise<MobileUserProfileSnapshot>, key: string): Promise<void> {
    await v.run(async () => { const saved = await operation(); if (!v.alive) return; snapshot = saved; drafts.delete(key); draw(); ctx.refresh(); new Notice(t(ctx, "已保存")); });
  }
  function slot(parent: HTMLElement, definition: UserProfileSlotDefinition): void {
    const key = definition.profileKey, item = currentItems(snapshot!).find(value => value.profileKey === key), draft = drafts.get(key);
    const row = el(ctx.document, "section", "pd-agent-profile-row"); row.dataset.profileKey = key;
    const title = el(ctx.document, "div", "pd-agent-profile-title", t(ctx, definition.labelZh)); row.append(title);
    if (item) {
      row.append(el(ctx.document, "div", "pd-agent-profile-value", item.text), el(ctx.document, "div", "pd-agent-source", t(ctx, item.basis === "observed_memory" ? "系统观察 · 仅供参考" : "你确认的")));
      const sources = el(ctx.document, "details", "pd-agent-sources"); sources.append(el(ctx.document, "summary", "", t(ctx, "来源")));
      const linked = snapshot!.sources.filter(source => source.profileKey === key);
      for (const source of linked) {
        const part = el(ctx.document, "div", "pd-agent-source-entry"); part.append(el(ctx.document, "div", "pd-settings-name", source.title), el(ctx.document, "div", "pd-agent-prose", source.content));
        if (!source.available) part.append(el(ctx.document, "div", "pd-agent-source", t(ctx, "来源暂不可用"))); sources.append(part);
      }
      if (!linked.length) sources.append(el(ctx.document, "div", "pd-agent-source", t(ctx, "来源暂不可用"))); row.append(sources);
    }
    const bar = actions(ctx, row);
    if (draft) {
      const editor = textarea(ctx, row, t(ctx, definition.labelZh), draft.text, value => { draft.text = value; v.changed(); }, `profile-${key}`); editor.maxLength = 120;
      row.append(bar);
      bar.append(settingsAction(ctx, "取消", () => { drafts.delete(key); draw(); }), settingsAction(ctx, "重新核对", async () => {
        await v.run(async () => { const latest = await api.readProfile(); if (!v.alive) return; snapshot = latest; draft.revision = latest.revision; draft.original = currentItems(latest).find(value => value.profileKey === key)?.text ?? ""; draw(); });
      }), settingsAction(ctx, "保存", async () => {
        if (!draft.text.trim()) { v.report(t(ctx, "请输入内容；删除请使用删除操作。")); return; }
        await mutate(() => api.saveProfile(key, draft.text, draft.revision), key);
      }, true));
    } else {
      bar.append(settingsAction(ctx, item ? "修改" : "补写", () => { drafts.set(key, { text: item?.text ?? "", original: item?.text ?? "", revision: snapshot!.revision }); draw(); v.body.querySelector<HTMLTextAreaElement>(`[data-focus="profile-${key}"]`)?.focus(); }));
      if (item?.basis === "observed_memory") bar.append(settingsAction(ctx, "确认", () => mutate(() => api.confirmProfile(key, snapshot!.revision), key)));
      if (item) {
        const area = el(ctx.document, "div", "pd-agent-inline-confirm"), remove = settingsAction(ctx, "删除", () => confirm(ctx, area, "只删除这项画像，原记忆会保留。", "删除", () => mutate(() => api.deleteProfile(key, snapshot!.revision), key)));
        remove.classList.add("pd-agent-danger"); bar.append(remove); row.append(area);
      }
    }
    parent.append(row);
  }
  function draw(): void {
    if (!v.alive || !snapshot) return; v.ready();
    paint(ctx, v.body, () => {
      for (const [section, label] of [["identity", "身份"], ["preference", "偏好"], ["collaboration", "协作"]] as const) {
        const slots = snapshot!.slots.filter(slot => slot.section === section), populated = slots.filter(slot => currentItems(snapshot!).some(item => item.profileKey === slot.profileKey));
        const group = settingsGroup(ctx, v.body, t(ctx, label)), heading = group.previousElementSibling!; heading.append(el(ctx.document, "span", "pd-agent-count", `${populated.length}/${slots.length}`)); group.dataset.profileSection = section;
        for (const definition of populated) slot(group, definition);
        const unfilled = slots.filter(slot => !populated.includes(slot));
        if (unfilled.length) {
          const details = el(ctx.document, "details", "pd-agent-unfilled"); details.open = expanded.has(section) || unfilled.some(slot => drafts.has(slot.profileKey));
          details.append(el(ctx.document, "summary", "", en(ctx) ? `${unfilled.length} unfilled items` : `还有 ${unfilled.length} 项没填`));
          details.addEventListener("toggle", () => { if (details.open) expanded.add(section); else expanded.delete(section); });
          for (const definition of unfilled) slot(details, definition); group.append(details);
        }
      }
    });
  }
  const load = () => { if (v.busy) return; const ticket = ++generation;
    void api.readProfile().then(value => { if (!v.alive || ticket !== generation) return; snapshot = value; draw(); }).catch(v.report);
  };
  return v.bind(load);
}

function createMemoryListPage(ctx: IPadSettingsContext): MobileShellPage {
  const api = memory(ctx), v = view(ctx, "ipad-memory-list", "记忆修正");
  let snapshot: MobileMemoryListSnapshot | undefined, query = "", generation = 0, pageIndex = 0, forgottenOpen = false;
  const searchArea = el(ctx.document, "div", "pd-agent-search"), list = el(ctx.document, "div", "pd-agent-memory-list"), toolbar = el(ctx.document, "div", "pd-settings-actions"), output = el(ctx.document, "div", "pd-agent-export");
  v.body.replaceChildren(searchArea, toolbar, output, list);
  const input = settingsField(ctx, searchArea, t(ctx, "查找记忆"), "", value => { query = value; pageIndex = 0; load(); }, "search"); input.autocomplete = "off";
  toolbar.append(settingsAction(ctx, "导出", () => v.run(async () => {
    const exported = await api.export(); if (!v.alive) return; output.replaceChildren(); settingsRow(ctx, output, t(ctx, "已导出"), exported.path, () => ctx.host.openNote(exported.path));
  })));
  function draw(): void {
    if (!snapshot || !v.alive) return; v.ready(); list.replaceChildren();
    const group = settingsGroup(ctx, list, t(ctx, "记忆")), start = pageIndex * 20;
    for (const record of snapshot.records.slice(start, start + 20)) settingsRow(ctx, group, record.title, t(ctx, record.basis === "explicit" ? "你确认的" : "系统观察 · 仅供参考"), () => v.child(() => ctx.push(createMemoryDetailPage(ctx, record.id))));
    if (!snapshot.records.length) empty(ctx, group, "还没有记忆");
    if (snapshot.records.length > 20) {
      const bar = actions(ctx, list), previous = settingsAction(ctx, "上一页", () => { pageIndex--; draw(); }), next = settingsAction(ctx, "下一页", () => { pageIndex++; draw(); });
      previous.disabled = !pageIndex; next.disabled = start + 20 >= snapshot.records.length; bar.append(previous, el(ctx.document, "span", "pd-agent-count", `${pageIndex + 1}/${Math.ceil(snapshot.records.length / 20)}`), next);
    }
    const forgotten = el(ctx.document, "details", "pd-agent-forgotten"); forgotten.open = forgottenOpen; forgotten.append(el(ctx.document, "summary", "", `${t(ctx, "已忘记")} · ${snapshot.forgotten.length}`));
    forgotten.addEventListener("toggle", () => { forgottenOpen = forgotten.open; }); list.append(forgotten);
    for (const record of snapshot.forgotten) {
      const row = settingsRow(ctx, forgotten, record.title), area = el(ctx.document, "div", "pd-agent-inline-confirm");
      row.append(settingsAction(ctx, "恢复", () => confirm(ctx, area, "恢复这条记忆？", "恢复", async () => {
        const saved = await v.run(async () => { await api.restore(record.id, snapshot!.revision); ctx.refresh(); }); if (saved) load();
      }))); forgotten.append(area);
    }
    if (!snapshot.forgotten.length) empty(ctx, forgotten, "没有已忘记的记忆");
  }
  function load(): void { if (v.busy) return; const ticket = ++generation;
    void api.list(query).then(value => { if (!v.alive || ticket !== generation) return; snapshot = value; pageIndex = Math.min(pageIndex, Math.max(0, Math.ceil(value.records.length / 20) - 1)); draw(); }).catch(v.report);
  }
  return v.bind(load);
}

function createMemoryDetailPage(ctx: IPadSettingsContext, id: string): MobileShellPage {
  const api = memory(ctx), v = view(ctx, `ipad-memory-${id}`, "记忆详情");
  let snapshot: MobileMemorySnapshot | undefined, draft: MobileMemoryCorrection | undefined, preview: MobileMemoryCorrectionPreview | undefined, generation = 0;
  v.dirty = () => !!draft && !!snapshot && (draft.title !== snapshot.record.title || draft.content !== snapshot.record.content || draft.recallWhen !== snapshot.record.recallWhen);
  v.discard = () => { draft = undefined; preview = undefined; draw(); };
  function draw(): void {
    if (!v.alive || !snapshot) return; v.ready();
    paint(ctx, v.body, () => {
      const record = snapshot!.record, card = el(ctx.document, "section", "pd-agent-memory-record"); card.append(el(ctx.document, "h2", "pd-agent-memory-title", record.title)); v.body.append(card);
      card.append(el(ctx.document, "div", "pd-agent-source", `${t(ctx, kindLabels[record.kind])} · ${t(ctx, record.status === "current" ? "当前有效" : record.status === "closed" ? "已结束" : "已被更新")} · ${record.date}`));
      card.append(el(ctx.document, "div", "pd-agent-source", t(ctx, record.basis === "explicit" ? "你确认的" : "系统观察 · 仅供参考")));
      const source = el(ctx.document, "details", "pd-agent-sources"); source.append(el(ctx.document, "summary", "", t(ctx, "来源")), el(ctx.document, "div", "pd-agent-prose", en(ctx) ? record.contentOrigin === "user_edit" ? "Records you edited" : "Records saved in a task" : record.contentOrigin === "user_edit" ? "你手动编辑的记录" : "任务中保存的记录")); card.append(source);
      if (!draft) {
        const text = el(ctx.document, "div", "pd-agent-prose markdown-rendered"); ctx.host.renderMarkdown(record.content, text, record.file); card.append(text);
        if (record.recallWhen) card.append(el(ctx.document, "div", "pd-agent-recall", `${t(ctx, "何时想起")}：${record.recallWhen}`));
        const bar = actions(ctx, card), area = el(ctx.document, "div", "pd-agent-inline-confirm"); card.append(area);
        bar.append(settingsAction(ctx, "修正", () => { draft = { title: record.title, content: record.content, recallWhen: record.recallWhen }; draw(); }), settingsAction(ctx, "忘记", () => confirm(ctx, area, "忘记这条记忆？之后可以恢复。", "确认忘记", async () => {
          const saved = await v.run(async () => { await api.forget(id, "用户在记忆设置中确认忘记", snapshot!.revision); ctx.refresh(); }); if (saved) { v.allow(); await ctx.back(); }
        })));
      } else if (preview) {
        const before = el(ctx.document, "div", "pd-agent-correction-before"), after = el(ctx.document, "div", "pd-agent-correction-after");
        before.append(el(ctx.document, "h3", "pd-settings-label", t(ctx, "修改前")), el(ctx.document, "div", "pd-settings-name", preview.original.title), el(ctx.document, "div", "pd-agent-prose", preview.original.content), el(ctx.document, "div", "pd-agent-recall", preview.original.recallWhen));
        after.append(el(ctx.document, "h3", "pd-settings-label", t(ctx, "修改后")), el(ctx.document, "div", "pd-settings-name", preview.title), el(ctx.document, "div", "pd-agent-prose", preview.content), el(ctx.document, "div", "pd-agent-recall", preview.recallWhen)); card.append(before, after);
        const bar = actions(ctx, card); bar.append(settingsAction(ctx, "取消", () => { draft = undefined; preview = undefined; v.changed(); draw(); }), settingsAction(ctx, "继续修改", () => { preview = undefined; draw(); }), settingsAction(ctx, "确认修正", () => v.run(async () => {
          const saved = await api.applyCorrection(preview!); if (!v.alive) return; snapshot = saved; draft = undefined; preview = undefined; draw(); ctx.refresh(); new Notice(t(ctx, "已保存"));
        }), true));
      } else {
        const title = settingsField(ctx, card, t(ctx, "标题"), draft.title, value => { draft!.title = value; v.changed(); }); title.dataset.focus = "memory-title";
        textarea(ctx, card, t(ctx, "记忆内容"), draft.content, value => { draft!.content = value; v.changed(); }, "memory-content");
        const recall = settingsField(ctx, card, t(ctx, "何时想起"), draft.recallWhen, value => { draft!.recallWhen = value; v.changed(); }); recall.dataset.focus = "memory-recall";
        const bar = actions(ctx, card); bar.append(settingsAction(ctx, "取消", () => { draft = undefined; v.changed(); draw(); }), settingsAction(ctx, "重新核对", () => v.run(async () => { const latest = await api.read(id); if (!v.alive) return; snapshot = latest; draw(); })), settingsAction(ctx, "预览修改", () => v.run(async () => {
          const value = await api.previewCorrection(id, { ...draft! }, snapshot!.revision); if (!v.alive) return; preview = value; draw();
        }), true));
      }
    });
  }
  const load = () => { if (v.busy || draft) return; const ticket = ++generation;
    void api.read(id).then(value => { if (!v.alive || ticket !== generation || draft) return; snapshot = value; draw(); }).catch(v.report);
  };
  return v.bind(load);
}

function createArchiveListPage(ctx: IPadSettingsContext): MobileShellPage {
  const api = memory(ctx), v = view(ctx, "ipad-memory-archives", "已归档会话"); let generation = 0;
  const load = () => { if (v.busy) return; const ticket = ++generation;
    void api.listArchives().then(records => {
      if (!v.alive || ticket !== generation) return; v.ready(); v.body.replaceChildren(); const group = settingsGroup(ctx, v.body, t(ctx, "已归档会话"));
      for (const record of records) settingsRow(ctx, group, record.title, en(ctx) ? `${record.messageCount} messages` : `${record.messageCount} 条消息`, () => v.child(() => ctx.push(createArchivePage(ctx, record))));
      if (!records.length) empty(ctx, group, "还没有归档会话");
    }).catch(v.report);
  };
  return v.bind(load);
}

function createArchivePage(ctx: IPadSettingsContext, summary: MobileArchiveItem): MobileShellPage {
  const api = memory(ctx), v = view(ctx, `ipad-memory-archive-${summary.id}`, summary.title); let generation = 0;
  function draw(task: MobileSession): void {
    v.ready(); v.body.replaceChildren(); const stream = el(ctx.document, "div", "pd-agent-archive-messages"); v.body.append(stream);
    for (const message of task.messages) {
      if (!("content" in message) || !["user", "assistant", "toolResult"].includes(message.role)) continue;
      const text = typeof message.content === "string" ? message.content : message.content.filter(block => block.type === "text").map(block => block.text).join("\n"); if (!text.trim()) continue;
      const article = el(ctx.document, "article", "pd-agent-archive-message"); article.append(el(ctx.document, "div", "pd-agent-source", t(ctx, message.role === "user" ? "你的消息" : message.role === "assistant" ? "Agent 回复" : "工具结果")));
      const body = el(ctx.document, "div", "pd-agent-prose markdown-rendered"); if (message.role === "user") body.textContent = text; else ctx.host.renderMarkdown(text, body, task.notePath); article.append(body); stream.append(article);
    }
    if (!stream.childElementCount) empty(ctx, stream, "没有消息");
    const bar = actions(ctx, v.body), area = el(ctx.document, "div", "pd-agent-inline-confirm"); v.body.append(area);
    bar.append(settingsAction(ctx, "恢复会话", () => confirm(ctx, area, "恢复会话？恢复后不会自动继续运行。", "恢复", async () => {
      const saved = await v.run(async () => { await api.restoreArchive(task.id); ctx.refresh(); }); if (saved) await ctx.back();
    })));
  }
  const load = () => { if (v.busy) return; const ticket = ++generation; void api.readArchive(summary.id).then(task => { if (v.alive && ticket === generation) draw(task); }).catch(v.report); };
  return v.bind(load);
}
