import { knowledgeFolderBindingPrompt, knowledgeFolderConflicts, knowledgeOrganizationSettings, type KnowledgeFolderBindings } from "./folder-bindings";
import { DESKTOP_KNOWLEDGE_ROOT_ROLES } from "./root-paths-core";

export type KnowledgeWikiWriteIssue = "knowledge_directory_unbound" | "knowledge_directory_invalid" | "knowledge_directory_conflict";

export function knowledgeWikiWriteIssue(config: KnowledgeFolderBindings | null | undefined, exists: (path: string) => boolean = () => true): KnowledgeWikiWriteIssue | null {
  const wiki = config?.roles.wiki;
  if (!config || !wiki?.enabled || !wiki.writePath || !wiki.readPaths.includes(wiki.writePath)) return "knowledge_directory_unbound";
  if (config.migrationIssues.some(issue => issue.startsWith("wiki：")) || !exists(wiki.writePath)) return "knowledge_directory_invalid";
  if (knowledgeFolderConflicts(config).some(conflict => conflict.roles.includes("wiki") && conflict.path === wiki.writePath)) return "knowledge_directory_conflict";
  return null;
}

/** Used only to pause a requested Knowledge write, never to reroute ordinary questions. */
export function requestsKnowledgeWrite(text: string): boolean {
  return /^\s*\/maintain\b/u.test(text)
    || /(?:整理|提炼|建立|搭建|构建|创建|更新|写入|保存|归纳|沉淀)[^。！？\n]{0,40}(?:资料|知识库|知识成果|wiki)/iu.test(text)
    || /(?:知识库|知识成果|wiki)[^。！？\n]{0,30}(?:整理|提炼|建立|搭建|创建|更新|写入|保存)/iu.test(text)
    || /\b(?:organize|build|create|update|write|save|extract)\b[^.!?\n]{0,60}\b(?:knowledge\s*base|wiki|sources|materials)\b/iu.test(text);
}

export function knowledgeWriteContextPrompt(config: KnowledgeFolderBindings | null | undefined, issue: KnowledgeWikiWriteIssue | null): string {
  const bindings = config ? knowledgeFolderBindingPrompt(config, DESKTOP_KNOWLEDGE_ROOT_ROLES) : "尚未配置知识库目录。";
  if (issue) {
    const reason = issue === "knowledge_directory_conflict" ? "知识成果文件夹同时绑定了其他用途，需要重新选择。这里的冲突是插件用途重叠，与文件所有权或其他人的知识库无关。"
      : issue === "knowledge_directory_invalid" ? "知识成果文件夹不存在或已经失效，需要重新选择。" : "还没有选择知识成果文件夹。";
    return `${bindings}\n知识成果目录检查：${issue}。${reason}本轮若要整理资料、建立知识库或写入知识成果，一次写入都不要尝试，不调用任何替代写工具。只用一两句说明这个目录问题，请用户点击回答下方的“去设置目录”，在设置 → 知识库选择文件夹，设置好后再继续。此时不盘点资料、不列计划，不猜测覆盖风险或权限问题。不要要求重复授权，也不要编造目录。普通只读问题仍可回答。`;
  }
  const policy = knowledgeOrganizationSettings(config);
  return `${bindings}\n整理资料与写入知识成果时，直接使用以上 wiki 默认写入位置 ${JSON.stringify(config?.roles.wiki.writePath)}；raw/inbox 是来源，不把用途名当作真实路径，不在绑定范围外另建目录。分类开关：${policy.enabled ? "开启" : "关闭"}；分类范围：${policy.scope === "all" ? "已绑定且归属唯一的根目录之内" : JSON.stringify(policy.paths)}。开工前先检索已有知识；已有成果只补缺，不重复创建。目录关闭分类时仍可保存到已有文件夹，不能新建分类。未成功写入成果前不要把原文标记为已提炼。`;
}
