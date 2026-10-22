import assert from "node:assert/strict";
import type { PiKnowledgeMaintenanceToolInput, PiKnowledgeMaintenanceToolResult } from "../harness/pi-native/contracts";
import type { VaultDomainService } from "../harness/pi-native/vault-domain-service";
import { ProductionPiKnowledgeMaintenanceToolPort, readPrivateMaintenanceRecords } from "../plugin/pi-knowledge-maintenance-production";
import { createMaintenanceSectionSnapshot } from "../knowledge-base/maintenance-section-patch";

/** Translate old fixture data into actual staged tool calls; no legacy production bypass. */
export async function executeStagedMaintenanceFixture(port: ProductionPiKnowledgeMaintenanceToolPort, domain: VaultDomainService, input: Readonly<PiKnowledgeMaintenanceToolInput>, pageSources?: readonly (readonly string[])[]): Promise<PiKnowledgeMaintenanceToolResult> {
  const sources = [...input.sourcePaths ?? []];
  const actions = input.candidateActions ?? [];
  const sourceBodyFingerprints: Record<string, string> = {}, observedTargetRevisions: Record<string, string> = {}, originals = new Map<string, string>();
  for (const relativePath of sources) sourceBodyFingerprints[relativePath] = (await domain.noteRead({ vaultId: input.vaultId, relativePath })).snapshot.bodyFingerprint!;
  for (const action of actions) if (action.expectedTarget.kind === "file") {
    const read = await domain.noteRead({ vaultId: input.vaultId, relativePath: action.targetPath });
    observedTargetRevisions[action.targetPath] = `sha256:${read.snapshot.contentSha256}`; originals.set(action.targetPath, read.snapshot.content);
  }
  const base = { ...input, candidateActions: undefined, sourceBodyFingerprints, observedTargetRevisions };
  let result = await port.execute({ ...base, p1: { stage: "decompose", decompositions: sources.map(sourcePath => ({ sourcePath, summary: `Synthetic fixture: ${sourcePath}`, units: actions.some((_, index) => (pageSources?.[index] ?? sources).includes(sourcePath)) ? ["Fixture knowledge point"] : [] })) } });
  if (result.status === "failed" || result.maintenanceStage === "completed") return result;
  result = await port.execute({ ...base, toolCallId: `${input.toolCallId}:plan`, p1: { stage: "plan", writingPlan: actions.map((action, index) => ({ id: `page-${index}`, targetPath: action.targetPath, expectedTarget: action.expectedTarget, sourcePaths: pageSources?.[index] ?? sources })) } });
  if (result.status === "failed") return result;
  let failure: PiKnowledgeMaintenanceToolResult | undefined;
  for (const [index, action] of actions.entries()) {
    const before = originals.get(action.targetPath);
    if (before === undefined) result = await port.execute({ ...base, toolCallId: `${input.toolCallId}:write:${index}`, p1: { stage: "write", pageId: `page-${index}`, content: action.content } });
    else {
      result = await port.execute({ ...base, toolCallId: `${input.toolCallId}:sections:${index}`, p1: { stage: "sections", targetPath: action.targetPath } });
      if (result.status === "failed") { failure ??= result; continue; }
      const snapshot = createMaintenanceSectionSnapshot(before), desired = createMaintenanceSectionSnapshot(action.content);
      assert.equal(desired.regions.length, snapshot.regions.length, "legacy fixture updates may not add/remove headings through a section replacement");
      assert.equal(before.slice(0, snapshot.regions[0]?.start ?? before.length), action.content.slice(0, desired.regions[0]?.start ?? action.content.length), "fixture updates retain frontmatter bytes");
      const sectionPatches = snapshot.regions.flatMap((region, index) => {
        const next = desired.regions[index];
        assert.equal(before.slice(region.start, region.contentStart), action.content.slice(next.start, next.contentStart), "fixture updates retain heading bytes");
        const content = action.content.slice(next.contentStart, next.end);
        return content === before.slice(region.contentStart, region.end) ? [] : [{ regionId: region.id, operation: "replace" as const, content }];
      });
      assert.ok(sectionPatches.length, "the fixture must contain an actual regional change");
      result = await port.execute({ ...base, toolCallId: `${input.toolCallId}:write:${index}`, p1: { stage: "write", pageId: `page-${index}`, sectionPatches } });
    }
    if (result.status === "failed") failure ??= result;
  }
  if (failure) {
    const record = (await readPrivateMaintenanceRecords(port.state.rootPath)).find(record => record.originConversationId === input.conversationId && record.p1?.phase !== "completed");
    return { ...failure, ...(record ? { recordId: record.recordId, maintenanceResult: record.result, producedPaths: Object.values(record.p1!.committedPages).map(page => page.path) } : {}) };
  }
  return result;
}
