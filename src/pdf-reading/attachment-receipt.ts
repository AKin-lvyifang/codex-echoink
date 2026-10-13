/** Emitted only by the secured PDF tool after processing and artifact readback. */
export interface PdfAttachmentReceipt {
  conversationId: string;
  userEntryId: string;
  attachmentId: string;
  sha256: string;
}

export function pdfAttachmentReceipt(result: unknown): PdfAttachmentReceipt | null {
  if (!result || typeof result !== "object") return null;
  const outer = result as Record<string, unknown>;
  const details = (outer.details && typeof outer.details === "object" ? outer.details : outer) as Record<string, unknown>;
  if (details.source !== "echoink-pdf-reading" || details.readbackVerified !== true || details.status !== "completed") return null;
  const receipt = details.consumedAttachment as PdfAttachmentReceipt | undefined;
  if (!receipt || typeof receipt.conversationId !== "string" || !receipt.conversationId
    || typeof receipt.userEntryId !== "string" || !receipt.userEntryId
    || !/^pdf-[a-f0-9-]{36}$/u.test(receipt.attachmentId) || !/^[a-f0-9]{64}$/u.test(receipt.sha256)) return null;
  return receipt;
}
