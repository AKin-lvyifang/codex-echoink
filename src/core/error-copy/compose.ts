import { knownCopyBySentence, lookupErrorCode } from "./codes";
import { lookupProviderPatternCode } from "./codes/provider";
import { NEXT } from "./next";
import { errorCopyLanguage, pickErrorCopy, type ErrorCopy } from "./types";

/**
 * Turns any thrown value into text a non-technical user can read.
 * Known codes → their sentence; internal codes, English exceptions and
 * developer jargon → the caller's fallback (which already says what to do);
 * Chinese text written for users passes through with "Provider" → "模型服务".
 */
export function userFacingErrorText(error: unknown, fallback: string, language: string = "zh"): string {
  const en = errorCopyLanguage(language) === "en";
  // Errors that carry their own code (e.g. agent capability denials) fall back to that code's sentence.
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code.trim() : "";
  const codeFallback = (code && knownErrorText(code, en)) || fallback;
  const raw = rawErrorText(error);
  if (!raw) return codeFallback;
  const known = knownErrorText(raw, en);
  if (known) return known;
  if (looksLikeErrorCode(raw) || INTERNAL_WORDS.test(raw)) return codeFallback;
  const hasHan = /\p{Script=Han}/u.test(raw);
  if (!en && !hasHan) return codeFallback;
  if (en && hasHan) return codeFallback;
  return en ? raw : normalizeProviderTerm(raw);
}

/** The error's own readable sentence, or the scene fallback. */
export function errorText(error: unknown, fallback: ErrorCopy, language?: string): string {
  return userFacingErrorText(error, pickErrorCopy(fallback, language), errorCopyLanguage(language));
}

/** "What did not happen" + the error's readable reason, or the next step when it has none. */
export function failureText(error: unknown, lead: ErrorCopy, next: ErrorCopy, language?: string): string {
  const en = errorCopyLanguage(language) === "en";
  const reason = userFacingErrorText(error, "", en ? "en" : "zh");
  return joinErrorCopy(lead, reason ? [reason, reason] : next, language);
}

/** Button and menu actions with no better scene sentence; callers add a NEXT tail. */
export const ACTION_FAILED: ErrorCopy = ["操作未能完成。", "The action could not be completed."];

/** The error's own readable sentence, or "操作未能完成。请重试；如问题持续，请重新加载插件。" */
export function actionFailureText(error: unknown, language?: string): string {
  return userFacingErrorText(error, joinErrorCopy(ACTION_FAILED, NEXT.retryOrReload, language), errorCopyLanguage(language));
}

/** Static composition: scene sentence + a NEXT or CAUSE sentence. */
export function joinErrorCopy(lead: ErrorCopy, tail: ErrorCopy, language?: string): string {
  const en = errorCopyLanguage(language) === "en";
  return `${pickErrorCopy(lead, language)}${en ? " " : ""}${pickErrorCopy(tail, language)}`;
}

/** Raw text for the run report; never the main sentence. */
export function rawErrorText(error: unknown): string {
  const text = error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : error && typeof error === "object" && "message" in error && typeof error.message === "string"
        ? error.message
        : "";
  return text.trim().replace(/^(?:[A-Z][A-Za-z]*)?Error:\s*/u, "").trim();
}

export function normalizeProviderTerm(text: string): string {
  return text
    .replace(/[ \t]*API\s*Provider\s*设置/gu, "设置 → 模型服务")
    .replace(/([ \t]*)Provider([ \t]*)/gu, (match: string, before: string, after: string, offset: number, source: string) =>
      `${/\p{Script=Han}$/u.test(source.slice(0, offset)) ? "" : before}模型服务${/^\p{Script=Han}/u.test(source.slice(offset + match.length)) ? "" : after}`);
}

const INTERNAL_WORDS = /ProductRun|Pi\s*Session|Pi\s*Chat|Pi Runtime|pi_session|pi_native|runtime identity|JSONL|agent_settled|contentPath|metadata|元数据|生命周期|入队|队首|undefined|null is not|Cannot read propert/iu;

function looksLikeErrorCode(text: string): boolean {
  return /^[a-z][a-z0-9]*(?:[_:.-][a-z0-9]+)+$/u.test(text) || /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/u.test(text);
}

function knownErrorText(raw: string, en: boolean): string | null {
  const entry = lookupErrorCode(raw) ?? lookupProviderPatternCode(raw) ?? knownCopyBySentence(raw);
  return entry ? entry[en ? 1 : 0] : null;
}

/**
 * iPhone / iPad services throw the Chinese half of a sentence. Before showing it,
 * known sentences switch to the interface language, then the page dictionary
 * (`translate`) gets a chance, then the usual readability check applies; the raw
 * text never reaches the page, it only goes to the run report.
 */
export function settingsErrorText(error: unknown, fallback: ErrorCopy, language?: string, translate?: (zh: string) => string): string {
  const en = errorCopyLanguage(language) === "en";
  const raw = rawErrorText(error);
  const known = raw ? knownCopyBySentence(raw) : null;
  if (known) return pickErrorCopy(known, language);
  const translated = en && raw && translate ? translate(raw) : raw;
  return userFacingErrorText(translated !== raw ? translated : error, pickErrorCopy(fallback, language), en ? "en" : "zh");
}
