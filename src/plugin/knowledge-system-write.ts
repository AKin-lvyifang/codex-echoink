import type CodexForObsidianPlugin from "../main";
import type { KnowledgeSystemTask } from "../knowledge-base/knowledge-system-task";
import { knowledgeSystemHash } from "../knowledge-base/knowledge-system-task";
import { domainMapBlock } from "../knowledge-base/maintenance-tree-map";
import { VaultDomainService } from "../harness/pi-native/vault-domain-service";
import { ObsidianVaultDomainAdapter } from "./obsidian-vault-domain-adapter";
import {
  createOperationIdentity,
  confirmAndConsumeApprovalTicket,
  type ApprovalOperationContract,
} from "../harness/pi-native/tool-authorization";
import { TFile } from "obsidian";

export async function writeKnowledgeSystemMap(
  plugin: CodexForObsidianPlugin,
  task: KnowledgeSystemTask,
  signal: AbortSignal,
): Promise<void> {
  const root = plugin.getVaultPath();
  const read = async (path: string) => {
    const file = plugin.app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? plugin.app.vault.read(file) : null;
  };

  const write = task.write!,
    data = await plugin.getKnowledgeUpgradeLocalData(),
    entry = await data.catalog.get(task.conversationId);
  if (!entry || !task.approved) throw new Error("确认绑定暂不可用。");
  const choice = task.proposal!.choices[task.approved.framework];
  const afterBlock = task.approved.move ? choice.move!.afterBlock : choice.afterBlock;
  const vaultId = data.deviceScope.vaultIdDigest,
    domain = new VaultDomainService(new ObsidianVaultDomainAdapter(plugin.app, vaultId, root));
  const beforeVersion = write.before === null ? null : knowledgeSystemHash(write.before),
    afterVersion = knowledgeSystemHash(write.after);
  const contract: ApprovalOperationContract = {
    productRunId: task.id,
    conversationId: task.conversationId,
    piSessionId: entry.piSessionId,
    toolCallId: write.operationId,
    userId: `local-${data.deviceScope.deviceIdDigest}`,
    deviceId: data.deviceScope.deviceIdDigest,
    vaultId,
    toolId: write.before === null ? "note_create" : "note_update",
    toolVersion: "1",
    policyVersion: "echoink-knowledge-system-v1",
    normalizedArguments: {
      relativePath: write.path,
      expectedVersion: beforeVersion,
      contentSha256: afterVersion,
    },
    resolvedTarget: { relativePath: write.path },
    targetVersion: { beforeVersion, expectedAfterSha256: afterVersion },
    preview: {
      ...task.approved,
      operations: task.approved.move ? choice.move!.operations : choice.operations,
    },
  };
  const identity = createOperationIdentity(contract),
    inspection = await data.receipts.inspectRecovery(identity);
  if (inspection.state === "receipt_present") {
    if (inspection.receipt.status === "completed" && inspection.receipt.readback.readbackVerified)
      return;
    throw new Error("这次写入尚未核对，请保留地图后重试。");
  }
  if (inspection.state === "readback_required") {
    const receipt = await data.receipts.recoverMissingReceipt(identity, async () => {
      const current = await read(write.path),
        verified = current !== null && domainMapBlock(current, task.domain) === afterBlock;
      return {
        status: verified ? "completed" : "uncertain",
        safeSummary: "梳理地图恢复核对",
        readback: {
          checkedAt: Date.now(),
          readbackVerified: verified,
          observedTargetVersion: current === null ? null : knowledgeSystemHash(current),
          safeSummary: "只核对已批准的领域区块",
        },
      };
    });
    if (receipt.status === "completed") return;
    throw new Error("地图有了新修改，请核对后重新梳理。");
  }
  if (inspection.state === "not_found") {
    const authorization = await confirmAndConsumeApprovalTicket({
      approvals: data.approvals,
      contract,
      signal,
      confirm: async () =>
        task.approved?.proposalVersion === task.proposalVersion && !signal.aborted,
    });
    await data.receipts.beginAuthorizedOperation(authorization);
  }
  const common = {
    vaultId,
    operationIdentity: identity,
    relativePath: write.path,
    content: write.after,
    signal,
    beforeSideEffect: async () => {
      await data.receipts.markEffectStarted(identity);
    },
  };
  const result =
    beforeVersion === null
      ? await domain.noteCreate(common)
      : await domain.noteUpdate({ ...common, expectedVersion: beforeVersion });
  if (result.sideEffectStarted) await data.receipts.markEffectCompleted(identity);
  await data.receipts.persistReceipt({
    operationIdentity: identity,
    status: result.status,
    safeSummary: "梳理知识地图",
    readback: {
      checkedAt: Date.now(),
      readbackVerified: result.readbackVerified,
      observedTargetVersion: result.readback.source.snapshot?.version ?? null,
      safeSummary: "地图写入后核对",
    },
  });
  if (result.status !== "completed" || !result.readbackVerified)
    throw new Error("地图未完成写入，原内容保留，请核对后继续。");
}
