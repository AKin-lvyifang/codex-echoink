/**
 * People name parsing and stable default-avatar derivation for to-dos.
 * Names stay plain readable text in the Markdown source; avatars are a pure
 * display layer. No contact system, no image generation, no external service.
 */

/** Separators between names; plain spaces never split (English full names). */
const PEOPLE_SEPARATOR = /[,，、;；]+/u;

export function parsePeopleNames(people: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const part of (people ?? "").split(PEOPLE_SEPARATOR)) {
    const name = part.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

export function joinPeopleNames(names: readonly string[]): string {
  return names.map((name) => name.trim()).filter(Boolean).join("、");
}

/** Chinese names use the first Han character; Latin names the first letter
 *  uppercased; anything else falls back to the first character. */
export function personInitial(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const first = [...trimmed][0];
  if (/[一-鿿]/u.test(first)) return first;
  if (/[a-zA-Z]/u.test(first)) return first.toUpperCase();
  return first;
}

/** Stable hash so the same name always maps to the same palette color. */
export function personColorIndex(name: string, paletteSize: number): number {
  const key = name.trim().toLowerCase();
  let hash = 0;
  for (const char of key) hash = (hash * 31 + char.codePointAt(0)!) % 100003;
  return hash % paletteSize;
}

export const TODO_AVATAR_PALETTE_SIZE = 8;
