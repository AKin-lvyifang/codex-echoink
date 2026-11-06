import {
  patchKnowledgeProperties,
  readMaintenanceFrontmatterProperty,
} from "./maintenance-source-frontmatter";

export const KNOWLEDGE_PAIR_DECISIONS = ["不是重复", "并列保留"] as const;
export type KnowledgePairDecision = (typeof KNOWLEDGE_PAIR_DECISIONS)[number];

export function knowledgePairDecisionLinks(
  content: string,
  field: KnowledgePairDecision,
): string[] {
  const value = readMaintenanceFrontmatterProperty(content, field);
  if (
    value.error ||
    (value.present &&
      (!Array.isArray(value.value) ||
        value.value.some((item) => typeof item !== "string")))
  )
    throw new Error(`${field}属性不是文本列表，原值保留。`);
  return (value.value as string[] | undefined) ?? [];
}

export function appendKnowledgePairDecision(
  content: string,
  field: KnowledgePairDecision,
  target: string,
): string {
  return patchKnowledgeProperties(content, {
    [field]: [
      ...new Set([
        ...knowledgePairDecisionLinks(content, field),
        `[[${target.replace(/\.md$/u, "")}]]`,
      ]),
    ],
  });
}

export function knowledgeDecisionPaths(
  content: string,
  field: KnowledgePairDecision,
  resolve: (link: string) => { path: string } | null,
): string[] {
  const value = readMaintenanceFrontmatterProperty(content, field).value;
  return (Array.isArray(value) ? value : []).flatMap((item) => {
    const raw =
      typeof item === "string" &&
      /^\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/u.exec(item)?.[1];
    const target = raw && resolve(raw);
    return target ? [target.path] : [];
  });
}
