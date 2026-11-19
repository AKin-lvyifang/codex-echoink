import type { ErrorCopy } from "./types";

/**
 * Standard next-step sentences. Every error that ends with "what to do now"
 * uses one of these instead of writing its own wording.
 * Rules: docs/claude建议/报错文案规范.md
 */
export const NEXT = {
  retry: ["请重试。", "Try again."],
  retryLater: ["请稍后重试。", "Try again later."],
  checkNetwork: ["请检查网络后重试。", "Check your network connection and try again."],
  reloadPlugin: ["请重新加载插件。", "Reload the plugin."],
  retryOrReload: ["请重试；如问题持续，请重新加载插件。", "Try again; if the problem persists, reload the plugin."],
  retryOrReport: ["请稍后重试；如问题持续，请点击“上报问题”。", "Try again later; if the problem persists, click Report a problem."],
  retryOrReopen: ["请重试；如问题持续，请重新打开 EchoInk。", "Try again; if the problem persists, reopen EchoInk."],
  continueTask: ["请点击“继续”重试。", "Click Continue to try again."],
  report: ["请点击“上报问题”。", "Click Report a problem."],
  reopen: ["请关闭后重新打开，再继续操作。", "Close it and open it again, then continue."],
  testConnection: ["请在 设置 → 模型服务 中点击“测试连接”排查。", "Go to Settings → Model services and click Test connection."],
  providerSettings: ["请在 设置 → 模型服务 中检查。", "Check it in Settings → Model services."],
  chooseModel: ["请重新选择模型后发送。", "Choose a model again, then send."],
  accountStatus: ["请在 设置 → 账号与会员 中查看会员状态。", "Check your membership in Settings → Account & membership."],
  signIn: ["请在 设置 → 账号与会员 中登录。", "Sign in under Settings → Account & membership."],
  waitForAnswer: ["请等待回答结束后重试。", "Wait for the answer to finish, then try again."],
  resendOrTest: ["请重新发送；如问题持续，请在 设置 → 模型服务 中点击“测试连接”。", "Send it again; if the problem persists, go to Settings → Model services and click Test connection."],
  continueOrReport: ["请再次点击“继续”；如问题持续，请点击“上报问题”。", "Click Continue again; if the problem persists, click Report a problem."]
} as const satisfies Record<string, ErrorCopy>;

export type NextStep = keyof typeof NEXT;
