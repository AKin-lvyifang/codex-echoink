import { TFolder, type App } from "obsidian";
import type { KnowledgeFolderBindings } from "../knowledge-base/folder-bindings";
import type { GenerationRuntimePort, GenerationExecutionIdentity } from "../generation/runtime";
import type { GenerationRequest, GenerationResult } from "../generation/types";
import { assertGenerationPathSafe, readGenerationSources } from "../generation/sources";
import { freezeGenerationRequest } from "../generation/request";
import { generationFileStem, prepareGenerationOutput } from "../generation/output";
import type { VaultDomainService } from "../harness/pi-native/vault-domain-service";
import { PI_VAULT_TOOL_POLICIES, PI_VAULT_TOOL_VERSION, PI_VAULT_TOOL_POLICY_VERSION, type PiVaultToolWriteExecutionPort } from "../harness/pi-native/pi-vault-tool-contracts";
import type { PiVaultToolAuthorizationPort } from "../harness/pi-native/pi-vault-tool-security-extension";
import { isWriteToolAuthorizationContext } from "../harness/pi-native/tool-authorization";
export interface GenerationProductionOptions {
  app: App;
  vaultRoot: string;
  bindings(): KnowledgeFolderBindings | null | undefined;
  assertRead(path: string, identity: GenerationExecutionIdentity): Promise<void>;
  assertWrite(path: string, identity: GenerationExecutionIdentity): Promise<void>;
  authorization(identity: GenerationExecutionIdentity): PiVaultToolAuthorizationPort;
  writeExecution: PiVaultToolWriteExecutionPort;
  domain: VaultDomainService;
}
function assertBinding(options: GenerationProductionOptions, request: GenerationRequest): void {
  const binding = options.bindings()?.roles.outputs;
  if (!binding?.enabled || !binding.writePath || !binding.readPaths.includes(binding.writePath)) throw new Error("尚未绑定输出目录，请到设置 › 知识库绑定。");
  if (binding.writePath !== request.outputRoot) throw new Error("输出目录已换绑，请重新打开生成弹窗。");
  if (!(options.app.vault.getAbstractFileByPath(request.outputRoot) instanceof TFolder)) throw new Error("输出目录已失效，请到设置 › 知识库重新绑定。");
}
export function createGenerationRuntimePort(options: GenerationProductionOptions): GenerationRuntimePort {
  return {
    async prepare(raw, identity) {
      const request = freezeGenerationRequest(raw);
      if (identity.access.mode === "plan" || identity.access.permission === "read-only") throw new Error("生成需要 Agent 模式和可写权限。");
      assertBinding(options, request);
      for (const source of request.sourcePaths) await options.assertRead(source, identity);
      const assessment = await readGenerationSources(options.vaultRoot, request.sourcePaths, options.bindings()?.roles.outputs.readPaths ?? [], identity.signal);
      if (assessment.error) throw new Error(assessment.error);
      return assessment;
    },
    async assertContinuation(request, identity) {
      identity.signal.throwIfAborted();
      if (identity.access.mode === "plan" || identity.access.permission === "read-only") throw new Error("生成需要 Agent 模式和可写权限。");
      assertBinding(options, request);
      for (const source of request.sourcePaths) await options.assertRead(source, identity);
      await options.assertWrite(`${request.outputDirectory}/生成成果.${request.outputKind === "canvas" ? "canvas" : "md"}`, identity);
      identity.signal.throwIfAborted();
    },
    async finish(request, assessment, modelText, identity, onStage, attempt) {
      const result: GenerationResult = { requestId: request.id, outputKind: request.outputKind, writeState: "not_written", readFailures: assessment.readFailures, sourcePaths: assessment.sources.map(source => source.path) };
      try {
        if (!modelText || identity.signal.aborted) { result.error = identity.signal.aborted ? "已取消，尚未写入文件。" : "生成未完成，尚未写入文件。"; return result; }
        if (request.outputKind === "canvas") await onStage("layout");
        const { title, content, branchCount, characterCount } = prepareGenerationOutput(request, assessment.sources, modelText, attempt);
        Object.assign(result, { title, ...(branchCount === undefined ? {} : { branchCount }), ...(characterCount === undefined ? {} : { characterCount }) });
        identity.signal.throwIfAborted(); assertBinding(options, request);
        await assertGenerationPathSafe(options.vaultRoot, request.outputRoot);
        await options.assertWrite(`${request.outputDirectory}/生成成果.${request.outputKind === "canvas" ? "canvas" : "md"}`, identity);
        const directory = options.app.vault.getAbstractFileByPath(request.outputDirectory);
        if (directory && !(directory instanceof TFolder)) throw new Error("生成目录被文件占用，尚未写入文件。");
        // The explicit Generate action authorizes only this fixed bound child.
        if (!directory) {
          try { await options.app.vault.createFolder(request.outputDirectory); }
          catch (error) { if (!(options.app.vault.getAbstractFileByPath(request.outputDirectory) instanceof TFolder)) throw error; }
        }
        await assertGenerationPathSafe(options.vaultRoot, request.outputDirectory);
        const stem = generationFileStem(title, request.template.name), extension = request.outputKind === "canvas" ? "canvas" : "md";
        let suffix = 1, target: string;
        do { target = `${request.outputDirectory}/${stem}${suffix === 1 ? "" : ` ${suffix}`}.${extension}`; suffix += 1; } while (options.app.vault.getAbstractFileByPath(target));
        await options.assertWrite(target, identity);
        identity.signal.throwIfAborted(); assertBinding(options, request);
        const args = { relativePath: target, content }, toolCallId = `generation-${request.id}`;
        await onStage("approval");
        const authorization = await options.authorization(identity).authorize({ toolCallId, toolId: "note_create", arguments: args, policy: PI_VAULT_TOOL_POLICIES.note_create, toolVersion: PI_VAULT_TOOL_VERSION, policyVersion: PI_VAULT_TOOL_POLICY_VERSION, signal: identity.signal });
        if (!isWriteToolAuthorizationContext(authorization)) throw new Error("生成写入确认无效，尚未写入文件。");
        identity.signal.throwIfAborted(); assertBinding(options, request);
        await options.assertWrite(target, identity);
        await onStage("saving");
        result.path = target;
        const receipt = await options.writeExecution.execute({ toolCallId, toolId: "note_create", arguments: args, authorization, signal: identity.signal, onVerifying: () => undefined },
          beforeSideEffect => options.domain.noteCreate({ vaultId: identity.vaultId, operationIdentity: authorization.operationIdentity, relativePath: target, content, signal: identity.signal,
            beforeSideEffect: async () => { identity.signal.throwIfAborted(); assertBinding(options, request); await options.assertWrite(target, identity); await beforeSideEffect(); result.writeState = "unconfirmed"; } }));
        result.path = target;
        result.writeState = receipt.status === "completed" && receipt.readbackVerified ? "verified" : receipt.sideEffectStarted && !receipt.readbackVerified ? "unconfirmed" : "not_written";
        if (result.writeState === "not_written") delete result.path;
        if (result.writeState !== "verified") result.error = result.writeState === "unconfirmed" ? "写入结果未确认，请先核对文件，不要重复生成。" : "尚未写入文件。";
        return result;
      } catch (error) {
        if (result.writeState === "not_written") delete result.path;
        result.error = result.writeState === "unconfirmed" ? "写入结果未确认，请先核对文件，不要重复生成。" : identity.signal.aborted ? "已取消，尚未写入文件。" : error instanceof Error ? error.message : "生成失败，尚未写入文件。";
        return result;
      }
    }
  };
}
