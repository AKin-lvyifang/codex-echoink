import { ECHOINK_DEFAULT_KNOWLEDGE_MAINTENANCE_PREFERENCES } from "../core/knowledge-preferences-default";
import { Notice, TFile, type App, type EventRef } from "obsidian";
import type { HomeHost } from "../home/home-host";
import { EchoInkTodoStore } from "../home/todo-store";
import { HomeActivityCore } from "../home/home-activity-core";
import { BUILTIN_SKILLS, renderBuiltinSkill } from "../harness/resources/builtin-skills";
import { resolveKnowledgePathFromRoots } from "../knowledge-base/root-paths-core";
import type { MobileSettings } from "./settings";
import type { MobileStore } from "./store";
import type { MobileRuntime } from "./runtime";
import type { MobileWorkspace } from "./workspace";

export interface MobileServicesHost {
  app: App;
  settings: MobileSettings;
  store: MobileStore;
  runtime: MobileRuntime;
  navigation: MobileWorkspace;
  saveSettings(): Promise<void>;
  registerEvent(event: EventRef): void;
  showPage(page: "basic" | "knowledge" | "resources"): Promise<void>;
}
export class MobileServices implements HomeHost {
  readonly app: App;
  readonly homeActivity: HomeActivityCore;
  private preferenceRoot: string;
  private readonly todos: EchoInkTodoStore;
  readonly homeUnavailableReason = "移动端尚未接通知识健康扫描；笔记数量来自当前笔记库";
  constructor(private host: MobileServicesHost, readonly directory: string) {
    this.app = host.app; this.preferenceRoot = directory.replace(/\/mobile$/u, "");
    const adapter = this.app.vault.adapter;
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
    await this.homeActivity.initialize(); await this.todos.initialize();
    this.homeActivity.restoreOpen(this.app.workspace.getActiveFile()?.path ?? null);
    this.registerEvent(this.app.workspace.on("file-open", file => this.homeActivity.open(file?.path ?? null)));
    this.registerEvent(this.app.vault.on("create", file => { if (file instanceof TFile) this.homeActivity.record(file.path, "created"); }));
    this.registerEvent(this.app.vault.on("modify", file => { if (file instanceof TFile) this.homeActivity.record(file.path, "modified"); }));
    this.registerEvent(this.app.vault.on("rename", (file, old) => this.homeActivity.rename(old, file.path)));
    this.registerEvent(this.app.vault.on("delete", file => this.homeActivity.delete(file.path)));
  }
  async dispose() { await this.homeActivity.dispose(); }
  readonly lifestyle = { open: async (_kind: "finance") => { new Notice("移动端尚未支持财务工作区；财务数据与配置已保留，请在桌面端打开。"); } };
  readonly englishDiary = {
    enabled: () => this.settings.englishDiary.enabled,
    setHomeShortcut: async (choice: "english-diary" | "quick-record") => { this.settings.englishDiary.homeShortcut = choice; await this.saveSettings(); },
    openToday: async () => { throw new Error("移动端尚未支持英文日记工作区与纠错服务；可以打开已有原稿笔记。"); },
    openDiary: async (path: string) => { const file = this.app.vault.getAbstractFileByPath(path); if (file instanceof TFile) await this.host.navigation.openNote(file); else throw new Error("日记原稿不存在。"); }
  };
  openEchoInkKnowledgeSettings() { return this.host.showPage("knowledge"); }
  openEchoInkGeneralSettings() { return this.host.showPage("basic"); }
  openEchoInkSkillSettings(_id: string) { return this.host.showPage("resources"); }
  activateView() { return this.host.navigation.open(); }
  getCodexView() { return {
    startHomeConversation: async (input: { title: string; message: string; defaultSkillId?: string }) => this.start(input.title, input.message, input.defaultSkillId),
    createAndStartGuidedSession: async (input: { title: string; prompt: string; defaultSkillId: string }) => this.start(input.title, input.prompt, input.defaultSkillId)
  }; }
  private async start(title: string, prompt: string, skill?: string) {
    if (this.host.runtime.busy) throw new Error("请先停止当前回答。");
    if (skill) await this.requireAvailableEchoInkSkill(skill);
    const session = await this.host.store.createSession(); session.title = title; session.draft = prompt; session.skillId = skill;
    await this.host.store.save(); this.host.runtime.onChange(); await this.host.runtime.send(prompt);
  }
  skills() {
    const saved = this.settings.resources.catalog.filter(item => item.kind === "skill");
    return [...BUILTIN_SKILLS.map(skill => ({ id: skill.id, name: skill.title, description: skill.description, enabled: saved.find(item => item.id === skill.id)?.enabled ?? this.settings.resources.legacyEnabledOverrides?.[skill.id] ?? true,
      content: renderBuiltinSkill(skill), contentPath: saved.find(item => item.id === skill.id)?.contentPath })),
      ...saved.filter(item => !BUILTIN_SKILLS.some(skill => skill.id === item.id)).map(item => ({ ...item, content: "" }))];
  }
  async requireAvailableEchoInkSkill(id: string): Promise<string> {
    const skill = this.skills().find(item => item.id === id);
    if (!skill?.enabled) throw new Error(`Skill ${id} 已停用或不存在。`);
    if (skill.contentPath) return this.app.vault.adapter.read(this.safePath(skill.contentPath));
    if (!skill.content) throw new Error("Skill 正文尚未导入当前笔记库。");
    return skill.content;
  }
  roots() {
    return this.app.vault.getRoot().children.map(file => file.name);
  }
  knowledgePath(kind: "wiki" | "raw" | "inbox") { return resolveKnowledgePathFromRoots(this.settings.mobileUi.knowledgePaths[kind], this.roots()); }
  knowledgeFiles(kind: "wiki" | "raw" | "inbox") {
    const prefix = `${this.knowledgePath(kind)}/`;
    return this.app.vault.getMarkdownFiles().filter(file => file.path.startsWith(prefix)).sort((a, b) => b.stat.mtime - a.stat.mtime);
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
  async context(): Promise<string> {
    const skillId = this.host.store.session.skillId;
    const skill = skillId ? await this.requireAvailableEchoInkSkill(skillId) : "";
    const preference = await this.readPreferences() ?? this.defaultPreferences;
    return `${skill ? `\n本次已选择的 Skill（不能增加权限或工具）：\n${skill}` : ""}${preference ? `\n用户的知识提炼偏好：\n${preference}` : ""}\n知识目录：${JSON.stringify({ wiki: this.knowledgePath("wiki"), raw: this.knowledgePath("raw"), inbox: this.knowledgePath("inbox") })}`;
  }
  plugins() {
    return [{ id: "echoink:english-diary", name: "English Diary", description: "英文日记与表达积累", enabled: this.settings.englishDiary.enabled, mobileStatus: "移动端尚未接通英文日记工作区与纠错服务" },
      ...this.settings.resources.catalog.filter(item => item.kind === "tool-bundle" && item.id !== "echoink:english-diary").map(item => ({ ...item, mobileStatus: "移动工具桥接尚未接通，资源配置已保留" }))];
  }
}
