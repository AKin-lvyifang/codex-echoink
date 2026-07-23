import type { StoredSession } from "../../settings/settings";
import { migrationContentDigest } from "./record-migration-validator";

export function legacyWorkspaceMigrationPlaceholderFingerprint(
  cwd: string
): string {
  return migrationContentDigest({
    kind: "legacy-workspace",
    cwd
  });
}

export function hasLegacyWorkspaceMigrationPlaceholder(
  session: Pick<StoredSession, "cwd" | "workspaceFingerprint">
): boolean {
  const cwd = session.cwd;
  const storedWorkspaceFingerprint = session.workspaceFingerprint?.trim();
  return Boolean(
    cwd.trim()
    && storedWorkspaceFingerprint
    && storedWorkspaceFingerprint
      === legacyWorkspaceMigrationPlaceholderFingerprint(cwd)
  );
}
