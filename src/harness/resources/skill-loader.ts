import { parseVaultSkillDocument, normalizeSkillId, type VaultSkillFrontmatter } from "./skill-document";
export { parseVaultSkillDocument } from "./skill-document";
export type { VaultSkillFrontmatter, ParsedVaultSkillDocument } from "./skill-document";
import { getDesktopCrypto } from "../../platform/desktop-crypto";
import { getDesktopFsPromises } from "../../platform/desktop-filesystem";
import { getDesktopPath } from "../../platform/desktop-paths";

import type { ResourceRef } from "../../resources/types";

const { createHash } = getDesktopCrypto();

const { readdir, readFile, stat } = getDesktopFsPromises();
const path = getDesktopPath();

export interface LoadVaultSkillInput {
  vaultPath: string;
  skillId: string;
  maxBytes: number;
}

export interface VaultSkillFile {
  relativePath: string;
  content: string;
}

export interface LoadedVaultSkill {
  ref: ResourceRef;
  rootPath: string;
  frontmatter: VaultSkillFrontmatter;
  instruction: string;
  files: VaultSkillFile[];
  contentHash: string;
}

export async function loadVaultSkill(input: LoadVaultSkillInput): Promise<LoadedVaultSkill> {
  const skillId = normalizeSkillId(input.skillId);
  const skillRoot = safeJoin(input.vaultPath, ".echoink", "resources", "skills", skillId);
  const entryPath = safeJoin(skillRoot, "SKILL.md");
  const entry = await readLimitedFile(entryPath, input.maxBytes);
  const parsed = parseVaultSkillDocument(entry, skillId);
  const files = await readSupportFiles(skillRoot, input.maxBytes - Buffer.byteLength(entry, "utf8"));
  const hash = createHash("sha256");
  hash.update(entry);
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update(file.content);
  }
  return {
    ref: { plane: "echoink-vault", resourceId: skillId },
    rootPath: skillRoot,
    frontmatter: parsed.frontmatter,
    instruction: parsed.instruction,
    files,
    contentHash: hash.digest("hex")
  };
}

async function readSupportFiles(skillRoot: string, remainingBytes: number): Promise<VaultSkillFile[]> {
  if (remainingBytes <= 0) throw new Error("Skill content exceeds size limit.");
  const files: VaultSkillFile[] = [];
  let budget = remainingBytes;
  for (const dir of ["references", "templates"] as const) {
    const root = safeJoin(skillRoot, dir);
    const found = await listMarkdownFiles(root, dir).catch((error) => {
      if (isMissingFileSystemError(error)) return [];
      throw error;
    });
    for (const relativePath of found) {
      const fullPath = safeJoin(skillRoot, relativePath);
      const content = await readLimitedFile(fullPath, budget);
      budget -= Buffer.byteLength(content, "utf8");
      files.push({ relativePath, content });
    }
  }
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function listMarkdownFiles(root: string, base: string): Promise<string[]> {
  const result: string[] = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const relativePath = `${base}/${entry.name}`;
    const fullPath = safeJoin(path.dirname(root), relativePath);
    if (entry.isDirectory()) {
      const nested = await listMarkdownFiles(fullPath, relativePath);
      result.push(...nested);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) result.push(relativePath);
  }
  return result;
}

async function readLimitedFile(filePath: string, maxBytes: number): Promise<string> {
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error(`Not a file: ${filePath}`);
  if (info.size > maxBytes) throw new Error("Skill content exceeds size limit.");
  return await readFile(filePath, "utf8");
}

function isMissingFileSystemError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function safeJoin(root: string, ...parts: string[]): string {
  const base = path.resolve(root);
  const target = path.resolve(base, ...parts);
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) throw new Error("Path traversal is not allowed.");
  return target;
}
