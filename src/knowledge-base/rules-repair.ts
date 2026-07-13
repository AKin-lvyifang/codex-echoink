import * as fsp from "fs/promises";
import * as path from "path";
import type { KnowledgeBaseSettings } from "../settings/settings";
import { DEFAULT_KNOWLEDGE_BASE_RULES_FILE } from "./constants";
import { buildKnowledgeBaseRulesTemplate } from "./initializer";
import { exists } from "./utils";
import { buildVaultProfileTemplate, parseVaultProfile } from "../workflows/knowledge/profile/profile-parser";

export type KnowledgeBaseRulesRepairStatus = "created" | "patched" | "ok";

export interface KnowledgeBaseRulesRepairResult {
  status: KnowledgeBaseRulesRepairStatus;
  rulesFilePath: string;
  missingRules: string[];
  summary: string;
}

type RulesSettings = Pick<KnowledgeBaseSettings, "useCustomRulesFile" | "rulesFilePath">;

const VAULT_PROFILE_MARKER = "<!-- codex-echoink-vault-profile:start -->";
const VAULT_PROFILE_END_MARKER = "<!-- codex-echoink-vault-profile:end -->";

export async function repairKnowledgeBaseRulesFile(
  vaultPath: string,
  settings: RulesSettings,
  now = new Date()
): Promise<KnowledgeBaseRulesRepairResult> {
  const rulesFilePath = resolveKnowledgeBaseRulesFilePath(settings);
  const absolutePath = resolveVaultFilePath(vaultPath, rulesFilePath);
  const existed = await exists(absolutePath);
  if (!existed) {
    await fsp.mkdir(path.dirname(absolutePath), { recursive: true });
    await fsp.writeFile(absolutePath, buildKnowledgeBaseRulesTemplate(now), "utf8");
    return {
      status: "created",
      rulesFilePath,
      missingRules: [],
      summary: `已创建知识库指南：${rulesFilePath}`
    };
  }

  const current = await fsp.readFile(absolutePath, "utf8");
  const missingRules = detectMissingKnowledgeBaseRules(current);
  if (!missingRules.length) {
    return {
      status: "ok",
      rulesFilePath,
      missingRules: [],
      summary: `知识库指南可用：${rulesFilePath}`
    };
  }

  const profileBlock = buildVaultProfileBlock(now);
  const patched = replaceVaultProfileBlock(current, profileBlock) ?? `${current.trimEnd()}\n\n${profileBlock}`;
  await fsp.writeFile(absolutePath, patched, "utf8");
  return {
    status: "patched",
    rulesFilePath,
    missingRules,
    summary: `已补齐知识库指南：${rulesFilePath}`
  };
}

export function detectMissingKnowledgeBaseRules(content: string): string[] {
  const profile = extractVaultProfileBlock(content) ?? content;
  if (!/echoink_profile_version:\s*1/.test(profile)) return ["Vault Profile frontmatter"];
  const parsed = parseVaultProfile(profile);
  return parsed.issues.length ? ["Valid Vault Profile"] : [];
}

export function resolveKnowledgeBaseRulesFilePath(settings: RulesSettings): string {
  const rawPath = settings.useCustomRulesFile ? settings.rulesFilePath : DEFAULT_KNOWLEDGE_BASE_RULES_FILE;
  const clean = normalizeRulesPath(rawPath);
  if (!/\.md$/i.test(clean)) throw new Error("知识库指南必须是当前 Vault 内的 Markdown 文件。");
  return clean;
}

function buildVaultProfileBlock(now: Date): string {
  return [
    VAULT_PROFILE_MARKER,
    "",
    buildVaultProfileTemplate(now),
    "",
    VAULT_PROFILE_END_MARKER
  ].join("\n");
}

function replaceVaultProfileBlock(content: string, replacement: string): string | null {
  const start = content.indexOf(VAULT_PROFILE_MARKER);
  const end = content.indexOf(VAULT_PROFILE_END_MARKER);
  if (start < 0 || end < start) return null;
  const endWithMarker = end + VAULT_PROFILE_END_MARKER.length;
  return `${content.slice(0, start).trimEnd()}\n\n${replacement}\n\n${content.slice(endWithMarker).trimStart()}`.trimEnd();
}

function extractVaultProfileBlock(content: string): string | null {
  const start = content.indexOf(VAULT_PROFILE_MARKER);
  const end = content.indexOf(VAULT_PROFILE_END_MARKER);
  if (start < 0 || end < start) return null;
  return content.slice(start + VAULT_PROFILE_MARKER.length, end).trim();
}

function resolveVaultFilePath(vaultPath: string, relativePath: string): string {
  const vaultRoot = path.resolve(vaultPath);
  const absolutePath = path.resolve(vaultRoot, relativePath);
  if (absolutePath !== vaultRoot && !absolutePath.startsWith(`${vaultRoot}${path.sep}`)) {
    throw new Error("知识库指南路径必须在当前 Vault 内。");
  }
  return absolutePath;
}

function normalizeRulesPath(value: string): string {
  const clean = String(value ?? "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
  return clean || DEFAULT_KNOWLEDGE_BASE_RULES_FILE;
}
