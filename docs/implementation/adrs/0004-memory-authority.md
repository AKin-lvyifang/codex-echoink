# ADR 0004: Memory Authority

## Decision

EchoInk Memory is the authority for EchoInk context. Agent private memory is a backend capability, not an EchoInk truth source.

The Harness uses a replaceable `MemoryProvider` from the start. The first implementation may be `NoopMemoryProvider`, but Chat, Knowledge, Editor, and Adapter code must depend on the interface.

## Consequences

- MemoryProvider is injected into Context Compiler and Run Orchestrator.
- `.codex-memory/` migration is read-only first.
- Archive memory is not injected by default.
- Agent private memory cannot overwrite EchoInk Memory silently.
