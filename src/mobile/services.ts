import { classifyKnowledgePath, emptyKnowledgeFolderBindings, knowledgeFolderIssues, normalizeKnowledgeFolderBindings, type KnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import type { KnowledgeMaintenanceRecord } from "../knowledge-base/maintenance-record";
import { sha256Hex } from "../utils/sha256";
import { ECHOINK_DEFAULT_KNOWLEDGE_MAINTENANCE_PREFERENCES } from "../core/knowledge-preferences-default";
import { TFolder, TFile, type App, type EventRef } from "obsidian";
import type { HomeHost } from "../home/home-host";
import { EchoInkTodoStore } from "../home/todo-store";
import { HomeActivityCore } from "../home/home-activity-core";
import { BUILTIN_SKILLS, renderBuiltinSkill } from "../harness/resources/builtin-skills";
import { resolveKnowledgePathFromRoots } from "../knowledge-base/root-paths-core";
import type { MobileSettings } from "./settings";
import type { AgentRegistry } from "../agents/types";
import type { MobileQueuedTurn } from "./task-contracts";
import { MobileCapabilityPolicy } from "./capability-policy";
import type { MobileStore } from "./store";
import type { MobileRuntime } from "./runtime";
import type { MobileWorkspace } from "./workspace";
import type { CapabilityAccess } from "../membership/types";
import { mobileGenerateText } from "./transport";
import { selectedModel } from "./settings";
import { requestUrl } from "obsidian";
import { EchoInkHomeView, VIEW_TYPE_ECHOINK_HOME } from "../home/home-view";
import { mobileAtomicFilePort } from "./finance-store";
import { MobileLifestyleService } from "./finance";
import type { MobileSettingsRoute } from "../ui/mobile/settings-pages";
import type { MobileAgentProfile } from "../harness/memory/mobile-profile-protocol";
import { MobileAgentRegistryService } from "./agent-registry-service";
import type { AgentTemplateId } from "../harness/memory/agent-templates";
import type { AgentAvatarState } from "../harness/memory/agent-identity-model";
import { defaultAgentIdentityState } from "../harness/memory/agent-identity-model";

export interface MobileServicesHost {
  app: App;
  settings: MobileSettings;
  store: MobileStore;
  runtime: MobileRuntime;
  navigation: MobileWorkspace;
  accountService?: CapabilityAccess;
  saveSettings(candidateRegistry?: AgentRegistry): Promise<void>;
  registerEvent(event: EventRef): void;
  showPage(page: MobileSettingsRoute): Promise<void>;
}
export class MobileServices implements HomeHost {
  readonly app: App;
  readonly homeActivity: HomeActivityCore;
  private preferenceRoot: string;
  private readonly todos: EchoInkTodoStore;
  private skillStateWrites: Promise<void> = Promise.resolve();
  agentIdentity = defaultAgentIdentityState();
  private readonly identityListeners = new Set<() => void>();
  private profileProtocol: MobileAgentRegistryService;
  subscribeIdentity(listener: () => void) { this.identityListeners.add(listener); return () => { this.identityListeners.delete(listener); }; }
  async readAgentProfile(): Promise<MobileAgentProfile> { return this.profileProtocol.profile(); }
  async saveAgentProfile(change: { identity?: { displayName: string; avatar: AgentAvatarState }; templateId?: AgentTemplateId }, version: string) {
    const profile = await this.profileProtocol.save(change, version); this.agentIdentity = profile.identity;
    this.identityListeners.forEach(listener => listener()); this.host.runtime.onChange(); return profile;
  }
  async removeAgent(agentId: string, version: string): Promise<void> {
    if (agentId === "sol") throw new Error("总助不能删除。");
    const before = await this.profileProtocol.snapshot();
    if (before.version !== version) throw new Error("Agent 配置已变化，请重新读取后再编辑。");
    try {
      await this.host.runtime.stopAgent(agentId);
      if ((await this.profileProtocol.snapshot()).version !== version) throw new Error("Agent 配置已变化，请重新读取后再编辑。");
      await this.host.store.handoffAgentTasks(agentId);
      await this.profileProtocol.removeAgent(agentId, version);
      await this.refreshAgentIdentity();
    } finally { this.host.runtime.unblockAgent(agentId); }
  }
  async refreshAgentIdentity() {
    this.agentIdentity = (await this.profileProtocol.profile()).identity;
    this.identityListeners.forEach(listener => listener()); this.host.runtime.onChange();
  }
  readonly homeUnavailableReason = "移动端尚未接通知识健康扫描；笔记数量来自当前笔记库";
  constructor(private host: MobileServicesHost, readonly directory: string) {
    this.app = host.app; this.preferenceRoot = directory.replace(/\/mobile$/u, "");
    const adapter = this.app.vault.adapter; this.profileProtocol = new MobileAgentRegistryService(adapter, host.settings, registry => host.saveSettings(registry));
    this.homeActivity = new HomeActivityCore({ read: async () => await adapter.exists(`${directory}/home-activity.json`) ? adapter.read(`${directory}/home-activity.json`) : null,
      write: bytes => adapter.write(`${directory}/home-activity.json`, bytes) });
    this.todos = new EchoInkTodoStore(this);
  }
  get settings() { return this.host.settings; }
  registerEvent(event: EventRef) { this.host.registerEvent(event); }
  saveSettings() { return this.host.saveSettings(); }
  getTodoStore() { return this.todos; }
  getKnowledgeSurfaceService() { return null; }
  async initialize() {
    await this.refreshAgentIdentity();
    await this.homeActivity.initialize(); await this.todos.initialize();
    this.homeActivity.restoreOpen(this.app.workspace.getActiveFile()?.path ?? null);
    this.registerEvent(this.app.workspace.on("file-open", file => this.homeActivity.open(file?.path ?? null)));
    this.registerEvent(this.app.vault.on("create", file => { if (file instanceof TFile) this.homeActivity.record(file.path, "created"); }));
    this.registerEvent(this.app.vault.on("modify", file => { if (file instanceof TFile) { this.homeActivity.record(file.path, "modified"); } }));
    this.registerEvent(this.app.vault.on("rename", (file, old) => this.homeActivity.rename(old, file.path)));
    this.registerEvent(this.app.vault.on("delete", file => this.homeActivity.delete(file.path)));
  }
  async dispose() { this.lifestyle?.dispose(); await this.homeActivity.dispose(); }
  lifestyle!: MobileLifestyleService;
  get accountService() { return this.host.accountService; }
  async initializeFinance() { this.lifestyle = new MobileLifestyleService(this, this.preferenceRoot); await this.lifestyle.initialize(); }
  notifyHomeSurfacesChanged() { for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_ECHOINK_HOME)) if (leaf.view instanceof EchoInkHomeView) leaf.view.refreshHomeSurfaces(); }
  openLifestyleSettings(_kind: "finance") { return this.host.showPage("finance-settings"); }
  getSkillRuntimeCoordinator() {
    return { resolveById: (id: string) => this.requireAvailableEchoInkSkill(id), recordUse: (id: string) => {
      const run = async () => {
      const path = ".echoink/resources/skill-state.json", adapter = this.app.vault.adapter;
      if (!await adapter.exists(path)) return;
      const state = JSON.parse(await adapter.read(path)) as { schema: string; records?: Record<string, { status: string; lastUsedAt: number | null; usageCount: number }> };
      if (state.schema !== "echoink.skill-runtime.v1" || !state.records) throw new Error("Skill 使用状态不可读取，原文件已保留。");
      const item = state.records?.[id];
      if (item && item.status === "active") {
        if (!Number.isSafeInteger(item.usageCount) || item.usageCount < 0) throw new Error("Skill 使用状态不可读取，原文件已保留。");
        item.lastUsedAt = Date.now(); item.usageCount += 1; await mobileAtomicFilePort(adapter, path).write(`${JSON.stringify(state, null, 2)}\n`);
      }
      };
      const pending = this.skillStateWrites.then(run, run); this.skillStateWrites = pending.catch(() => {}); return pending;
    } };
  }
  async readEchoInkBuiltinSkill(id: string) { return { fileStatus: "ready", content: await this.requireAvailableEchoInkSkill(id) }; }
  async generateLifestyleText(system: string, user: string, maxTokens: number, signal: AbortSignal) {
    const selected = selectedModel(this.settings);
    if (!selected) throw new Error("尚未配置当前 EchoInk Provider");
    return mobileGenerateText(selected.provider, selected.model, requestUrl, system, user, maxTokens, signal);
  }
  async saveFinanceCsv(name: string, content: string) {
    const directory = "EchoInk/财务导出";
    for (const path of ["EchoInk", directory]) if (!await this.app.vault.adapter.exists(path)) await this.app.vault.createFolder(path);
    const stem = name.replace(/\.csv$/u, ""); let path = `${directory}/${name}`, index = 1;
    while (await this.app.vault.adapter.exists(path)) path = `${directory}/${stem}-${index++}.csv`;
    await this.app.vault.create(path, content); return path;
  }
  readonly englishDiary = {
    enabled: () => this.settings.englishDiary.enabled,
    setHomeShortcut: async (choice: "english-diary" | "quick-record") => { this.settings.englishDiary.homeShortcut = choice; await this.saveSettings(); },
    openToday: async () => { throw new Error("移动端尚未支持英文日记工作区与纠错服务；可以打开已有原稿笔记。"); },
    openDiary: async (path: string) => { const file = this.app.vault.getAbstractFileByPath(path); if (file instanceof TFile) await this.host.navigation.openNote(file); else throw new Error("日记原稿不存在。"); }
  };
  openEchoInkKnowledgeSettings() { return this.host.showPage("knowledge"); }
  openEchoInkGeneralSettings() { return this.host.showPage("settings"); }
  openEchoInkSkillSettings(_id: string) { return this.host.showPage("resources"); }
  activateView() { return this.host.navigation.open(); }
  getCodexView() { return {
    startHomeConversation: async (input: { title: string; message: string; defaultSkillId?: string }) => input.defaultSkillId === "daily-journal" ? this.prepareJournal(input.title, true) : this.start(input.title, input.message, input.defaultSkillId),
    createAndStartGuidedSession: async (input: { title: string; prompt: string; defaultSkillId: string }) => input.defaultSkillId === "daily-journal" ? this.prepareJournal(input.title, true) : this.start(input.title, input.prompt, input.defaultSkillId)
  }; }
  async prepareJournal(title?: string, newSession = false, sessionId = this.host.store.session.id) {
    await this.requireAvailableEchoInkSkill("daily-journal");
    const id = newSession ? (await this.host.store.createSession()).id : sessionId;
    await this.host.store.updateSession(id, session => {
      if (title) session.title = title;
      session.skillId = "daily-journal";
      if (session.draftContext) delete session.draftContext.selectedSkill;
    }); this.host.runtime.onChange();
  }
  private async start(title: string, prompt: string, skill?: string) {
    if (skill) await this.requireAvailableEchoInkSkill(skill);
    const session = await this.host.store.createSession();
    await this.host.store.patchSession(session.id, { title, draft: prompt, skillId: skill });
    this.host.runtime.onChange();
    const accepted = await this.host.runtime.submit(prompt, session.id);
    void accepted.completion.catch(() => { /* The task owns and displays its run error. */ });
  }
  skills() {
    const saved = this.settings.resources.catalog.filter(item => item.kind === "skill");
    const record = (id: string) => saved.find(item => item.id === id || item.metadata?.resourceId === id);
    return [...BUILTIN_SKILLS.map(skill => ({ id: skill.id, name: skill.title, description: skill.description, enabled: record(skill.id)?.enabled ?? this.settings.resources.legacyEnabledOverrides?.[skill.id] ?? true,
      content: renderBuiltinSkill(skill), contentPath: record(skill.id)?.contentPath })),
      ...saved.filter(item => !BUILTIN_SKILLS.some(skill => skill.id === item.id || skill.id === item.metadata?.resourceId)).map(item => ({ ...item, content: "" }))];
  }
  async requireAvailableEchoInkSkill(id: string): Promise<string> {
    const skill = this.skills().find(item => item.id === id);
    if (!skill?.enabled) throw new Error(`Skill ${id} 已停用或不存在。`);
    if (skill.contentPath) return this.app.vault.adapter.read(this.safePath(skill.contentPath));
    const runtimePath = this.safePath(`.echoink/resources/skills/${id}/SKILL.md`);
    if (await this.app.vault.adapter.exists(runtimePath)) return this.app.vault.adapter.read(runtimePath);
    if (!skill.content) throw new Error("Skill 正文尚未导入当前笔记库。");
    return skill.content;
  }
  roots() {
    return this.app.vault.getRoot().children.map(file => file.name);
  }
  knowledgePath(kind: "wiki" | "raw" | "inbox") {
    const config = this.settings.knowledgeBase.folderBindings;
    if (!config) return resolveKnowledgePathFromRoots(this.settings.mobileUi.knowledgePaths[kind], this.roots());
    const binding = config.roles[kind];
    if (config.migrationIssues.some((issue) => issue.startsWith(`${kind}：`)) || !binding.enabled || !binding.writePath || !(this.app.vault.getAbstractFileByPath(binding.writePath) instanceof TFolder)) throw new Error(`${kind} 位置未启用、尚未绑定或已失效，请在知识库目录中选择。`);
    return binding.writePath;
  }
  knowledgeBindingDescription(kind: "wiki" | "raw" | "inbox"): string {
    const binding = this.settings.knowledgeBase.folderBindings?.roles[kind];
    if (!binding) return this.knowledgePath(kind);
    if (!binding.enabled) return "未启用";
    if (!binding.readPaths.length) return "尚未绑定";
    const invalid = binding.readPaths.filter(directory => !(this.app.vault.getAbstractFileByPath(directory) instanceof TFolder));
    return invalid.length ? `位置失效：${invalid.join("、")}` : binding.readPaths.join("、");
  }
  async saveKnowledgeBindings(next: KnowledgeFolderBindings, expectedRevision: number): Promise<void> {
    const previous = this.settings.knowledgeBase.folderBindings;
    if ((previous?.revision ?? 0) !== expectedRevision) throw new Error("目录配置已更新，请重新打开后编辑。");
    const normalized = normalizeKnowledgeFolderBindings(next) ?? emptyKnowledgeFolderBindings();
    const existingIssues = previous ? knowledgeFolderIssues(previous) : [];
    const issues = knowledgeFolderIssues(normalized).filter(issue => !existingIssues.includes(issue));
    if (issues.length) throw new Error(issues.join("；"));
    for (const [role, binding] of Object.entries(normalized.roles)) {
      if (JSON.stringify(binding) === JSON.stringify(previous?.roles[role as keyof typeof previous.roles])) continue;
      if (!binding.enabled || binding.native) continue;
      for (const directory of binding.readPaths) if (!(this.app.vault.getAbstractFileByPath(directory) instanceof TFolder)) throw new Error(`目录不存在：${directory}；请选择已有目录。`);
    }
    normalized.revision = expectedRevision + 1;
    this.settings.knowledgeBase.folderBindings = normalized;
    try { await this.host.saveSettings(); }
    catch (error) { this.settings.knowledgeBase.folderBindings = previous; throw error; }
    this.notifyHomeSurfacesChanged();
  }
  async readMaintenanceRecord(recordId: string): Promise<KnowledgeMaintenanceRecord> {
    if (!/^maintenance-[a-f0-9]{32}$/u.test(recordId)) throw new Error("维护记录身份无效。");
    const adapter = this.app.vault.adapter;
    const target = `${this.preferenceRoot}/pi-agent-product-v1/knowledge/records/${recordId}.json`;
    if (!await adapter.exists(target)) throw new Error("维护记录不存在或尚未同步。");
    const envelope = JSON.parse(await adapter.read(target));
    const stable = (value: unknown): string => value === null || typeof value !== "object" ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(stable).join(",")}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(",")}}`;
    const record = envelope?.payload as KnowledgeMaintenanceRecord;
    if (envelope?.schemaVersion !== 1 || envelope.kind !== "record" || typeof envelope.vaultId !== "string" || envelope.payloadDigest !== sha256Hex(stable(record)) || record?.schemaVersion !== 1 || record.recordId !== recordId || !Array.isArray(record.sources) || !Array.isArray(record.result?.notes)) throw new Error("维护记录损坏，请重新同步。");
    return record;
  }
  knowledgeFiles(kind: "wiki" | "raw" | "inbox") {
    const config = this.settings.knowledgeBase.folderBindings;
    const prefixes = config ? config.roles[kind].enabled ? config.roles[kind].readPaths.map((directory) => `${directory}/`) : [] : [`${this.knowledgePath(kind)}/`];
    return this.app.vault.getMarkdownFiles().filter(file => prefixes.some((prefix) => file.path.startsWith(prefix)) && (!config || classifyKnowledgePath(config, file.path) === kind)).sort((a, b) => b.stat.mtime - a.stat.mtime);
  }
  safePath(path: string): string {
    const normalized = path.trim().replace(/\\/gu, "/");
    if (!normalized || normalized.startsWith("/") || /^[a-z]:/iu.test(normalized) || normalized.split("/").some(part => !part || part === "." || part === "..")) throw new Error("请填写当前笔记库内的相对路径。");
    return normalized;
  }
  async readProfile(kind: "agent" | "user"): Promise<string | null> {
    const path = kind === "agent" ? ".echoink/agents/echoink/AGENT.md" : ".echoink/shared-user/USER.md";
    return await this.app.vault.adapter.exists(path) ? this.app.vault.adapter.read(path) : null;
  }
  usePluginDataRoot(root: string) { this.preferenceRoot = root; }
  get preferencesPath() { return `${this.preferenceRoot}/pi-agent-product-v1/knowledge/preferences.md`; }
  async readPreferences(): Promise<string | null> { return await this.app.vault.adapter.exists(this.preferencesPath) ? this.app.vault.adapter.read(this.preferencesPath) : null; }
  async savePreferences(content: string, expected: string | null) {
    if (await this.readPreferences() !== expected) throw new Error("偏好已在其他页面更新，请重新打开后编辑。");
    if (!content.trim() || new TextEncoder().encode(content).length > 64 * 1024) throw new Error("偏好不能为空，且不能超过 64 KiB。");
    const parent = this.preferencesPath.slice(0, this.preferencesPath.lastIndexOf("/"));
    if (!await this.app.vault.adapter.exists(parent)) await this.app.vault.adapter.mkdir(parent);
    await this.app.vault.adapter.write(this.preferencesPath, content);
  }
  async restorePreferences(expected: string | null) {
    if (await this.readPreferences() !== expected) throw new Error("偏好已更新，请重新打开后操作。");
    if (expected === null) return;
    await this.app.vault.adapter.write(`${this.preferencesPath}.mobile-backup`, expected);
    await this.app.vault.adapter.remove(this.preferencesPath);
  }
  readonly defaultPreferences = ECHOINK_DEFAULT_KNOWLEDGE_MAINTENANCE_PREFERENCES;
  async context(sessionId = this.host.store.session.id, turn?: MobileQueuedTurn): Promise<string> {
    const session = this.host.store.getSession(sessionId);
    if (!session && !turn) throw new Error("会话不存在，未读取运行上下文。");
    const agentId = turn?.agentSnapshot.agentId ?? session!.agentId;
    const policy = new MobileCapabilityPolicy({ store: this.host.store, settings: () => this.settings,
      agentId, permission: turn?.permission, proAccess: () => this.host.accountService });
    policy.assertTool("task_update");
    let memoryAllowed = this.host.store.state.memoryEnabled;
    if (memoryAllowed) { try { policy.assertTool("memory_search"); } catch { memoryAllowed = false; } }
    const skillId = turn ? turn.skillId : session?.skillId;
    if (skillId) policy.assertSkill(skillId);
    const profile = await this.profileProtocol.context(memoryAllowed, agentId, turn?.agentSnapshot);
    const skill = skillId ? await this.requireAvailableEchoInkSkill(skillId) : "";
    const preference = await this.readPreferences() ?? this.defaultPreferences;
    return `${profile}${skill ? `\n本次已选择的 Skill（不能增加权限或工具）：\n${skill}` : ""}${preference ? `\n用户的知识提炼偏好：\n${preference}` : ""}\n知识目录：${JSON.stringify(this.settings.knowledgeBase.folderBindings?.roles ?? this.settings.mobileUi.knowledgePaths)}`;
  }
  plugins() {
    return [{ id: "echoink:finance", name: "财务", description: "账目、预算、账单计划与分析", enabled: this.settings.lifestyle.finance.enabled, mobileStatus: "复用当前笔记库的财务账本" },
      { id: "echoink:english-diary", name: "English Diary", description: "英文日记与表达积累", enabled: this.settings.englishDiary.enabled, mobileStatus: "移动端尚未接通英文日记工作区与纠错服务" },
      ...this.settings.resources.catalog.filter(item => item.kind === "tool-bundle" && !["echoink:english-diary", "echoink:finance"].includes(item.id)).map(item => ({ ...item, mobileStatus: "移动工具桥接尚未接通，资源配置已保留" }))];
  }
}
