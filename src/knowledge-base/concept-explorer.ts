import type { KnowledgeAgentReadResult, KnowledgeAgentSearchHit } from "./knowledge-agent-index";
import type { KnowledgeRelationPage } from "./knowledge-relations";
import { readToolResult, toolResultForProvider } from "../harness/pi-native/pi-knowledge-read-tools";
import type { PiKnowledgeReference } from "../harness/pi-native/contracts";

export interface ConceptExplorerPort {
  /** Exact title/alias matches, already limited to the current Knowledge scope. */
  candidates(name: string): Promise<readonly string[]>;
  read(input: { vaultRelativePath: string; expectedContentRevision?: string }): Promise<KnowledgeAgentReadResult>;
  related(input: { vaultRelativePath: string; limit?: number; cursor?: string }): Promise<KnowledgeRelationPage>;
}
export interface ExploreConceptArguments { name: string; vaultRelativePath?: string; cursor?: string; candidateOffset?: number }
export interface ConceptExploration {
  data: Record<string, unknown>;
  references: readonly PiKnowledgeReference[];
  sources: readonly Pick<KnowledgeAgentSearchHit, "vaultRelativePath" | "contentRevision">[];
}

export function normalizeExploreConceptArguments(value: unknown): ExploreConceptArguments {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("invalid_arguments");
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !["name", "vaultRelativePath", "cursor", "candidateOffset"].includes(key))
    || typeof input.name !== "string" || !input.name.trim() || input.name.length > 256
    || input.vaultRelativePath !== undefined && (typeof input.vaultRelativePath !== "string" || input.vaultRelativePath.length > 1024)
    || input.cursor !== undefined && (typeof input.cursor !== "string" || input.cursor.length > 4096)
    || input.candidateOffset !== undefined && (!Number.isSafeInteger(input.candidateOffset) || Number(input.candidateOffset) < 0)) throw new TypeError("invalid_arguments");
  return { name: input.name.trim(), ...(input.vaultRelativePath === undefined ? {} : { vaultRelativePath: input.vaultRelativePath }),
    ...(input.cursor === undefined ? {} : { cursor: input.cursor }), ...(input.candidateOffset === undefined ? {} : { candidateOffset: input.candidateOffset as number }) };
}

/** Shared by external MCP and the in-app Agent; neither borrows a chat tool authorization. */
export async function exploreConcept(port: ConceptExplorerPort, input: ExploreConceptArguments): Promise<ConceptExploration> {
  const paths = [...new Set(await port.candidates(input.name))].sort();
  if (!paths.length) return { data: { status: "unresolved", message: "本次概念检索未找到，请用 search_knowledge 或 knowledge_search 补充搜索。" }, sources: [], references: [] };
  if (input.vaultRelativePath && !paths.includes(input.vaultRelativePath)) throw Object.assign(new Error("Concept selection changed"), { code: "source_changed" });
  if (!input.vaultRelativePath && paths.length > 1) {
    const offset = input.candidateOffset ?? 0;
    const candidates = await Promise.all(paths.slice(offset, offset + 12).map(async vaultRelativePath => {
      const note = await port.read({ vaultRelativePath });
      return { vaultRelativePath, title: note.title, contentRevision: note.contentRevision };
    }));
    return { data: { status: "ambiguous", candidates, total: paths.length, hasMore: offset + candidates.length < paths.length,
      ...(offset + candidates.length < paths.length ? { nextCandidateOffset: offset + candidates.length } : {}) }, sources: candidates, references: [] };
  }
  const vaultRelativePath = input.vaultRelativePath ?? paths[0];
  const snapshot = await port.read({ vaultRelativePath });
  const related = await port.related({ vaultRelativePath, limit: 6, cursor: input.cursor });
  if (related.contentRevision !== snapshot.contentRevision) throw Object.assign(new Error("Concept source changed"), { code: "source_changed" });
  const read = readToolResult({ ...snapshot, related }, { vaultRelativePath, expectedContentRevision: snapshot.contentRevision, lineCount: 40 });
  return { data: { status: "available", note: toolResultForProvider(read), related: read.related, rawSources: read.rawSources,
    linkMeaning: "链接只是阅读线索，不代表观点一致。" }, references: [read.reference], sources: [{ vaultRelativePath, contentRevision: snapshot.contentRevision }] };
}
