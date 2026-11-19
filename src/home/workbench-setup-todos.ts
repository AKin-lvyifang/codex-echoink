import { getModuleOwner } from "../agents/registry";
import { isExpertAgent } from "../agents/persona";
import { AGENT_MODULE_IDS, GENERALIST_AGENT_ID, type AgentModuleId } from "../agents/types";
import type { CodexForObsidianSettings } from "../settings/settings";
import { onboardingDirectoriesReady, onboardingModelReady } from "../settings/onboarding-setup-status";

export type WorkbenchSetupTodoKind = "model" | "knowledge" | "knowledge-owner" | "owners" | "pro-owner" | "persona";
export interface WorkbenchSetupTodo {
  kind: WorkbenchSetupTodoKind;
  /** Stable per item; dismissal is stored under this key. */
  key: string;
  /** The item's content; a dismissed item returns when this changes. */
  signature: string;
  moduleIds: AgentModuleId[];
  agentName?: string;
}

const PRO_MODULES: readonly AgentModuleId[] = ["finance", "english-diary", "pdf-reading"];
const MODULE_NAMES: Record<AgentModuleId, readonly [string, string]> = {
  journal: ["日记", "Journal"], todos: ["待办", "To-dos"], "knowledge-base": ["知识库", "Knowledge base"], review: ["复盘", "Review"],
  finance: ["财务", "Finance"], "english-diary": ["英文日记", "English diary"], "pdf-reading": ["PDF 精读", "PDF reading"]
};
export const setupTodoModuleName = (id: AgentModuleId, english: boolean): string => MODULE_NAMES[id][english ? 1 : 0];

function proModuleEnabled(settings: CodexForObsidianSettings, id: AgentModuleId): boolean {
  return (id === "finance" ? settings.lifestyle?.finance?.enabled : id === "english-diary" ? settings.englishDiary?.enabled : settings.pdfReading?.enabled) !== false;
}

/** Live setup problems in priority order; nothing is stored except dismissals. */
export function workbenchSetupTodos(settings: CodexForObsidianSettings, hasPro: boolean): WorkbenchSetupTodo[] {
  const list: WorkbenchSetupTodo[] = [];
  const legacyDismissed = (settings.setup?.knowledgeReminderDismissedAt ?? 0) > 0;
  if (!legacyDismissed && !onboardingDirectoriesReady(settings)) list.push({ kind: "knowledge", key: "knowledge", signature: "knowledge", moduleIds: [] });
  if (!legacyDismissed && !onboardingModelReady(settings)) list.push({ kind: "model", key: "model", signature: "model", moduleIds: [] });
  const registry = settings.agentRegistry;
  const enabled = AGENT_MODULE_IDS.filter(id => !PRO_MODULES.includes(id) || proModuleEnabled(settings, id));
  // Free users are not reminded about PRO modules they cannot open.
  const counted = enabled.filter(id => !PRO_MODULES.includes(id) || hasPro);
  const missing = counted.filter(id => !getModuleOwner(registry, id));
  const linkPaused = missing.includes("knowledge-base") && settings.knowledgeBase?.autoLinkEnabled !== false;
  if (linkPaused) list.push({ kind: "knowledge-owner", key: "knowledge-owner", signature: "knowledge-owner", moduleIds: ["knowledge-base"] });
  const rest = missing.filter(id => !(linkPaused && id === "knowledge-base"));
  if (rest.length) list.push({ kind: "owners", key: "owners", signature: rest.join(","), moduleIds: rest });
  if (!hasPro) for (const id of enabled) {
    const owner = getModuleOwner(registry, id);
    if (owner && isExpertAgent(owner)) list.push({ kind: "pro-owner", key: `pro-owner:${id}`, signature: owner.id, moduleIds: [id], agentName: owner.name });
  }
  const generalist = registry.agents.find(agent => agent.id === GENERALIST_AGENT_ID);
  const byGeneralist = counted.filter(id => getModuleOwner(registry, id)?.id === GENERALIST_AGENT_ID);
  if (generalist && byGeneralist.length && !generalist.persona?.trim())
    list.push({ kind: "persona", key: "persona", signature: "persona", moduleIds: byGeneralist, agentName: generalist.name });
  const dismissed = settings.setup?.setupTodoDismissed ?? {};
  return list.filter(item => dismissed[item.key] !== item.signature);
}

export interface WorkbenchGuideStep { key: string; icon: string; zh: string; en: string; actionZh: string; actionEn: string; pro?: boolean }
/** The former “Start here” carousel, now one row per step inside “Getting started”. */
export const WORKBENCH_GUIDE_STEPS: readonly WorkbenchGuideStep[] = [
  { key: "knowledge", icon: "library", zh: "把这个仓库设成知识库", en: "Make this vault your knowledge base", actionZh: "开始设置", actionEn: "Start setup" },
  { key: "avatar", icon: "smile", zh: "给你的助手换个头像、起个名字", en: "Give your assistant a name and avatar", actionZh: "去设置", actionEn: "Settings" },
  { key: "appearance", icon: "palette", zh: "换一套外观看看", en: "Try a different appearance", actionZh: "去看看", actionEn: "Take a look" },
  { key: "journal", icon: "notebook-pen", zh: "帮我开始写今天的日记", en: "Help me start today's journal", actionZh: "开始写", actionEn: "Start writing" },
  { key: "reading", icon: "book-open", zh: "带我精读一篇笔记", en: "Read a note closely with me", actionZh: "选一篇", actionEn: "Choose a note" },
  { key: "english", icon: "languages", zh: "用英文写今天的日记，帮我改错", en: "Write today's diary in English and help me improve it", actionZh: "开始写", actionEn: "Start writing", pro: true },
  { key: "pdf", icon: "file-text", zh: "把一份 PDF 拆成精读笔记", en: "Turn a PDF into close-reading notes", actionZh: "去看看", actionEn: "Take a look", pro: true }
];
/** Steps not yet done or dismissed; the knowledge step yields to the identical setup to-do. */
export function workbenchGuideSteps(settings: CodexForObsidianSettings, todos: readonly WorkbenchSetupTodo[]): WorkbenchGuideStep[] {
  const done = new Set(settings.setup?.onboardingGuideDone ?? []);
  return WORKBENCH_GUIDE_STEPS.filter(step => !done.has(step.key) && !(step.key === "knowledge" && todos.some(item => item.kind === "knowledge")));
}
