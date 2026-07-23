const MAX_CONVERSATION_SESSION_ID_LENGTH = 120;

/**
 * Legacy stores derived directory names with a lossy sanitizer. Keep this
 * helper only for inventory diagnostics; durable reads and writes must use the
 * exact, lossless contract below.
 */
export function legacyConversationPathPart(value: string): string {
  return value
    .replace(/[^a-zA-Z0-9_.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_CONVERSATION_SESSION_ID_LENGTH)
    || "session";
}

export function isSafeConversationSessionId(value: string): boolean {
  return typeof value === "string"
    && value.trim().length > 0
    && value === value.trim()
    && value !== "."
    && value !== ".."
    && !value.includes("/")
    && !value.includes("\\")
    && legacyConversationPathPart(value) === value;
}
