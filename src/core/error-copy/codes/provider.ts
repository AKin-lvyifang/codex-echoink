import { CAUSE } from "../causes";
import type { ErrorCopy } from "../types";

const OUTPUT_LIMIT_REACHED: ErrorCopy = [
  "回答已达到单次输出上限，未能完整生成。请发送“继续”接着生成，或在 设置 → 模型服务 中调高该模型的“单次输出上限”。",
  "The answer reached the request output limit and was not finished. Send “Continue” to resume, or raise this model's “Request output limit” in Settings → Model services."
];

/** The model service could not take the document as a file, and its extracted text is too long. */
export const DOCUMENT_FALLBACK_TOO_LONG: ErrorCopy = [
  "该模型服务不支持直接读取文档，改用文档文字后内容超出了该模型的处理上限，消息未发送。请减少文档、新建会话，或更换处理上限更高的模型。",
  "This model service cannot read the document directly, and the document text exceeds what the model can process, so the message was not sent. Remove some documents, start a new conversation, or choose a model with a higher limit."
];

const AGENT_MISSING: ErrorCopy = ["负责该任务的 Agent 已不存在。请选择其他 Agent 后重新发起。", "The assigned Agent no longer exists. Choose another Agent and start again."];

/** Model-service failure codes (provider_*, tool-call, agent capability) → sentence. Owned by the chat/model-service area. */
export const PROVIDER_CODES: Readonly<Record<string, ErrorCopy>> = {
  // Credentials and sign-in
  provider_auth_failed: CAUSE.providerAuth,
  provider_api_key_missing: CAUSE.providerAuth,
  provider_oauth_relogin_required: CAUSE.providerLoginExpired,
  provider_account_login_required: CAUSE.signInRequired,
  // Model
  provider_model_invalid: CAUSE.providerModelUnavailable,
  provider_model_unavailable: CAUSE.providerModelUnavailable,
  // Conversation length
  context_length_exceeded: CAUSE.contextTooLong,
  provider_partial_interrupted_context: CAUSE.contextTooLong,
  provider_history_compaction_failed: [
    "对话太长，暂时没能压缩，请稍后重试或新开对话。",
    "The conversation is too long and could not be condensed. Try again later or start a new conversation."
  ],
  provider_history_still_too_long: [
    "对话压缩后仍太长，请新开对话或缩短本次输入。",
    "The conversation is still too long after condensing. Start a new conversation or shorten your message."
  ],
  // Quota and availability
  provider_plan_subscription_required: [
    "当前账号未开通该模型服务的套餐，或套餐已到期。请在服务商后台确认订阅状态后重试。",
    "This account has no active plan for this model service, or the plan has expired. Check the subscription status in the provider's console, then try again."
  ],
  provider_plan_usage_limited: [
    "套餐额度已用完。请等待额度重置后重试，或在服务商后台开启超额用量。",
    "The plan allowance has been used up. Wait for it to reset and try again, or turn on extra usage in the provider's console."
  ],
  provider_rate_limited: CAUSE.providerRateLimit,
  provider_partial_interrupted_rate: CAUSE.providerRateLimit,
  provider_service_failed: CAUSE.providerUnavailable,
  provider_service_unavailable: CAUSE.providerUnavailable,
  provider_unavailable: CAUSE.providerUnavailable,
  provider_partial_interrupted_service: CAUSE.providerUnavailable,
  // Timeout
  provider_request_timeout: CAUSE.providerTimeout,
  provider_partial_interrupted_deadline: CAUSE.providerTimeout,
  // Network
  provider_network_error: CAUSE.providerNetwork,
  provider_network_failed: CAUSE.providerNetwork,
  provider_network_interrupted: CAUSE.providerNetwork,
  provider_partial_interrupted_network: CAUSE.providerNetwork,
  provider_http_incomplete: CAUSE.providerNetwork,
  provider_network_error_http_incomplete: CAUSE.providerNetwork,
  provider_certificate_failed: CAUSE.providerCertificate,
  provider_proxy_failed: CAUSE.providerProxy,
  // Request and response
  provider_request_rejected: CAUSE.providerRejected,
  provider_auto_output_request_rejected: CAUSE.providerRejected,
  provider_http_failed: CAUSE.providerNotResponding,
  provider_protocol_failed: CAUSE.providerProtocolMismatch,
  provider_protocol_mismatch: CAUSE.providerProtocolMismatch,
  provider_finish_reason_missing: CAUSE.providerIncomplete,
  provider_finish_reason_unsupported: CAUSE.providerIncomplete,
  provider_sse_json_invalid: CAUSE.providerIncomplete,
  provider_utf8_invalid: CAUSE.providerIncomplete,
  provider_content_filtered: CAUSE.contentFiltered,
  provider_output_limit_rejected: [
    "模型服务不接受当前的“单次输出上限”。请在 设置 → 模型服务 中打开该模型，调低“单次输出上限”后重试。",
    "The model service does not accept the current “Request output limit”. Go to Settings → Model services, open this model, lower the limit, and try again."
  ],
  provider_output_limit_reached: OUTPUT_LIMIT_REACHED,
  provider_reasoning_output_limit_reached: [
    "模型的本次输出额度已全部用于思考，未生成正文。请调低思考档位，或在 设置 → 模型服务 中调高该模型的“单次输出上限”。",
    "The model used its entire output budget on reasoning and produced no answer. Lower the reasoning effort, or raise this model's “Request output limit” in Settings → Model services."
  ],
  controlled_transport_aborted: ["已停止生成。", "Generation stopped."],
  echoink_document_fallback_input_budget_exceeded: DOCUMENT_FALLBACK_TOO_LONG,
  // Tool calls
  provider_tool_call_missing: CAUSE.toolCallIncomplete,
  model_tool_call_text_disabled: CAUSE.toolCallDisabled,
  model_tool_call_text_incompatible: CAUSE.toolCallIncompatible,
  // Conversation state
  conversation_already_running: CAUSE.busyAnswering,
  // Agent capability (fixed codes; "agent_capability_<reason>:<capability>" goes through agentCapabilityDenialCopy)
  agent_capability_agent_missing: AGENT_MISSING,
  agent_capability_knowledge_denied: ["本轮无法使用知识库。请检查 Agent 能力与知识库设置。", "Knowledge was unavailable for this turn. Check the Agent capabilities and Knowledge settings."]
};

/** Provider failure codes the runtime may persist or forward. */
export const PROVIDER_FAILURE_CODE_IDS: readonly string[] = Object.keys(PROVIDER_CODES)
  .filter(code => code.startsWith("provider_") || code === "context_length_exceeded" || code === "controlled_transport_aborted");

/**
 * 小echo server codes. Kept apart from PROVIDER_CODES: names such as
 * AUTH_REQUIRED or SERVER_BUSY are generic, and other services may reuse them.
 */
export const XIAOECHO_CODES: Readonly<Record<string, ErrorCopy>> = {
  NEW_API_UNREACHABLE: CAUSE.providerUnavailable,
  NEW_API_UNAUTHORIZED: CAUSE.providerUnavailable,
  NEW_API_NOT_CONFIGURED: CAUSE.providerUnavailable,
  NEW_API_ERROR: CAUSE.providerUnavailable,
  POINTS_INSUFFICIENT: ["AI 点数不足。请先签到领取 AI 点数后重试。", "Not enough AI points. Check in to earn AI points, then try again."],
  MODEL_UNAVAILABLE: CAUSE.providerModelUnavailable,
  MODEL_UNKNOWN: CAUSE.providerModelUnavailable,
  SERVER_BUSY: CAUSE.providerUnavailable,
  XIAOECHO_BUSY: CAUSE.providerUnavailable,
  XIAOECHO_UNAVAILABLE: CAUSE.providerUnavailable,
  XIAOECHO_TIMEOUT: CAUSE.providerTimeout,
  XIAOECHO_DISABLED: CAUSE.providerUnavailable,
  CONTENT_TOO_LONG: CAUSE.contextTooLong,
  XIAOECHO_REQUEST_REJECTED: ["模型服务没有接受这次请求。", "The model service did not accept this request."],
  AUTH_REQUIRED: CAUSE.signInRequired,
  ACCOUNT_DISABLED: ["EchoInk 账号已停用，无法使用小echo。请联系客服。", "This EchoInk account is disabled, so xiaoecho cannot be used. Contact support."]
};

const CAPABILITY_LABELS: Readonly<Record<string, ErrorCopy>> = {
  conversation: ["对话", "Conversation"],
  memory: ["记忆", "Memory"],
  "vault-notes": ["库内笔记", "Vault notes"],
  knowledge: ["知识库", "Knowledge"],
  journal: ["日记", "Journal"],
  todos: ["待办", "Tasks"],
  finance: ["财务", "Finance"],
  "english-diary": ["英文日记", "English diary"],
  "pdf-reading": ["PDF 精读", "PDF reading"],
  review: ["复盘", "Review"],
  "web-search": ["联网搜索", "Web search"]
};

function capabilityLabel(reason: string, capability: string): ErrorCopy {
  if (capability === "knowledge" && reason === "agent_disabled") return ["知识整理", "Knowledge organization"];
  if (Object.hasOwn(CAPABILITY_LABELS, capability)) return CAPABILITY_LABELS[capability];
  if (capability.startsWith("mcp:")) return ["MCP", "MCP"];
  if (capability.startsWith("vault-skill:")) return ["我的技能", "My skills"];
  return ["这项能力", "This capability"];
}

/** Agent capability denial (reason + capability id) → sentence. */
export function agentCapabilityDenialCopy(reason: string, capability: string): ErrorCopy {
  if (reason === "module_disabled" && capability === "knowledge") {
    return ["知识库当前不可用。请在 设置 → 知识库 中检查目录配置。", "Knowledge is unavailable. Check the folder setup in Settings → Knowledge."];
  }
  const [zh, en] = capabilityLabel(reason, capability);
  switch (reason) {
    case "agent_missing": return AGENT_MISSING;
    case "agent_disabled": return [`该 Agent 未开启「${zh}」。请在 Agent 设置的“能用的能力”中勾选后继续。`, `${en} is off for this Agent. Turn it on under Capabilities in the Agent settings, then continue.`];
    case "module_disabled": return [`${zh}已关闭。请开启后继续。`, `${en} is turned off. Turn it on, then continue.`];
    case "pro_required": return CAUSE.proRequired;
    case "read_only": return CAUSE.workspaceReadOnly;
    case "resource_disabled": return ["该工具或技能已关闭。请开启后继续。", "This tool or skill is turned off. Turn it on, then continue."];
    case "scope_required": return ["该操作没有可核对的范围，无法继续。请重新发起并说明要处理的笔记或文件夹。", "This action has no scope that can be checked, so it cannot continue. Start again and name the notes or folders to work on."];
    case "folder_grant_required": return ["该文件夹尚未向这位员工开放写入。请在总助派发任务时开放该文件夹，或直接交给这位员工处理。", "This folder is not open to this worker for writing. Have the assistant open it when assigning the task, or ask this worker directly."];
    default: return ["该操作当前不可用。请检查能力与工具设置后继续。", "This action is unavailable. Check the capability and tool settings, then continue."];
  }
}

const CAPABILITY_DENIAL = /^agent_capability_(agent_missing|agent_disabled|module_disabled|pro_required|read_only|resource_disabled|scope_required|folder_grant_required):(.+)$/u;

/** "agent_capability_<reason>:<capability>" → its parts, or undefined. */
export function parseAgentCapabilityDenial(value: string): { reason: string; capabilityId: string } | undefined {
  const match = CAPABILITY_DENIAL.exec(value);
  if (match) return { reason: match[1], capabilityId: match[2] };
  if (value === "agent_capability_agent_missing") return { reason: "agent_missing", capabilityId: "conversation" };
  return undefined;
}

/** Codes whose sentence depends on a parameter (capability denials). */
export function lookupProviderPatternCode(code: string): ErrorCopy | null {
  const denial = parseAgentCapabilityDenial(code);
  return denial ? agentCapabilityDenialCopy(denial.reason, denial.capabilityId) : null;
}
