import { redactEchoInkLocalSecretsV1 } from "../harness/pi-native/vault-tool-result-safety";
/** Keep actionable details while removing credentials from persisted/UI errors. */
export function knowledgeErrorDetail(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return redactEchoInkLocalSecretsV1(text)
    .replace(/(Bearer\s+)[^\s"',;]+/giu, "$1[redacted]")
    .replace(/((?:api[-_ ]?key|access[-_ ]?token|authorization|secret|password)["']?\s*[:=]\s*["']?)[^\s"',;&}]+/giu, "$1[redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]+/gu, "[redacted]")
    .replace(/(https?:\/\/)[^/@\s]+:[^/@\s]+@/giu, "$1[redacted]@");
}
