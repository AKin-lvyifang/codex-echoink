import { apiProviderHasUsableCredential, getActiveApiProviderModel, type CodexForObsidianSettings } from "./settings";
import { isEchoInkPiReasoningEffortSupported, normalizeEchoInkReasoningEffort, resolveEchoInkPiReasoningCapabilities } from "./pi-model-catalog";
import type { ReasoningEffort } from "../types/app-server";

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
  if (!active) throw new Error("准备知识分析：缺少已选择的模型；本地整理保留，选择模型后继续。");
  if (!active.model.id.trim()) throw new Error("准备知识分析：缺少模型 ID。");
  if (!active.provider.runtimeProviderId.trim()) throw new Error("准备知识分析：缺少 Provider 连接类型。");
  if (!active.provider.baseUrl.trim()) throw new Error("准备知识分析：缺少 API 地址。");
  try { const url = new URL(active.provider.baseUrl); if (!["https:", "http:"].includes(url.protocol)) throw new Error(); }
  catch { throw new Error("准备知识分析：API 地址无效，请检查连接设置。"); }
  if (!apiProviderHasUsableCredential(active.provider, settings.openAICodexCredential)) throw new Error("准备知识分析：缺少此 Provider 所需的登录或 API Key。");
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
