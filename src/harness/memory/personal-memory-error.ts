export class PersonalMemoryAccessError extends Error {
  constructor(
    readonly code:
      | "vault_mismatch"
      | "no_memory"
      | "invalid_request"
      | "not_found"
      | "revision_conflict"
      | "unsafe_path",
    message: string
  ) {
    super(message);
    this.name = "PersonalMemoryAccessError";
  }
}
