import { countTextTokens } from "./usage/token-estimator";

const normalize = (text: string) => text.trim().replace(/[\s，。！？,.!?~～]+/gu, "").toLowerCase();
const greeting = "你好|您好|嗨|哈喽|在吗|在么|喂|hello|hi|hey";
const courtesy = "谢谢|多谢|thanks|thankyou|好的|好|ok|okay|嗯|啊";
const titleFiller = new RegExp(`^(?:${greeting}|${courtesy})+$`, "u");
const plainGreeting = new RegExp(`^(?:${greeting})$`, "u");
const plainCourtesy = new RegExp(`^(?:${courtesy})$`, "u");

export function meaningfulTitleRequest(text: string): boolean {
  const compact = normalize(text);
  return !!compact && !titleFiller.test(compact);
}

export function shortSocialTurn(text: string, hasPriorConversation: boolean): boolean {
  if (text.length > 32 || /[\r\n]/u.test(text.trim())) return false;
  const compact = normalize(text);
  return plainGreeting.test(compact) || !hasPriorConversation && plainCourtesy.test(compact);
}

export const SHORT_SOCIAL_SYSTEM = "用用户的语言只答一句简短问候或致谢。不要解释或追问。资料只用于称呼。";

export function finishLimitedSocialReply(output: string, userText: string): string {
  const complete = output.trim().match(/^.*?[。！？.!?]/u)?.[0];
  if (complete) return complete;
  const compact = normalize(userText);
  if (/^[a-z]+$/u.test(compact)) return /^(?:thanks|thankyou)$/u.test(compact) ? "You're welcome!" : "Hi there!";
  return /^(?:谢谢|多谢)$/u.test(compact) ? "不客气！" : "你好呀！";
}
export const SHORT_SOCIAL_OUTPUT_TOKENS = 64;

/** Do not truncate explicitly pinned context to fit a spending target. */
export function shortSocialOutputLimit(prompt: string | undefined, material: readonly unknown[]): number | undefined {
  // Leave room for the gateway identity and provider message framing.
  const estimate = countTextTokens(prompt ?? "") + countTextTokens(JSON.stringify(material));
  return estimate <= 335 ? SHORT_SOCIAL_OUTPUT_TOKENS : undefined;
}
