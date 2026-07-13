# ADR 0003: Core Policy And Vault Profile

## Decision

Core Policy is code-level product policy. `LLM-WIKI.md` is only the Vault Profile.

Core Policy includes Raw protection, allowed write boundaries, Evidence validation, workflow success criteria, approval rules, transaction, rollback, and report contracts.

Vault Profile includes user-editable preferences such as folder mapping, naming, language, domains, routing preferences, and extra protected paths.

## Consequences

- Deleting or corrupting `LLM-WIKI.md` cannot disable Core Policy.
- User instructions can override Vault Profile preferences but cannot bypass Core Policy.
- Knowledge workflow success cannot be decided from final natural language.
