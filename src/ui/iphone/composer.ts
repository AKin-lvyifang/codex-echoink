import { setIcon } from "obsidian";
import type { TaskDraft } from "../../agents/task-workspace";
import type { MobilePermission } from "../../mobile/store";
import { selectedModel, supportedProvider } from "../../mobile/settings";
import { renderProviderBrandIcon } from "../../settings/provider-brand-icons";
import { shellElement } from "../mobile/shell-controls";
import type { IPhonePageContext } from "./workbench-contract";
export { createInlineQuestion } from "./inline-question";

type Surface = { element: HTMLElement; flush: () => Promise<void>; canLeave: () => Promise<boolean>; dispose: () => void };
const permissions: [MobilePermission, string][] = [["read-only", "只读"], ["workspace-write", "工作区可写"], ["full-access", "完全访问权限"]];
const resumeFlights = new WeakMap<object, Set<string>>();
const failureText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function iPhoneAction(ctx: IPhonePageContext, label: string, action: () => void | Promise<void>, icon?: string, primary = false): HTMLButtonElement {
  const button = shellElement(ctx.document, "button", `ip-action${primary ? " ip-primary" : ""}`); button.type = "button";
  const visible = shellElement(ctx.document, "span", "ip-action-visible");
  if (icon) { const mark = shellElement(ctx.document, "span", "ip-icon"); mark.setAttribute("aria-hidden", "true"); setIcon(mark, icon); visible.append(mark); }
  visible.append(shellElement(ctx.document, "span", "ip-action-label", label)); button.append(visible);
  button.addEventListener("click", event => {
    event.stopPropagation(); if (button.disabled) return;
    void Promise.resolve().then(action).catch(error => ctx.error(error));
  });
  return button;
}

/** All three continue entry points retain M4 inspection and its exact fingerprint. */
export async function requestIPhoneTaskResume(ctx: IPhonePageContext, taskId: string, text?: string, accepted?: () => void): Promise<void> {
  const flights = resumeFlights.get(ctx.host.runtime) ?? new Set<string>(); resumeFlights.set(ctx.host.runtime, flights);
  if (flights.has(taskId) || ctx.host.runtime.stateFor(taskId).resuming) return;
  const originPageId = ctx.shell.activePageId;
  const attempt = async (fingerprint?: string): Promise<void> => {
    if (flights.has(taskId)) return;
    flights.add(taskId);
    try {
      const submission = await ctx.host.runtime.resumeTask(taskId, text?.trim() ? text : undefined, fingerprint);
      void submission.completion.catch(error => ctx.error(error)); accepted?.();
    } catch (error) {
      const review = ctx.host.runtime.stateFor(taskId).resumeReview;
      if (!review?.issues.length || review.taskId !== taskId) { ctx.error(error); return; }
      if (ctx.shell.activePageId !== originPageId) { await ctx.host.runtime.cancelResume(taskId); return; }
      const snapshot = structuredClone(review);
      const body = shellElement(ctx.document, "div", "ip-resume-review");
      for (const issue of snapshot.issues) {
        const row = shellElement(ctx.document, "section", "ip-resume-issue");
        const memory = ctx.host.store.state.memories.find(item => issue.target === item.id || issue.target === `memory:${item.id}`);
        const memoryTarget = snapshot.operations.some(operation => operation.id === issue.operationId && operation.toolName === "memory_write") || /^memory:/u.test(issue.target);
        row.append(shellElement(ctx.document, "strong", "", memory ? `记忆：${memory.title}` : memoryTarget ? "长期记忆" : issue.target));
        row.append(shellElement(ctx.document, "div", "", issue.status === "conflict" ? "内容有冲突" : "结果未确认"));
        row.append(shellElement(ctx.document, "p", "", issue.operationId.startsWith("legacy-") ? "上次保存记录不完整，无法确认是否已完成。" : issue.label)); body.append(row);
      }
      let proceeding = false;
      const footer = shellElement(ctx.document, "div", "ip-task-actions");
      footer.append(iPhoneAction(ctx, "暂不继续", () => { ctx.shell.closeSheet(); }));
      const confirm = iPhoneAction(ctx, "我已核对，请基于现状继续", async () => {
        if (confirm.disabled) return; confirm.disabled = true; proceeding = true;
        // Closing for confirmation must not cancel the preparation being requested.
        ctx.shell.closeSheet(); await attempt(snapshot.fingerprint);
      }, undefined, true); footer.append(confirm);
      ctx.shell.openSheet({ title: "继续前核对", content: body, footer, onClose: () => {
        if (!proceeding) void ctx.host.runtime.cancelResume(taskId).catch(error => ctx.error(error));
      } });
    } finally { flights.delete(taskId); }
  };
  await attempt();
}

/** Page-owned DOM, with independent per-Agent new-task and per-task reply drafts. */
export function createIPhoneComposer(ctx: IPhonePageContext, target: { agentId?: string; taskId?: string }): Surface {
  if (!!target.agentId === !!target.taskId) throw new Error("输入区需要唯一的 Agent 或任务。");
  const { host, document } = ctx, taskId = target.taskId, agentId = target.agentId;
  const element = shellElement(document, "div", "ip-composer-wrap");
  const references = shellElement(document, "div", "ip-composer-references");
  const composer = shellElement(document, "div", "ip-composer");
  const input = shellElement(document, "textarea", "ip-composer-input"); input.rows = 2; input.setAttribute("aria-label", taskId ? "任务回复草稿" : "新任务草稿");
  const bar = shellElement(document, "div", "ip-composer-bar");
  const error = shellElement(document, "div", "ip-composer-error"); error.setAttribute("role", "alert"); error.hidden = true;
  const status = shellElement(document, "div", "ip-composer-status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  element.append(references, composer, error, status); composer.append(input, bar);
  let disposed = false, sending = false, stopping = false, dirty = false, editVersion = 0, saveFailure: unknown;
  let saves: Promise<void> = Promise.resolve();
  const readDraft = (): TaskDraft => {
    if (agentId) return host.store.state.newTaskDrafts[agentId] ?? { text: "", attachments: [] };
    const task = host.store.getSession(taskId!); return { text: task?.draft ?? "", attachments: [], ...task?.draftContext };
  };
  input.value = readDraft().text;
  const showFailure = (failure: unknown) => { if (!disposed) { error.textContent = failureText(failure); error.hidden = false; } };
  const update = (change: (draft: TaskDraft) => void): Promise<void> => {
    const command = saves.catch(() => {}).then(() => host.store.update(latest => {
      if (agentId) { const draft = latest.newTaskDrafts[agentId] ??= { text: "", attachments: [] }; change(draft); }
      else {
        const task = latest.sessions.find(task => task.id === taskId); if (!task) throw new Error("任务不存在，输入已保留。");
        const draft: TaskDraft = { text: task.draft, attachments: [], ...task.draftContext }; change(draft);
        const { text, ...metadata } = draft; task.draft = text; task.draftContext = metadata;
      }
    }));
    saves = command; return command;
  };
  const saveText = async (text: string) => {
    const version = ++editVersion; dirty = true;
    try { await update(draft => { draft.text = text; }); if (version === editVersion) { dirty = false; saveFailure = undefined; } }
    catch (failure) { saveFailure = failure; throw failure; }
  };
  const restoreAfterAdmission = (submitted: string) => {
    if (disposed) return;
    if (input.value === submitted) { dirty = false; input.value = readDraft().text; return; }
    const current = readDraft();
    if (current.text === input.value || current.text !== "" && current.text !== submitted) return;
    const expected = JSON.stringify(current), text = input.value, version = ++editVersion;
    dirty = true;
    void update(draft => {
      // Another mounted page can save a newer draft while admission is pending.
      // The old page has no authority to restore its DOM over that new snapshot.
      if (!disposed && JSON.stringify(draft) === expected) draft.text = text;
    }).then(() => {
      if (!disposed && version === editVersion) { dirty = false; saveFailure = undefined; input.value = readDraft().text; }
    }).catch(failure => { saveFailure = failure; showFailure(failure); });
  };
  const flush = async () => {
    await saves.catch(() => {});
    if (dirty || saveFailure) await saveText(input.value);
    await saves;
  };
  const iconButton = (label: string, icon: string, action: () => void | Promise<void>) => {
    const button = iPhoneAction(ctx, "", action, icon); button.classList.add("ip-composer-icon"); button.setAttribute("aria-label", label); return button;
  };
  const open = (title: string, body: HTMLElement) => ctx.shell.openSheet({ title, content: body });
  const choose = async (change: (draft: TaskDraft) => void) => { await update(change); if (!disposed) { ctx.shell.closeSheet(); refresh(); } };
  const row = (body: HTMLElement, label: string, action: () => void | Promise<void>, selected = false) => {
    const button = iPhoneAction(ctx, label, action, selected ? "check" : undefined); button.classList.add("ip-picker-row"); button.setAttribute("aria-pressed", String(selected)); body.append(button); return button;
  };
  const notes = () => {
    const body = shellElement(document, "div", "ip-note-picker");
    const search = shellElement(document, "input", "ip-picker-search"); search.type = "search"; search.placeholder = "按标题或路径查找笔记"; search.setAttribute("aria-label", search.placeholder);
    const rows = shellElement(document, "div", "ip-picker-rows"); body.append(search, rows);
    const pick = (path: string, name: string) => choose(draft => { draft.noteMentions = [{ vaultRelativePath: path, fileName: name }]; });
    const render = () => {
      rows.replaceChildren();
      const files = host.app.vault.getMarkdownFiles().filter(file => !file.path.split("/").some(part => part.startsWith(".")) && file.path.toLocaleLowerCase().includes(search.value.toLocaleLowerCase())).slice(0, 60);
      for (const file of files) row(rows, file.path, () => pick(file.path, file.basename));
      if (!files.length) rows.append(shellElement(document, "p", "ip-picker-empty", "没有找到笔记"));
    }; search.addEventListener("input", render); render(); open("引用笔记", body);
  };
  bar.append(iconButton("添加到任务", "plus", () => {
    const body = shellElement(document, "div", "ip-picker"); row(body, "引用笔记", notes);
    row(body, "选择 Skill", () => {
      const skills = shellElement(document, "div", "ip-picker");
      row(skills, "不使用 Skill", () => choose(draft => { draft.selectedSkill = null; }), readDraft().selectedSkill === null);
      for (const skill of host.settings().resources.catalog.filter(resource => resource.kind === "skill" && resource.enabled)) {
        row(skills, skill.name, () => choose(draft => { draft.selectedSkill = structuredClone(skill); }), readDraft().selectedSkill?.id === skill.id);
      } open("选择 Skill", skills);
    }); open("添加到任务", body);
  }));
  bar.append(iconButton("引用笔记", "at-sign", notes));
  const model = iPhoneAction(ctx, "", () => {
    const body = shellElement(document, "div", "ip-model-picker"), draft = readDraft();
    for (const provider of host.settings().apiProviders.filter(provider => supportedProvider(provider) && provider.providerId !== "ollama")) {
      const group = shellElement(document, "section", "ip-model-group"), heading = shellElement(document, "h3", "ip-model-heading");
      const brand = shellElement(document, "span", "ip-brand"); renderProviderBrandIcon(brand, provider.providerId === "openai" ? "openai-codex" : provider.providerId ?? "custom");
      heading.append(brand, shellElement(document, "span", "", provider.name)); group.append(heading); body.append(group);
      for (const item of provider.models) {
        const selected = (draft.selectedProviderSettingsId ?? host.settings().activeApiProviderId) === provider.id
          && (draft.selectedModel ?? (draft.selectedProviderSettingsId === undefined ? host.settings().defaultModel : provider.defaultModelId)) === item.id;
        const button = row(group, item.displayName || item.id, () => choose(value => { value.selectedProviderSettingsId = provider.id; value.selectedModel = item.id; }), selected);
        const brand = shellElement(document, "span", "ip-brand"); renderProviderBrandIcon(brand, provider.providerId === "openai" ? "openai-codex" : provider.providerId ?? "custom");
        const visible = button.querySelector(".ip-action-visible")!, mark = visible.querySelector(".ip-icon"); visible.prepend(brand); if (mark) visible.append(mark);
      }
    }
    row(body, host.settings().settingsLanguage === "en" ? "Manage model services" : "管理模型服务", async () => { await flush(); ctx.shell.closeSheet(); return host.openLegacy("providers"); }); open(host.settings().settingsLanguage === "en" ? "Choose model" : "选择模型", body);
  }); model.classList.add("ip-composer-model"); bar.append(model);
  const permission = iconButton("工作区权限", "shield-check", () => {
    const body = shellElement(document, "div", "ip-permission-picker"), workspace = host.store.permission;
    const rank = permissions.findIndex(item => item[0] === workspace);
    for (const [index, [value, label]] of permissions.entries()) {
      const button = row(body, label, () => choose(draft => { draft.selectedPermission = value === "full-access" ? "danger-full-access" : value; }), effectivePermission() === value);
      button.disabled = index > rank;
    } open("工作区权限", body);
  }); bar.append(permission);
  const stop = iconButton("停止当前任务", "square", async () => {
    if (!taskId || stopping) return; stopping = true; refresh();
    try { if (host.runtime.stateFor(taskId).resuming) await host.runtime.cancelResume(taskId); else await host.runtime.stopTask(taskId); }
    catch (failure) { showFailure(failure); } finally { stopping = false; refresh(); }
  }); stop.classList.add("ip-composer-stop"); bar.append(stop);
  const send = iconButton("发送", "arrow-up", async () => {
    if (sending || !input.value.trim()) return;
    const text = input.value; sending = true; error.hidden = true; refresh();
    const accepted = () => { restoreAfterAdmission(text); refresh(); };
    try {
      await saveText(text); await saves; if (saveFailure) throw saveFailure instanceof Error ? saveFailure : new Error(typeof saveFailure === "string" ? saveFailure : "草稿保存失败，请重试。");
      if (taskId && host.store.getSession(taskId)?.taskStatus === "interrupted") await requestIPhoneTaskResume(ctx, taskId, text, accepted);
      else {
        const submission = taskId ? await host.runtime.submit(text, taskId) : await host.runtime.sendNew(agentId!, text);
        void submission.completion.catch(failure => { showFailure(failure); ctx.error(failure); }); accepted();
        if (agentId && !disposed) await ctx.navigate({ kind: "task", taskId: submission.taskId });
      }
    } catch (failure) { showFailure(failure); }
    finally { sending = false; refresh(); }
  }); send.classList.add("ip-composer-send"); bar.append(send);
  const effectivePermission = (): MobilePermission => {
    const draft = readDraft(), workspace = host.store.permission;
    const requested = draft.selectedMode === "plan" ? "read-only" : draft.selectedPermission === "danger-full-access" ? "full-access" : draft.selectedPermission ?? workspace;
    return requested === "read-only" || workspace === "read-only" ? "read-only" : requested === "workspace-write" || workspace === "workspace-write" ? "workspace-write" : "full-access";
  };
  const refresh = () => {
    if (disposed) return;
    const task = taskId ? host.store.getSession(taskId) : undefined, state = taskId ? host.runtime.stateFor(taskId) : undefined;
    const name = host.settings().agentRegistry.agents.find(agent => agent.id === (agentId ?? task?.agentId))?.name ?? "Agent";
    input.placeholder = taskId ? task?.taskStatus === "completed" ? `接着和${name}聊这件事…` : `回复${name}…` : `交代给${name}一件新事…`;
    if (!dirty && !sending && input.value !== readDraft().text) input.value = readDraft().text;
    const draft = readDraft(), fallback = selectedModel(host.settings());
    const provider = draft.selectedProviderSettingsId === undefined && draft.selectedModel === undefined ? fallback?.provider : host.settings().apiProviders.find(item => item.id === (draft.selectedProviderSettingsId ?? host.settings().activeApiProviderId) && supportedProvider(item));
    const selected = draft.selectedProviderSettingsId === undefined && draft.selectedModel === undefined ? fallback?.model : provider?.models.find(item => item.id === (draft.selectedModel ?? provider.defaultModelId));
    const visible = model.querySelector<HTMLElement>(".ip-action-visible")!; visible.replaceChildren();
    if (provider && selected) { const brand = shellElement(document, "span", "ip-brand"); renderProviderBrandIcon(brand, provider.providerId === "openai" ? "openai-codex" : provider.providerId ?? "custom"); visible.append(brand); }
    visible.append(shellElement(document, "span", "ip-model-label", selected?.displayName || selected?.id || "配置模型")); model.setAttribute("aria-label", `选择模型：${selected?.displayName || selected?.id || "未配置"}`);
    permission.setAttribute("aria-label", `工作区权限：${permissions.find(item => item[0] === effectivePermission())?.[1]}`);
    send.disabled = sending || !!state?.resuming || !input.value.trim(); send.setAttribute("aria-busy", String(sending));
    stop.hidden = (!state?.busy && !state?.resuming) || state?.interaction?.status === "pending"; stop.disabled = stopping; stop.setAttribute("aria-label", state?.resuming ? "取消继续" : "停止当前任务");
    status.textContent = state?.queuedCount ? state.paused ? `已暂停 ${state.queuedCount} 条` : `排队 ${state.queuedCount} 条` : ""; status.hidden = !status.textContent;
    references.replaceChildren();
    const note = draft.noteMentions !== undefined ? draft.noteMentions[0]?.vaultRelativePath : task?.notePath;
    if (note) {
      references.append(iPhoneAction(ctx, note, () => host.openNote(note), "file-text"));
      references.append(iconButton("移除笔记引用", "x", () => choose(value => { value.noteMentions = []; })));
    }
    if (draft.selectedSkill) { references.append(shellElement(document, "span", "ip-composer-skill", draft.selectedSkill.name)); references.append(iconButton("移除 Skill", "x", () => choose(value => { value.selectedSkill = null; }))); }
    references.hidden = !references.childNodes.length;
  };
  input.addEventListener("input", () => { void saveText(input.value).catch(showFailure); refresh(); });
  const unsubscribe = host.runtime.subscribe(id => { if (!taskId || id === taskId) refresh(); });
  const unsubscribeWorkbench = host.workbench.subscribe(refresh);
  // The task-tail button shares the mounted input, including uncommitted edits.
  const resume = () => {
    if (!taskId) return;
    const text = input.value;
    void saveText(text).then(() => requestIPhoneTaskResume(ctx, taskId, text, () => {
      restoreAfterAdmission(text); refresh();
    })).catch(showFailure);
  };
  element.addEventListener("ip-resume-task", resume);
  // Settings retain this Composer node; refresh its model label when focus returns.
  const refreshOnReturn = (event: FocusEvent) => { if (event.target === model || event.target === input) refresh(); };
  element.addEventListener("focusin", refreshOnReturn);
  refresh();
  return { element, flush, async canLeave() {
    try { await flush(); return true; }
    catch (failure) { showFailure(failure); return false; }
  }, dispose() { if (disposed) return; disposed = true; unsubscribe(); unsubscribeWorkbench(); element.removeEventListener("ip-resume-task", resume); element.removeEventListener("focusin", refreshOnReturn); } };
}
