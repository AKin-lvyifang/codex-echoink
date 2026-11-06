import { readMaintenanceFrontmatterProperty } from "./maintenance-source-frontmatter";

export interface KnowledgeWikiProperties {
  merged: boolean;
  specialized: boolean;
}

/** Presence, including an empty marker, excludes a merged page; malformed YAML remains readable. */
export function knowledgeWikiProperties(content: string): KnowledgeWikiProperties {
  const merged = readMaintenanceFrontmatterProperty(content, "已合并到");
  const specialized = readMaintenanceFrontmatterProperty(content, "echoink-english-diary");
  return {
    merged: merged.present && !merged.error,
    specialized: specialized.present && !specialized.error,
  };
}

/** Shared by filesystem and Obsidian search, maintenance, maps and health. Opening a note remains allowed. */
export function isActiveKnowledgeWiki(properties: KnowledgeWikiProperties): boolean {
  return !properties.merged;
}
export function isGeneralKnowledgeWiki(properties: KnowledgeWikiProperties): boolean {
  return isActiveKnowledgeWiki(properties) && !properties.specialized;
}
export function isKnowledgeMap(path: string, content = ""): boolean {
  return (
    /(?:^|\/)(?:index|.+索引)\.(?:md|markdown)$/iu.test(path) ||
    content.includes("<!-- echoink-domain-map:BEGIN")
  );
}

export function knowledgeWikiPropertiesFromMetadata(
  frontmatter: Record<string, unknown> | undefined,
): KnowledgeWikiProperties {
  return {
    merged: !!frontmatter && Object.hasOwn(frontmatter, "已合并到"),
    specialized: !!frontmatter && Object.hasOwn(frontmatter, "echoink-english-diary"),
  };
}
