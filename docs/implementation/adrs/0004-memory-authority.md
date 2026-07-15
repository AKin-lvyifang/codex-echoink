# ADR 0004: Memory Authority

## Decision

EchoInk Memory is the authority for EchoInk context. Agent private memory is a backend capability, not an EchoInk truth source.

The Harness owns a replaceable, backend-neutral `MemoryProvider`. `FileMemoryProvider` stores formal state under `Vault/.echoink/memory`; `NoopMemoryProvider` remains the disabled-mode implementation. Chat, Knowledge, Editor, and Adapter code depend on the interface, not a specific Agent backend.

`index.json` is the only canonical structured source. `current.md`, `spec/index.md`, `tasks/index.md`, and `archive/index.md` are deterministic projections and must never be edited by a Curator.

Memory writes follow a journaled lifecycle: capture bounded and redacted run events, serialize the full sync per Vault, prepare a revision-bound transaction, run a read-only Curator, validate strict JSON and source coverage, stage the next index and projections, commit atomically, then advance the manifest revision. The installed index records its producing transaction identity; recovery never accepts revision equality alone. Failed validation, Curator calls, superseded recovery, or interrupted commits retain pending events for retry or recovery.

All formal mutations share the same Vault lane and staged commit protocol. Confirmation, deletion, import, supersede, expiry, Curator commit, and recovery cannot overwrite one another, and each can roll forward or restore backups after a process interruption. Projection repair uses revision-and-identity rechecking so it cannot leave an older projection after a concurrent formal commit. Formal files and the pending journal fail closed instead of replacing corrupt, partial, or future-schema data with defaults.

## Consequences

- `MemoryProvider` is injected into Context Compiler and Run Orchestrator. It observes user input, tool/file effects, terminal results, and local workflow commit events.
- Business Run commits enqueue Memory observation asynchronously. Slow or failed Curator work never holds the Run commit lane.
- On startup, unfinished Memory run states reconcile terminal and local-commit events from the durable Harness ledger. The asynchronous handoff is recoverable without moving Curator latency back into the business Run.
- Chat and `knowledge.ask` retrieve memory and capture only explicit durable signals.
- Structured write workflows record results only after `run.local_commit.completed`; checks, editor actions, prompt enhancement, and Curator runs do not capture long-term memory by default.
- Curators run through a backend-neutral interface. Codex, OpenCode, and Hermes are interchangeable execution engines; internal Curator runs are read-only, tool-free, resource-free, and memory-disabled. Events and active memories are explicitly untrusted data, not executable instructions.
- `.codex-memory/` is a read-only migration source. Import is explicit and never deletes or rewrites the source.
- Migration preview exposes real Markdown counts and bytes; oversized imports are blocked before formal state changes.
- V1 migration and missing projection repair regenerate deterministic Markdown from the validated full index and leave a repair marker across crashes.
- Retrieved Memory is injected through one backend-neutral untrusted-data envelope. Embedded instructions cannot grant permissions or override system/workflow rules.
- Archive memory is not injected by default.
- Agent private memory cannot overwrite EchoInk Memory silently.
