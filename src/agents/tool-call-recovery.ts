import type { ApiProviderConfig } from "../settings/settings";
import { toolCallTextFailureMessage, type ToolCallTextFailureCode } from "../harness/tool-call-text";

export interface ToolCallFailureInfo {
  readonly toolCallTextFailure?: ToolCallTextFailureCode;
  readonly providerSettingsId?: string;
  readonly modelId?: string;
}
export interface ToolCallRecoveryTarget { providerSettingsId: string; modelId: string }
export type ToolCallRecoverySurface = "desktop" | "iphone" | "ipad";
export const TOOL_CALL_RESUME_PROMPT = "上一轮的工具调用只是文字，没有真正执行。请用可用的工具重新执行需要的操作。";

/** Old records retain their diagnosis without inventing a provider identity. */
export function toolCallFailureInfo(record?: ToolCallFailureInfo, legacyCode?: unknown): ToolCallFailureInfo {
  const code = record?.toolCallTextFailure ?? legacyCode;
  if (!toolCallTextFailureMessage(code)) return {};
  return { toolCallTextFailure: code as ToolCallTextFailureCode,
    ...(record?.providerSettingsId ? { providerSettingsId: record.providerSettingsId } : {}),
    ...(record?.modelId ? { modelId: record.modelId } : {}) };
}

export function toolCallingSettingsPath(surface: ToolCallRecoverySurface, providerName = "对应服务", modelName = "对应模型"): string {
  return `设置 → 模型 → 模型服务 → ${providerName} → 参数 → ${modelName} → ${surface === "iphone" ? "支持工具调用" : "工具调用"}`;
}
export function toolCallingDisabledMessage(surface: ToolCallRecoverySurface, providerName?: string, modelName?: string): string {
  return `当前模型未开启工具调用，无法执行。请到 ${toolCallingSettingsPath(surface, providerName, modelName)} 开启。`;
}

/** A duplicate ID or a removed model is not a safe one-click target. Explicit composer choices are retained. */
export function toolCallRecoveryTarget(info: ToolCallFailureInfo | undefined, providers: readonly ApiProviderConfig[], selected?: ToolCallRecoveryTarget): ToolCallRecoveryTarget | undefined {
  if (!info?.toolCallTextFailure || !info.providerSettingsId || !info.modelId) return;
  const target = selected ?? { providerSettingsId: info.providerSettingsId, modelId: info.modelId };
  const matches = providers.filter(provider => provider.id === target.providerSettingsId);
  if (matches.length !== 1 || matches[0].models.filter(model => model.id === target.modelId).length !== 1) return;
  return target;
}

/** Patch only these two fields; the caller owns its existing save/rollback transaction. */
export function enableTargetToolCalling(providers: readonly ApiProviderConfig[], target: ToolCallRecoveryTarget): void {
  const provider = providers.find(provider => provider.id === target.providerSettingsId);
  const model = provider?.models.find(model => model.id === target.modelId);
  if (!model) throw new Error("任务所用模型已不存在，请先检查模型服务设置。");
  model.toolCalling = true;
  model.capabilityOverrides = { ...model.capabilityOverrides, toolCalling: true };
}

export function toolCallRecoveryGuidance(info: ToolCallFailureInfo | undefined, providers: readonly ApiProviderConfig[], surface: ToolCallRecoverySurface, selected?: ToolCallRecoveryTarget) {
  const code = info?.toolCallTextFailure;
  if (!code) return undefined;
  const target = toolCallRecoveryTarget(info, providers, selected);
  const provider = providers.find(provider => provider.id === target?.providerSettingsId);
  const model = provider?.models.find(model => model.id === target?.modelId);
  const enable = !!model && !model.toolCalling;
  let message = toolCallTextFailureMessage(code)!;
  if (!target) message = code === "model_tool_call_text_disabled"
    ? `模型把工具调用写成了文字，本轮没有执行工具。请到 ${toolCallingSettingsPath(surface)} 开启工具调用。`
    : `模型返回了工具调用文本，本轮没有执行工具。请检查代理接口的工具调用兼容性，或到 ${toolCallingSettingsPath(surface)} 检查或更换模型。`;
  else if (code === "model_tool_call_text_disabled" && !enable) message = "模型把工具调用写成了文字，本轮没有执行工具。";
  return { target, enable, message, buttonLabel: enable ? "开启工具调用并继续" : "继续" };
}
