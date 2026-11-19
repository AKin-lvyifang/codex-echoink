import { CAUSE } from "../causes";
import { NEXT } from "../next";
import type { ErrorCopy } from "../types";

const withNext = (lead: ErrorCopy, next: ErrorCopy): ErrorCopy => [`${lead[0]}${next[0]}`, `${lead[1]} ${next[1]}`];

/** Membership service codes (server protocol). UNKNOWN is the account fallback, not a global code. */
export const MEMBERSHIP_CODES = {
  AUTH_REQUIRED: ["登录状态已失效。请在 设置 → 账号与会员 中重新登录。", "Your sign-in has expired. Sign in again under Settings → Account & membership."],
  AUTH_FAILED: ["邮箱或密码不正确。请检查后重试；如忘记密码，请在 EchoInk 官网重设。", "The email or password is incorrect. Check and try again, or reset your password on the EchoInk website."],
  OTP_INVALID: ["验证码无效、已使用或已过期。请重新获取验证码。", "This code is invalid, used or expired. Request a new code."],
  RATE_LIMITED: withNext(["请求过于频繁。", "Too many requests."], NEXT.retryLater),
  MAIL_UNAVAILABLE: withNext(["邮件服务暂时不可用。", "The email service is temporarily unavailable."], NEXT.retryLater),
  DEVICE_LIMIT: ["设备名额已满。请先在 设置 → 账号与会员 中解绑旧设备。", "All device slots are in use. Remove an old device in Settings → Account & membership first."],
  DEVICE_REVOKED: ["本机授权已解除。请在 设置 → 账号与会员 中重新启用本机。", "This device was removed. Activate it again in Settings → Account & membership."],
  PRO_REQUIRED: CAUSE.proRequired,
  REVOKED: ["该授权已撤销。请联系支持核实。", "This access was revoked. Contact support to verify it."],
  SUBSCRIPTION_EXPIRED: ["订阅已到期，已有资料仍可查看。请在 设置 → 账号与会员 中查看续订选项。", "Your subscription has expired. Existing files remain readable. Check renewal options in Settings → Account & membership."],
  ENTITLEMENT_SCHEDULED: ["权益尚未生效。请在 设置 → 账号与会员 中查看生效日期。", "This access has not started yet. Check its start date in Settings → Account & membership."],
  CODE_ALREADY_REDEEMED: ["兑换码已被使用。请查看会员状态，或使用未兑换的兑换码。", "This activation code has already been used. Check your membership or use an unused code."],
  CODE_INVALID: ["兑换码无效。请检查后重新输入。", "This activation code is invalid. Check it and enter it again."],
  CODE_FOR_OTHER_ACCOUNT: ["此内测激活码属于其他账号。请使用本账号领取的激活码。", "This beta code belongs to another account. Use the code assigned to this account."],
  BETA_ENDED: ["内测活动已结束，此激活码无法兑换，已有资料仍可查看。请在 设置 → 账号与会员 中查看可选套餐。", "The beta event has ended and this code cannot be redeemed. Existing files remain readable. Check available plans in Settings → Account & membership."],
  ALREADY_OWNED: withNext(["当前账号已拥有该买断权益，无需重复购买。", "This account already owns this lifetime access; no purchase is needed."], NEXT.accountStatus),
  PASSWORD_LENGTH: ["密码长度不符合要求。请设置 10 至 128 个字符的密码。", "The password length is invalid. Choose a password with 10 to 128 characters."],
  PRODUCT_UNAVAILABLE: ["该套餐暂未开放购买。请返回订阅页选择其他套餐。", "This plan is not available for purchase. Return to Subscriptions and choose another plan."],
  SERVICE_UNAVAILABLE: withNext(["账号服务暂时不可用。", "The account service is temporarily unavailable."], NEXT.checkNetwork),
  OPERATION_CANCELLED: ["账号已切换，本次操作已取消。请在当前账号下重试。", "The account changed, so this action was cancelled. Try again with the current account."],
  ACCOUNT_DISABLED: ["账号已停用。请联系支持恢复使用。", "This account is disabled. Contact support to restore access."],
  PROOF_INVALID: ["本机授权已失效。请联网后在 设置 → 账号与会员 中重新验证。", "This device authorization has expired. Connect to the internet and verify it again in Settings → Account & membership."],
  VERSION_NOT_COVERED: ["当前插件版本不支持此技能。请更新插件后重试。", "This plugin version does not support this skill. Update the plugin and try again."],
  UNKNOWN: withNext(["账号请求未能完成。", "The account request could not be completed."], NEXT.retryOrReport),
  PRODUCTS_UNAVAILABLE: withNext(["暂时无法读取套餐信息。", "Plan information is temporarily unavailable."], NEXT.checkNetwork),
  VERIFY_FAILED: withNext(["会员状态未能验证。", "Your membership could not be verified."], NEXT.checkNetwork),
  NETWORK: withNext(["无法连接会员服务。", "Could not reach the membership service."], NEXT.checkNetwork)
} as const satisfies Record<string, ErrorCopy>;

export type MembershipCode = keyof typeof MEMBERSHIP_CODES;

/** PRO gate states raised by the account service when an action needs PRO. */
export const PRO_ACCESS_COPY = {
  verificationRequired: ["会员状态需要联网验证，已有资料仍可查看。请联网后在 设置 → 账号与会员 中重新验证。", "Your membership needs to be verified online. Existing files remain readable. Connect to the internet and verify it in Settings → Account & membership."],
  deviceRequired: ["当前账号已拥有 PRO，但本机尚未启用。请在 设置 → 账号与会员 中启用本机。", "This account has PRO, but this device is not activated. Activate it in Settings → Account & membership."],
  deviceLimit: ["设备名额已满。请在 设置 → 账号与会员 中解绑旧设备后启用本机。", "All device slots are in use. Remove an old device in Settings → Account & membership, then activate this one."],
  scheduled: MEMBERSHIP_CODES.ENTITLEMENT_SCHEDULED,
  /** Any other missing PRO (including signed out). */
  required: CAUSE.proRequired,
  /** Membership state could not be read at all. */
  unavailable: ["PRO 授权暂时无法确认。请在 设置 → 账号与会员 中查看会员状态。", "PRO access could not be confirmed. Check your membership in Settings → Account & membership."]
} as const satisfies Record<string, ErrorCopy>;

/** Cloud sync codes. Some share a name with membership codes but have their own sync sentence. */
export const CLOUD_SYNC_CODES = {
  AUTH_REQUIRED: ["同步登录状态已失效。请在 设置 → 账号与会员 中重新登录。", "Your sync sign-in has expired. Sign in again under Settings → Account & membership."],
  ACCOUNT_DISABLED: ["账号已停用。请联系支持恢复同步。", "This account is disabled. Contact support to restore sync."],
  DEVICE_REQUIRED: ["本机尚未启用。请在 设置 → 账号与会员 中点击“在此设备启用”，再开启云同步。", "This device is not activated. Select Activate on this device in Settings → Account & membership, then turn on cloud sync."],
  SYNC_NOT_INCLUDED: ["当前账号不含云同步权益。请在 设置 → 账号与会员 中查看可用订阅。", "This account does not include cloud sync. Check available subscriptions in Settings → Account & membership."],
  SYNC_READ_ONLY: ["订阅已到期，云端资料暂时只读。请续订后再上传。", "Your subscription has expired and cloud files are read-only. Renew before uploading."],
  QUOTA_EXCEEDED: ["云端空间已满。请清理不需要的云端文件后再同步。", "Cloud storage is full. Remove unneeded cloud files, then sync again."],
  RATE_LIMITED: ["同步请求过于频繁，已暂停片刻。稍后将自动继续同步。", "Too many sync requests. Sync is paused briefly and will continue automatically."],
  SYNC_ENABLE_RATE_LIMITED: ["同步请求过多，请稍后重新开启", "Too many sync requests. Turn on sync again shortly."],
  SYNC_NOT_CONFIGURED: withNext(["云同步服务暂时不可用。", "Cloud sync is temporarily unavailable."], NEXT.retryLater),
  MEMBERSHIP_UNAVAILABLE: withNext(["云同步服务暂时不可用。", "Cloud sync is temporarily unavailable."], NEXT.retryLater),
  FORBIDDEN: ["当前账号无法同步这些资料。请在 设置 → 账号与会员 中确认登录账号和设备授权。", "This account cannot sync these files. Check your account and device activation in Settings → Account & membership."],
  NETWORK: withNext(["无法连接同步服务。", "Could not reach cloud sync."], NEXT.checkNetwork),
  PASSWORD_REQUIRED: ["账号尚未设置密码。请先在 EchoInk 官网账号页设置密码，再输入密码开启云同步。", "This account has no password. Set one on the EchoInk website account page, then enter it to turn on cloud sync."],
  DECRYPT: ["同步密码不正确或资料无法解密，本机文件未改动。请重新输入原同步密码。", "The sync password is incorrect or these files cannot be decrypted. Local files are unchanged. Enter the original sync password again."],
  KEY_CACHE: ["本机保存的同步凭据无法读取。请关闭云同步后重新输入密码开启。", "The saved sync credential cannot be read. Turn cloud sync off, then enter your password to turn it on again."],
  FILE_TRANSFER: withNext(["文件未能完整传输。", "The file transfer could not be completed."], NEXT.checkNetwork),
  UNKNOWN: withNext(["本次同步未能完成，本机文件已保留。", "Sync could not be completed. Local files are kept."], NEXT.retryOrReport)
} as const satisfies Record<string, ErrorCopy>;

export type CloudSyncCode = keyof typeof CLOUD_SYNC_CODES;

/** Server and local sync codes that share a sentence with a code above. */
export const CLOUD_SYNC_CODE_ALIASES: Readonly<Record<string, CloudSyncCode>> = {
  DEVICE_NOT_REGISTERED: "DEVICE_REQUIRED", INVALID_DEVICE: "DEVICE_REQUIRED",
  BODY_TOO_LARGE: "FILE_TRANSFER", INVALID_FILE: "FILE_TRANSFER", INVALID_FILES: "FILE_TRANSFER", NOT_FOUND: "FILE_TRANSFER",
  OBJECT_LINK_INVALID: "FILE_TRANSFER", OBJECT_MISSING: "FILE_TRANSFER", HASH_MISMATCH: "FILE_TRANSFER", SIZE_MISMATCH: "FILE_TRANSFER", UPLOAD_NOT_PREPARED: "FILE_TRANSFER",
  OBJECT_PUT_FAILED: "SYNC_NOT_CONFIGURED", OBJECT_GET_FAILED: "SYNC_NOT_CONFIGURED", INTERNAL_ERROR: "SYNC_NOT_CONFIGURED",
  INVALID_JSON: "UNKNOWN", REQUEST_FAILED: "UNKNOWN"
};

/**
 * Account codes any error exit may meet (module buttons, settings, chat).
 * Membership codes win on shared names; generic fallbacks (UNKNOWN) stay with their own callers.
 */
export const ACCOUNT_CODES: Readonly<Record<string, ErrorCopy>> = {
  DEVICE_REQUIRED: CLOUD_SYNC_CODES.DEVICE_REQUIRED,
  SYNC_NOT_INCLUDED: CLOUD_SYNC_CODES.SYNC_NOT_INCLUDED,
  SYNC_READ_ONLY: CLOUD_SYNC_CODES.SYNC_READ_ONLY,
  SYNC_NOT_CONFIGURED: CLOUD_SYNC_CODES.SYNC_NOT_CONFIGURED,
  MEMBERSHIP_UNAVAILABLE: CLOUD_SYNC_CODES.MEMBERSHIP_UNAVAILABLE,
  QUOTA_EXCEEDED: CLOUD_SYNC_CODES.QUOTA_EXCEEDED,
  ...Object.fromEntries(Object.entries(MEMBERSHIP_CODES).filter(([code]) => code !== "UNKNOWN"))
};
