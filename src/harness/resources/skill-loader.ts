import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import * as path from "node:path";
import type { ResourceRef } from "../contracts/run";

export interface LoadVaultSkillInput {
  vaultPath: string;
  skillId: string;
  maxBytes: number;
}

export interface VaultSkillFrontmatter {
  id: string;
  name: string;
  version: string;
  description: string;
  scopes: string[];
  permissions: string[];
  entry: string;
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
  const parsed = parseSkillDocument(entry);
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
    frontmatter: {
      id: parsed.frontmatter.id || skillId,
      name: parsed.frontmatter.name || skillId,
      version: parsed.frontmatter.version || "",
      description: parsed.frontmatter.description || "",
      scopes: parsed.frontmatter.scopes,
      permissions: parsed.frontmatter.permissions,
      entry: parsed.frontmatter.entry || "instruction"
    },
    instruction: parsed.body,
    files,
    contentHash: hash.digest("hex")
  };
}

function normalizeSkillId(value: string): string {
  const id = value.trim();
  if (!/^[a-zA-Z0-9._-]+$/.test(id) || id.includes("..")) throw new Error("Invalid skill id.");
  return id;
}

async function readSupportFiles(skillRoot: string, remainingBytes: number): Promise<VaultSkillFile[]> {
  if (remainingBytes <= 0) throw new Error("Skill content exceeds size limit.");
  const files: VaultSkillFile[] = [];
  let budget = remainingBytes;
  for (const dir of ["references", "templates"] as const) {
    const root = safeJoin(skillRoot, dir);
    const found = await listMarkdownFiles(root, dir).catch(() => []);
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

function parseSkillDocument(text: string): { frontmatter: VaultSkillFrontmatter; body: string } {
  if (!text.startsWith("---\n")) {
    return { frontmatter: emptyFrontmatter(), body: text.trim() };
  }
  const end = text.indexOf("\n---", 4);
  if (end < 0) return { frontmatter: emptyFrontmatter(), body: text.trim() };
  const rawFrontmatter = text.slice(4, end).trim();
  const body = text.slice(end + "\n---".length).trim();
  return {
    frontmatter: parseFrontmatter(rawFrontmatter),
    body
  };
}

function parseFrontmatter(text: string): VaultSkillFrontmatter {
  const data = emptyFrontmatter();
  const lines = text.split(/\r?\n/);
  let activeList: "scopes" | "permissions" | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const listItem = trimmed.match(/^-\s+(.+)$/);
    if (listItem && activeList) {
      data[activeList].push(stripQuotes(listItem[1].trim()));
      continue;
    }
    activeList = null;
    const match = trimmed.match(/^([a-zA-Z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const key = match[1] as keyof VaultSkillFrontmatter;
    const value = stripQuotes(match[2].trim());
    if (key === "scopes" || key === "permissions") {
      activeList = key;
      if (value) data[key] = parseInlineList(value);
      continue;
    }
    if (key in data && typeof data[key] === "string") {
      (data[key] as string) = value;
    }
  }
  return data;
}

function parseInlineList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1).split(",").map((item) => stripQuotes(item.trim())).filter(Boolean);
  }
  return [stripQuotes(trimmed)];
}

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}

function emptyFrontmatter(): VaultSkillFrontmatter {
  return {
    id: "",
    name: "",
    version: "",
    description: "",
    scopes: [],
    permissions: [],
    entry: ""
  };
}

function safeJoin(root: string, ...parts: string[]): string {
  const base = path.resolve(root);
  const target = path.resolve(base, ...parts);
  if (target !== base && !target.startsWith(`${base}${path.sep}`)) throw new Error("Path traversal is not allowed.");
  return target;
}
