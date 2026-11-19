/** One sentence in both interface languages. */
export type ErrorCopy = readonly [zh: string, en: string];

export type ErrorCopyLanguage = "zh" | "en";

export function errorCopyLanguage(language?: string): ErrorCopyLanguage {
  return language === "en" ? "en" : "zh";
}

export function pickErrorCopy(copy: ErrorCopy, language?: string): string {
  return copy[errorCopyLanguage(language) === "en" ? 1 : 0];
}
