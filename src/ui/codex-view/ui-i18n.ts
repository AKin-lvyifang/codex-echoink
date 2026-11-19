import { knownCopyBySentence } from "../../core/error-copy";
import type { SettingsLanguage } from "../../settings/settings";

/**
 * Localizes only explicitly supplied EchoInk UI copy. It deliberately never
 * accepts persisted message, Tool, or Vault content for translation.
 */
export function conversationUiText(
  language: SettingsLanguage,
  zh: string,
  en: string
): string {
  return language === "en" ? en : zh;
}

export function conversationUiLocale(language: SettingsLanguage): "zh-CN" | "en-US" {
  return language === "en" ? "en-US" : "zh-CN";
}

/**
 * Fixed EchoInk system states written by older Pi projections. Call this only
 * for an already classified first-party system field; unknown text is kept
 * verbatim so Provider, Tool, user, model, and Vault content never changes.
 */
const ENGLISH_SYSTEM_COPY: Readonly<Record<string, string>> = Object.freeze({
  "上下文压缩": "Context compaction",
  "上下文已压缩": "Context compacted",
  "上下文压缩未完成": "Context compaction incomplete",
  "上下文压缩完成": "Context compaction complete",
  "正在压缩上下文": "Compacting context",
  "已切换对话分支": "Conversation branch switched",
  "正在切换对话分支": "Switching conversation branch",
  "会话信息": "Conversation information",
  "会话诊断": "Conversation diagnostics",
  "正在回忆相关 Memory": "Recalling relevant Memory",
  "处理过程": "Processing",
  "更新计划": "Plan update",
  "图片": "Image",
  "回答失败": "Answer failed",
  "回答未完成": "Answer incomplete",
  "回答已停止": "Answer stopped",
  "上次运行已中断": "Previous run interrupted",
  "等待用户回答": "Waiting for your answer",
  "等待用户确认": "Waiting for your confirmation",
  "需要用户确认后继续": "Your confirmation is needed to continue",
  "Codex 已自动压缩上下文。": "Codex automatically compacted the context.",
  "正在生成回复...": "Generating reply...",
  "安全恢复中": "Recovering safely",
  "安全恢复受阻": "Safe recovery is blocked",
  "处理完成": "Processing complete",
  "处理已中断": "Processing interrupted",
  "处理失败": "Processing failed",
  "正在整理较早的对话，并保留近期原文。": "Organizing earlier conversation while keeping recent text verbatim.",
  "已从所选节点继续对话": "Continued from the selected node",
  "本次上下文压缩已停止": "This context compaction was stopped",
  "正在从 Pi Session 的活动分支重新加载对话。": "Reloading the conversation from the active Pi Session branch.",
  "Agent 未返回可显示内容": "Agent returned no displayable content",
  "Agent 执行失败": "Agent execution failed",
  "已停止生成": "Generation stopped",
  "插件关闭前本轮尚未完成；这里只显示 Pi Session 中已验证的内容。": "This turn did not finish before the plugin closed. Only verified Pi Session content is shown here.",
  "达到输出上限，回答未完整生成。": "The output limit was reached, so the answer was not completed.",
  "模型把本次输出额度用在思考上，未生成正文。请调低思考档位，或在模型设置中调高单次输出上限。": "The model used its entire output budget on reasoning and produced no answer. Lower the reasoning effort, or go to Settings → Model services and raise this model's “Request output limit”.",
  "模型的本次输出额度已全部用于思考，未生成正文。请调低思考档位，或在 设置 → 模型服务 中调高该模型的“单次输出上限”。": "The model used its entire output budget on reasoning and produced no answer. Lower the reasoning effort, or go to Settings → Model services and raise this model's “Request output limit”.",
  "Provider 不支持该原生文档输入，且冻结文本超过当前模型的输入容量；未发起第二次请求。请减少文档、新开会话或切换容量更大的模型。": "The model service does not support this native document input, and its frozen text exceeds the model's input capacity. No second request was made. Reduce the documents, start a new conversation, or choose a model with more capacity.",
  "内容被 Provider 安全策略拦截，回答未完成。": "The model service's safety policy blocked the content, so the answer was not completed.",
  "Provider 未返回结束原因，回答未完成。": "The model service returned no finish reason, so the answer was not completed.",
  "Provider 返回了不支持的结束原因，回答未完成。": "The model service returned an unsupported finish reason, so the answer was not completed.",
  "Provider 返回的流数据格式损坏，回答未完成。": "The model service returned malformed streaming data, so the answer was not completed.",
  "网络连接提前结束，回答未完整接收。": "The network connection ended early, so the answer was not fully received.",
  "Provider 返回的文本编码无效，回答未完成。": "The model service returned invalid text encoding, so the answer was not completed.",
  "网络连接中断，回答未完成。": "The network connection was interrupted, so the answer was not completed.",
  "本次回答在上下文超限前已产生部分内容，已停止自动重试。": "This answer produced partial content before exceeding the context limit, so automatic retry stopped.",
  "Provider 当前请求受限，回答未完成。": "The model service is rate-limiting this request, so the answer was not completed.",
  "Provider 服务暂时不可用，回答未完成。": "The model service is temporarily unavailable, so the answer was not completed.",
  "Provider 声明了工具调用，但没有返回完整工具参数。": "The model service declared a tool call but did not return complete tool arguments.",
  "Provider 凭证不可用，请检查设置。": "The model service credentials are unavailable. Check Settings.",
  "当前 Provider 模型不可用，请检查模型设置。": "The current model is unavailable. Check Settings → Model services.",
  "当前对话超过模型上下文上限。": "This conversation exceeds the model's context limit.",
  "Provider 返回格式不符合当前协议，回答未完成。": "The model service response does not match the current protocol, so the answer was not completed.",
  "模型服务不接受当前的“单次输出上限”。请在 设置 → 模型服务 中打开该模型，调低“单次输出上限”后重试。": "The model service does not accept the current “Request output limit”. Go to Settings → Model services, open this model, lower the limit, and try again.",
  "本次回答被模型服务的内容审核拦截。请调整提问内容后重试，或更换模型。": "The model service's content moderation blocked this answer. Revise your question and try again, or choose another model.",
  "当前对话长度已超出该模型的处理上限，回答仅生成了一部分。请新建会话后继续。": "The conversation exceeds this model's processing limit, so only part of the answer was generated. Start a new conversation to continue.",
  "模型服务请求过于频繁或额度已用尽。请稍后重试，或检查账户额度。": "The model service is receiving too many requests, or the quota is exhausted. Try again later, or check the account quota.",
  "证书校验失败。请检查模型服务证书或代理证书。": "Certificate verification failed. Check the model service or proxy certificate.",
  "模型服务暂时不可用，回答未完成。请稍后重试。": "The model service is temporarily unavailable, so the answer was not completed. Try again later.",
  "当前模型不可用，可能已下线或账号无访问权限。请在 设置 → 模型服务 中更换模型。": "The current model is unavailable; it may have been retired, or the account may lack access. Go to Settings → Model services and choose another model.",
  "模型服务返回的内容与所选 API 协议不匹配。请在 设置 → 模型服务 中更换“API 协议”后重试。": "The model service's response does not match the selected API protocol. Go to Settings → Model services, change the “API protocol”, and try again.",
  "无法连接模型服务。请检查网络或代理。": "Could not connect to the model service. Check the network or proxy.",
  "正在执行...": "Running...",
  "知识库管理": "Knowledge management"
});

export function localizeKnownConversationSystemCopy(
  language: SettingsLanguage,
  text: string
): string {
  if (language !== "en") return text;
  if (text === "没有找到相关笔记") return "No related notes found";
  if (text === "检索知识库 · 没有找到相关笔记") return "Search knowledge · No related notes found";
  const read = /^(检索知识库 · )?读了 (\d+) 篇相关笔记$/u.exec(text);
  if (read) return `${read[1] ? "Search knowledge · " : ""}Read ${read[2]} relevant note${read[2] === "1" ? "" : "s"}`;
  // Shared error sentences (core/error-copy) carry their own English.
  return ENGLISH_SYSTEM_COPY[text] ?? knownCopyBySentence(text)?.[1] ?? text;
}

export function formatConversationRelativeTime(
  timestamp: number,
  language: SettingsLanguage,
  now = Date.now()
): string {
  const elapsed = Math.max(0, now - timestamp);
  if (language === "en") {
    if (elapsed < 60_000) return "just now";
    if (elapsed < 60 * 60_000) return `${Math.max(1, Math.floor(elapsed / 60_000))} min ago`;
    const updated = new Date(timestamp);
    const current = new Date(now);
    if (sameLocalDate(updated, current)) {
      return `today ${twoDigits(updated.getHours())}:${twoDigits(updated.getMinutes())}`;
    }
    const yesterday = new Date(current.getFullYear(), current.getMonth(), current.getDate() - 1);
    if (sameLocalDate(updated, yesterday)) return "yesterday";
    return updated.toLocaleDateString(conversationUiLocale(language), {
      month: "short",
      day: "numeric",
      ...(updated.getFullYear() === current.getFullYear() ? {} : { year: "numeric" })
    });
  }
  if (elapsed < 60_000) return "刚刚";
  if (elapsed < 60 * 60_000) return `${Math.max(1, Math.floor(elapsed / 60_000))} 分钟前`;
  const updated = new Date(timestamp);
  const current = new Date(now);
  if (sameLocalDate(updated, current)) return `今天 ${twoDigits(updated.getHours())}:${twoDigits(updated.getMinutes())}`;
  const yesterday = new Date(current.getFullYear(), current.getMonth(), current.getDate() - 1);
  if (sameLocalDate(updated, yesterday)) return "昨天";
  if (updated.getFullYear() === current.getFullYear()) return `${updated.getMonth() + 1} 月 ${updated.getDate()} 日`;
  return updated.toLocaleDateString(conversationUiLocale(language));
}

function sameLocalDate(left: Date, right: Date): boolean {
  return left.getFullYear() === right.getFullYear()
    && left.getMonth() === right.getMonth()
    && left.getDate() === right.getDate();
}

function twoDigits(value: number): string {
  return String(value).padStart(2, "0");
}
