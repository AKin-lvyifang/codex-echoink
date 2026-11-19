import { apiProviderHasUsableCredential, getActiveApiProviderModel, type CodexForObsidianSettings } from "./settings";
import { isEchoInkPiReasoningEffortSupported, normalizeEchoInkReasoningEffort, resolveEchoInkPiReasoningCapabilities } from "./pi-model-catalog";
import type { ReasoningEffort } from "../types/app-server";
import { CAUSE } from "../core/error-copy";

/** Knowledge analysis is checked before it starts; the lead says what did not happen. */
const NOT_STARTED = "知识分析未能开始，本地整理已保留。";

export function resolveKnowledgeMaintenanceSubmitSnapshot(
  settings: Pick<
    CodexForObsidianSettings,
    | "activeApiProviderId"
    | "apiProviders"
    | "defaultModel"
    | "openAICodexCredential"
  >
): Readonly<{
  runtimeProviderId: string;
  modelId: string;
  reasoning: ReasoningEffort;
}> {
  const active = getActiveApiProviderModel(settings);
  if (!active) throw new Error(`${NOT_STARTED}${CAUSE.providerNotConfigured[0]}`);
  if (!active.model.id.trim()) throw new Error(`${NOT_STARTED}所选模型缺少 Model ID。请在 设置 → 模型服务 中补充 Model ID。`);
  if (!active.provider.runtimeProviderId.trim()) throw new Error(`${NOT_STARTED}所选模型服务未设置 API 协议。请在 设置 → 模型服务 中选择“API 协议”。`);
  if (!active.provider.baseUrl.trim()) throw new Error(`${NOT_STARTED}所选模型服务缺少接口地址。请在 设置 → 模型服务 中填写接口地址。`);
  try { const url = new URL(active.provider.baseUrl); if (!["https:", "http:"].includes(url.protocol)) throw new Error(); }
  catch { throw new Error(`${NOT_STARTED}${CAUSE.providerUrlInvalid[0]}`); }
  if (!apiProviderHasUsableCredential(active.provider, settings.openAICodexCredential)) throw new Error(`${NOT_STARTED}${CAUSE.providerAuth[0]}`);
  const capabilities = resolveEchoInkPiReasoningCapabilities(
    active.provider.runtimeProviderId,
    active.model.id,
    active.model
  );
  if (
    !capabilities.supported
    || (capabilities.supportsOff && !active.model.reasoningEnabled)
  ) {
    return Object.freeze({
      runtimeProviderId: active.provider.runtimeProviderId,
      modelId: active.model.id,
      reasoning: "none"
    });
  }
  const stored = normalizeEchoInkReasoningEffort(active.model.reasoningEffort);
  const reasoning = stored && isEchoInkPiReasoningEffortSupported(capabilities, stored)
    ? stored : capabilities.defaultEffort ?? "none";
  return Object.freeze({
    runtimeProviderId: active.provider.runtimeProviderId,
    modelId: active.model.id,
    reasoning
  });
}
