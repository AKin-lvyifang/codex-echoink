import { CLOUD_SYNC_CODE_ALIASES, CLOUD_SYNC_CODES, type CloudSyncCode } from "../../core/error-copy/codes/account";

/** Fixed bilingual display text; protocol codes remain unchanged for retry decisions. The table lives in core/error-copy/codes/account.ts. */
export const CLOUD_FAILURE_TEXT: Readonly<Record<string, readonly [string, string]>> = CLOUD_SYNC_CODES;

const known = (code: string): code is CloudSyncCode => Object.prototype.hasOwnProperty.call(CLOUD_SYNC_CODES, code);

/** Sync code (or legacy local message) → the sync sentence. Raw text never shows. */
export function cloudFailureText(error: unknown, zh = true): string {
  const raw = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  const code = typeof error === "object" && error && "code" in error ? String(error.code) : raw;
  const alias = CLOUD_SYNC_CODE_ALIASES[code] ?? code;
  const key: CloudSyncCode = known(alias) ? alias : known(raw) ? raw : legacyCode(raw);
  return CLOUD_SYNC_CODES[key][zh ? 0 : 1];
}

function legacyCode(raw: string): CloudSyncCode {
  if (/同步密码|解密/.test(raw)) return "DECRYPT";
  if (/钥匙缓存|同步凭据/.test(raw)) return "KEY_CACHE";
  if (/还没有密码|尚未设置密码|先输入账号密码/.test(raw)) return "PASSWORD_REQUIRED";
  if (/先在.*登录/.test(raw)) return "AUTH_REQUIRED";
  if (/在此设备启用/.test(raw)) return "DEVICE_REQUIRED";
  if (/空间已满/.test(raw)) return "QUOTA_EXCEEDED";
  if (/请求太频繁|请求过于频繁/.test(raw)) return "RATE_LIMITED";
  if (/连不上|无法连接/.test(raw)) return "NETWORK";
  if (/文件没能|未能完整传输|路径过长/.test(raw)) return "FILE_TRANSFER";
  return (Object.keys(CLOUD_SYNC_CODES) as CloudSyncCode[]).find(key => (CLOUD_SYNC_CODES[key] as readonly string[]).includes(raw)) ?? "UNKNOWN";
}
