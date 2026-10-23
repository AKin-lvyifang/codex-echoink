/** Preserve typed readonly arrays; untrusted elements stay unknown, never any. */
export function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value);
}
