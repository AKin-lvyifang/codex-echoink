import type { FileConversationCatalog } from "../harness/pi-native/file-conversation-catalog";

export function meaningfulTitleRequest(text: string): boolean {
  const compact = text.replace(/[\s，。！？,.!?~～]+/gu, "").toLowerCase();
  return !!compact && !/^(你好|您好|嗨|哈喽|在吗|在么|喂|hello|hi|hey|谢谢|多谢|thanks|thankyou|好的|好|ok|okay|嗯|啊)+$/u.test(compact);
}
export function shortConversationTitle(text: string): string {
  return Array.from(text.replace(/^[\s"'“”「」]+|[\s"'“”「」]+$/gu, "").replace(/\s+/gu, " ").trim()).slice(0, 14).join("");
}
/** Catalog claims the fallback before IO, so retries/restarts cannot issue a second request. */
export async function generateConversationTitle(input: {
  catalog: FileConversationCatalog; conversationId: string; requests: readonly string[];
  generate?: (prompt: string) => Promise<string>; changed(): void;
}): Promise<void> {
  const meaningful = input.requests.find(meaningfulTitleRequest);
  if (!meaningful) return;
  const fallback = shortConversationTitle(meaningful);
  if (!await input.catalog.claimShortTitle(input.conversationId, fallback)) return;
  input.changed();
  if (!input.generate) return;
  try {
    const generated = shortConversationTitle(await input.generate(input.requests.slice(0, input.requests.indexOf(meaningful) + 1).slice(-6).map(text => text.slice(0, 800)).join("\n")));
    if (generated) { await input.catalog.finishShortTitle(input.conversationId, fallback, generated); input.changed(); }
  } catch { /* The durable fallback is already final. Never retry or disturb the answer. */ }
}
