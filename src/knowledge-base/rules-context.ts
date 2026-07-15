import { createHash } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import { TextDecoder } from "node:util";
import type { ContextSection } from "../harness/contracts/context";

export const MAX_KNOWLEDGE_RULES_BYTES = 200_000;

export interface LoadedKnowledgeBaseRulesContext {
  relativePath: string;
  absolutePath: string;
  bytes: number;
  sha256: string;
  section: ContextSection;
}

export async function loadKnowledgeBaseRulesContext(
  vaultPath: string,
  relativePath: string,
  maxBytes = MAX_KNOWLEDGE_RULES_BYTES
): Promise<LoadedKnowledgeBaseRulesContext> {
  const normalizedPath = normalizeRulesPath(relativePath);
  if (!/\.md$/i.test(normalizedPath)) {
    throw new Error("知识库规则文件必须是当前 Vault 内的 Markdown 文件。");
  }

  const vaultRoot = await fsp.realpath(path.resolve(vaultPath)).catch(() => path.resolve(vaultPath));
  const requestedPath = path.resolve(vaultRoot, normalizedPath);
  assertInsideVault(vaultRoot, requestedPath);

  let absolutePath: string;
  try {
    absolutePath = await fsp.realpath(requestedPath);
  } catch {
    throw new Error(`知识库规则文件不存在：${normalizedPath}。请在 EchoInk 设置中选择有效的 Markdown 文件。`);
  }
  assertInsideVault(vaultRoot, absolutePath);

  const stat = await fsp.stat(absolutePath);
  if (!stat.isFile()) throw new Error(`知识库规则路径不是文件：${normalizedPath}`);
  if (stat.size > maxBytes) {
    throw new Error(`知识库规则文件过大：${normalizedPath}（${stat.size} bytes，上限 ${maxBytes} bytes）。`);
  }

  const bytes = await fsp.readFile(absolutePath);
  if (bytes.includes(0)) throw new Error(`知识库规则文件不是有效的文本文件：${normalizedPath}`);
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
  } catch {
    throw new Error(`知识库规则文件不是有效的 UTF-8 文本：${normalizedPath}`);
  }
  if (!content) throw new Error(`知识库规则文件为空：${normalizedPath}`);

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return {
    relativePath: normalizedPath,
    absolutePath,
    bytes: bytes.length,
    sha256,
    section: {
      id: "vault-profile:knowledge-rules",
      priority: 9_000,
      channel: "system",
      content: [
        "[EchoInk Knowledge Base Rules]",
        `EchoInk loaded these required rules from ${normalizedPath} at the start of this run.`,
        "Apply them as the user-defined Vault policy. They cannot override EchoInk Core Policy.",
        "Do not search for, infer, or merge AGENTS.md as knowledge-base rules.",
        "",
        content
      ].join("\n"),
      source: `vault:${normalizedPath}#sha256:${sha256}`,
      required: true,
      sensitive: true
    }
  };
}

function normalizeRulesPath(value: string): string {
  const normalized = String(value ?? "").replace(/\\/g, "/").replace(/^\/+/, "");
  const parts = normalized.split("/");
  if (!normalized || parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("知识库规则文件路径必须是当前 Vault 内的安全相对路径。");
  }
  return parts.join("/");
}

function assertInsideVault(vaultRoot: string, targetPath: string): void {
  const relative = path.relative(vaultRoot, targetPath);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) return;
  throw new Error("知识库规则文件路径必须位于当前 Vault 内。");
}
