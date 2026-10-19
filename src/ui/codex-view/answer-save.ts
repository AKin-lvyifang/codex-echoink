import { TFolder, type Vault } from "obsidian";
import { normalizeKnowledgeDirectory, type KnowledgeFolderBindings } from "../../knowledge-base/folder-bindings";

export type AnswerSaveVault = Pick<Vault, "getAbstractFileByPath" | "createFolder" | "create">;

export interface AnswerSaveInput {
  folderBindings: KnowledgeFolderBindings | null | undefined;
  question: string;
  answerMarkdown: string;
  conversationId: string;
  conversationTitle?: string;
  sourcePaths: readonly string[];
  savedAt?: Date;
}

// Serialize manual saves in this Vault so simultaneous answers cannot claim the same name.
const pendingSaves = new WeakMap<AnswerSaveVault, Promise<unknown>>();

/** A user action, independent of Agent permissions or Provider/model availability. */
export async function saveAnswerAsNote(vault: AnswerSaveVault, input: AnswerSaveInput): Promise<string> {
  const previous = pendingSaves.get(vault) ?? Promise.resolve();
  const pending = previous.catch(() => undefined).then(() => createAnswerNote(vault, input));
  pendingSaves.set(vault, pending);
  try {
    return await pending;
  } finally {
    if (pendingSaves.get(vault) === pending) pendingSaves.delete(vault);
  }
}

function outputDirectory(vault: AnswerSaveVault, bindings: AnswerSaveInput["folderBindings"]): string {
  const output = bindings?.roles.outputs;
  if (!output?.enabled || !output.writePath || !output.readPaths.includes(output.writePath)) {
    throw new Error("尚未绑定输出目录，请到设置 › 知识库绑定。");
  }
  try {
    if (normalizeKnowledgeDirectory(output.writePath) !== output.writePath) throw new Error("invalid path");
  } catch {
    throw new Error("输出目录绑定无效，请到设置 › 知识库重新绑定。");
  }
  if (!(vault.getAbstractFileByPath(output.writePath) instanceof TFolder)) {
    throw new Error("输出目录已失效，请到设置 › 知识库重新绑定。");
  }
  return output.writePath;
}

function answerFileName(question: string): string {
  const name = Array.from(question).slice(0, 24).join("")
    .replace(/[\p{P}\p{C}<>|]/gu, "").replace(/\s+/gu, " ").trim() || "对话摘录";
  return /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(name) ? `摘录 ${name}` : name;
}

function sourceLinks(paths: readonly string[]): string[] {
  return [...new Set(paths)].map(path => {
    try {
      if (normalizeKnowledgeDirectory(path) !== path) throw new Error("invalid path");
    } catch {
      throw new Error("来源笔记路径无效，未保存笔记。");
    }
    if (/[#^|\[\]]/u.test(path)) {
      throw new Error(`来源路径含有无法用于 Obsidian 双链的字符，请先重命名来源笔记或文件夹：${path}`);
    }
    // Wikilinks resolve literal Vault paths; URI encoding would point at a different file.
    return `[[${path}]]`;
  });
}

function noteMarkdown(input: AnswerSaveInput): string {
  const links = sourceLinks(input.sourcePaths);
  const title = input.conversationTitle?.trim();
  const conversation = title && title !== input.conversationId ? `${title} (${input.conversationId})` : input.conversationId;
  const properties = [
    "---",
    `类型: ${JSON.stringify("摘录")}`,
    `提问: ${JSON.stringify(input.question)}`,
    `来源对话: ${JSON.stringify(conversation)}`,
    links.length ? `来源:\n${links.map(link => `  - ${JSON.stringify(link)}`).join("\n")}` : "来源: []",
    `保存时间: ${JSON.stringify((input.savedAt ?? new Date()).toISOString())}`,
    "---"
  ].join("\n");
  return `${properties}\n\n${input.answerMarkdown}\n\n## 来源\n${links.map(link => `- ${link}\n`).join("")}`;
}

function isNameCollision(error: unknown): boolean {
  return /already exists|EEXIST|已存在/iu.test(String(error));
}

async function createAnswerNote(vault: AnswerSaveVault, input: AnswerSaveInput): Promise<string> {
  const output = outputDirectory(vault, input.folderBindings);
  const markdown = noteMarkdown(input);
  const directory = `${output}/摘录`;
  const existing = vault.getAbstractFileByPath(directory);
  if (existing && !(existing instanceof TFolder)) throw new Error("摘录路径已被文件占用，未保存笔记。");
  if (!existing) {
    try {
      await vault.createFolder(directory);
    } catch (error) {
      // Another native user action may have created this child folder meanwhile.
      if (!isNameCollision(error) || !(vault.getAbstractFileByPath(directory) instanceof TFolder)) throw error;
    }
  }
  const name = answerFileName(input.question);
  for (let suffix = 1; ; suffix += 1) {
    const path = `${directory}/${name}${suffix === 1 ? "" : ` ${suffix}`}.md`;
    if (vault.getAbstractFileByPath(path)) continue;
    try {
      // Vault.create rejects existing files; never use modify or adapter.write here.
      return (await vault.create(path, markdown)).path;
    } catch (error) {
      if (!isNameCollision(error) || !vault.getAbstractFileByPath(path)) throw error;
    }
  }
}
