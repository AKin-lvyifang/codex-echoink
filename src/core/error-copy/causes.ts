import type { ErrorCopy } from "./types";

/**
 * Root causes shared across desktop, iPhone/iPad and settings. Each cause has
 * exactly one sentence (result + next step). Callers never write their own
 * wording for these; same cause, same words, everywhere.
 * Rules: docs/claude建议/报错文案规范.md
 */
export const CAUSE = {
  // 模型服务
  providerAuth: ["API Key 无效或未填写。请在 设置 → 模型服务 中重新填写，并点击“测试连接”。", "The API key is invalid or missing. Re-enter it in Settings → Model services and click Test connection."],
  providerAuthMobile: ["API Key 无效或未填写。请在 设置 → 模型服务 中重新填写，并点击“测试并保存”。", "The API key is invalid or missing. Re-enter it in Settings → Model services and tap Test and save."],
  providerLoginExpired: ["该模型服务的登录状态已失效。请在 设置 → 模型服务 中重新登录。", "Sign-in for this model service has expired. Sign in again in Settings → Model services."],
  providerNotFound: ["模型或接口地址不存在。请在 设置 → 模型服务 中检查 Model ID 和接口地址。", "The model or endpoint does not exist. Check the Model ID and endpoint in Settings → Model services."],
  providerUrlInvalid: ["接口地址无效。请使用 HTTPS 地址；HTTP 仅支持本机或局域网地址（如 http://192.168.1.10:8080/v1）。请在 设置 → 模型服务 中修改。", "The endpoint is invalid. Use HTTPS; plain HTTP is supported only for this computer or the local network (e.g. http://192.168.1.10:8080/v1). Change it in Settings → Model services."],
  providerNetwork: ["无法连接模型服务。请检查网络或代理设置后重试。", "Could not reach the model service. Check your network or proxy settings and try again."],
  providerTimeout: ["模型服务响应超时。请稍后重试。", "The model service timed out. Try again later."],
  providerRateLimit: ["模型服务请求过于频繁或额度已用尽。请稍后重试，或在模型服务后台检查额度。", "Too many requests, or the model service quota is used up. Try again later, or check the quota with your model service."],
  providerModelUnavailable: ["当前模型不可用（可能已下线或账号无权限）。请在 设置 → 模型服务 中更换模型。", "The current model is unavailable (it may be retired or your account lacks access). Choose another model in Settings → Model services."],
  providerModelRemoved: ["所选模型服务或模型已被删除或停用。请重新选择模型后发送。", "The selected model service or model was removed or disabled. Choose a model again, then send."],
  providerNotConfigured: ["尚未配置模型服务。请在 设置 → 模型服务 中添加并选择模型。", "No model service is set up. Add one and choose a model in Settings → Model services."],
  providerUnavailable: ["模型服务暂时不可用。请稍后重试。", "The model service is temporarily unavailable. Try again later."],
  providerNotResponding: ["模型服务未正常响应。请在 设置 → 模型服务 中点击“测试连接”排查。", "The model service did not respond normally. Go to Settings → Model services and click Test connection."],
  providerNotRespondingMobile: ["模型服务未正常响应。请在 设置 → 模型服务 中点击“测试并保存”排查。", "The model service did not respond normally. Go to Settings → Model services and tap Test and save."],
  providerRejectedOnTest: ["模型服务拒绝了测试请求。请检查 API Key、模型 ID 和“API 协议”是否正确。", "The model service rejected the test request. Check that the API key, model ID and API protocol are correct."],
  providerRejected: ["模型服务拒绝了本次请求。请在 设置 → 模型服务 中点击“测试连接”查看原因。", "The model service rejected the request. Go to Settings → Model services and click Test connection to see why."],
  providerProtocolMismatch: ["已连接，但返回内容与所选 API 协议不匹配。请更换“API 协议”后重新测试。", "Connected, but the response does not match the selected API protocol. Change the API protocol and test again."],
  providerIncomplete: ["模型服务返回的内容不完整，回答未能生成完毕。请重新发送；如问题持续，请更换模型。", "The model service returned an incomplete response, so the answer was not finished. Send again; if the problem persists, choose another model."],
  providerCertificate: ["证书校验未通过。请检查代理证书，或确认接口地址填写正确。", "Certificate verification failed. Check the proxy certificate or confirm the endpoint is correct."],
  providerProxy: ["无法连接代理。请检查代理设置或代理服务。", "Could not connect to the proxy. Check the proxy settings or the proxy service."],
  contextTooLong: ["当前对话长度已超出该模型的处理上限。请新建会话后继续，或更换处理上限更高的模型。", "This conversation exceeds what the model can process. Start a new conversation, or choose a model with a higher limit."],
  contentFiltered: ["模型服务的内容审核拦截了本次回答。请调整提问后重试，或更换模型。", "The model service's content filter blocked this answer. Rephrase and try again, or choose another model."],
  toolCallDisabled: ["模型未实际执行工具调用。请在 设置 → 模型服务 中为该模型开启“工具调用”后重试。", "The model did not actually run the tool. Turn on Tool calling for this model in Settings → Model services, then try again."],
  toolCallIncompatible: ["模型未实际执行工具调用，该模型可能不支持工具调用。请在 设置 → 模型服务 中更换模型。", "The model did not actually run the tool and may not support tool calling. Choose another model in Settings → Model services."],
  documentsTooLong: ["文档内容超出了该模型剩余的处理上限，消息未发送。请减少文档或缩短内容，也可新建会话，或更换处理上限更高的模型。", "The documents exceed what the model can still process, so the message was not sent. Remove some documents or shorten them, start a new conversation, or choose a model with a higher limit."],
  toolCallIncomplete: ["模型返回的工具调用参数不完整，该操作未执行。请重新发送；如问题持续，请更换模型。", "The model returned incomplete tool arguments, so the action did not run. Send again; if the problem persists, choose another model."],
  // 账号与权益
  proRequired: ["此操作需要有效的 PRO 权益。请在 设置 → 账号与会员 中查看会员状态。", "This requires an active PRO membership. Check your membership in Settings → Account & membership."],
  signInRequired: ["请先登录 EchoInk 账号。请在 设置 → 账号与会员 中登录。", "Sign in to your EchoInk account first, under Settings → Account & membership."],
  // 运行状态
  busyAnswering: ["EchoInk 正在回答。请等待回答结束后重试。", "EchoInk is answering. Wait for the answer to finish, then try again."],
  previousAnswerRunning: ["上一条回答尚未完成。请等待其完成后再发送。", "The previous answer is still in progress. Wait for it to finish, then send again."],
  pluginStarting: ["EchoInk 正在启动。请稍后重试；如问题持续，请重新加载插件。", "EchoInk is starting. Try again later; if the problem persists, reload the plugin."],
  providerSwitching: ["EchoInk 正在切换模型。请等待切换完成后重试。", "EchoInk is switching models. Wait for it to finish, then try again."],
  workspaceReadOnly: ["当前为只读权限，无法执行写入操作。请允许写入后继续。", "The workspace is read-only, so this write cannot run. Allow writing, then continue."],
  editedElsewhere: ["该内容已在其他位置被修改或删除。请关闭后重新打开，再继续编辑。", "This was changed or removed elsewhere. Close it and open it again before editing."],
  networkOffline: ["网络未连接。请检查网络后重试。", "You are offline. Check your network connection and try again."],
  // 知识库与收藏
  knowledgeFolderMissing: ["尚未设置知识库目录。请先在工作台点击“去初始化”完成设置。", "No knowledge folder is set up. Click Set up on the workbench first."],
  sourceMissing: ["原文件已不存在或已移动。请确认文件位置后重试。", "The original file no longer exists or was moved. Check where it is and try again."],
  captureLinkUnsupported: ["收藏仅支持网页链接和公众号文章链接。请粘贴链接后重试。", "Only web page and WeChat article links can be collected. Paste a link and try again."]
} as const satisfies Record<string, ErrorCopy>;

export type CauseId = keyof typeof CAUSE;
