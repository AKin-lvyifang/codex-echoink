import { getDesktopCrypto } from "../platform/desktop-crypto";

const { createHash } = getDesktopCrypto();

export const RAW_INTEGRITY_ERROR_PREFIX = "知识库任务试图改写 raw/ 原始资料文件";

export function contentFingerprint(content: Buffer): string {
  return `sha256:${content.length}:${createHash("sha256").update(content).digest("hex")}`;
}

export function isRawIntegrityErrorMessage(message: string): boolean {
  return message.startsWith(RAW_INTEGRITY_ERROR_PREFIX);
}
