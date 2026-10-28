/** Only evidenced record-write/readback failures receive a save-failure Notice. */
export function isPiConversationPersistenceError(value: unknown, seen = new Set<unknown>()): boolean {
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  const error = value as { name?: unknown; code?: unknown; syscall?: unknown; cause?: unknown; errors?: unknown };
  if (error.name === "PiSessionDurabilityError" && (error.code === "pi_session_readback_mismatch" || error.code === "pi_session_active_leaf_invalid")) return true;
  if (error.name === "PiNativeFileStoreError" && error.code === "readback-diverged") return true;
  if (typeof error.syscall === "string" && /^(?:write|fsync|fdatasync|rename|truncate)/u.test(error.syscall)
    && typeof error.code === "string" && ["EBUSY", "EPERM", "EACCES", "ENOSPC", "EIO", "EROFS"].includes(error.code)) return true;
  return isPiConversationPersistenceError(error.cause, seen)
    || Array.isArray(error.errors) && error.errors.some(cause => isPiConversationPersistenceError(cause, seen));
}
