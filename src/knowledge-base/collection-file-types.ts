/** The formats accepted by EchoInk's explicit Save to Knowledge action. */
export const COLLECTION_DOCUMENT_TYPES = [
  { label: "PDF", extensions: [".pdf"] },
  { label: "Word DOCX", extensions: [".docx"] },
  { label: "Markdown", extensions: [".md", ".markdown"] },
  { label: "TXT", extensions: [".txt"] }
] as const;
export const COLLECTION_IMAGE_TYPES = [
  { label: "PNG", extensions: [".png"] },
  { label: "JPG/JPEG", extensions: [".jpg", ".jpeg"] },
  { label: "GIF", extensions: [".gif"] },
  { label: "WebP", extensions: [".webp"] }
] as const;
const documentExtensions = new Set<string>(COLLECTION_DOCUMENT_TYPES.flatMap(type => [...type.extensions]));
const imageExtensions = new Set<string>(COLLECTION_IMAGE_TYPES.flatMap(type => [...type.extensions]));
export function collectionFileKind(path: string): "files" | "images" | null {
  const extension = path.slice(path.lastIndexOf(".")).toLowerCase();
  return imageExtensions.has(extension) ? "images" : documentExtensions.has(extension) ? "files" : null;
}
