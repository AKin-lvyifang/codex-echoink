/** JWT payloads use unpadded Base64URL and contain UTF-8 JSON, not binary text. */
export function decodeCodexJwtBase64Url(value: string): string {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64.padEnd(base64.length + (4 - base64.length % 4) % 4, "="));
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/** Normalize SSE line endings without delaying a CR at a chunk boundary. */
export function createCodexSseNewlineNormalizer(): (chunk: string) => string {
  let previousEndedWithCr = false;
  return (chunk) => {
    // TextDecoder can return an empty chunk while buffering a UTF-8 character.
    if (!chunk) return "";
    const next = previousEndedWithCr && chunk.startsWith("\n") ? chunk.slice(1) : chunk;
    previousEndedWithCr = chunk.endsWith("\r");
    return next.replace(/\r\n?/g, "\n");
  };
}
