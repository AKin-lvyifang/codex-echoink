import { maintenanceVisibleClassification } from "./maintenance-p2-planning";
import {
  isGeneralKnowledgeWiki,
  isKnowledgeMap,
  knowledgeWikiProperties,
} from "./knowledge-wiki-policy";

export function maintenanceDomainCatalog(documents: readonly { path: string; content: string }[]): {
  domains: { domain: string; count: number }[];
  incompatible: string[];
} {
  const counts = new Map<string, number>(),
    incompatible: string[] = [];
  for (const doc of documents) {
    if (
      !isGeneralKnowledgeWiki(knowledgeWikiProperties(doc.content)) ||
      isKnowledgeMap(doc.path, doc.content)
    )
      continue;
    const visible = maintenanceVisibleClassification(doc.content);
    if (visible.domain) counts.set(visible.domain, (counts.get(visible.domain) ?? 0) + 1);
    else if (visible.domainPresent) incompatible.push(doc.path);
  }
  return {
    domains: [...counts]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([domain, count]) => ({ domain, count })),
    incompatible,
  };
}
