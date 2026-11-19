import { CAUSE, pickErrorCopy, settingsErrorText } from "../../core/error-copy";
import { safeSkillCompareUrl } from "../../membership/skill-delivery";
import { MobileSubmissionScroller } from "../mobile/submission-scroll";
import { renderComposerSubmission } from "../composer-submission-renderer";
import { isAgentHired, isExpertAgent } from "../../agents/persona";
import { attachNativeTooltip } from "../native-tooltip";
import { setIcon } from "obsidian";
import type { TaskDraft } from "../../agents/task-workspace";
import type { MobilePermission } from "../../mobile/store";
import { selectedModel, supportedProvider } from "../../mobile/settings";
import { toolCallRecoveryTarget } from "../../agents/tool-call-recovery";
import { renderProviderBrandIcon } from "../../settings/provider-brand-icons";
import { shellElement } from "../mobile/shell-controls";
import { SETTINGS_FALLBACK } from "../../core/error-copy/codes/settings";
import type { IPadPageContext } from "./workbench-contract";
export { createInlineQuestion } from "./inline-question";

type Surface = { scroll: MobileSubmissionScroller; element: HTMLElement; submissions: HTMLElement; refreshSubmissions: () => void; flush: () => Promise<void>; canLeave: () => Promise<boolean>; dispose: () => void };
const permissions: [MobilePermission, string][] = [["read-only", "只读"], ["workspace-write", "工作区可写"], ["full-access", "完全访问权限"]];
const resumeFlights = new WeakMap<object, Set<string>>();
type ResumeDraft = { text(): string; accepted(text: string): void };
const resumeDrafts = new WeakMap<IPadPageContext, Map<string, ResumeDraft>>();
const failureText = (ctx: Pick<IPadPageContext, "host">, error: unknown): string => settingsErrorText(error, SETTINGS_FALLBACK.mobileTask, ctx.host.settings().settingsLanguage);

export function iPadAction(ctx: IPadPageContext, label: string, action: () => void | Promise<void>, icon?: string, primary = false): HTMLButtonElement {
  const button = shellElement(ctx.document, "button", `pd-action${primary ? " pd-primary" : ""}`); button.type = "button";
  const visible = shellElement(ctx.document, "span", "pd-action-visible");
  if (icon) { const mark = shellElement(ctx.document, "span", "pd-icon"); mark.setAttribute("aria-hidden", "true"); setIcon(mark, icon); visible.append(mark); }
  visible.append(shellElement(ctx.document, "span", "pd-action-label", label)); button.append(visible);
  button.addEventListener("click", event => {
    event.stopPropagation(); if (button.disabled) return;
    void Promise.resolve().then(action).catch(error => ctx.error(error));
  });
  return button;
}

/** All three continue entry points retain M4 inspection and its exact fingerprint. */
export async function requestIPadTaskResume(ctx: IPadPageContext, taskId: string, text?: string, accepted?: () => void, submissionId?: string): Promise<void> {
  const flights = resumeFlights.get(ctx.host.runtime) ?? new Set<string>(); resumeFlights.set(ctx.host.runtime, flights);
  if (flights.has(taskId) || ctx.host.runtime.stateFor(taskId).resuming) return;
  const draft = resumeDrafts.get(ctx)?.get(taskId), submitted = text ?? draft?.text();
  const originPageId = ctx.shell.activePageId;
  const attempt = async (fingerprint?: string): Promise<void> => {
    if (flights.has(taskId)) return;
    flights.add(taskId);
    try {
      const submission = submissionId ? await ctx.host.runtime.submitComposerSubmission(submissionId, fingerprint) : await ctx.host.runtime.resumeTask(taskId, submitted?.trim() ? submitted : undefined, fingerprint);
      void submission.completion.catch(error => ctx.error(error));
      if (accepted) accepted(); else if (submitted !== undefined) draft?.accepted(submitted);
    } catch (error) {
      const review = ctx.host.runtime.stateFor(taskId).resumeReview;
      if (!review?.issues.length || review.taskId !== taskId) {
        if (!submissionId || !ctx.host.runtime.composerSubmissions.captureFailure(submissionId, failureText(ctx, error))) ctx.error(error);
        return;
      }
      if (ctx.shell.activePageId !== originPageId) { await ctx.host.runtime.cancelResume(taskId); return; }
      const snapshot = structuredClone(review);
      const body = shellElement(ctx.document, "div", "pd-resume-review");
      for (const issue of snapshot.issues) {
        const row = shellElement(ctx.document, "section", "pd-resume-issue");
        const memory = ctx.host.store.state.memories.find(item => issue.target === item.id || issue.target === `memory:${item.id}`);
        const memoryTarget = snapshot.operations.some(operation => operation.id === issue.operationId && operation.toolName === "memory_write") || /^memory:/u.test(issue.target);
        row.append(shellElement(ctx.document, "strong", "", memory ? `记忆：${memory.title}` : memoryTarget ? "长期记忆" : issue.target));
        row.append(shellElement(ctx.document, "div", "", issue.status === "conflict" ? "内容有冲突" : "结果未确认"));
        row.append(shellElement(ctx.document, "p", "", issue.operationId.startsWith("legacy-") ? "上次保存记录不完整，无法确认是否已完成。" : issue.label)); body.append(row);
      }
      let proceeding = false;
      const footer = shellElement(ctx.document, "div", "pd-task-actions");
      footer.append(iPadAction(ctx, "暂不继续", () => { ctx.shell.closeSheet(); }));
      const confirm = iPadAction(ctx, "我已核对，请基于现状继续", async () => {
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
export function createIPadComposer(ctx: IPadPageContext, target: { agentId?: string; taskId?: string }): Surface {
  if (!!target.agentId === !!target.taskId) throw new Error("输入区需要唯一的 Agent 或任务。");
  const { host, document } = ctx, taskId = target.taskId, agentId = target.agentId;
  const element = shellElement(document, "div", "pd-composer-wrap");
  const submissions = shellElement(document, "div", "echoink-composer-submissions");
  const owner = taskId ?? `agent:${agentId}`;
  const scroll = new MobileSubmissionScroller(host.runtime, () => owner, () => submissions.parentElement,
    () => submissions.closest<HTMLElement>(agentId ? ".pd-agent-tasks" : ".echoink-ipad-content"), document);
  let handingOff = false;
  const references = shellElement(document, "div", "pd-composer-references");
  const composer = shellElement(document, "div", "pd-composer");
  const input = shellElement(document, "textarea", "pd-composer-input"); input.rows = 2; input.setAttribute("aria-label", taskId ? "任务回复草稿" : "新任务草稿");
  const bar = shellElement(document, "div", "pd-composer-bar");
  const error = shellElement(document, "div", "pd-composer-error"); error.setAttribute("role", "alert"); error.hidden = true;
  const status = shellElement(document, "div", "pd-composer-status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
  element.append(references, composer, error, status); composer.append(input, bar);
  let disposed = false, sending = false, stopping = false, dirty = false, editVersion = 0, saveFailure: unknown;
  let saves: Promise<void> = Promise.resolve();
  const readDraft = (): TaskDraft => {
    if (agentId) return host.store.state.newTaskDrafts[agentId] ?? { text: "", attachments: [] };
    const task = host.store.getSession(taskId!);
    const target = toolCallRecoveryTarget(task?.interruption, host.settings().apiProviders);
    return { text: task?.draft ?? "", attachments: [], ...(target ? { selectedProviderSettingsId: target.providerSettingsId, selectedModel: target.modelId } : {}), ...task?.draftContext };
  };
  input.value = readDraft().text;
  const showFailure = (failure: unknown) => { if (!disposed) { error.textContent = failureText(ctx, failure); error.hidden = false; } };
  const update = (change: (draft: TaskDraft) => void, workspacePermission?: MobilePermission): Promise<void> => {
    const command = saves.catch(() => {}).then(() => host.store.update(latest => {
      if (workspacePermission) latest.permission = workspacePermission;
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
    const button = iPadAction(ctx, "", action, icon); button.classList.add("pd-composer-icon"); button.setAttribute("aria-label", label); return button;
  };
  const currentAgent = () => host.settings().agentRegistry.agents.find(agent => agent.id === (agentId ?? (taskId ? host.store.getSession(taskId)?.agentId : undefined)));
  const open = (title: string, body: HTMLElement) => ctx.shell.openSheet({ title, content: body });
  const choose = async (change: (draft: TaskDraft) => void, workspacePermission?: MobilePermission) => { await update(change, workspacePermission); if (!disposed) { ctx.shell.closeSheet(); refresh(); } };
  const row = (body: HTMLElement, label: string, action: () => void | Promise<void>, selected = false) => {
    const button = iPadAction(ctx, label, action, selected ? "check" : undefined); button.classList.add("pd-picker-row"); button.setAttribute("aria-pressed", String(selected)); body.append(button); return button;
  };
  const notes = () => {
    const body = shellElement(document, "div", "pd-note-picker");
    const search = shellElement(document, "input", "pd-picker-search"); search.type = "search"; search.placeholder = "按标题或路径查找笔记"; search.setAttribute("aria-label", search.placeholder);
    const rows = shellElement(document, "div", "pd-picker-rows"); body.append(search, rows);
    const pick = (path: string, name: string) => choose(draft => { draft.noteMentions = [{ vaultRelativePath: path, fileName: name }]; });
    const render = () => {
      rows.replaceChildren();
      const files = host.app.vault.getMarkdownFiles().filter(file => !file.path.split("/").some(part => part.startsWith(".")) && file.path.toLocaleLowerCase().includes(search.value.toLocaleLowerCase())).slice(0, 60);
      for (const file of files) row(rows, file.path, () => pick(file.path, file.basename));
      if (!files.length) rows.append(shellElement(document, "p", "pd-picker-empty", "没有找到笔记"));
    }; search.addEventListener("input", render); render(); open("引用笔记", body);
  };
  bar.append(iconButton("添加到任务", "plus", () => {
    const body = shellElement(document, "div", "pd-picker"); row(body, "引用笔记", notes);
    if (!isExpertAgent(currentAgent())) row(body, "选择 Skill", () => {
      const skills = shellElement(document, "div", "pd-picker");
      row(skills, "不使用 Skill", () => choose(draft => { draft.selectedSkill = null; }), readDraft().selectedSkill === null);
      void host.services.capabilities.listSkills().then(items => {
        for (const skill of items.filter(item => item.enabled)) {
          const button = row(skills, `${skill.name}${skill.locked ? " · PRO" : ""}`, () => {
            if (skill.locked) {
              const info = shellElement(document, "div", "pd-picker");
              info.append(shellElement(document, "p", "", skill.description));
              info.append(shellElement(document, "p", "", pickErrorCopy(CAUSE.proRequired, host.settings().settingsLanguage)));
              const compareUrl = skill.compareUrl ? safeSkillCompareUrl(skill.compareUrl) : null;
              if (compareUrl) { const link = shellElement(document, "a", "", "查看对比示例"); link.href = compareUrl; link.target = "_blank"; link.rel = "noopener noreferrer"; info.append(link); }
              open(skill.name, info); return;
            }
            const resource = host.settings().resources.catalog.find(item => item.kind === "skill" && (item.id === skill.id || item.metadata?.resourceId === skill.id))
              ?? { id: skill.id, kind: "skill" as const, source: "echoink-local" as const, name: skill.name, description: skill.description, enabled: skill.enabled,
                bridgeMode: "prompt-only" as const, metadata: { resourceId: skill.id }, ...(skill.contentPath ? { contentPath: skill.contentPath } : {}) };
            return choose(draft => { draft.selectedSkill = structuredClone(resource); });
          }, readDraft().selectedSkill?.id === skill.id);
          if (skill.locked) { const lock = shellElement(document, "span", "pd-icon"); lock.setAttribute("aria-hidden", "true"); setIcon(lock, "lock"); button.firstElementChild?.prepend(lock); }
        }
      }).catch(ctx.error);
      open("选择 Skill", skills);
    }); open("添加到任务", body);
  }));
  bar.append(iconButton("引用笔记", "at-sign", notes));
  const model = iPadAction(ctx, "", () => {
    const body = shellElement(document, "div", "pd-model-picker"), draft = readDraft();
    for (const provider of host.settings().apiProviders.filter(provider => supportedProvider(provider) && provider.providerId !== "ollama")) {
      const group = shellElement(document, "section", "pd-model-group"), heading = shellElement(document, "h3", "pd-model-heading");
      const brand = shellElement(document, "span", "pd-brand"); renderProviderBrandIcon(brand, provider.providerId === "openai" ? "openai-codex" : provider.providerId ?? "custom");
      heading.append(brand, shellElement(document, "span", "", provider.name)); group.append(heading); body.append(group);
      for (const item of provider.models) {
        const selected = (draft.selectedProviderSettingsId ?? host.settings().activeApiProviderId) === provider.id
          && (draft.selectedModel ?? (draft.selectedProviderSettingsId === undefined ? host.settings().defaultModel : provider.defaultModelId)) === item.id;
        const button = row(group, item.displayName || item.id, () => choose(value => { value.selectedProviderSettingsId = provider.id; value.selectedModel = item.id; }), selected);
        const brand = shellElement(document, "span", "pd-brand"); renderProviderBrandIcon(brand, provider.providerId === "openai" ? "openai-codex" : provider.providerId ?? "custom"); button.querySelector(".pd-action-visible")!.prepend(brand);
      }
    }
    row(body, host.settings().settingsLanguage === "en" ? "Manage model services" : "管理模型服务", () => { ctx.shell.closeSheet(); return host.openSettings ? host.openSettings("model") : host.openLegacy("providers"); }); open(host.settings().settingsLanguage === "en" ? "Choose model" : "选择模型", body);
  }); model.classList.add("pd-composer-model"); bar.append(model);
  const permission = iconButton("工作区权限", "shield-check", () => {
    const body = shellElement(document, "div", "pd-permission-picker");
    for (const [value, label] of permissions) {
      row(body, label, () => choose(draft => { draft.selectedPermission = value === "full-access" ? "danger-full-access" : value; }, value), effectivePermission() === value);
    } open("工作区权限", body);
  }); bar.append(permission);
  const stop = iconButton("停止当前任务", "square", async () => {
    const pending = [...host.runtime.composerSubmissions.records.values()].find(record => record.owner === owner && record.phase === "preparing");
    if (pending) { await host.runtime.cancelComposerSubmission(pending.id); input.value = readDraft().text; refresh(); return; }
    if (!taskId || stopping) return; stopping = true; refresh();
    try { if (host.runtime.stateFor(taskId).resuming) await host.runtime.cancelResume(taskId); else await host.runtime.stopTask(taskId); }
    catch (failure) { showFailure(failure); } finally { stopping = false; refresh(); }
  }); stop.classList.add("pd-composer-stop"); bar.append(stop);
  const send = iconButton("发送", "arrow-up", async () => {
    if (sending || !input.value.trim()) return;
    const text = input.value, snapshot = { ...structuredClone(readDraft()), text };
    const submissionId = host.runtime.beginComposerSubmission(target, snapshot);
    input.value = ""; sending = true; error.hidden = true; refresh();
    try {
      await update(draft => { if (draft.text === text) Object.assign(draft, { text: "", attachments: [], noteMentions: [], annotations: [], selectedSkill: null }); });
      dirty = false;
      if (taskId && host.store.getSession(taskId)?.taskStatus === "interrupted") await requestIPadTaskResume(ctx, taskId, text, () => refresh(), submissionId);
      else await submitSnapshot(submissionId);
    } catch (failure) { host.runtime.composerSubmissions.fail(submissionId, failureText(ctx, failure)); }
    finally { sending = false; refresh(); }
  }); send.classList.add("pd-composer-send"); bar.append(send);
  const submitSnapshot = async (id: string) => {
    const submission = await host.runtime.submitComposerSubmission(id);
    void submission.completion.catch(failure => ctx.error(failure));
    if (agentId && !disposed) {
      handingOff = true;
      try { await ctx.navigate({ kind: "task", taskId: submission.taskId }); host.runtime.composerSubmissions.remove(id); }
      finally { handingOff = false; }
    }
  };
  const renderSubmissions = () => {
    scroll.capture(); submissions.replaceChildren();
    for (const record of host.runtime.composerSubmissions.records.values()) {
      if (record.owner !== owner) continue;
      if (taskId && record.phase === "preparing" && host.runtime.isRunning?.(taskId)
        && host.runtime.isComposerSubmissionRunning?.(record.id) === false) continue;
      if (record.phase === "accepted" && taskId && record.turnId && submissions.parentElement?.querySelector(`[data-submission-turn="${record.turnId}"]`)) { host.runtime.composerSubmissions.records.delete(record.id); continue; }
      renderComposerSubmission(submissions, record, { text: record.snapshot.text, language: host.settings().settingsLanguage ?? "zh", userClass: "pd-task-user",
        button: (parent, label, action) => { parent.append(iPadAction(ctx, label, action)); },
        retry: async () => { if (!host.runtime.retryComposerSubmission(record.id)) return; try { await submitSnapshot(record.id); } catch { /* The runtime owns its failed snapshot. */ } },
        edit: async () => { await flush(); if (!await host.runtime.restoreComposerSubmission(record.id)) { showFailure(new Error("输入框里有新的草稿，请先处理它；这条消息仍然保留。")); return; } input.value = readDraft().text; refresh(); }
      });
    }
    scroll.refresh();
  };
  const effectivePermission = (): MobilePermission => {
    const draft = readDraft(), workspace = host.store.permission;
    const requested = draft.selectedMode === "plan" ? "read-only" : draft.selectedPermission === "danger-full-access" ? "full-access" : draft.selectedPermission ?? workspace;
    return requested === "read-only" || workspace === "read-only" ? "read-only" : requested === "workspace-write" || workspace === "workspace-write" ? "workspace-write" : "full-access";
  };
  const refresh = () => {
    if (disposed) return;
    renderSubmissions();
    const task = taskId ? host.store.getSession(taskId) : undefined, state = taskId ? host.runtime.stateFor(taskId) : undefined;
    const name = host.settings().agentRegistry.agents.find(agent => agent.id === (agentId ?? task?.agentId))?.name ?? "Agent";
    input.placeholder = taskId ? task?.taskStatus === "completed" ? `接着和${name}聊这件事…` : `回复${name}…` : `交代给${name}一件新事…`;
    if (!dirty && !sending && input.value !== readDraft().text) input.value = readDraft().text;
    const draft = readDraft(), fallback = selectedModel(host.settings());
    const provider = draft.selectedProviderSettingsId === undefined && draft.selectedModel === undefined ? fallback?.provider : host.settings().apiProviders.find(item => item.id === (draft.selectedProviderSettingsId ?? host.settings().activeApiProviderId) && supportedProvider(item));
    const selected = draft.selectedProviderSettingsId === undefined && draft.selectedModel === undefined ? fallback?.model : provider?.models.find(item => item.id === (draft.selectedModel ?? provider.defaultModelId));
    const visible = model.querySelector<HTMLElement>(".pd-action-visible")!; visible.replaceChildren();
    if (provider && selected) { const brand = shellElement(document, "span", "pd-brand"); renderProviderBrandIcon(brand, provider.providerId === "openai" ? "openai-codex" : provider.providerId ?? "custom"); visible.append(brand); }
    const modelName = selected?.displayName || selected?.id;
    visible.append(shellElement(document, "span", "pd-model-label", modelName || "配置模型"));
    attachNativeTooltip(model, `选择模型：${modelName || "未配置"}`); model.setAttribute("aria-label", model.title);
    permission.setAttribute("aria-label", `工作区权限：${permissions.find(item => item[0] === effectivePermission())?.[1]}`);
    send.disabled = sending || !!state?.resuming || !input.value.trim() || !isAgentHired(currentAgent()); send.setAttribute("aria-busy", String(sending));
    send.hidden = !!state?.busy && !input.value.trim() && state?.interaction?.status !== "pending";
    stop.hidden = (!state?.busy && !state?.resuming && ![...host.runtime.composerSubmissions.records.values()].some(record => record.owner === owner && record.phase === "preparing")) || state?.interaction?.status === "pending"; stop.disabled = stopping; stop.setAttribute("aria-label", state?.resuming ? "取消继续" : "停止当前任务");
    status.textContent = state?.queuedCount ? state.paused ? `已暂停 ${state.queuedCount} 条` : `排队 ${state.queuedCount} 条` : ""; status.hidden = !status.textContent;
    references.replaceChildren();
    const note = draft.noteMentions !== undefined ? draft.noteMentions[0]?.vaultRelativePath : task?.notePath;
    if (note) {
      references.append(iPadAction(ctx, note, () => host.openNote(note), "file-text"));
      references.append(iconButton("移除笔记引用", "x", () => choose(value => { value.noteMentions = []; })));
    }
    if (draft.selectedSkill && !isExpertAgent(currentAgent())) { references.append(shellElement(document, "span", "pd-composer-skill", draft.selectedSkill.name)); references.append(iconButton("移除 Skill", "x", () => choose(value => { value.selectedSkill = null; }))); }
    references.hidden = !references.childNodes.length;
  };
  input.addEventListener("input", () => { void saveText(input.value).catch(showFailure); refresh(); });
  const unsubscribe = host.runtime.subscribe(id => { if (!taskId || id === taskId) refresh(); });
  const unsubscribeWorkbench = host.workbench.subscribe(refresh);
  const drafts = resumeDrafts.get(ctx) ?? new Map<string, ResumeDraft>(); resumeDrafts.set(ctx, drafts);
  const resumeDraft: ResumeDraft = { text: () => input.value, accepted: text => { restoreAfterAdmission(text); refresh(); } };
  if (taskId) drafts.set(taskId, resumeDraft);
  // The task-tail button shares the mounted input, including uncommitted edits.
  const resume = () => {
    if (!taskId) return;
    const text = input.value;
    if (text.trim()) { send.click(); return; }
    void saveText(text).then(() => requestIPadTaskResume(ctx, taskId, text, () => {
      restoreAfterAdmission(text); refresh();
    })).catch(showFailure);
  };
  element.addEventListener("pd-resume-task", resume);
  const unsubscribeSubmissions = host.runtime.composerSubmissions.subscribe(() => { if (!disposed) refresh(); });
  refresh();
  return { scroll, element, submissions, refreshSubmissions: renderSubmissions, flush, async canLeave() {
    try { await flush(); scroll.leave(handingOff); return true; }
    catch (failure) { showFailure(failure); return false; }
  }, dispose() { if (disposed) return; disposed = true; scroll.dispose(); unsubscribeSubmissions(); unsubscribe(); unsubscribeWorkbench(); if (taskId && drafts.get(taskId) === resumeDraft) drafts.delete(taskId); element.removeEventListener("pd-resume-task", resume); } };
}
