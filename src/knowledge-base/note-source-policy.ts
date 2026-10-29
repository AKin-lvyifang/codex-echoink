/** Reserved private roots are never ordinary note sources, regardless of bindings. */
const PRIVATE_NOTE_ROOTS: readonly string[] = ["私有记忆"];

/** Paths are Vault-relative slash paths; callers retain their own path validation. */
export function isPrivateNoteSourcePath(relativePath: string, additionalRoots: readonly string[] = [], configDir?: string): boolean {
  return [...PRIVATE_NOTE_ROOTS, ...additionalRoots, ...(configDir ? [`${configDir}/plugins`] : [])].some(root => Boolean(root)
    && (relativePath === root || relativePath.startsWith(`${root}/`)));
}
