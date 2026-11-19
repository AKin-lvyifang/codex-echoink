/** 小echo 排队（方哥 11-08 定）：服务端并发闸门返回 SERVER_BUSY / XIAOECHO_BUSY 时，插件静默重试一次（隔 2 秒），再失败才提示用户。 */
export const XIAOECHO_PROVIDER_ID = "xiaoecho";
export const XIAOECHO_RETRY_DELAY_MS = 2_000;
const BUSY_CODES = ["SERVER_BUSY", "XIAOECHO_BUSY"] as const;
/** The busy code when this failure is the server asking us to wait; null for everything else. */
export function xiaoechoBusyCode(provider: string | undefined, status: number | null, message: string): string | null {
  if (provider !== XIAOECHO_PROVIDER_ID) return null;
  if (status !== null && status !== 503 && status !== 429) return null;
  return BUSY_CODES.find(code => message.includes(code)) ?? null;
}
