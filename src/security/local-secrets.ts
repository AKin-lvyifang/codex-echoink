export const REDACTED_SECRET = "[REDACTED_SECRET]" as const;

const VALUE_SECRET_PATTERNS: readonly RegExp[] = [
  /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/giu,
  /\bsk-[A-Za-z0-9_-]{12,}\b/gu,
  /\bghp_[A-Za-z0-9]{12,}\b/gu,
  /\bgithub_pat_[A-Za-z0-9_]{12,}\b/gu,
  /\bxox[baprs]-[A-Za-z0-9-]{12,}\b/gu,
  /\bAKIA[A-Z0-9]{16}\b/gu,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/gu
];

const CREDENTIAL_FIELD =
  /((?:["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|credential(?:value)?|client[_-]?secret|password|secret)["']?)\s*[:=]\s*)(["']?)((?!\[REDACTED_SECRET\])[^\s,"'}\]]+)(["']?)/giu;

export function redactEchoInkLocalSecretsV1(value: string): string {
  let redacted = value;
  for (const pattern of VALUE_SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, (match) => {
      const scheme = /^(?:Bearer|Basic)\s+/iu.exec(match)?.[0] ?? "";
      return `${scheme}${REDACTED_SECRET}`;
    });
  }
  redacted = redacted.replace(
    CREDENTIAL_FIELD,
    (_match, prefix: string, openingQuote: string) =>
      `${prefix}${openingQuote}${REDACTED_SECRET}${openingQuote}`
  );
  return redacted;
}


/** Literal value replacement shared by Provider errors and report exports. */
export function replaceKnownSecrets(value: string, secrets: readonly string[], replacement: string = REDACTED_SECRET): string {
  for (const secret of [...new Set(secrets)].filter(Boolean).sort((a, b) => b.length - a.length)) value = value.split(secret).join(replacement);
  return value;
}
