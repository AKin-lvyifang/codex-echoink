import { CAUSE } from "../causes";
import { NEXT } from "../next";
import type { ErrorCopy } from "../types";

/** Scene sentence + a NEXT sentence, as one pair. */
export const withNext = (lead: ErrorCopy, next: ErrorCopy): ErrorCopy => [`${lead[0]}${next[0]}`, `${lead[1]} ${next[1]}`];

/** Journal location / naming-format organizer (settings → journal). */
export const JOURNAL_FORMAT_CODES = {
  journal_links_disabled: ["Obsidian 未开启“自动更新内部链接”。请在 Obsidian 设置 → 文件与链接 中开启后再整理。", "Automatically update internal links is off. Turn it on in Obsidian Settings → Files and links, then organize again."],
  journal_model_missing: CAUSE.providerNotConfigured,
  journal_parent_occupied: ["目标文件夹位置已有同名文件。请移走该文件后重新预览。", "A file already uses the destination folder name. Move it away, then preview again."],
  journal_target_occupied: ["目标位置已有同名日记。请处理后重新预览。", "A journal already exists at the destination. Resolve it, then preview again."],
  journal_template_missing: ["日记模板不存在或位置已被占用。请重新选择模板。", "The journal template is missing or its location is taken. Choose a template again."],
  journal_settings_changed: ["日记设置已变化。请重新预览整理清单。", "Journal settings changed. Preview the plan again."],
  journal_source_changed: ["日记内容已变化。请重新预览整理清单。", "A journal changed. Preview the plan again."],
  journal_record_invalid: ["整理记录已损坏，文件保持原状。请点击“上报问题”。", "The organizing record is damaged; files were left unchanged. Click Report a problem."],
  journal_record_changed: withNext(["整理记录未能保存，文件保持原状。", "The organizing record could not be saved; files were left unchanged."], NEXT.retry),
  journal_previous_record: ["上次整理未完成。请先核对或撤销上次整理。", "The previous organizing run did not finish. Check or undo it first."],
  journal_busy: ["正在整理日记。请等待整理结束后重试。", "Journals are being organized. Wait for it to finish, then try again."],
  journal_cancelled: ["整理已停止，已移动的日记可以撤销。", "Organizing stopped. Moved journals can be restored."],
  journal_plan_missing: ["整理清单已失效。请重新预览整理清单。", "The organizing plan has expired. Preview it again."]
} as const satisfies Record<string, ErrorCopy>;

export const JOURNAL_FORMAT_FAILED: ErrorCopy = ["日记整理未能完成。请检查模型服务或文件状态后重试。", "Organizing could not be completed. Check the model service and the files, then try again."];

/** Finance service codes that reach a button or form. */
export const FINANCE_CODES = {
  finance_version_conflict: CAUSE.editedElsewhere,
  finance_record_not_found: ["该记录已不存在。请刷新后重试。", "This record no longer exists. Refresh and try again."],
  finance_bill_not_found: ["该账单已不存在。请刷新后重试。", "This bill no longer exists. Refresh and try again."],
  finance_readback_failed: ["财务记录保存后核对未通过，原数据已保留。请刷新后核对。", "The finance record could not be confirmed after saving; existing data was kept. Refresh and check it."],
  finance_invalid_record: ["记录内容无效，未保存。请检查金额、日期和分类后重试。", "The record is invalid and was not saved. Check the amount, date and category, then try again."],
  finance_budget_total_unset: ["尚未设置总预算。请先设置总预算。", "No total budget is set. Set the total budget first."],
  finance_category_budget_unset: ["该分类尚未设置预算。请先设置分类预算。", "This category has no budget. Set it first."]
} as const satisfies Record<string, ErrorCopy>;

/** Web search providers (DeepSeek, Tavily). Generic keys, so only the search tools look them up. */
export const WEB_SEARCH_CODES = {
  key_missing: ["API Key 未填写。请填写后重试。", "The API key is missing. Enter it and try again."],
  key_invalid: ["API Key 无效或无访问权限。请检查后重新填写。", "The API key is invalid or lacks access. Check it and enter it again."],
  rate_limit: withNext(["请求过于频繁。", "Too many requests."], NEXT.retryLater),
  network: withNext(["无法连接搜索服务。", "Could not reach the search service."], NEXT.checkNetwork),
  timeout: withNext(["搜索服务响应超时。", "The search service timed out."], NEXT.retryLater),
  cancelled: ["测试已取消。", "Test cancelled."],
  invalid_response: withNext(["未收到有效的搜索结果。", "No valid search results were received."], NEXT.retryLater)
} as const satisfies Record<string, ErrorCopy>;

export const DEEPSEEK_SEARCH_CODES = {
  ...WEB_SEARCH_CODES,
  quota: ["DeepSeek 账户余额不足。请在 DeepSeek 后台检查余额。", "Your DeepSeek balance is insufficient. Check it in your DeepSeek account."],
  invalid_query: ["搜索词长度需为 1–128 个字符。请缩短后重试。", "Search queries must be 1–128 characters. Shorten it and try again."]
} as const satisfies Record<string, ErrorCopy>;

export const TAVILY_SEARCH_CODES = {
  ...WEB_SEARCH_CODES,
  quota: ["Tavily 账户额度已用尽。请在 Tavily 后台检查额度。", "Your Tavily credits are used up. Check them in your Tavily account."]
} as const satisfies Record<string, ErrorCopy>;

/** OpenAI Codex sign-in (OAuth). Keys overlap model-service codes, so only the OAuth service looks them up. */
export const OPENAI_CODEX_AUTH_CODES = {
  provider_oauth_relogin_required: CAUSE.providerLoginExpired,
  provider_network_error: withNext(["无法连接 OpenAI Codex 授权服务。", "Could not reach the OpenAI Codex sign-in service."], NEXT.checkNetwork),
  provider_rate_limited: withNext(["OpenAI Codex 授权请求过于频繁。", "Too many OpenAI Codex sign-in requests."], NEXT.retryLater),
  provider_request_rejected: ["OpenAI Codex 拒绝了授权请求。请在 设置 → 模型服务 中重新登录。", "OpenAI Codex rejected the sign-in request. Sign in again in Settings → Model services."],
  provider_service_unavailable: withNext(["OpenAI Codex 授权服务暂时不可用。", "The OpenAI Codex sign-in service is temporarily unavailable."], NEXT.retryLater),
  provider_protocol_failed: withNext(["OpenAI Codex 授权响应无法识别。", "The OpenAI Codex sign-in response could not be read."], NEXT.retry),
  provider_unavailable: withNext(["OpenAI Codex 授权暂时不可用。", "OpenAI Codex sign-in is temporarily unavailable."], NEXT.retry)
} as const satisfies Record<string, ErrorCopy>;

/** Module codes any error exit may meet. Only uniquely prefixed codes are registered here. */
export const MODULES_CODES: Readonly<Record<string, ErrorCopy>> = {
  ...JOURNAL_FORMAT_CODES,
  ...FINANCE_CODES
};
