import { rawErrorText, userFacingErrorText } from "../core/error-copy";
import { MEMBERSHIP_CODES, type MembershipCode } from "../core/error-copy/codes/account";

/** Fixed account errors in both interface languages. The table lives in core/error-copy/codes/account.ts. */
export const MEMBERSHIP_ERROR_TEXT: Readonly<Record<string, readonly [string, string]>> = MEMBERSHIP_CODES;
let languageProbe: () => string | undefined = () => undefined;
export function setMembershipLanguageProbe(probe: () => string | undefined) { languageProbe = probe; }
export function membershipErrorText(code: string, language = languageProbe()) {
  const copy = Object.prototype.hasOwnProperty.call(MEMBERSHIP_CODES, code) ? MEMBERSHIP_CODES[code as MembershipCode] : MEMBERSHIP_CODES.UNKNOWN;
  return copy[language === "en" ? 1 : 0];
}

/** Any thrown value → fixed account copy. Upper-case protocol codes use the table; other raw text falls back. */
export function membershipFailureText(error: unknown, fallbackCode = "UNKNOWN", language = languageProbe()): string {
  const raw = rawErrorText(error);
  if (/^[A-Z][A-Z0-9_]+$/u.test(raw)) return membershipErrorText(Object.prototype.hasOwnProperty.call(MEMBERSHIP_CODES, raw) ? raw : fallbackCode, language);
  return userFacingErrorText(error, membershipErrorText(fallbackCode, language), language === "en" ? "en" : "zh");
}
